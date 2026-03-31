/**
 * WebSocket Recording Server — Deepgram Nova 2 + Gemini 2.5 Pro hybrid
 * Path: wss://.../api/recording/stream
 * Exported for server.js to mount on the HTTP upgrade handler.
 */

import { WebSocketServer } from 'ws';
import logger from './logger.js';
import * as auth from './auth.js';
import { getDeepgramKey } from './services/secrets.js';
import { geminiExtractFromText } from './gemini_extract.js';

const wss = new WebSocketServer({ noServer: true });

const wsRecordingSessions = new Map();

const DEEPGRAM_CONFIG = {
  model: 'nova-2',
  language: 'en-GB',
  smart_format: true,
  punctuate: true,
  diarize: false,
  encoding: 'linear16',
  sample_rate: 16000,
  channels: 1,
  interim_results: true,
  utterance_end_ms: 1500,
  vad_events: true,
  keywords: [
    'Ze:2',
    'Zs:2',
    'R1:2',
    'R2:2',
    'Rn:2',
    'PFC:2',
    'MCB:2',
    'RCBO:2',
    'RCD:2',
    'AFDD:2',
    'TN-C-S:2',
    'TN-S:2',
  ],
};

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
    if (k === 'keywords') {
      for (const kw of v) dgParams.append('keywords', kw);
    } else {
      dgParams.set(k, String(v));
    }
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
    lastExtractionTime: Date.now(),
    pendingGeminiExtraction: false,
    extractionTimer: null,
    startTime: Date.now(),
    chunkCount: 0,
  };

  deepgramWs.on('open', () => {
    logger.info('Deepgram WebSocket connected', { sessionId });
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
    ws.send(JSON.stringify({ type: 'error', message: `Deepgram error: ${err.message}` }));
  });

  state.extractionTimer = setInterval(() => {
    maybeRunExtraction(state);
  }, 5000);

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
    logger.info('Deepgram utterance end', {
      sessionId: state.sessionId,
      bufferLen: state.transcriptBuffer.length,
      newChars: state.transcriptBuffer.length - state.lastExtractionOffset,
    });
    const newChars = state.transcriptBuffer.length - state.lastExtractionOffset;
    if (newChars > 100) {
      maybeRunExtraction(state, true);
    }
  }
}

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
  } else {
    // Log when audio is being dropped (Deepgram not connected)
    if (!state._lastDropLog || Date.now() - state._lastDropLog > 5000) {
      logger.warn('Audio dropped — Deepgram not connected', {
        sessionId: state.sessionId,
        dgState: state.deepgramWs?.readyState ?? 'null',
        chunkCount: state.chunkCount,
      });
      state._lastDropLog = Date.now();
    }
  }
}

async function maybeRunExtraction(state, force = false) {
  if (state.pendingGeminiExtraction) return;

  const newChars = state.transcriptBuffer.length - state.lastExtractionOffset;
  const timeSinceLastMs = Date.now() - state.lastExtractionTime;

  const shouldExtract =
    force ||
    (timeSinceLastMs >= 15000 && newChars >= 200) ||
    (timeSinceLastMs >= 10000 && newChars >= 400);

  if (!shouldExtract || newChars < 50) return;

  state.pendingGeminiExtraction = true;
  const extractionStart = Date.now();

  try {
    const windowSize = 5000;
    const transcriptWindow =
      state.transcriptBuffer.length > windowSize
        ? state.transcriptBuffer.slice(-windowSize)
        : state.transcriptBuffer;

    logger.info('Running Gemini text extraction', {
      sessionId: state.sessionId,
      transcriptLen: state.transcriptBuffer.length,
      windowLen: transcriptWindow.length,
      newChars,
    });

    const result = await geminiExtractFromText(transcriptWindow, state.context);

    state.lastExtractionOffset = state.transcriptBuffer.length;
    state.lastExtractionTime = Date.now();

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

    logger.info('Gemini text extraction complete', {
      sessionId: state.sessionId,
      latencyMs: Date.now() - extractionStart,
      circuits: result.circuits?.length ?? 0,
    });
  } catch (err) {
    logger.error('Gemini text extraction error', {
      sessionId: state.sessionId,
      error: err.message,
    });
    state.ws.send(
      JSON.stringify({
        type: 'error',
        message: `Extraction error: ${err.message}`,
      })
    );
  } finally {
    state.pendingGeminiExtraction = false;
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
    state.pendingGeminiExtraction = false;
    await maybeRunExtraction(state, true);
  }

  if (state.deepgramWs?.readyState === 1) {
    state.deepgramWs.send(JSON.stringify({ type: 'CloseStream' }));
    state.deepgramWs.close();
  }

  cleanupStreamSession(state);
  ws.send(JSON.stringify({ type: 'stopped' }));
}

function cleanupStreamSession(state) {
  if (state.extractionTimer) {
    clearInterval(state.extractionTimer);
    state.extractionTimer = null;
  }
  if (state.deepgramWs?.readyState === 1) {
    state.deepgramWs.close();
  }
  wsRecordingSessions.delete(state.sessionId);
}

export { wss };
