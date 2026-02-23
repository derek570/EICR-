import { AudioRingBuffer } from "./audio-ring-buffer";

export type SleepState = "active" | "dozing" | "sleeping";

export interface SleepManagerCallbacks {
  onEnterDozing: () => void;
  onEnterSleeping: () => void;
  onWake: (fromState: SleepState) => void;
}

const SILENCE_TIMEOUT = 60_000; // 60s silence -> dozing
const DOZING_TIMEOUT = 300_000; // 5min dozing -> sleeping
const RMS_THRESHOLD = 0.01;
const FRAMES_REQUIRED = 3; // consecutive high-RMS frames to wake
const VOLUME_CHECK_INTERVAL = 30; // ms

export class SleepManager {
  private _state: SleepState = "active";
  private callbacks: SleepManagerCallbacks;
  private analyser: AnalyserNode | null = null;
  private analyserData: Float32Array<ArrayBuffer> | null = null;

  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private dozingTimer: ReturnType<typeof setTimeout> | null = null;
  private volumeInterval: ReturnType<typeof setInterval> | null = null;
  private consecutiveHighFrames = 0;

  readonly ringBuffer = new AudioRingBuffer();

  get state(): SleepState {
    return this._state;
  }

  constructor(callbacks: SleepManagerCallbacks) {
    this.callbacks = callbacks;
  }

  setAnalyser(analyser: AnalyserNode): void {
    this.analyser = analyser;
    this.analyserData = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
  }

  start(): void {
    this._state = "active";
    this.consecutiveHighFrames = 0;
    this.ringBuffer.reset();
    this.clearAllTimers();
    this.startSilenceTimer();
  }

  stop(): void {
    this.clearAllTimers();
    this._state = "active";
    this.consecutiveHighFrames = 0;
    this.ringBuffer.reset();
  }

  onTranscriptReceived(): void {
    if (this._state === "active") {
      this.resetSilenceTimer();
    }
  }

  processChunk(samples: Float32Array): void {
    if (this._state === "dozing" || this._state === "sleeping") {
      this.ringBuffer.write(samples);
    }
  }

  // --- State transitions ---

  private enterDozing(): void {
    this._state = "dozing";
    this.consecutiveHighFrames = 0;
    this.ringBuffer.reset();
    this.startVolumeMonitoring();
    this.startDozingTimer();
    this.callbacks.onEnterDozing();
  }

  private enterSleeping(): void {
    this._state = "sleeping";
    this.consecutiveHighFrames = 0;
    // Volume monitoring continues from dozing
    this.callbacks.onEnterSleeping();
  }

  private wake(): void {
    const fromState = this._state;
    this._state = "active";
    this.consecutiveHighFrames = 0;
    this.stopVolumeMonitoring();
    this.clearDozingTimer();
    this.startSilenceTimer();
    this.callbacks.onWake(fromState);
  }

  // --- Silence timer (active state) ---

  private startSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      if (this._state === "active") {
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
      if (this._state === "dozing") {
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

  // --- Volume monitoring (dozing/sleeping) ---

  private startVolumeMonitoring(): void {
    this.stopVolumeMonitoring();
    this.volumeInterval = setInterval(() => {
      this.checkVolume();
    }, VOLUME_CHECK_INTERVAL);
  }

  private stopVolumeMonitoring(): void {
    if (this.volumeInterval !== null) {
      clearInterval(this.volumeInterval);
      this.volumeInterval = null;
    }
  }

  private checkVolume(): void {
    if (!this.analyser || !this.analyserData) return;

    this.analyser.getFloatTimeDomainData(this.analyserData);

    let sumSquares = 0;
    for (let i = 0; i < this.analyserData.length; i++) {
      const sample = this.analyserData[i];
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / this.analyserData.length);

    if (rms > RMS_THRESHOLD) {
      this.consecutiveHighFrames++;
      if (this.consecutiveHighFrames >= FRAMES_REQUIRED) {
        this.wake();
      }
    } else {
      this.consecutiveHighFrames = 0;
    }
  }

  // --- Cleanup ---

  private clearAllTimers(): void {
    this.clearSilenceTimer();
    this.clearDozingTimer();
    this.stopVolumeMonitoring();
  }
}
