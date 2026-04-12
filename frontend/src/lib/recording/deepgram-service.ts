// deepgram-service.ts
// Port of iOS DeepgramService.swift — direct browser WebSocket to Deepgram Nova-3.

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

export interface DeepgramConnectOptions {
  /** Backend WS proxy URL for fallback (e.g., ws://host/api/recording/stream) */
  proxyUrl?: string;
  /** JWT auth token for proxy fallback */
  authToken?: string;
}

export interface DeepgramServiceCallbacks {
  onInterimTranscript: (text: string, confidence: number) => void;
  onFinalTranscript: (text: string, confidence: number, words: DeepgramWord[]) => void;
  onUtteranceEnd: () => void;
  onError: (error: Error) => void;
  onConnectionStateChange: (state: DeepgramConnectionState) => void;
  onProxyExtraction?: (data: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// DeepgramService
// ---------------------------------------------------------------------------

export class DeepgramService {
  private callbacks: DeepgramServiceCallbacks;
  private ws: WebSocket | null = null;

  // Connection state
  private _connectionState: DeepgramConnectionState = 'disconnected';
  private isStreamingPaused = false;
  private keepAliveIntervalId: ReturnType<typeof setInterval> | null = null;
  private activeKeepAliveId: ReturnType<typeof setInterval> | null = null;

  // Sample rate for resampling (mobile browsers often ignore AudioContext({sampleRate:16000}))
  private actualSampleRate = 16000;

  // Reconnection
  private shouldReconnect = false;
  private reconnectAttempt = 0;
  private readonly maxReconnectDelay = 30;
  private reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
  private currentApiKey: string | null = null;
  private currentKeywords: Array<{ keyword: string; boost: number }> = [];

  // Latency tracking
  private lastAudioSendTime: number | null = null;

  // Disconnect delay
  private disconnectTimerId: ReturnType<typeof setTimeout> | null = null;

  // Proxy fallback
  private _useProxy = false;
  private _proxyUrl: string | null = null;
  private _authToken: string | null = null;
  private _proxyReady = false;
  private _proxyReadyTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private _triedDirectFirst = false;

  constructor(callbacks: DeepgramServiceCallbacks) {
    this.callbacks = callbacks;
  }

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  get connectionState(): DeepgramConnectionState {
    return this._connectionState;
  }

  // ---------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------

  connect(
    apiKey: string,
    keywords: Array<{ keyword: string; boost: number }> = [],
    sampleRate = 16000,
    options?: DeepgramConnectOptions
  ): void {
    this.actualSampleRate = sampleRate;
    this.log('SAMPLE_RATE', `AudioContext rate=${sampleRate}Hz`);
    // Cancel any pending reconnect
    this.clearReconnectTimer();

    // Close existing connection
    this.disconnectImmediate();

    this.currentApiKey = apiKey;
    this.currentKeywords = keywords;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;

    // Store proxy info for fallback
    if (options?.proxyUrl) this._proxyUrl = options.proxyUrl;
    if (options?.authToken) this._authToken = options.authToken;

    // If already in proxy mode, connect via proxy
    if (this._useProxy) {
      this.connectProxy();
      return;
    }

    this._triedDirectFirst = true;
    this.setConnectionState('connecting');
    this.log('CONNECTING', `keywords=${keywords.length}, mode=direct`);

    const url = this.buildURL(keywords);
    if (!url) {
      this.setConnectionState('disconnected');
      this.callbacks.onError(new Error('Invalid Deepgram WebSocket URL'));
      return;
    }

    // Use subprotocol auth — sends the token in the Sec-WebSocket-Protocol header.
    const ws = new WebSocket(url, ['token', apiKey]);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.log('WS_OPEN', 'direct connection');
      this.setConnectionState('connected');
      this.reconnectAttempt = 0;
      this.startActiveKeepAlive();
    };

    ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    ws.onclose = (event: CloseEvent) => {
      this.log('WS_CLOSE', `code=${event.code}, reason=${event.reason || 'none'}`);
      this.ws = null;

      // Auth failure on first attempt — fall back to server-side proxy
      if (
        this._triedDirectFirst &&
        !this._useProxy &&
        this._proxyUrl &&
        this._authToken &&
        this.reconnectAttempt === 0 &&
        (event.code === 1008 || event.code === 1006)
      ) {
        console.warn(
          '[DeepgramService] Direct Deepgram connection failed (code=' +
            event.code +
            '), falling back to server-side proxy'
        );
        this._useProxy = true;
        this.connectProxy();
        return;
      }

      if (this.shouldReconnect && event.code !== 1000) {
        this.scheduleReconnect();
      } else {
        this.setConnectionState('disconnected');
      }
    };

    ws.onerror = () => {
      this.log('WS_ERROR', 'WebSocket error');
      // onclose will fire after onerror, so reconnection is handled there.
      // Only notify if we're not going to reconnect.
      if (!this.shouldReconnect) {
        this.callbacks.onError(new Error('Deepgram WebSocket error'));
      }
    };

    this.ws = ws;
  }

  // ---------------------------------------------------------------------------
  // Proxy Fallback — connect through server-side WS proxy
  // The server holds the Deepgram key; audio is forwarded server-side.
  // ---------------------------------------------------------------------------

  private connectProxy(): void {
    if (!this._proxyUrl || !this._authToken) {
      this.log('PROXY_FAIL', 'No proxy URL or auth token');
      this.setConnectionState('disconnected');
      return;
    }

    this._proxyReady = false;
    this.clearProxyReadyTimeout();
    this.setConnectionState('connecting');
    this.log('CONNECTING', 'mode=proxy (server-side)');

    // Safety timeout: if the backend never sends {type:'ready'} (e.g. its Deepgram
    // connection fails or is slow) _proxyReady would stay false forever, silently
    // dropping all audio. After 8s, mark ready anyway so audio can flow.
    this._proxyReadyTimeoutId = setTimeout(() => {
      this._proxyReadyTimeoutId = null;
      if (!this._proxyReady && this._connectionState === 'connecting') {
        console.warn(
          '[DeepgramService] Proxy ready timeout — no {type:ready} in 8s; unblocking audio'
        );
        this._proxyReady = true;
        this.setConnectionState('connected');
      }
    }, 8000);

    // Browser WebSockets can't set headers; pass JWT as query param
    const wsUrl = `${this._proxyUrl}?token=${encodeURIComponent(this._authToken)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.log('PROXY_WS_OPEN', '');
      // Send start message to initiate server-side Deepgram connection
      ws.send(
        JSON.stringify({
          type: 'start',
          sessionId: `proxy_${Date.now()}`,
        })
      );
    };

    ws.onmessage = (event: MessageEvent) => {
      this.handleProxyMessage(event.data);
    };

    ws.onclose = (event: CloseEvent) => {
      this.log('PROXY_WS_CLOSE', `code=${event.code}, reason=${event.reason || 'none'}`);
      this.ws = null;
      this._proxyReady = false;
      this.clearProxyReadyTimeout();

      if (this.shouldReconnect && event.code !== 1000) {
        this.scheduleReconnect();
      } else {
        this.setConnectionState('disconnected');
      }
    };

    ws.onerror = () => {
      this.log('PROXY_WS_ERROR', 'Proxy WebSocket error');
      if (!this.shouldReconnect) {
        this.callbacks.onError(new Error('Proxy WebSocket error'));
      }
    };

    this.ws = ws;
  }

  private handleProxyMessage(data: unknown): void {
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
        this.log('PROXY_READY', 'Server-side Deepgram connected');
        this.clearProxyReadyTimeout();
        this._proxyReady = true;
        this.setConnectionState('connected');
        this.reconnectAttempt = 0;
        break;

      case 'transcript': {
        const text = (json.text as string) ?? '';
        if (!text) return;
        this.log('PROXY_FINAL', `"${text.slice(0, 80)}"`);
        this.callbacks.onFinalTranscript(text, 1.0, []);
        break;
      }

      case 'transcript_partial': {
        const text = (json.text as string) ?? '';
        if (!text) return;
        this.callbacks.onInterimTranscript(text, 0.5);
        break;
      }

      case 'extraction': {
        this.log(
          'PROXY_EXTRACTION',
          `circuits=${(json.data as Record<string, unknown>)?.circuits ? ((json.data as Record<string, unknown>).circuits as unknown[]).length : 0}`
        );
        this.callbacks.onProxyExtraction?.(json.data as Record<string, unknown>);
        break;
      }

      case 'error': {
        const msg = (json.message as string) ?? 'Proxy error';
        this.log('PROXY_ERROR', msg);
        this.callbacks.onError(new Error(msg));
        break;
      }

      default:
        this.log('PROXY_MSG', `type=${type}`);
    }
  }

  private static arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
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

    this.log('DISCONNECTING', this._useProxy ? 'sending stop' : 'sending CloseStream');

    // Send close message
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        if (this._useProxy) {
          this.ws.send(JSON.stringify({ type: 'stop' }));
        } else {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
      }
    } catch {
      // Ignore send errors during disconnect
    }

    // Close after brief delay to let CloseStream propagate
    const ws = this.ws;
    this.disconnectTimerId = setTimeout(() => {
      this.disconnectTimerId = null;
      // Null out handlers before closing to prevent stale callbacks
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
    // Clear pending disconnect delay
    if (this.disconnectTimerId !== null) {
      clearTimeout(this.disconnectTimerId);
      this.disconnectTimerId = null;
    }

    this.clearProxyReadyTimeout();
    this.isStreamingPaused = false;
    this.stopKeepAliveWhilePaused();
    this.stopActiveKeepAlive();

    if (this.ws) {
      // Null out handlers before closing
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
  // Send Audio
  // ---------------------------------------------------------------------------

  // Resample Float32 audio from any sample rate to 16kHz using linear interpolation.
  // Needed because mobile browsers often ignore AudioContext({sampleRate:16000}) and
  // deliver audio at 44100Hz or 48000Hz. Sending wrong-rate audio to Deepgram (which
  // has sample_rate=16000 in the URL) produces garbled/empty transcripts.
  private resampleTo16k(samples: Float32Array): Float32Array {
    if (this.actualSampleRate === 16000) return samples;
    const ratio = this.actualSampleRate / 16000;
    const outputLength = Math.floor(samples.length / ratio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const srcIdx = i * ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, samples.length - 1);
      const frac = srcIdx - lo;
      output[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
    }
    return output;
  }

  sendSamples(samples: Float32Array): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    if (this.isStreamingPaused) return;
    if (this._useProxy && !this._proxyReady) return;

    // Resample to 16kHz if mobile AudioContext gave a different rate
    const resampled = this.resampleTo16k(samples);

    // Convert Float32 -> Int16 PCM
    const int16 = new Int16Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) {
      const clamped = Math.max(-1, Math.min(1, resampled[i]));
      int16[i] = Math.round(clamped * 32767);
    }

    this.lastAudioSendTime = performance.now();

    try {
      if (this._useProxy) {
        // Proxy mode: send base64-encoded audio in JSON
        const base64 = DeepgramService.arrayBufferToBase64(int16.buffer);
        this.ws.send(JSON.stringify({ type: 'audio', data: base64 }));
      } else {
        // Direct mode: send raw binary
        this.ws.send(int16.buffer);
      }
    } catch {
      this.log('AUDIO_SEND_ERROR', 'Failed to send audio data');
    }
  }

  // ---------------------------------------------------------------------------
  // Keep-Alive
  // ---------------------------------------------------------------------------

  sendKeepAlive(): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    // Proxy mode doesn't need client-side keep-alive (server handles it)
    if (this._useProxy) return;

    try {
      this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
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

  replayBuffer(samples: Float32Array): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    if (samples.length === 0) return;

    this.log(
      'BUFFER_REPLAY',
      `replaying ${samples.length} samples through sendSamples (resampling applied)`
    );
    this.sendSamples(samples);
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

  // Active keepAlive — sends both KeepAlive JSON and 500ms of silent PCM every 10s
  // when no audio has been sent recently. Mirrors iOS DeepgramService behaviour:
  // "KeepAlive JSON alone is unreliable (~20s timeout observed). Binary audio data
  // uses Deepgram's audio liveness path which is more reliable."
  private startActiveKeepAlive(): void {
    this.stopActiveKeepAlive();
    this.activeKeepAliveId = setInterval(() => {
      if (this._connectionState !== 'connected' || !this.ws) {
        this.stopActiveKeepAlive();
        return;
      }
      // Only fire if no audio sent in last 8s (avoids redundant sends during speech)
      const timeSinceAudio = this.lastAudioSendTime
        ? performance.now() - this.lastAudioSendTime
        : Infinity;
      if (timeSinceAudio < 8000) return;

      // 1. Send JSON KeepAlive
      try {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      } catch {
        /* ignore */
      }

      // 2. Send 500ms of silent PCM (8000 samples at 16kHz = 16000 bytes as Int16)
      // Deepgram's audio liveness path is more reliable than JSON-only keepalive.
      const silentPCM = new Int16Array(8000); // 500ms at 16kHz
      try {
        this.ws.send(silentPCM.buffer);
      } catch {
        /* ignore */
      }

      this.log(
        'ACTIVE_KEEPALIVE',
        `sent KeepAlive+silence (${Math.round(timeSinceAudio / 1000)}s idle)`
      );
    }, 10000);
  }

  private stopActiveKeepAlive(): void {
    if (this.activeKeepAliveId !== null) {
      clearInterval(this.activeKeepAliveId);
      this.activeKeepAliveId = null;
    }
  }

  private clearProxyReadyTimeout(): void {
    if (this._proxyReadyTimeoutId !== null) {
      clearTimeout(this._proxyReadyTimeoutId);
      this._proxyReadyTimeoutId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Message Handling
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
      case 'Results':
        this.handleResults(json);
        break;

      case 'UtteranceEnd':
        this.log('UTTERANCE_END', '');
        this.callbacks.onUtteranceEnd();
        break;

      case 'Metadata':
        if (json.request_id) {
          this.log('METADATA', `request_id=${json.request_id}`);
        }
        break;

      case 'Error': {
        const errorMsg = (json.message as string | undefined) ?? 'Unknown Deepgram error';
        this.log('DEEPGRAM_ERROR', errorMsg);
        this.callbacks.onError(new Error(errorMsg));
        break;
      }

      default:
        this.log('UNKNOWN_MSG_TYPE', type);
    }
  }

  private handleResults(json: Record<string, unknown>): void {
    const channel = json.channel as Record<string, unknown> | undefined;
    if (!channel) return;

    const alternatives = channel.alternatives as Array<Record<string, unknown>> | undefined;
    if (!alternatives || alternatives.length === 0) return;

    const first = alternatives[0];
    const transcript = (first.transcript as string | undefined) ?? '';
    const confidence = (first.confidence as number | undefined) ?? 0;
    const isFinal = (json.is_final as boolean | undefined) ?? false;

    // Skip empty transcripts
    if (!transcript) return;

    // Parse words
    const words: DeepgramWord[] = [];
    const rawWords = first.words as Array<Record<string, unknown>> | undefined;
    if (rawWords) {
      for (const w of rawWords) {
        if (
          typeof w.word === 'string' &&
          typeof w.start === 'number' &&
          typeof w.end === 'number' &&
          typeof w.confidence === 'number'
        ) {
          words.push({
            word: w.word,
            start: w.start,
            end: w.end,
            confidence: w.confidence,
            punctuated_word: w.punctuated_word as string | undefined,
          });
        }
      }
    }

    if (isFinal) {
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
    } else {
      this.callbacks.onInterimTranscript(transcript, confidence);
    }
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
      if (!this.shouldReconnect || !this.currentApiKey) return;
      this.log('RECONNECTING', `attempt=${this.reconnectAttempt}, proxy=${this._useProxy}`);
      if (this._useProxy) {
        this.connectProxy();
      } else {
        this.connect(this.currentApiKey, this.currentKeywords);
      }
    }, delay * 1000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimerId !== null) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // URL Builder
  // ---------------------------------------------------------------------------

  private buildURL(keywords: Array<{ keyword: string; boost: number }>): string | null {
    const params = new URLSearchParams();
    params.set('model', 'nova-3');
    params.set('smart_format', 'true');
    params.set('punctuate', 'true');
    params.set('numerals', 'true');
    params.set('encoding', 'linear16');
    params.set('sample_rate', '16000');
    params.set('channels', '1');
    params.set('language', 'en-GB');
    params.set('interim_results', 'true');
    params.set('endpointing', '300');
    params.set('utterance_end_ms', '2000'); // Match iOS (was 1300 — caused premature endings)
    params.set('vad_events', 'true'); // Receive SpeechStarted events (matches iOS)

    // Add keyterm params (Nova-3 uses "keyterm")
    for (const { keyword, boost } of keywords) {
      if (boost <= 0) continue;
      const value = boost !== 1.0 ? `${keyword}:${boost.toFixed(1)}` : keyword;
      params.append('keyterm', value);
    }

    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
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
    this._useProxy = false;
    this._proxyReady = false;
    this.clearReconnectTimer();
    this.clearProxyReadyTimeout();
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
