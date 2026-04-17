/**
 * VAD sleep/wake state machine. Port of iOS `SleepManager.swift`.
 *
 * Drives three power-saving tiers while the inspector is recording:
 *
 *   active ──15s no final transcript──► dozing
 *   dozing ──1800s dozing──────────────► sleeping
 *   dozing/sleeping ──VAD wake (speech)──► active
 *
 * **Doze** keeps the Deepgram WS open but stops forwarding real samples
 * (KeepAlive + silent PCM keeps the socket alive, <100ms wake latency).
 * **Sleep** fully disconnects Deepgram after 30 minutes of dozing; wake
 * from sleep reopens the WS + replays the 3-second ring buffer.
 *
 * Phase 4e ships a functional RMS-energy wake path. The iOS reference
 * uses a Silero VAD ONNX model (threshold 0.80, 12-of-30 frames) which
 * is more resistant to tool noise / breath / footsteps. TODO: land
 * `onnxruntime-web` + Silero v5 model and swap the RMS path for a real
 * VAD in `processAudioFrame`.
 *
 * Constants lifted 1:1 from `Sources/Audio/SleepManager.swift` so the
 * behaviour matches iOS observationally.
 */

export type SleepState = 'active' | 'dozing' | 'sleeping';

export interface SleepManagerCallbacks {
  /** Fired when the 15s no-final-transcript timer elapses in `active`. */
  onEnterDozing?: () => void;
  /** Fired when the 30-min dozing timer elapses. */
  onEnterSleeping?: () => void;
  /** Fired when VAD detects speech while dozing or sleeping. */
  onWake?: (fromState: Exclude<SleepState, 'active'>) => void;
  /** Lifecycle logging hook — debug only. */
  onStateChange?: (state: SleepState) => void;
}

export interface SleepManagerConfig {
  /** Seconds of no FINAL transcript before entering doze. Default 15s
   *  (iOS `noTranscriptTimeout`). */
  noTranscriptTimeoutSec?: number;
  /** Seconds of dozing before full disconnect. Default 1800s / 30min
   *  (iOS `dozingTimeout`). */
  dozingTimeoutSec?: number;
  /** RMS threshold that counts as "speech" for the wake heuristic.
   *  Default 0.02 ≈ -34 dBFS — a rough match for iOS energy floor in
   *  combination with the frames-required count. */
  wakeRmsThreshold?: number;
  /** Consecutive mic-level callbacks above `wakeRmsThreshold` required
   *  to wake. At ~60Hz this defaults to ~200ms. iOS uses 12 VAD frames
   *  in a 30-frame window at 32ms/frame (≈ 400ms) with Silero. */
  wakeFramesRequired?: number;
  /** Cooldown after entering doze during which wake is suppressed. iOS
   *  uses 63 frames (~2s) while the AGC drains. */
  postDozeCooldownMs?: number;
}

const DEFAULTS: Required<SleepManagerConfig> = {
  noTranscriptTimeoutSec: 15,
  dozingTimeoutSec: 1800,
  wakeRmsThreshold: 0.02,
  wakeFramesRequired: 12,
  postDozeCooldownMs: 2000,
};

export class SleepManager {
  private state: SleepState = 'active';
  private cfg: Required<SleepManagerConfig>;
  private cbs: SleepManagerCallbacks;

  private noTranscriptTimer: ReturnType<typeof setTimeout> | null = null;
  private dozingTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.clearDozingTimer();
    this.consecutiveSpeechFrames = 0;
    this.cooldownUntilMs = 0;
  }

  /** Called whenever Deepgram emits a FINAL transcript. Resets the
   *  no-transcript timer. iOS calls this from `onSpeechActivity` on
   *  every final — interim transcripts deliberately do NOT reset the
   *  timer to avoid the AGC self-feeding during long silences. */
  onSpeechActivity(): void {
    if (this.state !== 'active') return;
    this.armNoTranscriptTimer();
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
        const from = this.state as Exclude<SleepState, 'active'>;
        this.consecutiveSpeechFrames = 0;
        this.setState('active');
        this.clearDozingTimer();
        this.armNoTranscriptTimer();
        this.cbs.onWake?.(from);
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

  private armNoTranscriptTimer() {
    this.clearNoTranscriptTimer();
    this.noTranscriptTimer = setTimeout(() => {
      this.enterDozing();
    }, this.cfg.noTranscriptTimeoutSec * 1000);
  }

  private clearNoTranscriptTimer() {
    if (this.noTranscriptTimer) {
      clearTimeout(this.noTranscriptTimer);
      this.noTranscriptTimer = null;
    }
  }

  private armDozingTimer() {
    this.clearDozingTimer();
    this.dozingTimer = setTimeout(() => {
      this.enterSleeping();
    }, this.cfg.dozingTimeoutSec * 1000);
  }

  private clearDozingTimer() {
    if (this.dozingTimer) {
      clearTimeout(this.dozingTimer);
      this.dozingTimer = null;
    }
  }

  private enterDozing() {
    if (this.state !== 'active') return;
    this.clearNoTranscriptTimer();
    this.consecutiveSpeechFrames = 0;
    // Cooldown suppresses spurious wakes while the AGC / mic envelope
    // drains — iOS uses a 63-frame cooldown.
    this.cooldownUntilMs = performance.now() + this.cfg.postDozeCooldownMs;
    this.setState('dozing');
    this.armDozingTimer();
    this.cbs.onEnterDozing?.();
  }

  private enterSleeping() {
    if (this.state !== 'dozing') return;
    this.clearDozingTimer();
    this.consecutiveSpeechFrames = 0;
    this.setState('sleeping');
    this.cbs.onEnterSleeping?.();
  }
}
