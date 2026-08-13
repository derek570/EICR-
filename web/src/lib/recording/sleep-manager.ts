/**
 * VAD sleep/wake state machine — port of iOS `SleepManager.swift`
 * (Stage 4c collapsed 2-tier model, 2026-04-27).
 *
 * PLAN-C (id 120, 2026-08-13) — the diagram below is now the LEGACY
 * behaviour, live only when `autoSleepEnabled` is explicitly true
 * (default false — see `SleepManagerConfig.autoSleepEnabled`'s
 * docblock). With the flag off, the automatic state machine collapses
 * to `active` indefinitely and this class's `enterSleeping()` is
 * reachable ONLY via that automatic timer. `RecordingProvider`'s
 * explicit manual pause (Pause button, BFCache auto-pause) does NOT
 * call `enterSleeping()` at all — it uses the C2a lighter-weight pause
 * in recording-context.tsx instead, unconditionally in both flag
 * states. Do not reintroduce a call from the explicit pause path back
 * into this class's automatic machinery.
 *
 *   active ──60s no FINAL──────────► sleeping   (autoSleepEnabled: true only)
 *   sleeping ──VAD wake (speech)───► active
 *
 * Pre-fix the PWA carried a 3-tier model (active → dozing → sleeping)
 * inherited from the original Phase 4e wave. iOS dropped the dozing
 * tier on 2026-04-27 because Flux rejected the KeepAlive JSON the
 * tier relied on, and silent-PCM ping triggered spurious EndOfTurn
 * events. The PWA's nova-3 Deepgram path tolerates KeepAlive, but
 * keeping the third tier put the two clients out of step on every
 * timing-sensitive question (sleep entry, wake-grace, post-question
 * extension). This port collapses the state machine and ports iOS's
 * three timer constants verbatim.
 *
 * Timer constants — all lifted from `Sources/Audio/SleepManager.swift`
 * lines 63 / 68 / 76:
 *
 *   • noTranscriptTimeoutSec = 60s — base timer between final
 *     transcripts. Inspectors take 30–40s to set up the next reading,
 *     so a tighter timeout would cause constant reconnect churn while
 *     saving negligible cost; 60s is long enough for natural
 *     inspection rhythm but short enough that loft/garage transit
 *     time isn't billed.
 *   • questionAnswerTimeoutSec = 75s — extended timer after a
 *     question is asked via TTS. The user needs time to hear the
 *     question, think, and speak their answer.
 *   • postWakeGraceSec = 90s — grace timer after a wake. Deepgram
 *     reconnect (~1–2s key fetch + ~1–2s WS handshake + ~1–2s buffer
 *     replay) races with the standard timeout otherwise, causing a
 *     "Sorry, could you repeat that?" loop.
 *
 * VAD wake gate has two paths — the recording-context.tsx caller
 * picks one based on whether Silero loaded successfully:
 *
 *   • `processVadFrame(score)` — Silero v5 ONNX path. Compares the
 *     speech probability against `vadWakeThreshold` (0.80, iOS canon).
 *     This is the primary path; the SileroVAD wrapper at
 *     `silero-vad.ts` runs the model and feeds the probability in.
 *   • `processAudioLevel(rms)` — RMS fallback. Compares raw mic
 *     amplitude against `wakeRmsThreshold` (0.02). Used only when
 *     Silero load() failed (offline first-run + uncached, ORT crash,
 *     SHA mismatch). False-wakes on tool noise; documented hazard
 *     but better than no wake-from-sleep at all.
 *
 * Both paths share the same 12-of-30-frames accumulator + 2s post-
 * sleep cooldown semantics, so the state machine downstream (timer
 * arm, post-wake grace, onWake fan-out) doesn't care which scored.
 * Caller is expected to use ONE path per session — feeding both at
 * once would double-count frames against the wake gate.
 */

export type SleepState = 'active' | 'sleeping';

