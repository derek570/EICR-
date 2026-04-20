/**
 * WebSocket Recording Server — Deepgram Nova 3 + Sonnet hybrid
 * Path: wss://.../api/recording/stream
 * Exported for server.js to mount on the HTTP upgrade handler.
 *
 * HISTORY: Migrated from Gemini 2.5 Pro to Claude Sonnet extraction (matching iOS pipeline).
 * Time-threshold polling replaced with realtime per-utterance extraction (matching iOS
 * sonnet-stream.js behaviour — extract on every UtteranceEnd with new content).
 */

import { WebSocketServer } from 'ws';
import logger from './logger.js';
import * as auth from './auth.js';
import { getDeepgramKey } from './services/secrets.js';
import { sonnetExtractFromText } from './sonnet_extract.js';
import * as storage from './storage.js';

const wss = new WebSocketServer({ noServer: true });

const wsRecordingSessions = new Map();

// Base Deepgram streaming params (no keyterms — built dynamically below)
const DEEPGRAM_CONFIG = {
  model: 'nova-3',
  language: 'en-GB',
  smart_format: true,
  punctuate: true,
  numerals: true,
  diarize: false,
  encoding: 'linear16',
  sample_rate: 16000,
  channels: 1,
  interim_results: true,
  endpointing: 300,
  // [TTS-TIMING] Codex-review fix (HIGH): keep in sync with the iOS-direct
  // Deepgram config (DeepgramService.swift). Previously 2000ms here — out of
  // step with the iOS path after the 2026-04-20 TTS-timing fix. Any web/legacy
  // consumer of ws-recording would have carried the old latency budget and
  // could reintroduce the TTS-over-speech race when routed through this proxy.
  utterance_end_ms: 1200,
  vad_events: true,
};

// Default keyword boosts — mirrors iOS default_config.json (base_electrical + board_types).
// Used as fallback when remote config is unavailable. Kept in sync with the bundled iOS config.
const DEFAULT_KEYWORD_BOOSTS = {
  // base_electrical
  CertMate: 3.0,
  'cert mate': 3.0,
  megohms: 3.0,
  Zs: 2.0,
  Ze: 2.0,
  Zeddy: 2.0,
  'Zed e': 2.0,
  RCD: 1.5,
  RCBO: 1.5,
  MCB: 1.5,
  AFDD: 1.5,
  R1: 2.0,
  R2: 2.0,
  Rn: 1.5,
  CPC: 1.5,
  'R1 plus R2': 3.0,
  'loop impedance': 1.5,
  'insulation resistance': 2.5,
  insulation: 1.5,
  'ring continuity': 2.0,
  lives: 1.5,
  neutrals: 1.5,
  earths: 2.0,
  'live to live': 2.0,
  'live to earth': 2.0,
  'live to neutral': 1.5,
  'greater than': 2.0,
  'test voltage': 1.5,
  radial: 1.0,
  spur: 1.0,
  polarity: 1.0,
  'push button': 1.5,
  'push button works': 2.0,
  'trip time': 1.5,
  megger: 1.5,
  'earth fault': 1.5,
  continuity: 1.5,
  milliamps: 1.0,
  milliseconds: 1.0,
  circuit: 3.0,
  'nought point': 1.5,
  nought: 2.0,
  'main earth': 1.5,
  tails: 2.0,
  'meter tails': 1.5,
  bonding: 1.5,
  earthing: 2.0,
  'TN-C-S': 3.0,
  'TN-C': 2.0,
  'TN-S': 3.0,
  TT: 1.5,
  PME: 1.5,
  'prospective fault current': 1.5,
  PFC: 1.5,
  'supply voltage': 1.5,
  volts: 1.0,
  frequency: 1.5,
  hertz: 1.5,
  'type B': 1.5,
  'type C': 1.5,
  'number of points': 1.5,
  smokes: 1.5,
  'smoke detectors': 1.5,
  'cable size': 1.5,
  'circuit number': 1.5,
  upstairs: 1.0,
  downstairs: 1.0,
  wiring: 2.0,
  'reference method': 2.0,
  correction: 1.5,
  'N/A': 2.5,
  LIM: 3.0,
  limitation: 2.5,
  debug: 2.0,
  observation: 2.5,
  C1: 2.0,
  C2: 2.0,
  C3: 2.0,
  FI: 1.5,
  'code 1': 1.5,
  'code 2': 1.5,
  'code 3': 1.5,
  'danger present': 1.5,
  'potentially dangerous': 1.5,
  'improvement recommended': 1.5,
  'further investigation': 1.5,
  defect: 1.5,
  postcode: 1.5,
  customer: 1.5,
  client: 1.5,
  address: 1.5,
  'in tails': 2.0,
  DB: 1.5,
  'distribution board': 1.5,
  'Zs for': 2.0,
  'R1 plus R2 for': 2.0,
  'live to earth for': 2.0,
  'live to live for': 2.0,
  'number of points for': 1.5,
  'trip time for': 1.5,
  // board_types
  Hager: 1.5,
  Elucian: 1.5,
  BG: 1.5,
  Wylex: 1.5,
  MK: 1.5,
  Schneider: 1.5,
  Fusebox: 1.5,
  Crabtree: 1.5,
};

