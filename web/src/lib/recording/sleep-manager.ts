/**
 * VAD sleep/wake state machine — port of iOS `SleepManager.swift`
 * (Stage 4c collapsed 2-tier model, 2026-04-27).
 *
 *   active ──60s no FINAL──────────► sleeping
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
 * VAD wake gate is RMS-only today; Silero v5 ONNX is tracked as the
 * follow-up T20. iOS uses 0.80 probability over 12 / 30 frames; the
 * RMS proxy (≥0.02 for 12 consecutive ~16ms frames ≈ 200ms) catches
 * sustained speech but false-wakes on tool noise. Swap to Silero in
 * processAudioFrame when onnxruntime-web lands.
 */

export type SleepState = 'active' | 'sleeping';

export interface SleepManagerCallbacks {
  /** Fired when the no-transcript timer elapses in `active`, or when
   *  the consumer calls `enterSleeping()` directly (manual pause).
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
  /** RMS threshold that counts as "speech" for the wake heuristic.
   *  Default 0.02 ≈ -34 dBFS. Approximation of iOS's Silero 0.80
   *  probability gate; will be replaced when Silero ONNX lands. */
  wakeRmsThreshold?: number;
  /** Consecutive mic-level callbacks above `wakeRmsThreshold`
   *  required to wake. At ~60Hz this defaults to ~200ms. iOS uses 12
   *  VAD frames in a 30-frame window at 32ms/frame (~400ms) with
   *  Silero. */
  wakeFramesRequired?: number;
  /** Cooldown after entering sleep during which wake is suppressed.
   *  Default 2s — gives the AGC / mic envelope time to drain. */
  postSleepCooldownMs?: number;
}

const DEFAULTS: Required<SleepManagerConfig> = {
  noTranscriptTimeoutSec: 60,
  questionAnswerTimeoutSec: 75,
  postWakeGraceSec: 90,
  wakeRmsThreshold: 0.02,
  wakeFramesRequired: 12,
  postSleepCooldownMs: 2000,
};

export class SleepManager {
  private state: SleepState = 'active';
  private cfg: Required<SleepManagerConfig>;
  private cbs: SleepManagerCallbacks;

  /** Active timer that, when it fires, transitions active → sleeping.
   *  Re-armed on every onSpeechActivity / onQuestionAsked / wake — the
   *  CURRENT timeout is whichever of the three constants applies. */
  private noTranscriptTimer: ReturnType<typeof setTimeout> | null = null;

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

  /** Manual entry into sleeping (user tapped Pause). Same effect as
   *  the no-transcript timer firing — full Deepgram disconnect, ring
   *  buffer keeps recording for wake-replay. */
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
    }
  }

  /** Feed each mic-level RMS sample in so the wake heuristic can fire.
   *  No-op while in `active`. */
  processAudioLevel(rms: number): void {
    if (this.state === 'active') return;
    if (performance.now() < this.cooldownUntilMs) {
      this.consecutiveSpeechFrames = 0;
      return;
    }

    if (rms >= this.cfg.wakeRmsThreshold) {
      this.consecutiveSpeechFrames++;
      if (this.consecutiveSpeechFrames >= this.cfg.wakeFramesRequired) {
        this.consecutiveSpeechFrames = 0;
        // Set the post-wake-grace flag BEFORE the state transition so
        // the no-transcript timer arms with the 90s window when active
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

  private armNoTranscriptTimer() {
    this.clearNoTranscriptTimer();
    if (this.isTtsActive) return; // suspended while TTS speaks
    const ms = this.currentTimeoutSec() * 1000;
    this.noTranscriptTimer = setTimeout(() => {
      // Direct entry into sleeping — no intermediate doze tier.
      if (this.state === 'active') this.enterSleeping();
    }, ms);
  }

  private clearNoTranscriptTimer() {
    if (this.noTranscriptTimer) {
      clearTimeout(this.noTranscriptTimer);
      this.noTranscriptTimer = null;
    }
  }
}
