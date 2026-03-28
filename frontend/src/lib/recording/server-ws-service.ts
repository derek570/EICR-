// server-ws-service.ts
// Port of iOS ServerWebSocketService.swift — WebSocket client for server-side
// Sonnet extraction sessions via wss://backend/api/sonnet-stream.

import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerCostUpdate {
  sonnet: {
    turns: number;
    cacheReads: number;
    cacheWrites: number;
    input: number;
    output: number;
    compactions: number;
    cost: number;
  };
  deepgram: {
    minutes: number;
    cost: number;
  };
  elevenlabs?: {
    characters: number;
    cost: number;
  };
  totalJobCost: number;
}

export interface UserQuestion {
  field: string;
  circuit?: number;
  question: string;
  type: 'orphaned' | 'out_of_range' | 'unclear';
  value?: string;
}

export interface ExtractedReading {
  field: string;
  value: string;
  circuit?: number;
  source?: string;
}

export interface RollingExtractionResult {
  extracted_readings: ExtractedReading[];
  observations?: Array<{
    code: string;
    text: string;
    location?: string;
    scheduleItem?: string;
  }>;
  questionsForUser?: UserQuestion[];
}

export interface ServerWSCallbacks {
  onExtraction: (result: RollingExtractionResult) => void;
  onQuestion: (question: UserQuestion) => void;
  onCostUpdate: (cost: ServerCostUpdate) => void;
  onError: (message: string, recoverable: boolean) => void;
  onSessionAck: (status: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

// ---------------------------------------------------------------------------
// ServerWebSocketService
// ---------------------------------------------------------------------------

export class ServerWebSocketService {
  private callbacks: ServerWSCallbacks;
  private ws: WebSocket | null = null;

  // Connection state
  private _isConnected = false;
  private serverURL: string | null = null;
  private authToken: string | null = null;

  // Reconnection
  private shouldReconnect = false;
  private reconnectAttempt = 0;
  private readonly maxReconnectDelay = 30;
  private reconnectTimerId: ReturnType<typeof setTimeout> | null = null;

  // Message buffering — holds transcript/correction messages while disconnected
  private pendingMessages: Array<Record<string, unknown>> = [];

  // Ping keepalive
  private pingTimerId: ReturnType<typeof setInterval> | null = null;
  private static readonly PING_INTERVAL_MS = 25_000;

  constructor(callbacks: ServerWSCallbacks) {
    this.callbacks = callbacks;
  }

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  get isConnected(): boolean {
    return this._isConnected;
  }

  // ---------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------

  connect(serverURL: string, token: string): void {
    // Cancel any pending reconnect
    this.clearReconnectTimer();

    // Close existing connection
    this.disconnectImmediate();

    this.serverURL = serverURL;
    this.authToken = token;
    this.shouldReconnect = true;
    this.reconnectAttempt = 0;

    this.log('CONNECTING', serverURL);

    // Build URL with token query param
    let url: URL;
    try {
      url = new URL(serverURL);
    } catch (e) {
      console.error('[ServerWS] CONNECT_ERROR: Invalid URL', serverURL, e);
      toast.error('Server connection failed: invalid URL');
      this.callbacks.onError(`Invalid server URL: ${serverURL}`, false);
      return;
    }
    url.searchParams.set('token', token);
    this.log('CONNECT_URL', `${url.origin}${url.pathname}?token=<redacted>`);

    const ws = new WebSocket(url.toString());

    ws.onopen = () => {
      // DIAG: state change visible in production
      console.warn(
        `[ServerWS DIAG] STATE: disconnected -> connected (url=${url.origin}${url.pathname})`
      );
      this.log('WS_OPEN', `readyState=${ws.readyState}, url=${url.origin}${url.pathname}`);
      this._isConnected = true;
      this.reconnectAttempt = 0;
      this.startPingTimer();

      // NOTE: Do NOT flush buffered messages here. The caller's onConnect
      // sends session_start first, which must arrive at the server BEFORE
      // any transcripts. Buffered messages are flushed after session_ack
      // is received (see flushPendingMessages).
      this.callbacks.onConnect();
    };

    ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    ws.onclose = (event: CloseEvent) => {
      const isAbnormal = event.code !== 1000 && event.code !== 1001;
      const logMethod = isAbnormal ? 'error' : 'log';
      const msg = `code=${event.code}, reason=${event.reason || 'none'}, wasClean=${event.wasClean}`;
      // DIAG: state change visible in production
      console.warn(`[ServerWS DIAG] STATE: connected -> disconnected (${msg})`);
      console[logMethod](`[ServerWS] WS_CLOSE: ${msg}`);
      if (isAbnormal) {
        toast.error('Server disconnected — reconnecting…');
      }
      this.log('WS_CLOSE', msg);

      this.ws = null;
      this.stopPingTimer();
      const wasConnected = this._isConnected;
      this._isConnected = false;

      if (this.shouldReconnect && event.code !== 1000) {
        console.warn(
          `[ServerWS DIAG] STATE: disconnected -> reconnecting (attempt=${this.reconnectAttempt + 1})`
        );
        this.scheduleReconnect();
      }

      if (wasConnected) {
        this.callbacks.onDisconnect();
      }
    };

    ws.onerror = (event: Event) => {
      console.error('[ServerWS] WS_ERROR: WebSocket error event fired', {
        url: url.toString(),
        readyState: ws.readyState,
      });
      this.log('WS_ERROR', `readyState=${ws.readyState}`);
      // onclose fires after onerror; reconnection handled there.
    };

    this.ws = ws;
  }

  // ---------------------------------------------------------------------------
  // Disconnect
  // ---------------------------------------------------------------------------

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.pendingMessages = [];
    this.disconnectImmediate();
  }

  private disconnectImmediate(): void {
    this.stopPingTimer();

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

    const wasConnected = this._isConnected;
    this._isConnected = false;
    if (wasConnected) {
      this.callbacks.onDisconnect();
    }
  }

  // ---------------------------------------------------------------------------
  // Send Messages
  // ---------------------------------------------------------------------------

  private send(message: Record<string, unknown>): void {
    // If disconnected, buffer transcript and correction messages
    if (!this._isConnected || !this.ws) {
      const type = (message.type as string) ?? 'unknown';
      if (type === 'transcript' || type === 'correction') {
        this.pendingMessages.push(message);
        this.log('SEND_BUFFERED', `type=${type}, buffered=${this.pendingMessages.length}`);
      } else {
        this.log('SEND_DROPPED', `type=${type}, not connected`);
      }
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      this.log('SEND_ERROR', 'Failed to send message');
    }
  }

  // ---------------------------------------------------------------------------
  // Convenience Senders
  // ---------------------------------------------------------------------------

  sendSessionStart(sessionId: string, jobId: string, jobState: Record<string, unknown>): void {
    this.send({
      type: 'session_start',
      sessionId,
      jobId,
      jobState,
    });
  }

  sendTranscript(text: string, regexResults?: Array<Record<string, unknown>>): void {
    const msg: Record<string, unknown> = {
      type: 'transcript',
      text,
      timestamp: new Date().toISOString(),
    };
    if (regexResults && regexResults.length > 0) {
      msg.regexResults = regexResults;
    }
    this.send(msg);
  }

  sendCorrection(field: string, circuit: number, value: string): void {
    this.send({ type: 'correction', field, circuit, value });
  }

  sendPause(): void {
    this.send({ type: 'session_pause' });
  }

  sendResume(): void {
    this.send({ type: 'session_resume' });
  }

  sendStop(): void {
    this.send({ type: 'session_stop' });
  }

  sendCompactRequest(): void {
    this.send({ type: 'session_compact' });
  }

  /**
   * Flush buffered transcript/correction messages that accumulated while
   * disconnected. Call ONLY after session_ack confirms the server has an
   * active session.
   */
  flushPendingMessages(): void {
    if (!this._isConnected || this.pendingMessages.length === 0) return;

    this.log('FLUSH_BUFFER', `sending ${this.pendingMessages.length} buffered messages`);
    const buffered = this.pendingMessages;
    this.pendingMessages = [];

    for (const msg of buffered) {
      try {
        this.ws?.send(JSON.stringify(msg));
      } catch {
        this.log('FLUSH_SEND_ERROR', 'Failed to send buffered message');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound Message Handling
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
      case 'extraction': {
        const result = json.result as RollingExtractionResult | undefined;
        console.log('[ServerWS] extraction received:', {
          hasResult: !!result,
          readingsCount: result?.extracted_readings?.length ?? 0,
          observationsCount: result?.observations?.length ?? 0,
        });
        if (result) {
          this.callbacks.onExtraction(result);
        } else {
          this.log('DECODE_ERROR', 'Failed to decode extraction result');
        }
        break;
      }

      case 'question': {
        const question: UserQuestion = {
          field: json.field as string,
          circuit: json.circuit as number | undefined,
          question: json.question as string,
          type:
            (json.question_type as UserQuestion['type']) ??
            (json.questionType as UserQuestion['type']) ??
            'unclear',
          value: json.value as string | undefined,
        };
        if (question.field && question.question) {
          this.callbacks.onQuestion(question);
        } else {
          this.log('DECODE_ERROR', 'Failed to decode question');
        }
        break;
      }

      case 'cost_update': {
        const cost: ServerCostUpdate = {
          sonnet: json.sonnet as ServerCostUpdate['sonnet'],
          deepgram: json.deepgram as ServerCostUpdate['deepgram'],
          elevenlabs: json.elevenlabs as ServerCostUpdate['elevenlabs'],
          totalJobCost: json.totalJobCost as number,
        };
        if (cost.sonnet && cost.deepgram) {
          this.callbacks.onCostUpdate(cost);
        } else {
          this.log('DECODE_ERROR', 'Failed to decode cost update');
        }
        break;
      }

      case 'error': {
        const message = (json.message as string) ?? 'Unknown server error';
        const recoverable = (json.recoverable as boolean) ?? false;
        this.callbacks.onError(message, recoverable);
        break;
      }

      case 'session_ack': {
        const status = (json.status as string) ?? 'unknown';
        this.log('SESSION_ACK', status);
        this.callbacks.onSessionAck(status);
        break;
      }

      default:
        this.log('UNKNOWN_TYPE', type);
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-Reconnect
  // ---------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    this.reconnectAttempt += 1;

    // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
    const delay = Math.min(Math.pow(2, this.reconnectAttempt - 1), this.maxReconnectDelay);
    this.log('RECONNECT_SCHEDULED', `attempt=${this.reconnectAttempt}, delay=${delay}s`);

    this.reconnectTimerId = setTimeout(() => {
      this.reconnectTimerId = null;
      if (!this.shouldReconnect || !this.serverURL || !this.authToken) return;
      this.log('RECONNECTING', `attempt=${this.reconnectAttempt}`);
      this.connect(this.serverURL, this.authToken);
    }, delay * 1000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimerId !== null) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Ping Keepalive
  // ---------------------------------------------------------------------------

  private startPingTimer(): void {
    this.stopPingTimer();
    this.pingTimerId = setInterval(() => {
      if (!this._isConnected || !this.ws) {
        this.stopPingTimer();
        return;
      }
      try {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        this.log('PING_ERROR', 'Failed to send ping');
      }
    }, ServerWebSocketService.PING_INTERVAL_MS);
  }

  private stopPingTimer(): void {
    if (this.pingTimerId !== null) {
      clearInterval(this.pingTimerId);
      this.pingTimerId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Logging
  // ---------------------------------------------------------------------------

  private log(event: string, detail: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    if (detail) {
      console.log(`[ServerWS ${ts}] ${event}: ${detail}`);
    } else {
      console.log(`[ServerWS ${ts}] ${event}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  destroy(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.stopPingTimer();
    this.pendingMessages = [];

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

    this._isConnected = false;
  }
}