// Keyterm cache — refreshed from remote config every hour
let _cachedKeyterms = null;
let _keytermLoadTime = 0;
const KEYTERM_CACHE_TTL_MS = 3_600_000; // 1 hour

/**
 * Convert a keyword-boost map into sorted Deepgram keyterm strings.
 * Mirrors iOS DeepgramService.buildURL() + KeywordBoostGenerator.dedupAndCap():
 * - Sort by boost descending (alphabetically for ties)
 * - Append ":X.X" suffix only for boost >= 3.0 (saves URL chars for lower-tier terms)
 * - Cap at 100 before URL-length check (matching iOS maxKeyterms)
 */
function buildKeytermsFromBoosts(boosts) {
  const BOOST_THRESHOLD = 3.0;
  const MAX_KEYTERMS = 100;

  return Object.entries(boosts)
    .filter(([, boost]) => boost > 0)
    .sort(([ka, ba], [kb, bb]) => (bb !== ba ? bb - ba : ka.localeCompare(kb)))
    .slice(0, MAX_KEYTERMS)
    .map(([keyword, boost]) =>
      boost >= BOOST_THRESHOLD ? `${keyword}:${boost.toFixed(1)}` : keyword
    );
}

/**
 * Load Deepgram keyterms from remote config (GCS), falling back to DEFAULT_KEYWORD_BOOSTS.
 * Caches result for 1 hour. Matches iOS KeywordBoostGenerator.generateFromConfig().
 */
async function loadKeyterms() {
  if (_cachedKeyterms && Date.now() - _keytermLoadTime < KEYTERM_CACHE_TTL_MS) {
    return _cachedKeyterms;
  }

  try {
    const configText = await storage.downloadText('config/certmate_config.json');
    if (configText) {
      const config = JSON.parse(configText);
      const boosts = {
        ...config.keyword_boosts?.base_electrical,
        ...config.keyword_boosts?.board_types,
      };
      if (Object.keys(boosts).length > 0) {
        _cachedKeyterms = buildKeytermsFromBoosts(boosts);
        _keytermLoadTime = Date.now();
        logger.info('Loaded Deepgram keyterms from remote config', {
          count: _cachedKeyterms.length,
        });
        return _cachedKeyterms;
      }
    }
  } catch (err) {
    logger.warn('Failed to load Deepgram keyterms from remote config, using defaults', {
      error: err.message,
    });
  }

  _cachedKeyterms = buildKeytermsFromBoosts(DEFAULT_KEYWORD_BOOSTS);
  _keytermLoadTime = Date.now();
  logger.info('Using default Deepgram keyterms', { count: _cachedKeyterms.length });
  return _cachedKeyterms;
}

