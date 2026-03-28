// deepgram-service.ts
// Routes audio through the backend WS proxy at /api/recording/stream.
// The proxy connects to Deepgram using the master API key + Authorization header
// (the only auth method Deepgram currently accepts for WS streaming).
// Browser WebSocket API cannot set custom headers, and Deepgram no longer
// accepts subprotocol auth or temp keys — so proxying is the only option.

import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  punctuated_word?: string;
}

export type DeepgramConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface DeepgramServiceCallbacks {
  onInterimTranscript: (text: string, confidence: number) => void;
  onFinalTranscript: (text: string, confidence: number, words: DeepgramWord[]) => void;
  onUtteranceEnd: () => void;
  onError: (error: Error) => void;
  onConnectionStateChange: (state: DeepgramConnectionState) => void;
  /** Optional: called when the proxy sends extraction results (Gemini) */
  onExtraction?: (data: Record<string, unknown>) => void;
  /** Not used with proxy — kept for API compat */
  onRefreshKey?: () => Promise<string>;
}

// ---------------------------------------------------------------------------
// DeepgramService — backend proxy client
// ---------------------------------------------------------------------------

export class DeepgramService {
  private callbacks: DeepgramServiceCallbacks;
  private ws: WebSocket | null = null;

  // Connection state
  private _connectionState: DeepgramConnectionState = 'disconnected';
  private isStreamingPaused = false;
  private keepAliveIntervalId: ReturnType<typeof setInterval> | null = null;
  private activeKeepAliveIntervalId: ReturnType<typeof setInterval> | null = null;

  // Reconnection
  private shouldReconnect = false;
  private reconnectAttempt = 0;
  private readonly maxReconnectDelay = 30;
  private reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
  private lastCloseCode: number | null = null;

  // Connection params (for reconnect)
  private currentProxyUrl: string | null = null;
  private currentAuthToken: string | null = null;
  private currentSessionId: string | null = null;
  private currentJobId: string | null = null;
  private currentContext: string = '';

  // Latency tracking
  private lastAudioSendTime: number | null = null;

  // Diagnostic: log first audio samples once per connection
  private _hasLoggedFirstSamples = false;

  // Disconnect delay
  private disconnectTimerId: ReturnType<typeof setTimeout> | null = null;

  // Sample rate: the actual AudioContext sample rate (may differ from 16000 on mobile)
  private _actualSampleRate = 16000;

  constructor(callbacks: DeepgramServiceCallbacks) {
    this.callbacks = callbacks;
  }

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  get connectionState(): DeepgramConnectionState {
    return this._connectionState;
  }

