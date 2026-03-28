/**
 * DeepgramService — ported from CertMateUnified/Sources/Services/DeepgramService.swift
 *
 * Direct WebSocket connection to Deepgram Nova-3 for real-time transcription.
 * Accepts Int16 PCM audio data and streams via binary WebSocket messages.
 * Auto-reconnect with exponential backoff.
 */

// ============= Types =============

export interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  punctuated_word?: string;
}

export type DeepgramConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface DeepgramDelegate {
  onInterimTranscript(text: string, confidence: number): void;
  onFinalTranscript(text: string, confidence: number, words: DeepgramWord[]): void;
  onUtteranceEnd(): void;
  onError(error: Error): void;
  onConnectionStateChange(state: DeepgramConnectionState): void;
}

// ============= Service =============

export class DeepgramService {
  private ws: WebSocket | null = null;
  private delegate: DeepgramDelegate;
  private _connectionState: DeepgramConnectionState = 'disconnected';
  private shouldReconnect = false;
  private reconnectAttempt = 0;
  private maxReconnectDelay = 30;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentApiKey: string | null = null;
  private currentKeywords: Array<[string, number]> = [];
  private lastAudioSendTime: number | null = null;

  constructor(delegate: DeepgramDelegate) {
    this.delegate = delegate;
  }

  get connectionState(): DeepgramConnectionState {
    return this._connectionState;
  }

  private setConnectionState(state: DeepgramConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
    this.delegate.onConnectionStateChange(state);
  }

  // ---- Connect ----

  connect(apiKey: string, keywords: Array<[string, number]> = []): void {
    // Cancel pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close existing
    this.disconnectImmediate();

    this.currentApiKey = apiKey;
    this.currentKeywords = keywords;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;

    this.setConnectionState('connecting');

    const url = this.buildURL(keywords);

    try {
      // Authenticate via WebSocket subprotocol — Deepgram no longer accepts
      // the `token=` query parameter. The subprotocol approach sends the key
      // in the Sec-WebSocket-Protocol header during the HTTP Upgrade handshake.
      this.ws = new WebSocket(url, ['token', apiKey]);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.setConnectionState('connected');
        this.reconnectAttempt = 0;
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data);
      };

      this.ws.onerror = () => {
        this.delegate.onError(new Error('WebSocket connection error'));
      };

      this.ws.onclose = (event: CloseEvent) => {
        this.ws = null;
        if (this.shouldReconnect && event.code !== 1000) {
          this.scheduleReconnect();
        } else {
          this.setConnectionState('disconnected');
        }
      };
    } catch (error) {
      this.setConnectionState('disconnected');
      this.delegate.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // ---- Disconnect ----

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.disconnectClean();
  }

  private disconnectClean(): void {
    if (!this.ws) {
      this.setConnectionState('disconnected');
      return;
    }

    // Send Deepgram CloseStream message
    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        /* ignore */
      }
    }

    // Close after brief delay
    setTimeout(() => {
      this.disconnectImmediate();
    }, 500);
  }

  private disconnectImmediate(): void {
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setConnectionState('disconnected');
  }

  // ---- Send Audio ----

  sendAudio(pcmInt16: Int16Array): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    if (this.ws.readyState !== WebSocket.OPEN) return;

    this.lastAudioSendTime = Date.now();
    this.ws.send(pcmInt16.buffer);
  }

  // ---- Keep-Alive ----

  sendKeepAlive(): void {
    if (!this.ws || this._connectionState !== 'connected') return;
    if (this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
  }

  // ---- Update Keywords ----

  updateKeywords(keywords: Array<[string, number]>): void {
    if (!this.currentApiKey) return;
    this.connect(this.currentApiKey, keywords);
  }

  // ---- URL Builder ----

  private buildURL(keywords: Array<[string, number]>): string {
    const params = new URLSearchParams({
      model: 'nova-3',
      smart_format: 'true',
      punctuate: 'true',
      numerals: 'true',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      language: 'en-GB',
      interim_results: 'true',
      endpointing: '300',
      utterance_end_ms: '1300',
    });

    // Add keyterm params for Nova-3
    for (const [keyword] of keywords) {
      params.append('keyterm', keyword);
    }

    // Auth is via WebSocket subprotocol (Sec-WebSocket-Protocol header),
    // NOT the token= query param which Deepgram no longer accepts.

    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  }

  // ---- Message Handling ----

  private handleMessage(data: string | ArrayBuffer): void {
    let jsonStr: string;
    if (typeof data === 'string') {
      jsonStr = data;
    } else {
      jsonStr = new TextDecoder().decode(data);
    }

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(jsonStr);
    } catch {
      return;
    }

    const type = json.type as string;
    if (!type) return;

    switch (type) {
      case 'Results':
        this.handleResults(json);
        break;
      case 'UtteranceEnd':
        this.delegate.onUtteranceEnd();
        break;
      case 'Error': {
        const errorMsg = (json.message as string) ?? 'Unknown Deepgram error';
        this.delegate.onError(new Error(errorMsg));
        break;
      }
    }
  }

  private handleResults(json: Record<string, unknown>): void {
    const channel = json.channel as Record<string, unknown> | undefined;
    if (!channel) return;
    const alternatives = channel.alternatives as Array<Record<string, unknown>> | undefined;
    if (!alternatives || alternatives.length === 0) return;

    const first = alternatives[0];
    const transcript = (first.transcript as string) ?? '';
    const confidence = (first.confidence as number) ?? 0;
    const isFinal = (json.is_final as boolean) ?? false;

    if (!transcript) return;

    if (isFinal) {
      // Parse words
      const rawWords = (first.words as Array<Record<string, unknown>>) ?? [];
      const words: DeepgramWord[] = rawWords.map((w) => ({
        word: (w.word as string) ?? '',
        start: (w.start as number) ?? 0,
        end: (w.end as number) ?? 0,
        confidence: (w.confidence as number) ?? 0,
        punctuated_word: w.punctuated_word as string | undefined,
      }));

      this.delegate.onFinalTranscript(transcript, confidence, words);
    } else {
      this.delegate.onInterimTranscript(transcript, confidence);
    }
  }

  // ---- Auto-Reconnect ----

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    this.setConnectionState('reconnecting');
    this.reconnectAttempt++;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
    const delay = Math.min(Math.pow(2, this.reconnectAttempt - 1), this.maxReconnectDelay);

    this.reconnectTimer = setTimeout(() => {
      if (!this.shouldReconnect || !this.currentApiKey) return;
      this.connect(this.currentApiKey, this.currentKeywords);
    }, delay * 1000);
  }
}