wss.on('connection', (ws, request) => {
  let sessionState = null;

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    try {
      switch (msg.type) {
        case 'start':
          sessionState = await handleStreamStart(ws, msg, request);
          break;
        case 'audio':
          if (sessionState) handleStreamAudio(sessionState, msg);
          break;
        case 'context_update':
          if (sessionState) sessionState.context = msg.context || '';
          break;
        case 'stop':
          if (sessionState) await handleStreamStop(ws, sessionState);
          sessionState = null;
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
      }
    } catch (err) {
      logger.error('WebSocket message handler error', { error: err.message, type: msg.type });
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    if (sessionState) {
      logger.info('WebSocket closed, cleaning up session', { sessionId: sessionState.sessionId });
      cleanupStreamSession(sessionState);
    }
  });

  ws.on('error', (err) => {
    logger.error('WebSocket error', { error: err.message });
  });
});

async function handleStreamStart(ws, msg, request) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
    ws.close();
    return null;
  }
  const token = authHeader.slice(7);
  let userId;
  try {
    const decoded = auth.verifyToken(token);
    userId = decoded.userId || decoded.id || decoded.sub;
  } catch {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
    ws.close();
    return null;
  }

  const sessionId = msg.sessionId || `stream_${Date.now()}`;
  const jobId = msg.jobId || null;
  const context = msg.context || '';

  const deepgramApiKey = await getDeepgramKey();
  if (!deepgramApiKey) {
    ws.send(JSON.stringify({ type: 'error', message: 'Deepgram API key not configured' }));
    ws.close();
    return null;
  }

  const dgParams = new URLSearchParams();
  for (const [k, v] of Object.entries(DEEPGRAM_CONFIG)) {
    dgParams.set(k, String(v));
  }

  // Add keyterms dynamically from config, respecting iOS URL-length safety net (1800 chars)
  const keyterms = await loadKeyterms();
  const MAX_URL_LENGTH = 1800;
  let addedKeyterms = 0;
  for (const kt of keyterms) {
    const candidateUrl = `wss://api.deepgram.com/v1/listen?${dgParams.toString()}&keyterm=${encodeURIComponent(kt)}`;
    if (candidateUrl.length > MAX_URL_LENGTH) {
      logger.info('Deepgram keyterm URL limit reached', {
        sessionId,
        addedKeyterms,
        totalKeyterms: keyterms.length,
        urlLen: `wss://api.deepgram.com/v1/listen?${dgParams.toString()}`.length,
      });
      break;
    }
    dgParams.append('keyterm', kt);
    addedKeyterms++;
  }

  const dgUrl = `wss://api.deepgram.com/v1/listen?${dgParams.toString()}`;

  const { default: WebSocket } = await import('ws');
  const deepgramWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${deepgramApiKey}` },
  });

  const state = {
    sessionId,
    jobId,
    userId,
    ws,
    deepgramWs,
    context,
    transcriptBuffer: '',
    lastExtractionOffset: 0,
    pendingSonnetExtraction: false,
    startTime: Date.now(),
    chunkCount: 0,
    // Startup audio buffer: hold audio chunks while Deepgram WS is connecting.
    // Cap at ~10 seconds of Int16 PCM @ 16kHz = 320,000 bytes.
    audioStartupBuffer: [],
    audioStartupBufferBytes: 0,
    audioStartupBufferFlushed: false,
  };

  deepgramWs.on('open', () => {
    logger.info('Deepgram WebSocket connected', { sessionId });
    // Flush any audio buffered while Deepgram was connecting
    if (state.audioStartupBuffer.length > 0) {
      logger.info('Flushing startup audio buffer', {
        sessionId,
        chunks: state.audioStartupBuffer.length,
        bytes: state.audioStartupBufferBytes,
      });
      for (const chunk of state.audioStartupBuffer) {
        deepgramWs.send(chunk);
      }
    }
    state.audioStartupBuffer = [];
    state.audioStartupBufferBytes = 0;
    state.audioStartupBufferFlushed = true;
    ws.send(JSON.stringify({ type: 'ready' }));
  });

  deepgramWs.on('message', (dgData) => {
    try {
      const dgMsg = JSON.parse(dgData.toString());
      handleDeepgramMessage(state, dgMsg);
    } catch (err) {
      logger.error('Deepgram message parse error', { error: err.message });
    }
  });

  deepgramWs.on('close', (code, reason) => {
    logger.info('Deepgram WebSocket closed', {
      sessionId,
      closeCode: code,
      reason: reason?.toString() || 'none',
    });
  });

  deepgramWs.on('error', (err) => {
    logger.error('Deepgram WebSocket error', { sessionId, error: err.message });
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'error', message: `Deepgram error: ${err.message}` }));
    }
  });

  wsRecordingSessions.set(sessionId, state);
  logger.info('Stream recording started', { sessionId, userId, jobId });
  return state;
}

function handleDeepgramMessage(state, dgMsg) {
  if (dgMsg.type === 'Results' && dgMsg.channel?.alternatives?.[0]) {
    const alt = dgMsg.channel.alternatives[0];
    const transcript = alt.transcript || '';
    const isFinal = dgMsg.is_final === true;
    const confidence = alt.confidence || 0;

    if (!transcript) return;

    if (isFinal) {
      state.transcriptBuffer += (state.transcriptBuffer ? ' ' : '') + transcript;

      logger.info('Deepgram final transcript', {
        sessionId: state.sessionId,
        confidence: confidence.toFixed(3),
        textPreview: transcript.substring(0, 80),
        bufferLen: state.transcriptBuffer.length,
      });

      state.ws.send(
        JSON.stringify({
          type: 'transcript',
          text: transcript,
          isFinal: true,
        })
      );

      maybeRunExtraction(state);
    } else {
      state.ws.send(
        JSON.stringify({
          type: 'transcript_partial',
          text: transcript,
        })
      );
    }
  }

  if (dgMsg.type === 'SpeechStarted') {
    logger.info('Deepgram speech started (VAD)', { sessionId: state.sessionId });
  }

  if (dgMsg.type === 'UtteranceEnd') {
    const newChars = state.transcriptBuffer.length - state.lastExtractionOffset;
    logger.info('Deepgram utterance end', {
      sessionId: state.sessionId,
      bufferLen: state.transcriptBuffer.length,
      newChars,
    });
    // Realtime extraction: trigger on every utterance end with any new content.
    // Matches iOS sonnet-stream.js which extracts per-utterance, no time thresholds.
    if (newChars > 0) {
      maybeRunExtraction(state, true);
    }
  }
}

// Max startup buffer: ~10 seconds of Int16 PCM at 16kHz = 320,000 bytes
const MAX_STARTUP_BUFFER_BYTES = 320000;

function handleStreamAudio(state, msg) {
  if (!msg.data) return;
  const pcmBuffer = Buffer.from(msg.data, 'base64');
  if (state.deepgramWs?.readyState === 1) {
    state.deepgramWs.send(pcmBuffer);
    state.chunkCount++;
    // Log every 100th chunk (~10s of audio) to avoid spam but track flow
    if (state.chunkCount % 100 === 1) {
      logger.info('Audio streaming to Deepgram', {
        sessionId: state.sessionId,
        chunkCount: state.chunkCount,
        chunkBytes: pcmBuffer.length,
        elapsedSec: Math.round((Date.now() - state.startTime) / 1000),
      });
    }
  } else if (!state.audioStartupBufferFlushed) {
    // Deepgram WS is still connecting — buffer audio instead of dropping it.
    // If buffer is full, drop oldest chunks to make room for newest.
    state.audioStartupBuffer.push(pcmBuffer);
    state.audioStartupBufferBytes += pcmBuffer.length;
    while (
      state.audioStartupBufferBytes > MAX_STARTUP_BUFFER_BYTES &&
      state.audioStartupBuffer.length > 1
    ) {
      const dropped = state.audioStartupBuffer.shift();
      state.audioStartupBufferBytes -= dropped.length;
    }
    if (state.chunkCount === 0) {
      logger.info('Buffering audio while Deepgram connects', {
        sessionId: state.sessionId,
        bufferedChunks: state.audioStartupBuffer.length,
        bufferedBytes: state.audioStartupBufferBytes,
      });
    }
    state.chunkCount++;
  } else {
    // Deepgram WS disconnected after initial connection — audio is lost
    if (!state._lastDropLog || Date.now() - state._lastDropLog > 5000) {
      logger.warn('Audio dropped — Deepgram disconnected', {
        sessionId: state.sessionId,
        dgState: state.deepgramWs?.readyState ?? 'null',
        chunkCount: state.chunkCount,
      });
      state._lastDropLog = Date.now();
    }
  }
}

async function maybeRunExtraction(state, force = false) {
  if (state.pendingSonnetExtraction) return;

  const newChars = state.transcriptBuffer.length - state.lastExtractionOffset;

  // Skip if there's nothing new to extract (minimum 30 chars to avoid noise)
  if (newChars < 30 && !force) return;
  if (newChars === 0) return;

  state.pendingSonnetExtraction = true;
  const extractionStart = Date.now();

  try {
    const windowSize = 5000;
    const transcriptWindow =
      state.transcriptBuffer.length > windowSize
        ? state.transcriptBuffer.slice(-windowSize)
        : state.transcriptBuffer;

    logger.info('Running Sonnet text extraction', {
      sessionId: state.sessionId,
      transcriptLen: state.transcriptBuffer.length,
      windowLen: transcriptWindow.length,
      newChars,
    });

    const result = await sonnetExtractFromText(transcriptWindow, state.context);

    state.lastExtractionOffset = state.transcriptBuffer.length;

    if (state.ws.readyState === 1) {
      state.ws.send(
        JSON.stringify({
          type: 'extraction',
          data: {
            circuits: result.circuits,
            supply: result.supply,
            installation: result.installation,
            board: result.board,
            orphaned_values: result.orphaned_values,
            usage: result.usage,
          },
        })
      );
    } else {
      logger.warn('Extraction complete but WebSocket closed, result lost', {
        sessionId: state.sessionId,
        wsState: state.ws.readyState,
      });
    }

    logger.info('Sonnet text extraction complete', {
      sessionId: state.sessionId,
      latencyMs: Date.now() - extractionStart,
      circuits: result.circuits?.length ?? 0,
    });
  } catch (err) {
    logger.error('Sonnet text extraction error', {
      sessionId: state.sessionId,
      error: err.message,
    });
    if (state.ws.readyState === 1) {
      state.ws.send(
        JSON.stringify({
          type: 'error',
          message: `Extraction error: ${err.message}`,
        })
      );
    }
  } finally {
    state.pendingSonnetExtraction = false;
  }
}

async function handleStreamStop(ws, state) {
  logger.info('Stream recording stopping', {
    sessionId: state.sessionId,
    transcriptLen: state.transcriptBuffer.length,
    duration: Date.now() - state.startTime,
  });

  const remainingChars = state.transcriptBuffer.length - state.lastExtractionOffset;
  if (remainingChars > 30) {
    state.pendingSonnetExtraction = false;
    await maybeRunExtraction(state, true);
  }

  if (state.deepgramWs?.readyState === 1) {
    state.deepgramWs.send(JSON.stringify({ type: 'CloseStream' }));
    state.deepgramWs.close();
  }

  cleanupStreamSession(state);
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'stopped' }));
  }
}

function cleanupStreamSession(state) {
  if (state.deepgramWs?.readyState === 1) {
    state.deepgramWs.close();
  }
  wsRecordingSessions.delete(state.sessionId);
}

export { wss };