  /**
   * Set the actual AudioContext sample rate.
   * If it differs from 16000, sendSamples() will resample before sending.
   */
  setActualSampleRate(rate: number): void {
    this._actualSampleRate = rate;
    if (rate !== 16000) {
      this.log(
        'SAMPLE_RATE_MISMATCH',
        `AudioContext=${rate}Hz, Deepgram expects 16000Hz — will resample`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Connect — routes through backend proxy
  // ---------------------------------------------------------------------------

  /**
   * Connect to the backend WS recording proxy.
   * @param proxyUrl  Full WS URL, e.g. wss://api.certomatic3000.co.uk/api/recording/stream
   * @param authToken JWT auth token (will be sent as ?token= query param)
   * @param sessionId Recording session ID
   * @param jobId     Job ID for this recording
   * @param context   Optional initial context for Gemini extraction
   */
  connect(
    proxyUrl: string,
    authToken: string,
    sessionId: string,
    jobId: string,
    context: string = ''
  ): void {
    // Cancel any pending reconnect
    this.clearReconnectTimer();

    // Close existing connection
    this.disconnectImmediate();

    this.currentProxyUrl = proxyUrl;
    this.currentAuthToken = authToken;
    this.currentSessionId = sessionId;
    this.currentJobId = jobId;
    this.currentContext = context;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;

    this.setConnectionState('connecting');
    this.log('CONNECTING', `proxy=${proxyUrl}, session=${sessionId}`);

    // Append auth token as query param (browser WebSocket cannot set headers)
    const separator = proxyUrl.includes('?') ? '&' : '?';
    const url = `${proxyUrl}${separator}token=${encodeURIComponent(authToken)}`;

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.warn(`[DeepgramService DIAG] WS_OPEN proxy readyState=${ws.readyState}`);
      this.log('WS_OPEN', `readyState=${ws.readyState}`);

      // Send start message to initiate the Deepgram connection on the backend
      try {
        ws.send(
          JSON.stringify({
            type: 'start',
            sessionId: this.currentSessionId,
            jobId: this.currentJobId,
            context: this.currentContext,
          })
        );
      } catch {
        this.log('START_SEND_ERROR', 'Failed to send start message');
      }

      // Don't set 'connected' yet — wait for 'ready' from the proxy
    };

    ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    ws.onclose = (event: CloseEvent) => {
      const isAbnormal = event.code !== 1000 && event.code !== 1001;
      const msg = `code=${event.code}, reason=${event.reason || 'none'}, wasClean=${event.wasClean}`;
      this.lastCloseCode = event.code;
      this.stopActiveKeepAlive();

      console.warn(
        `[DeepgramService DIAG] WS_CLOSE: ${msg}, shouldReconnect=${this.shouldReconnect}`
      );

      if (isAbnormal) {
        console.error(`[DeepgramService] WS_CLOSE (abnormal): ${msg}`);
        toast.error('Transcription disconnected — reconnecting...');
      }
      this.log('WS_CLOSE', msg);
      this.ws = null;

      if (this.shouldReconnect && event.code !== 1000) {
        this.scheduleReconnect();
      } else {
        this.setConnectionState('disconnected');
      }
    };

    ws.onerror = () => {
      console.warn(`[DeepgramService DIAG] WS_ERROR: readyState=${ws.readyState}`);
      console.error('[DeepgramService] WS_ERROR: WebSocket error event fired', {
        readyState: ws.readyState,
      });
      this.log('WS_ERROR', `readyState=${ws.readyState}`);
      if (!this.shouldReconnect) {
        this.callbacks.onError(new Error('Recording proxy WebSocket error'));
      }
    };

    this.ws = ws;
  }

  // ---------------------------------------------------------------------------
  // Disconnect
  // ---------------------------------------------------------------------------

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.disconnectClean();
  }

  private disconnectClean(): void {
    if (!this.ws) {
      this.setConnectionState('disconnected');
      return;
    }

    this.log('DISCONNECTING', 'sending stop');

    // Send stop message to the proxy
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'stop' }));
      }
    } catch {
      // Ignore send errors during disconnect
    }

    // Close after brief delay to let stop propagate
    const ws = this.ws;
    this.disconnectTimerId = setTimeout(() => {
      this.disconnectTimerId = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close(1000);
        } catch {
          // Ignore
        }
      }
      if (this.ws === ws) {
        this.ws = null;
      }
      this.isStreamingPaused = false;
      this.stopKeepAliveWhilePaused();
      this.stopActiveKeepAlive();
      this.setConnectionState('disconnected');
    }, 500);
  }

  private disconnectImmediate(): void {
    if (this.disconnectTimerId !== null) {
      clearTimeout(this.disconnectTimerId);
      this.disconnectTimerId = null;
    }

    this.isStreamingPaused = false;
    this.stopKeepAliveWhilePaused();
    this.stopActiveKeepAlive();

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close(1000);
      } catch {
        // Ignore
      }
      this.ws = null;
    }

    this.setConnectionState('disconnected');
  }

  // ---------------------------------------------------------------------------
  // Send Audio — converts to base64 and sends as JSON
  // ---------------------------------------------------------------------------

  sendSamples(samples: Float32Array): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    if (this.isStreamingPaused) return;

    // Resample if AudioContext rate differs from Deepgram's expected 16kHz
    let pcmFloat = samples;
    if (this._actualSampleRate !== 16000) {
      pcmFloat = this.resampleFloat32(samples, this._actualSampleRate, 16000);
    }

    // Convert Float32 -> Int16 PCM
    const int16 = new Int16Array(pcmFloat.length);
    for (let i = 0; i < pcmFloat.length; i++) {
      const clamped = Math.max(-1, Math.min(1, pcmFloat[i]));
      int16[i] = Math.round(clamped * 32767);
    }

    // DIAG: log first audio chunk details at warn level for production visibility
    if (!this._hasLoggedFirstSamples) {
      this._hasLoggedFirstSamples = true;
      const preview = Array.from(int16.slice(0, 5));
      const nonZero = int16.some((v) => v !== 0);
      console.warn(
        `[DeepgramService DIAG] FIRST_AUDIO: chunkSize=${int16.length}, sampleRate=${this._actualSampleRate}, nonZero=${nonZero}, first5=${JSON.stringify(preview)}`
      );
    }

    this.lastAudioSendTime = performance.now();

    // Convert Int16 PCM buffer to base64 for the JSON proxy protocol
    try {
      const uint8 = new Uint8Array(int16.buffer);
      let binary = '';
      for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i]);
      }
      const base64 = btoa(binary);
      this.ws.send(JSON.stringify({ type: 'audio', data: base64 }));
    } catch {
      this.log('AUDIO_SEND_ERROR', 'Failed to send audio data');
    }
  }

  // ---------------------------------------------------------------------------
  // Keep-Alive
  // ---------------------------------------------------------------------------

  sendKeepAlive(): void {
    if (!this.ws || this._connectionState !== 'connected') return;

    try {
      this.ws.send(JSON.stringify({ type: 'keepalive' }));
    } catch {
      this.log('KEEPALIVE_ERROR', 'Failed to send keep-alive');
    }
  }

  // ---------------------------------------------------------------------------
  // Pause / Resume / Replay
  // ---------------------------------------------------------------------------

  pauseAudioStream(): void {
    if (this._connectionState !== 'connected') return;

    this.isStreamingPaused = true;
    this.log('STREAM_PAUSED', 'switching to KeepAlive-only mode');
    this.startKeepAliveWhilePaused();
  }

  resumeAudioStream(): void {
    this.isStreamingPaused = false;
    this.stopKeepAliveWhilePaused();
    this.log('STREAM_RESUMED', 'audio streaming resumed');
  }

  replayBuffer(data: ArrayBuffer): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    if (data.byteLength === 0) return;

    this.log('BUFFER_REPLAY', `sending ${data.byteLength} bytes of buffered audio`);

    // Convert raw buffer to base64 for the proxy protocol
    try {
      const uint8 = new Uint8Array(data);
      let binary = '';
      for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i]);
      }
      const base64 = btoa(binary);
      this.ws.send(JSON.stringify({ type: 'audio', data: base64 }));
    } catch {
      this.log('BUFFER_REPLAY_ERROR', 'Failed to replay buffer');
    }
  }

  private startKeepAliveWhilePaused(): void {
    this.stopKeepAliveWhilePaused();
    this.keepAliveIntervalId = setInterval(() => {
      if (!this.isStreamingPaused || this._connectionState !== 'connected') {
        this.stopKeepAliveWhilePaused();
        return;
      }
      this.sendKeepAlive();
    }, 5000);
  }

  private stopKeepAliveWhilePaused(): void {
    if (this.keepAliveIntervalId !== null) {
      clearInterval(this.keepAliveIntervalId);
      this.keepAliveIntervalId = null;
    }
  }

  /**
   * Safety-net keepAlive every 5s while connected.
   * The backend proxy forwards to Deepgram which closes after 10s of no data.
   */
  private startActiveKeepAlive(): void {
    this.stopActiveKeepAlive();
    this.activeKeepAliveIntervalId = setInterval(() => {
      if (this._connectionState !== 'connected') {
        this.stopActiveKeepAlive();
        return;
      }
      this.sendKeepAlive();
    }, 5_000);
  }

  private stopActiveKeepAlive(): void {
    if (this.activeKeepAliveIntervalId !== null) {
      clearInterval(this.activeKeepAliveIntervalId);
      this.activeKeepAliveIntervalId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Context update — forward to proxy for Gemini extraction
  // ---------------------------------------------------------------------------

  sendContextUpdate(context: string): void {
    this.currentContext = context;
    if (!this.ws || this._connectionState !== 'connected') return;
    try {
      this.ws.send(JSON.stringify({ type: 'context_update', context }));
    } catch {
      this.log('CONTEXT_UPDATE_ERROR', 'Failed to send context update');
    }
  }

  // ---------------------------------------------------------------------------
  // Message Handling — maps proxy responses to existing callbacks
  // ---------------------------------------------------------------------------

  private handleMessage(data: unknown): void {
    let json: Record<string, unknown>;
    try {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = json.type as string | undefined;
    if (!type) return;

    switch (type) {
      case 'ready':
        // Backend proxy has connected to Deepgram — we're fully connected
        this.log('PROXY_READY', 'backend connected to Deepgram');
        this.setConnectionState('connected');
        this.reconnectAttempt = 0;
        this._hasLoggedFirstSamples = false;
        this.startActiveKeepAlive();
        break;

      case 'transcript':
        // Final transcript from proxy
        this.handleFinalTranscript(json);
        break;

      case 'transcript_partial':
        // Interim transcript from proxy
        this.handleInterimTranscript(json);
        break;

      case 'extraction':
        // Gemini extraction result from proxy
        if (this.callbacks.onExtraction && json.data) {
          this.callbacks.onExtraction(json.data as Record<string, unknown>);
        }
        break;

      case 'error': {
        const errorMsg = (json.message as string | undefined) ?? 'Unknown proxy error';
        this.log('PROXY_ERROR', errorMsg);
        this.callbacks.onError(new Error(errorMsg));
        break;
      }

      case 'deepgram_closed': {
        const closeCode = json.code as number | undefined;
        const closeReason = (json.reason as string) ?? 'unknown';
        this.log('DEEPGRAM_CLOSED', `code=${closeCode}, reason=${closeReason}`);
        console.warn(`[DeepgramService] Deepgram disconnected (code=${closeCode}): ${closeReason}`);
        this.setConnectionState('reconnecting');
        break;
      }

      case 'deepgram_reconnected':
        this.log('DEEPGRAM_RECONNECTED', 'backend re-established Deepgram connection');
        console.warn('[DeepgramService] Deepgram reconnected');
        this.setConnectionState('connected');
        break;

      case 'warning': {
        const warnMsg = (json.message as string) ?? 'Unknown warning';
        this.log('PROXY_WARNING', warnMsg);
        break;
      }

      case 'stopped':
        this.log('PROXY_STOPPED', 'session ended');
        break;

      default:
        this.log('UNKNOWN_MSG_TYPE', type);
    }
  }

  private handleFinalTranscript(json: Record<string, unknown>): void {
    const transcript = (json.text as string | undefined) ?? '';
    if (!transcript) return;

    // Proxy doesn't send per-word data — pass empty words array
    const confidence = 1.0;
    const words: DeepgramWord[] = [];

    let latencyStr = '';
    if (this.lastAudioSendTime !== null) {
      const latencyMs = Math.round(performance.now() - this.lastAudioSendTime);
      latencyStr = `, latency=${latencyMs}ms`;
    }
    this.log(
      'FINAL_TRANSCRIPT',
      `conf=${confidence.toFixed(3)}${latencyStr}, text="${transcript.slice(0, 80)}"`
    );
    this.callbacks.onFinalTranscript(transcript, confidence, words);
  }

  private handleInterimTranscript(json: Record<string, unknown>): void {
    const transcript = (json.text as string | undefined) ?? '';
    if (!transcript) return;
    this.callbacks.onInterimTranscript(transcript, 1.0);
  }

  // ---------------------------------------------------------------------------
  // Auto-Reconnect
  // ---------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    this.setConnectionState('reconnecting');
    this.reconnectAttempt += 1;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
    const delay = Math.min(Math.pow(2, this.reconnectAttempt - 1), this.maxReconnectDelay);
    this.log('RECONNECT_SCHEDULED', `attempt=${this.reconnectAttempt}, delay=${delay}s`);

    this.reconnectTimerId = setTimeout(() => {
      this.reconnectTimerId = null;
      if (!this.shouldReconnect) return;
      if (!this.currentProxyUrl || !this.currentAuthToken) return;

      this.log('RECONNECTING', `attempt=${this.reconnectAttempt}`);
      this.connect(
        this.currentProxyUrl,
        this.currentAuthToken,
        this.currentSessionId ?? '',
        this.currentJobId ?? '',
        this.currentContext
      );
    }, delay * 1000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimerId !== null) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Wait for connection (used by wake-from-sleep replay)
  // ---------------------------------------------------------------------------

  waitForConnection(timeoutMs = 5000): Promise<void> {
    if (this._connectionState === 'connected') return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const originalCallback = this.callbacks.onConnectionStateChange;
      let timerId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        this.callbacks.onConnectionStateChange = originalCallback;
        if (timerId) {
          clearTimeout(timerId);
          timerId = null;
        }
      };

      this.callbacks.onConnectionStateChange = (state) => {
        originalCallback(state);
        if (state === 'connected') {
          cleanup();
          resolve();
        } else if (state === 'disconnected') {
          cleanup();
          reject(new Error('Recording proxy disconnected before connecting'));
        }
      };

      timerId = setTimeout(() => {
        timerId = null;
        cleanup();
        if (this._connectionState !== 'connected') {
          reject(new Error(`Recording proxy connection timed out after ${timeoutMs}ms`));
        } else {
          resolve();
        }
      }, timeoutMs);
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private setConnectionState(state: DeepgramConnectionState): void {
    if (this._connectionState === state) return;
    this.log('CONNECTION_STATE', `${this._connectionState} -> ${state}`);
    this._connectionState = state;
    this.callbacks.onConnectionStateChange(state);
  }

  /**
   * Linear-interpolation resample for Float32 audio.
   */
  private resampleFloat32(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
    const ratio = fromRate / toRate;
    const newLength = Math.round(samples.length / ratio);
    const result = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const low = Math.floor(srcIndex);
      const high = Math.min(low + 1, samples.length - 1);
      const frac = srcIndex - low;
      result[i] = samples[low] * (1 - frac) + samples[high] * frac;
    }

    return result;
  }

  private log(event: string, detail: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    if (detail) {
      console.log(`[DeepgramService ${ts}] ${event}: ${detail}`);
    } else {
      console.log(`[DeepgramService ${ts}] ${event}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  destroy(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.stopKeepAliveWhilePaused();
    this.stopActiveKeepAlive();

    if (this.disconnectTimerId !== null) {
      clearTimeout(this.disconnectTimerId);
      this.disconnectTimerId = null;
    }

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close(1000);
      } catch {
        // Ignore
      }
      this.ws = null;
    }

    this.setConnectionState('disconnected');
  }
}