export interface SleepManagerCallbacks {
  /** Fired when the no-transcript timer elapses in `active` (only
   *  possible with `autoSleepEnabled: true`), or when a consumer calls
   *  `enterSleeping()` directly. PLAN-C (id 120): `RecordingProvider`'s
   *  explicit manual pause does NOT call `enterSleeping()` — it uses the
   *  C2a lighter-weight pause instead (recording-context.tsx), so this
   *  fires ONLY on the automatic flag-ON timer path in production.
   *  iOS counterpart: `onEnterSleeping`. */
  onEnterSleeping?: () => void;
  /** Fired when the VAD wake heuristic detects sustained speech
   *  while sleeping. Mirrors iOS `onWake`. */
  onWake?: (fromState: 'sleeping') => void;
  /** Lifecycle logging hook — debug only. */
  onStateChange?: (state: SleepState) => void;
}

export interface SleepManagerConfig {
  /** Seconds of no FINAL transcript before sleeping. Default 60s
   *  (iOS `noTranscriptTimeout`). */
  noTranscriptTimeoutSec?: number;
  /** Seconds when a question is in flight. Default 75s
   *  (iOS `questionAnswerTimeout`). */
  questionAnswerTimeoutSec?: number;
  /** Seconds during the post-wake grace window. Default 90s
   *  (iOS `postWakeGraceTimeout`). */
  postWakeGraceSec?: number;
  /** RMS threshold that counts as "speech" for the RMS fallback wake
   *  heuristic. Default 0.02 ≈ -34 dBFS. Used by `processAudioLevel`. */
  wakeRmsThreshold?: number;
  /** Silero speech-probability threshold (0..1) for the primary wake
   *  path. Default 0.80 (iOS `SileroVAD.wakeThreshold`). Used by
   *  `processVadFrame`. */
  vadWakeThreshold?: number;
  /** Consecutive frames above the active threshold required to wake.
   *  Default 12. iOS uses 12 frames in a 30-frame window at 32ms/frame
   *  (~384ms of sustained speech). The Silero path matches the iOS
   *  cadence exactly; the RMS path runs at ~60Hz mic callbacks so 12
   *  frames is closer to ~200ms — coarser, but the consequences of a
   *  short over/under-window are smaller than the cost of two
   *  divergent constants on top of two divergent score functions. */
  wakeFramesRequired?: number;
  /** Cooldown after entering sleep during which wake is suppressed.
   *  Default 2s — gives the AGC / mic envelope time to drain. */
  postSleepCooldownMs?: number;
  /** PLAN-C (feedback id 120) — session-latched flag gating ONLY
   *  automatic no-transcript timer creation and timer-triggered sleep
   *  entry. Default false: the automatic state machine now collapses
   *  to `active` indefinitely (streaming continuously while recording)
   *  because the 60s auto-sleep tier caused post-wake dead air, slow
   *  cold-start interims, and a wake-during-close race that destroyed
   *  the 3s replay buffer (session CF052DF3 — see EVIDENCE.md). The
   *  machinery stays behind this flag (not deleted) so it can be
   *  re-enabled if continuous-streaming cost ever matters for a
   *  battery/data-constrained user. Does NOT gate explicit user
   *  actions — on THIS client, the Pause button + BFCache auto-pause
   *  route through the C2a lighter-weight pause in
   *  recording-context.tsx unconditionally, in both flag states.
   *  (Web has no AVAudioSession-interruption concept; iOS's own
   *  equivalent explicit path — `handleInterruptionResume` — is
   *  flag-independent too, but hardened separately via C1a's
   *  generation-owned reconnect, not this file's C2a.) iOS
   *  counterpart: `autoSleepEnabled` (UserDefaults-backed, hidden, not
   *  exposed in Settings this wave). */
  autoSleepEnabled?: boolean;
}

const DEFAULTS: Required<SleepManagerConfig> = {
  noTranscriptTimeoutSec: 60,
  questionAnswerTimeoutSec: 75,
  postWakeGraceSec: 90,
  wakeRmsThreshold: 0.02,
  vadWakeThreshold: 0.8,
  wakeFramesRequired: 12,
  postSleepCooldownMs: 2000,
  autoSleepEnabled: false,
};

/** localStorage key for the persisted `autoSleepEnabled` preference —
 *  intentionally the SAME key name as iOS's UserDefaults key (the plan's
 *  "mirrored on web via localStorage under the same key"), not
 *  namespaced like `cm-confirmation-mode` — this flag has no Settings UI
 *  this wave, so there's no in-product surface it could collide with. */
