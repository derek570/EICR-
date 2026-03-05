import { AudioRingBuffer } from './audio-ring-buffer';

export type SleepState = 'active' | 'dozing' | 'sleeping';
export type VadState = 'idle' | 'listening' | 'speaking' | 'trailing';

export interface SleepManagerCallbacks {
  onEnterDozing: () => void;
  onEnterSleeping: () => void;
  onWake: (fromState: SleepState) => void;
  onVadStateChange?: (state: VadState) => void;
}

const SILENCE_TIMEOUT = 60_000; // 60s silence -> dozing
const DOZING_TIMEOUT = 300_000; // 5min dozing -> sleeping
const VAD_FRAMES_REQUIRED = 3; // consecutive speech frames to wake (matches iOS vadFramesRequired = 3)

export class SleepManager {
  private _state: SleepState = 'active';
  private _vadState: VadState = 'idle';
  private callbacks: SleepManagerCallbacks;

  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private dozingTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveSpeechFrames = 0;

  // VAD instance from @ricky0123/vad-web (loaded dynamically)
  private micVAD: {
    start: () => Promise<void>;
    pause: () => Promise<void>;
    destroy: () => void;
  } | null = null;
  private vadInitializing = false;

  readonly ringBuffer = new AudioRingBuffer();

  get state(): SleepState {
    return this._state;
  }

  get vadState(): VadState {
    return this._vadState;
  }

  constructor(callbacks: SleepManagerCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Initialize Silero VAD. Must be called once after construction.
   * Uses dynamic import to avoid SSR issues with WASM/ONNX.
   */
  async initVAD(): Promise<void> {
    if (this.micVAD || this.vadInitializing) return;
    this.vadInitializing = true;

    try {
      // Dynamic import to avoid SSR — vad-web requires browser APIs
      const { MicVAD } = await import('@ricky0123/vad-web');

      this.micVAD = await MicVAD.new({
        baseAssetPath: '/vad/',
        onnxWASMBasePath: '/vad/',
        model: 'v5',
        startOnLoad: false,

        onSpeechStart: () => {
          this.setVadState('speaking');
          this.onSpeechDetected();
        },

        onSpeechRealStart: () => {
          // Real speech confirmed (past minSpeechFrames threshold)
          this.setVadState('speaking');
        },

        onSpeechEnd: () => {
          this.setVadState('trailing');
          this.consecutiveSpeechFrames = 0;
          // After trailing period, go back to listening
          setTimeout(() => {
            if (this._vadState === 'trailing') {
              this.setVadState(
                this._state === 'dozing' || this._state === 'sleeping' ? 'listening' : 'idle'
              );
            }
          }, 500);
        },

        onVADMisfire: () => {
          // Brief sound that wasn't real speech
          this.consecutiveSpeechFrames = 0;
        },
      });
    } catch (err) {
      console.error('[SleepManager] Failed to initialize Silero VAD:', err);
    } finally {
      this.vadInitializing = false;
    }
  }

  start(): void {
    this._state = 'active';
    this.consecutiveSpeechFrames = 0;
    this.ringBuffer.reset();
    this.clearAllTimers();
    this.startSilenceTimer();
    this.setVadState('idle');
  }

  stop(): void {
    this.clearAllTimers();
    this._state = 'active';
    this.consecutiveSpeechFrames = 0;
    this.ringBuffer.reset();
    this.stopVAD();
    this.setVadState('idle');
  }

  destroy(): void {
    this.stop();
    if (this.micVAD) {
      this.micVAD.destroy();
      this.micVAD = null;
    }
  }

  onTranscriptReceived(): void {
    if (this._state === 'active') {
      this.resetSilenceTimer();
    }
  }

  processChunk(samples: Float32Array): void {
    if (this._state === 'dozing' || this._state === 'sleeping') {
      this.ringBuffer.write(samples);
    }
  }

  // --- VAD state management ---

  private setVadState(state: VadState): void {
    if (this._vadState !== state) {
      this._vadState = state;
      this.callbacks.onVadStateChange?.(state);
    }
  }

  private onSpeechDetected(): void {
    if (this._state !== 'dozing' && this._state !== 'sleeping') return;

    this.consecutiveSpeechFrames++;
    if (this.consecutiveSpeechFrames >= VAD_FRAMES_REQUIRED) {
      this.wake();
    }
  }

  // --- State transitions ---

  private enterDozing(): void {
    this._state = 'dozing';
    this.consecutiveSpeechFrames = 0;
    this.ringBuffer.reset();
    this.startVAD();
    this.startDozingTimer();
    this.callbacks.onEnterDozing();
  }

  private enterSleeping(): void {
    this._state = 'sleeping';
    this.consecutiveSpeechFrames = 0;
    // VAD continues from dozing state
    this.callbacks.onEnterSleeping();
  }

  private wake(): void {
    const fromState = this._state;
    this._state = 'active';
    this.consecutiveSpeechFrames = 0;
    this.stopVAD();
    this.clearDozingTimer();
    this.startSilenceTimer();
    this.setVadState('idle');
    this.callbacks.onWake(fromState);
  }

  // --- VAD start/stop ---

  private async startVAD(): Promise<void> {
    this.setVadState('listening');
    try {
      await this.micVAD?.start();
    } catch (err) {
      console.error('[SleepManager] Failed to start VAD:', err);
    }
  }

  private async stopVAD(): Promise<void> {
    try {
      await this.micVAD?.pause();
    } catch (err) {
      console.error('[SleepManager] Failed to pause VAD:', err);
    }
  }

  // --- Silence timer (active state) ---

  private startSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      if (this._state === 'active') {
        this.enterDozing();
      }
    }, SILENCE_TIMEOUT);
  }

  private resetSilenceTimer(): void {
    this.startSilenceTimer();
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  // --- Dozing timer ---

  private startDozingTimer(): void {
    this.clearDozingTimer();
    this.dozingTimer = setTimeout(() => {
      if (this._state === 'dozing') {
        this.enterSleeping();
      }
    }, DOZING_TIMEOUT);
  }

  private clearDozingTimer(): void {
    if (this.dozingTimer !== null) {
      clearTimeout(this.dozingTimer);
      this.dozingTimer = null;
    }
  }

  // --- Cleanup ---

  private clearAllTimers(): void {
    this.clearSilenceTimer();
    this.clearDozingTimer();
  }
}
