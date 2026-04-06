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

export interface DeepgramServiceCallbacks {
  onInterimTranscript: (text: string, confidence: number) => void;
  onFinalTranscript: (text: string, confidence: number, words: DeepgramWord[]) => void;
  onUtteranceEnd: () => void;
  onError: (error: Error) => void;
  onConnectionStateChange: (state: DeepgramConnectionState) => void;
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

  connect(apiKey: string, keywords: Array<{ keyword: string; boost: number }> = []): void {
    // Cancel any pending reconnect
    this.clearReconnectTimer();

    // Close existing connection
    this.disconnectImmediate();

    this.currentApiKey = apiKey;
    this.currentKeywords = keywords;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;

    this.setConnectionState('connecting');
    this.log('CONNECTING', `keywords=${keywords.length}`);

    const url = this.buildURL(keywords);
    if (!url) {
      this.setConnectionState('disconnected');
      this.callbacks.onError(new Error('Invalid Deepgram WebSocket URL'));
      return;
    }

    // Use subprotocol auth — Deepgram no longer accepts the token= query parameter.
    // The subprotocol approach sends the key in the Sec-WebSocket-Protocol header.
    const ws = new WebSocket(url, ['token', apiKey]);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.log('WS_OPEN', '');
      this.setConnectionState('connected');
      this.reconnectAttempt = 0;
    };

    ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    ws.onclose = (event: CloseEvent) => {
      this.log('WS_CLOSE', `code=${event.code}, reason=${event.reason || 'none'}`);
      this.ws = null;

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

    this.log('DISCONNECTING', 'sending CloseStream');

    // Send CloseStream text frame
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
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
      this.setConnectionState('disconnected');
    }, 500);
  }

  private disconnectImmediate(): void {
    // Clear pending disconnect delay
    if (this.disconnectTimerId !== null) {
      clearTimeout(this.disconnectTimerId);
      this.disconnectTimerId = null;
    }

    this.isStreamingPaused = false;
    this.stopKeepAliveWhilePaused();

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

  sendSamples(samples: Float32Array): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    if (this.isStreamingPaused) return;

    // Convert Float32 -> Int16 PCM
    const int16 = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      int16[i] = Math.round(clamped * 32767);
    }

    this.lastAudioSendTime = performance.now();

    try {
      this.ws.send(int16.buffer);
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

  replayBuffer(data: ArrayBuffer): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    if (data.byteLength === 0) return;

    this.log('BUFFER_REPLAY', `sending ${data.byteLength} bytes of buffered audio`);
    try {
      this.ws.send(data);
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
      this.log('RECONNECTING', `attempt=${this.reconnectAttempt}`);
      this.connect(this.currentApiKey, this.currentKeywords);
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
    params.set('utterance_end_ms', '1300');

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
    this.clearReconnectTimer();
    this.stopKeepAliveWhilePaused();

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