const AUTO_SLEEP_STORAGE_KEY = 'autoSleepEnabled';

/**
 * Read the persisted `autoSleepEnabled` preference. Defaults to `false`
 * (auto-sleep retired) when unset — mirrors iOS's
 * `UserDefaults.standard.object(forKey: "autoSleepEnabled") as? Bool ??
 * false`. No corresponding setter this wave: the flag is hidden (no
 * Settings UI), re-enabled only via direct localStorage/UserDefaults
 * access if continuous-streaming cost ever needs revisiting.
 */
export function getAutoSleepEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(AUTO_SLEEP_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export class SleepManager {
  private state: SleepState = 'active';
  private cfg: Required<SleepManagerConfig>;
  private cbs: SleepManagerCallbacks;

  /** Cancel closure for the active timer, when armed — set by
   *  `timerScheduler`'s return value, cleared by `clearNoTranscriptTimer`.
   *  Re-armed on every onSpeechActivity / onQuestionAsked / wake — the
   *  CURRENT timeout is whichever of the three constants applies. */
  private cancelNoTranscriptTimer: (() => void) | null = null;

  /** PLAN-C (id 120) — injectable timer scheduler (test seam), mirroring
   *  iOS's `timerScheduler` on `SleepManager.swift`. The production
   *  default schedules exactly what the pre-seam code did (a plain
   *  `setTimeout`); tests can inject a fake that records
   *  `(timeoutMs, onFire)` pairs and invokes `onFire` manually for
   *  synchronous, deterministic control of the timer path without
   *  depending solely on `vi.useFakeTimers()`. Returns a cancel
   *  function — the sole handle this class keeps. Instance-scoped (not
   *  static), so no state leaks across the test file. */
  timerScheduler: (timeoutMs: number, onFire: () => void) => () => void = (timeoutMs, onFire) => {
    const id = setTimeout(onFire, timeoutMs);
    return () => clearTimeout(id);
  };

  /** Question-answer flow flag — extends the no-transcript timeout
   *  to questionAnswerTimeoutSec until the next final transcript
   *  arrives. */
  private isQuestionAnswerFlow = false;

  /** Post-wake grace flag — extends the no-transcript timeout to
   *  postWakeGraceSec for one cycle, until the next final lands and
   *  resets to the base 60s. */
  private isPostWakeGrace = false;

  /** TTS-active flag — while true the timer is fully suspended (TTS
   *  pauses the Deepgram audio stream, creating artificial silence
   *  that should NOT count toward sleep entry). Mirrors iOS
   *  `isTTSActive` (SleepManager.swift:97). */
  private isTtsActive = false;

  private consecutiveSpeechFrames = 0;
  private cooldownUntilMs = 0;

  /** PLAN-C (id 120) C2a — sticky latch set by `suspendTimer()` / cleared
   *  by `resumeTimer()`. `suspendTimer()` alone only clears whatever
   *  timer happens to be armed AT THAT INSTANT — it does not, by itself,
   *  stop a LATER re-arm. Because the lighter-weight pause deliberately
   *  leaves `state` at `active` (see the class docblock), any of
   *  `onSpeechActivity` / `onQuestionAsked` / `setTtsActive(false)`
   *  firing during a pause (e.g. a delayed extraction response arriving
   *  over the still-connected Sonnet session) would otherwise call
   *  `armNoTranscriptTimer()` again and silently resurrect the automatic
   *  60s timeout mid-pause — reintroducing the exact
   *  `onEnterSleeping`-tears-down-Sonnet failure C2a exists to eliminate
   *  (test 4b). This flag makes `armNoTranscriptTimer()` a no-op for the
   *  ENTIRE suspended window, not just the instant `suspendTimer()` ran.
   *  Codex diff-review r1 (found independently by two lenses). */
  private timerSuspended = false;

  constructor(callbacks: SleepManagerCallbacks = {}, config: SleepManagerConfig = {}) {
    this.cbs = callbacks;
    this.cfg = { ...DEFAULTS, ...config };
  }

  get currentState(): SleepState {
    return this.state;
  }

  /** Arm the state machine. Must be called once the recording is live so
   *  the no-transcript timer starts ticking. */
  start(): void {
    this.timerSuspended = false;
    this.setState('active');
    this.armNoTranscriptTimer();
  }

  /** Tear the state machine down — called on stop() to clear timers. */
  stop(): void {
    this.clearNoTranscriptTimer();
    this.consecutiveSpeechFrames = 0;
    this.cooldownUntilMs = 0;
    this.isQuestionAnswerFlow = false;
    this.isPostWakeGrace = false;
    this.isTtsActive = false;
    this.timerSuspended = false;
  }

  /** Called whenever Deepgram emits a FINAL transcript. Resets the
   *  timer with the BASE 60s timeout — exits any post-wake-grace /
   *  question-answer extension. iOS counterpart: onSpeechActivity. */
  onSpeechActivity(): void {
    if (this.state !== 'active') return;
    this.isQuestionAnswerFlow = false;
    this.isPostWakeGrace = false;
    this.armNoTranscriptTimer();
  }

  /** Mark a question as in flight — switches the timer to
   *  questionAnswerTimeoutSec until the next final. iOS counterpart:
   *  setQuestionAnswerFlow / armQuestionAnswerTimeout. */
  onQuestionAsked(): void {
    this.isQuestionAnswerFlow = true;
    if (this.state === 'active') this.armNoTranscriptTimer();
  }

  /** Direct entry into sleeping — same effect as the no-transcript
   *  timer firing (full Deepgram disconnect, ring buffer keeps
   *  recording for wake-replay). PLAN-C (id 120): despite the name and
   *  the comment this replaces, `RecordingProvider`'s manual Pause
   *  button does NOT call this — it uses the C2a lighter-weight pause
   *  instead, unconditionally in both `autoSleepEnabled` states (see
   *  recording-context.tsx `pause()`). This method's only production
   *  caller is `armNoTranscriptTimer`'s own timer callback, i.e. it
   *  fires only when the flag is on. */
  enterSleeping(): void {
    if (this.state === 'sleeping') return;
    this.clearNoTranscriptTimer();
    this.consecutiveSpeechFrames = 0;
    this.cooldownUntilMs = performance.now() + this.cfg.postSleepCooldownMs;
    this.setState('sleeping');
    this.cbs.onEnterSleeping?.();
  }

  /** TTS is playing → suspend the timer. While paused, no automatic
   *  sleep entry can fire (otherwise the inspector hearing a
   *  question would simultaneously be transitioned to sleeping by
   *  the artificial silence the speaker produces). */
  setTtsActive(active: boolean): void {
    if (this.isTtsActive === active) return;
    this.isTtsActive = active;
    if (active) {
      this.clearNoTranscriptTimer();
    } else if (this.state === 'active') {
      this.armNoTranscriptTimer();
    } else if (this.state === 'sleeping') {
      // Audit #56 — defensive force-wake. The `enterSleeping` guard
      // at applyWakeScore + the timer-already-cleared invariant
      // should prevent us reaching `sleeping` while TTS is active.
      // But a race where the SleepManager hit the 60s timer
      // simultaneously with a TTS dispatch can land us here with
      // tts=true & state=sleeping. iOS handles this defensively at
      // `SleepManager.swift:onTTSFinished:181-184`: if TTS finishes
      // while we got to sleeping anyway, wake immediately so the
      // inspector's next utterance doesn't fall into the post-sleep
      // mic gap.
      this.cbs.onWake?.('sleeping');
    }
  }

  /** Feed each mic-level RMS sample in so the RMS fallback wake
   *  heuristic can fire. No-op while in `active` or while the
   *  post-sleep cooldown is in flight. Used only when the Silero
   *  primary path failed to load (offline first run, ORT crash). */
  processAudioLevel(rms: number): void {
    this.applyWakeScore(rms, this.cfg.wakeRmsThreshold);
  }

  /** Feed a Silero VAD speech probability ([0..1]) per 32ms frame.
   *  Wakes after `wakeFramesRequired` consecutive scores ≥
   *  `vadWakeThreshold`. iOS canon path. */
  processVadFrame(score: number): void {
    this.applyWakeScore(score, this.cfg.vadWakeThreshold);
  }

  private applyWakeScore(score: number, threshold: number): void {
    if (this.state === 'active') return;
    if (performance.now() < this.cooldownUntilMs) {
      this.consecutiveSpeechFrames = 0;
      return;
    }
    if (score >= threshold) {
      this.consecutiveSpeechFrames++;
      if (this.consecutiveSpeechFrames >= this.cfg.wakeFramesRequired) {
        this.consecutiveSpeechFrames = 0;
        // Set post-wake-grace BEFORE the state transition so the
        // no-transcript timer arms with the 90s window when active
        // resumes. Cleared on the next final (onSpeechActivity).
        this.isPostWakeGrace = true;
        this.setState('active');
        this.armNoTranscriptTimer();
        this.cbs.onWake?.('sleeping');
      }
    } else {
      this.consecutiveSpeechFrames = 0;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private setState(next: SleepState) {
    if (this.state === next) return;
    this.state = next;
    this.cbs.onStateChange?.(next);
  }

  /** Compute the active timeout (in seconds) under the current flags.
   *  Priority — same as iOS:
   *    post-wake-grace > question-answer > base.
   *  Both extension flags survive across cycles until the next final
   *  resets them. */
  private currentTimeoutSec(): number {
    if (this.isPostWakeGrace) return this.cfg.postWakeGraceSec;
    if (this.isQuestionAnswerFlow) return this.cfg.questionAnswerTimeoutSec;
    return this.cfg.noTranscriptTimeoutSec;
  }

  /** PLAN-C (id 120) — suspend the automatic timer WITHOUT touching
   *  `state`, for the ENTIRE window until `resumeTimer()` is called —
   *  not just the instant this method runs. Used by
   *  recording-context.tsx's C2a lighter-weight pause so a flag-ON
   *  automatic timer can't fire `enterSleeping()` mid-pause (which would
   *  resurrect the full Deepgram/Sonnet teardown + replay path the
   *  lighter-weight pause exists to avoid) — including from a LATER
   *  re-arm via `onSpeechActivity`/`onQuestionAsked`/`setTtsActive(false)`
   *  while paused (e.g. a delayed extraction response over the
   *  still-connected Sonnet session). Safe/inert if `autoSleepEnabled`
   *  is false — there is no timer to suspend either way. */
  suspendTimer(): void {
    this.timerSuspended = true;
    this.clearNoTranscriptTimer();
  }

  /** PLAN-C (id 120) — re-arm the automatic timer per the
   *  session-latched flag. Counterpart to `suspendTimer()`, called on
   *  resume from the C2a lighter-weight pause. Safe to call
   *  unconditionally: `armNoTranscriptTimer()` itself no-ops when
   *  `autoSleepEnabled` is false. */
  resumeTimer(): void {
    this.timerSuspended = false;
    if (this.state === 'active') this.armNoTranscriptTimer();
  }

  private armNoTranscriptTimer() {
    this.clearNoTranscriptTimer();
    // PLAN-C (id 120) C2a — while suspended (a lighter-weight pause is
    // in flight), no re-arm may proceed, however it was triggered. See
    // `timerSuspended`'s docblock for the failure this closes.
    if (this.timerSuspended) return;
    // PLAN-C (id 120) — the Sleeping tier is retired by default. When
    // `autoSleepEnabled` is false the automatic state machine collapses
    // to `active` indefinitely: no timer is ever armed, so it can never
    // fire `enterSleeping()`. On THIS client, explicit lifecycle actions
    // (Pause button, BFCache auto-pause) are FLAG-INDEPENDENT — they no
    // longer call through this class at all (see C2a in
    // recording-context.tsx), so gating only the timer here is
    // sufficient to satisfy "does not gate explicit user actions". (Web
    // has no interruption-recovery concept; iOS's equivalent is hardened
    // separately via C1a, not this file.)
    if (!this.cfg.autoSleepEnabled) return;
    if (this.isTtsActive) return; // suspended while TTS speaks
    const ms = this.currentTimeoutSec() * 1000;
    this.cancelNoTranscriptTimer = this.timerScheduler(ms, () => {
      // Direct entry into sleeping — no intermediate doze tier.
      if (this.state === 'active') this.enterSleeping();
    });
  }

  private clearNoTranscriptTimer() {
    if (this.cancelNoTranscriptTimer) {
      this.cancelNoTranscriptTimer();
      this.cancelNoTranscriptTimer = null;
    }
  }
}
