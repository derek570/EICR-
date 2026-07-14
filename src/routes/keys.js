/**
 * Proxy routes and remote config — Claude proxy, TTS proxies, remote config
 * The GET /api/keys endpoint has been removed for security (never expose raw API keys to clients).
 * iOS clients should use proxy endpoints or direct WebSocket connections instead.
 *
 * HISTORY (3ea46f3, 2026-02-24): The original implementation sent the master Deepgram API key
 * directly to the iOS client. This was replaced with short-lived temp keys (600s TTL) created
 * via the Deepgram REST API, so the master key never leaves the server. The Claude proxy was
 * also hardened with a field whitelist — only model, messages, max_tokens, system, temperature,
 * top_p, and stop_sequences are forwarded. Any extra fields from the client are stripped and logged.
 *
 * HISTORY (a3e0759, 2026-02-26): Temp key creation requires the keys:write scope on the
 * Deepgram API key (which requires a Member-level role). When the Deepgram key only has
 * basic scopes, createDeepgramTempKey() throws a 403. Rather than returning a 500 to the
 * iOS client (which would break the recording session), we fall back to the master key.
 * This is a security trade-off: master key exposure to the client is worse than temp keys,
 * but a broken recording session is worse than either.
 */

import { Router } from 'express';
import * as auth from '../auth.js';
import * as storage from '../storage.js';
import { getDeepgramKey, getSecret } from '../services/secrets.js';
import logger from '../logger.js';

// Cached Deepgram project ID to avoid repeated lookups
let cachedProjectId = null;

const router = Router();

// Allowed Claude models for proxy requests
const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-5-20241022',
  'claude-sonnet-4-5-latest',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6-latest',
  'claude-haiku-4-5-20241022',
  'claude-haiku-4-5-latest',
  'claude-opus-4-6-latest',
  'claude-opus-4-6-20250501',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
]);

const MAX_TOKENS_LIMIT = 8192;

/**
 * Proxy Claude Anthropic API calls
 * POST /api/proxy/claude
 *
 * Validates model whitelist and max_tokens before forwarding.
 * Logs per-user cost data from Anthropic response usage.
 */
router.post('/proxy/claude', auth.requireAuth, async (req, res) => {
  try {
    // Validate request body
    const { model, max_tokens, messages } = req.body;

    if (!model || !ALLOWED_MODELS.has(model)) {
      return res.status(400).json({
        error: `Invalid model. Allowed: ${[...ALLOWED_MODELS].join(', ')}`,
      });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    if (max_tokens && (typeof max_tokens !== 'number' || max_tokens > MAX_TOKENS_LIMIT)) {
      return res.status(400).json({
        error: `max_tokens must be a number <= ${MAX_TOKENS_LIMIT}`,
      });
    }

    const { getAnthropicKey } = await import('../services/secrets.js');
    const anthropicKey = await getAnthropicKey();
    if (!anthropicKey) {
      return res.status(500).json({ error: 'Anthropic API key not configured' });
    }

    const userId = req.user?.id || req.user?.userId || 'unknown';

    // Build forwarded body from whitelisted fields only
    const forwardBody = {
      model,
      messages,
      max_tokens: max_tokens || 4096,
    };

    // HISTORY (3ea46f3, 2026-02-24): Only whitelisted Anthropic API fields are forwarded.
    // The client used to be able to send arbitrary fields (like stream: true, tools, etc.)
    // which could be used to abuse the API key. Now only safe fields are forwarded, and
    // any extra fields are stripped and logged as a warning.
    // Include optional Anthropic Messages API fields only if present and valid
    if (typeof req.body.system === 'string') {
      forwardBody.system = req.body.system;
    }
    // Allow system as content block array (required for prompt caching with cache_control)
    if (Array.isArray(req.body.system)) {
      forwardBody.system = req.body.system;
    }
    if (
      typeof req.body.temperature === 'number' &&
      req.body.temperature >= 0 &&
      req.body.temperature <= 1
    ) {
      forwardBody.temperature = req.body.temperature;
    }
    if (typeof req.body.top_p === 'number' && req.body.top_p >= 0 && req.body.top_p <= 1) {
      forwardBody.top_p = req.body.top_p;
    }
    if (Array.isArray(req.body.stop_sequences)) {
      forwardBody.stop_sequences = req.body.stop_sequences;
    }

    // Log stripped non-whitelisted fields
    const allowedFields = new Set([
      'model',
      'messages',
      'max_tokens',
      'system',
      'temperature',
      'top_p',
      'stop_sequences',
      'betas',
    ]);
    const extraFields = Object.keys(req.body).filter((k) => !allowedFields.has(k));
    if (extraFields.length > 0) {
      logger.warn('Claude proxy: stripped non-whitelisted fields', { userId, extraFields });
    }

    // Build Anthropic request headers — forward beta features if client requests them.
    // 'prompt-caching-2024-07-31' enables cache_control on system/messages blocks.
    const anthropicHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    };
    const clientBeta = req.headers['anthropic-beta'];
    const ALLOWED_BETAS = new Set(['prompt-caching-2024-07-31', 'extended-cache-ttl-2025-04-11']);
    if (typeof clientBeta === 'string') {
      const filteredBetas = clientBeta
        .split(',')
        .map((b) => b.trim())
        .filter((b) => ALLOWED_BETAS.has(b))
        .join(',');
      if (filteredBetas) {
        anthropicHeaders['anthropic-beta'] = filteredBetas;
      }
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify(forwardBody),
    });

    const data = await response.json();

    // Log per-user cost tracking
    if (data.usage) {
      logger.info('Claude proxy usage', {
        userId,
        model,
        input_tokens: data.usage.input_tokens || 0,
        output_tokens: data.usage.output_tokens || 0,
      });
    }

    res.status(response.status).json(data);
  } catch (error) {
    logger.error('Claude proxy error', { error: error.message });
    res.status(500).json({ error: 'Claude proxy request failed' });
  }
});

/**
 * Proxy Deepgram TTS calls from the web app
 * POST /api/proxy/deepgram-tts
 */
router.post('/proxy/deepgram-tts', auth.requireAuth, async (req, res) => {
  try {
    const deepgramKey = await getDeepgramKey();
    if (!deepgramKey) {
      return res.status(500).json({ error: 'Deepgram API key not configured' });
    }

    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'text field required' });
    }

    const response = await fetch(
      'https://api.deepgram.com/v1/speak?model=aura-2-draco-en&encoding=mp3',
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${deepgramKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    res.set('Content-Type', 'audio/mpeg');
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    logger.error('Deepgram TTS proxy error', { error: error.message });
    res.status(500).json({ error: 'Deepgram TTS proxy request failed' });
  }
});

/**
 * Stage 2 commit 2.5 — stream an ElevenLabs confirmation synth into the
 * caller's chunked HTTP response. Pipes vendor PCM/MP3 frames straight
 * out as they arrive (Strategy C — iOS plays as bytes land, not after
 * full buffer). Cost-tracker called on synthesising-transition per
 * PLAN_v4 §A.10; terminal counter incremented on completion.
 *
 * Mints a correlation ID (vl_confirmation_*) and echoes it on the
 * response header so the iOS-side ack (Stage 1b commit 1b.5) can pair
 * up.
 */
async function streamConfirmationViaElevenLabs({
  text,
  sessionId,
  // Voice-latency plan 2026-06-03 Tier 2b: accept turnId so the
  // ElevenLabs TTS streaming complete log row carries it. The
  // §CloudWatch dashboard query filters `ispresent(turnId)` and will
  // silently drop rows without it.
  turnId,
  apiKey,
  res,
  useMultiContext,
  recordStartedAttribution,
  recordTerminalAttribution,
}) {
  const { ElevenLabsStreamClient, contentTypeForFormat } =
    await import('../extraction/elevenlabs-stream-client.js');
  const { mintCorrelationId, recordOutcome, recordSpan } =
    await import('../extraction/voice-latency-telemetry.js');

  const correlationId = mintCorrelationId(sessionId, 'confirmation');
  const client = new ElevenLabsStreamClient({ apiKey, multiContext: useMultiContext });

  res.set('Content-Type', contentTypeForFormat(client.outputFormat));
  res.set('Transfer-Encoding', 'chunked');
  res.set('Cache-Control', 'no-store');
  res.set('X-Voice-Latency-Correlation-Id', correlationId);
  res.set('X-Voice-Latency-Source', 'confirmation');

  // Billable counter — once per correlation, regardless of terminal state.
  // Pass the stream client's actual model id (defaults to eleven_flash_v2_5)
  // so per-model cost accounting attributes the chars at the right rate.
  recordStartedAttribution(sessionId, text.length, correlationId, client.modelId);

  // Voice-latency plan 2026-06-03 Tier 2b — declare firstByteMs +
  // synthStartNs at the outer scope so the finally block's logger.info
  // row can read them even on the error path. Without this, the
  // throwing path would log undefined.
  let firstByteMs = null;
  let timings = null;
  const synthStartNs = process.hrtime.bigint();

  let terminal = 'failed';
  try {
    const opts = {
      onAudio: (buf) => {
        if (!res.writableEnded) res.write(buf);
      },
    };
    if (useMultiContext) opts.contextId = `conf_${correlationId}`;
    timings = await client.synth(text, opts);
    // ElevenLabsStreamClient stamps timings.firstAudioNs at the first
    // chunk-arrival. Derive ms here so the log + span rows agree.
    if (timings?.firstAudioNs) {
      firstByteMs = Number((timings.firstAudioNs - synthStartNs) / 1000000n);
    }
    terminal = 'completed';
    if (!res.writableEnded) res.end();
    recordOutcome(correlationId, 'sent_to_client', { meta: { sessionId, source: 'confirmation' } });
  } catch (err) {
    terminal = String(err?.message || '').includes('aborted') ? 'cancelled' : 'failed';
    recordOutcome(correlationId, terminal === 'cancelled' ? 'cancelled' : 'synth_failed', {
      meta: { sessionId, source: 'confirmation', error: err?.message },
    });
    if (!res.headersSent) {
      res.status(502).json({ error: err?.message || 'stream_failed' });
    } else if (!res.writableEnded) {
      res.end();
    }
    logger.warn('voice_latency.stream_synth_failed', {
      correlationId,
      sessionId,
      source: 'confirmation',
      error: err?.message,
    });
  } finally {
    recordTerminalAttribution(sessionId, correlationId, terminal, text.length);
    // Voice-latency Tier 2b — emit vendor_first_audio span on the
    // joint-waterfall correlationId so backend voice_latency.span rows
    // join the iOS-span rows by correlation_id. Mirrors the call shape
    // at voice-latency-fast-tts.js:300.
    if (timings) {
      try {
        ElevenLabsStreamClient.logSynthSpans(correlationId, timings, recordSpan);
      } catch (_spanErr) {
        // Telemetry must not break the response path.
      }
    }
    logger.info('ElevenLabs TTS streaming complete', {
      correlationId,
      sessionId,
      // Voice-latency plan 2026-06-03 Tier 2b — turnId echoed onto the
      // row so the §CloudWatch dashboard's `ispresent(turnId)` filter
      // includes streaming-path rows.
      turnId: turnId || null,
      source: 'confirmation',
      terminal,
      textLength: text.length,
      textPreview: text.slice(0, 120),
      output_format: client.outputFormat,
      multi_context: useMultiContext,
      // Tier 2b first-byte split — parallel to the legacy-path
      // ElevenLabs TTS success row's elevenlabs_first_byte_ms field.
      elevenlabs_first_byte_ms: firstByteMs,
    });
  }
}

/**
 * Proxy ElevenLabs TTS calls from the web app
 * POST /api/proxy/elevenlabs-tts
 */
router.post('/proxy/elevenlabs-tts', auth.requireAuth, async (req, res) => {
  try {
    const { getElevenLabsKey } = await import('../services/secrets.js');
    const elevenLabsKey = await getElevenLabsKey();
    if (!elevenLabsKey) {
      return res.status(500).json({ error: 'ElevenLabs API key not configured' });
    }

    // sessionId is OPTIONAL — kept off the 400 path so older clients that
    // only send `{text}` keep working. When iOS includes it (Build 75+) we
    // use it in the success log + the Commit 2 cost-tracker wiring so a
    // single CloudWatch query per session reconstructs the full TTS stream.
    //
    // Stage 1a commit 1a.5 — `source` field. Older iOS builds that don't
    // send it default to 'confirmation' (the only existing flow). When
    // Stage 1b ships, iOS will tag every TTS call with one of:
    //   confirmation  — readback after a successful extraction
    //   correction    — overriding/fixing a prior reading
    //   question      — ask_user TTS
    //   notification  — speakCriticalNotification path (suppression-exempt)
    //   tour          — bundled tour audio (rarely TTS'd via this proxy)
    //   alert         — non-critical alerts (suppression-exempt)
    // Stage 3 (suppression) gates on `source` to decide whether to
    // intercept identical re-asks; Stage 5 (ask_user streaming) routes
    // `question` through a different vendor path. Behaviour is unchanged
    // in 1a.5 — we parse, default, and log it. Tests pin the wire shape.
    // Voice-latency plan 2026-06-03 Tier 2: destructure turnId at the top
    // of the handler so it's in scope for BOTH the cache short-circuit
    // block AND the legacy / streaming logs at the bottom. The §CloudWatch
    // dashboard query filters `ispresent(turnId)`; without this scope fix,
    // every legacy-path ElevenLabs TTS success row is silently filtered
    // out. The existing redundant `const turnId = ...` redeclaration
    // inside the cache try block (originally at :372) is removed to
    // avoid shadowing this outer-scope binding.
    const { text, sessionId, turnId } = req.body;
    const rawSource = req.body?.source;
    const source =
      typeof rawSource === 'string' && rawSource.length > 0 ? rawSource : 'confirmation';
    if (!text) {
      return res.status(400).json({ error: 'text field required' });
    }

    // Loaded Barrel Phase 1.F readiness tracking (plan v10 §C + §G3).
    // Records the iOS Phase 4a adoption signal — whether this POST
    // body includes `turnId` + the `x-expand-version` header — so the
    // GET /api/voice-latency/loaded-barrel-readiness probe can answer
    // "is iOS adoption ≥80% yet?" before the operator flips
    // VOICE_LATENCY_LOADED_BARREL=true. Fire-and-forget; never blocks
    // the TTS POST. userId is the authenticated user id from req.user.
    try {
      const { recordPost } = await import('../extraction/loaded-barrel-readiness.js');
      const userId = req.user?.id || req.user?.user_id || req.user?.email || null;
      const hasTurnId = typeof req.body?.turnId === 'string' && req.body.turnId.length > 0;
      const hasExpanderVersion =
        typeof req.headers?.['x-expand-version'] === 'string' &&
        req.headers['x-expand-version'].length > 0;
      recordPost({ userId, hasTurnId, hasExpanderVersion });
    } catch (_err) {
      // Telemetry must never break the request path. Silently drop.
    }

    // Loaded Barrel Phase 3 (plan v10 §A) — cache short-circuit. If the
    // iOS POST carries a `turnId`, look up the speculator's pre-synth
    // by composite slot key. On HIT serve the MP3 immediately (~30ms).
    // On PENDING race the in-flight synth's promise vs a 200ms timer
    // with re-peek inside the timer callback (covers the case where
    // markReady fires between timer-arm and timer-fire on the same
    // macrotask cycle — plan §A determinism note). On MISS / TIMEOUT
    // fall through to the existing streaming-gate / batch path unchanged.
    //
    // Cache lookup runs BEFORE the streaming-confirmation gate so a
    // HIT skips both the live streaming synth AND the batch fallback.
    // This is the path that delivers the ~470ms latency win.
    //
    // Hard contract: cache short-circuit must NEVER 500 the request
    // path. Any error → log + fall through. Wrapped in outer try/catch.
    try {
      // Voice-latency plan 2026-06-03 Tier 2: turnId is destructured at
      // the top of the handler now (~:329). The redundant local
      // redeclaration that used to live here would have shadowed the
      // outer-scope binding and silently failed to reach the legacy log
      // path's `ispresent(turnId)` filter.
      if (sessionId && turnId) {
        const boardId = req.body?.boardId ?? null;
        const field = req.body?.field ?? null;
        const circuit = req.body?.circuit ?? null;
        const cacheMod = await import('../extraction/loaded-barrel-cache.js');
        const sessionsMod = await import('../extraction/active-sessions.js');
        const { recordOutcome } = await import('../extraction/voice-latency-telemetry.js');
        const cacheKey = cacheMod.buildCacheKey({
          sessionId,
          turnId,
          boardId,
          field,
          circuit,
          expandedText: text,
        });
        const cached = cacheMod.peek(cacheKey);

        if (cached && cached.state === 'ready') {
          if (cacheMod.claim(cacheKey)) {
            res.set('Content-Type', 'audio/mpeg');
            res.set('Cache-Control', 'no-store');
            res.set('X-Voice-Latency-Source', 'loaded_barrel_hit');
            res.set('X-Voice-Latency-Correlation-Id', cached.correlationId);
            res.write(cached.mp3Buffer);
            res.end();
            recordOutcome(cached.correlationId, 'loaded_barrel_hit', {
              meta: { sessionId, bytes: cached.mp3Buffer.length },
            });
            sessionsMod.promoteSpeculativeToCanonicalForSession(sessionId, cached.correlationId);
            return;
          }
          // Claim race lost — another consumer grabbed it. Fall through.
        }

        if (cached && cached.state === 'pending') {
          // Race the in-flight synth's promise vs a 200ms timer. The
          // timer-fire callback re-peeks so we catch a synth completion
          // that lands between the promise.then registration and the
          // timer firing on the same macrotask cycle.
          const winner = await new Promise((resolve) => {
            let settled = false;
            const settle = (v) => {
              if (!settled) {
                settled = true;
                resolve(v);
              }
            };
            cached.promise.then((buf) => {
              if (buf) settle({ type: 'spec', buf });
              else settle({ type: 'timeout' });
            });
            setTimeout(() => {
              const recheck = cacheMod.peek(cacheKey);
              if (recheck && recheck.state === 'ready') {
                settle({ type: 'spec_late', buf: recheck.mp3Buffer });
              } else {
                settle({ type: 'timeout' });
              }
            }, 200);
          });

          if ((winner.type === 'spec' || winner.type === 'spec_late') && winner.buf) {
            if (cacheMod.claim(cacheKey)) {
              const source =
                winner.type === 'spec' ? 'loaded_barrel_hit_pending' : 'loaded_barrel_hit_late';
              res.set('Content-Type', 'audio/mpeg');
              res.set('Cache-Control', 'no-store');
              res.set('X-Voice-Latency-Source', source);
              res.set('X-Voice-Latency-Correlation-Id', cached.correlationId);
              res.write(winner.buf);
              res.end();
              recordOutcome(cached.correlationId, source, {
                meta: { sessionId, bytes: winner.buf.length },
              });
              sessionsMod.promoteSpeculativeToCanonicalForSession(sessionId, cached.correlationId);
              return;
            }
          }
          // Timer fired without ready / claim lost. Supersede the
          // pending entry so the speculator's eventual completion
          // doesn't pointlessly keep it alive.
          cacheMod.markSuperseded(cacheKey, 'ios_post_timeout');
          if (cached.correlationId) {
            recordOutcome(cached.correlationId, 'loaded_barrel_miss', {
              meta: { sessionId, reason: 'pending_timeout' },
            });
          }
        }

        if (!cached) {
          // No entry — MISS. Recorded against a throwaway correlationId
          // so the telemetry analyser can compute MISS rate per session.
          // The speculator's correlationId is unknown here (it was
          // never minted for this slot+text).
          // Use a session-scoped synthetic correlationId so multiple
          // misses don't collide on the same recordOutcome dedupe.
          recordOutcome(`vl_loaded_barrel_miss_${sessionId}_${Date.now()}`, 'loaded_barrel_miss', {
            meta: { sessionId, turnId, field, circuit, boardId },
          });
        }
      }
    } catch (cacheErr) {
      logger.warn('voice_latency.loaded_barrel.shortcircuit_error', {
        sessionId,
        error: cacheErr?.message,
      });
      // Fall through to existing path.
    }

    if (res.headersSent || res.writableEnded) return; // safety after short-circuit

    // Stage 2 commit 2.5 — streaming-confirmations branch.
    // Gate is AND of:
    //   1. source === 'confirmation' — Stage 5 will route 'question'
    //      through ask_user-streaming instead; corrections + notifications
    //      stay on the batch path for now.
    //   2. session has VOICE_LATENCY_STREAM_CONFIRMATIONS=true (per-session
    //      snapshot from 1a.2). A mid-session env flip doesn't change
    //      a session already running.
    //   3. iOS client advertised `streaming_http_audio` capability (1a.3).
    //      Older iOS builds without StreamingAudioPlayer fall through to
    //      the legacy batch path so their AVAudioPlayer keeps working.
    //   4. Kill switch is not active (1a.2 live override).
    if (source === 'confirmation' && sessionId) {
      try {
        const {
          getVoiceLatencyForSession,
          recordElevenLabsStreamingStartedForSession,
          recordElevenLabsStreamingTerminalForSession,
        } = await import('../extraction/active-sessions.js');
        const { isKillSwitchActive } = await import('../extraction/voice-latency-config.js');
        const vl = getVoiceLatencyForSession(sessionId);
        const eligible =
          vl?.flags?.streamConfirmations === true &&
          vl?.capabilities?.hasStreamingHttpAudio === true &&
          !isKillSwitchActive();
        if (eligible) {
          await streamConfirmationViaElevenLabs({
            text,
            sessionId,
            // Voice-latency plan 2026-06-03 Tier 2b — turnId is in scope
            // from the top-level destructure at :329.
            turnId,
            apiKey: elevenLabsKey,
            res,
            useMultiContext: vl.flags.useMultiContext === true,
            recordStartedAttribution: recordElevenLabsStreamingStartedForSession,
            recordTerminalAttribution: recordElevenLabsStreamingTerminalForSession,
          });
          return;
        }
      } catch (err) {
        // Fall through to legacy path on any setup error — never let the
        // streaming gate break the existing flow.
        logger.warn('voice_latency.stream_gate_failed_falling_back', {
          sessionId,
          error: err.message,
        });
      }
    }

    const voiceId = 'Fahco4VZzobUeiPqni1S'; // Archer Conversational
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': elevenLabsKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        // Consolidated turbo→flash 2026-06-26: every live TTS path now runs
        // on eleven_flash_v2_5 (the streaming WS path already did). Flash is
        // ElevenLabs' documented recommended real-time model — Turbo v2.5 is
        // "superseded by" Flash. Contract-preserving for iOS/web: same Archer
        // voice, same default mp3_44100_128 output, same voice_settings; the
        // audio/mpeg byte contract is unchanged, so no client rebuild needed.
        // Both Flash and Turbo bill at 0.5 credits/char ($0.05/1k), so cost is
        // unchanged; the win is lower first-byte latency (~75ms vs ~250ms) and
        // one model across all confirmation paths.
        model_id: 'eleven_flash_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.3,
          use_speaker_boost: true,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('ElevenLabs API rejected request', {
        status: response.status,
        error: errorText.substring(0, 200),
      });
      return res.status(response.status).json({ error: errorText });
    }

    res.set('Content-Type', 'audio/mpeg');
    // Voice-latency plan 2026-06-03 Tier 2a: replace the one-shot
    // response.arrayBuffer() with a streaming reader so we can capture
    // the FIRST byte's wall-clock relative to the synth-start. Without
    // this, the existing "ElevenLabs TTS success" log fires when the
    // FULL audio has arrived — ~400-1200ms LATER than first-byte — and
    // misattributes the gap between server-side synth-complete and
    // iOS-side audible-first-byte. The first-byte stamp is what the
    // perceived-latency dashboard's vendor_first_audio component reads.
    const synthStartMs = Date.now();
    const reader = response.body.getReader();
    const chunks = [];
    let firstByteMs = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByteMs === null) firstByteMs = Date.now() - synthStartMs;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    // Node fetch returns Uint8Array chunks; Buffer.concat accepts them directly.
    const buffer = Buffer.concat(chunks);
    const totalSynthMs = Date.now() - synthStartMs;

    // Attribute the TTS character count to the live session's CostTracker
    // so per-session ElevenLabs cost is no longer zero (previously the
    // tracker field was only populated by the web frontend's direct-cost
    // path; iOS went through this proxy and never accumulated characters).
    // Dynamic import keeps this route module independent of the WS handler
    // module load order — routes are wired at Express startup, but the WS
    // handler doesn't import cleanly at the top of every route file.
    let trackerRecorded = false;
    if (sessionId) {
      try {
        const { recordElevenLabsUsageForSession } =
          await import('../extraction/active-sessions.js');
        // The non-streaming proxy POST above synthesises with eleven_flash_v2_5
        // (consolidated from turbo 2026-06-26) — attribute the chars at the
        // Flash rate so per-model cost accounting matches the model actually used.
        trackerRecorded = recordElevenLabsUsageForSession(
          sessionId,
          text.length,
          'eleven_flash_v2_5'
        );
      } catch (err) {
        logger.warn('ElevenLabs cost attribution failed', {
          sessionId,
          error: err.message,
        });
      }
    }

    // INV-2 (field session 6B6FE011 F1): bytes-per-char ratio of the synth.
    // ElevenLabs Flash occasionally returns garbled audio that is wildly
    // LONGER than the text warrants — F1 saw 172,661 bytes (~11s @128kbps)
    // for a 33-char address read-back (≈5232 bytes/char) while the 42-char
    // twin synthesised normally at 41,839 bytes (≈996 bytes/char). Normal
    // synth runs ~1000-1300 bytes/char, so a guarded ABSOLUTE threshold of
    // 2500 separates the garble class cleanly with no session-median state
    // to maintain (the DECIDED rule). textLength>0 is defensive — the 400
    // guard above already rejects empty text — and avoids a divide-by-zero
    // ratio ever reaching the log.
    const bytesPerChar =
      text.length > 0 ? Math.round((buffer.length / text.length) * 10) / 10 : null;

    // Record what was actually spoken + how much Sonnet-wording the
    // inspector heard. `textPreview` (first 120 chars) is sufficient to
    // pair with the QuestionGate "Flushing questions to iOS" log — we just
    // need enough to visually match. `trackerRecorded` surfaces whether the
    // CostTracker attribution landed so we can spot orphaned TTS calls
    // (e.g. TTS after WS close) in CloudWatch.
    logger.info('ElevenLabs TTS success', {
      sessionId: sessionId || null,
      // Voice-latency plan 2026-06-03 Tier 2a: turnId is destructured at
      // the top of the handler now. The §CloudWatch perceived-latency
      // dashboard joins these rows by (sessionId, turnId); without the
      // field on the row the `ispresent(turnId)` filter drops every
      // legacy-path entry.
      turnId: turnId || null,
      source,
      textPreview: text.slice(0, 120),
      textLength: text.length,
      bytes: buffer.length,
      trackerRecorded,
      // Voice-latency Tier 2a: first-byte vs full-buffer split. Together
      // these decompose the formerly-monolithic "ElevenLabs TTS success"
      // event-pair gap into vendor-network-first-byte + vendor-tail.
      elevenlabs_first_byte_ms: firstByteMs,
      elevenlabs_synth_total_ms: totalSynthMs,
      // INV-2: audio-size-to-text-size ratio (see the anomaly WARN below).
      bytes_per_char: bytesPerChar,
    });

    // INV-2 anomaly event — a dedicated WARN row (not just the field on the
    // success log) so a single CloudWatch Insights query over the WARN level
    // surfaces every garbled synth without scanning the success firehose.
    // Strictly-greater-than so a boundary-exact ratio doesn't page; the
    // garble class sits at ~2x the threshold and normal synth at ~half, so
    // the boundary carries no signal either way. model_id mirrors the
    // literal in the synth POST body above — the non-streaming proxy is
    // pinned to Flash (consolidated 2026-06-26); the streaming WS path has
    // its own client and is deliberately OUT OF SCOPE for this check.
    if (text.length > 0 && bytesPerChar > 2500) {
      logger.warn('elevenlabs_tts_audio_anomaly', {
        sessionId: sessionId || null,
        turnId: turnId || null,
        source,
        bytes: buffer.length,
        textLength: text.length,
        bytes_per_char: bytesPerChar,
        model_id: 'eleven_flash_v2_5',
        textPreview: text.slice(0, 120),
      });
    }
    res.send(buffer);
  } catch (error) {
    logger.error('ElevenLabs TTS proxy error', { error: error.message });
    res.status(500).json({ error: 'ElevenLabs TTS proxy request failed' });
  }
});

/**
 * Create a short-lived Deepgram API key for iOS WebSocket connections.
 * POST /api/proxy/deepgram-streaming-key
 *
 * Creates a temporary Deepgram API key (600s TTL) via the Deepgram REST API.
 * The iOS app connects directly to Deepgram via WebSocket for real-time
 * transcription, which cannot be proxied through the backend.
 *
 * The master Deepgram key is NEVER sent to the client. Only short-lived
 * temp keys with limited scopes are returned.
 */

async function getDeepgramProjectId(masterKey) {
  // Check cached value first
  if (cachedProjectId) return cachedProjectId;

  // Try env/secrets
  const envProjectId = await getSecret('DEEPGRAM_PROJECT_ID');
  if (envProjectId) {
    cachedProjectId = envProjectId;
    return cachedProjectId;
  }

  // Discover via Deepgram REST API
  const projectsResponse = await fetch('https://api.deepgram.com/v1/projects', {
    headers: { Authorization: `Token ${masterKey}` },
  });

  if (!projectsResponse.ok) {
    throw new Error(`Deepgram projects lookup failed: ${projectsResponse.status}`);
  }

  const projects = await projectsResponse.json();
  const projectId = projects.projects?.[0]?.project_id;

  if (!projectId) {
    throw new Error('No Deepgram project found');
  }

  cachedProjectId = projectId;
  return cachedProjectId;
}

/**
 * Create a short-lived Deepgram access token via /v1/auth/grant.
 * This is the modern token endpoint — simpler, doesn't require keys:write scope,
 * and produces JWT-style access tokens that work with WebSocket subprotocol auth.
 * The old /v1/projects/{id}/keys endpoint is deprecated and "too problematic"
 * per Deepgram community feedback.
 *
 * Token only needs to be valid at WS connection time — the WebSocket stays open
 * after token expiry. 30s TTL gives enough headroom for the client to connect.
 */
async function createDeepgramTempKey(userId) {
  const masterKey = await getDeepgramKey();
  if (!masterKey) {
    throw new Error('Deepgram API key not configured');
  }

  const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: {
      Authorization: `Token ${masterKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      time_to_live_in_seconds: 30,
      scopes: ['usage:write'],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Deepgram token grant failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  logger.info('Deepgram temp token created via /v1/auth/grant', { userId, ttl: 30 });
  return data.access_token;
}

router.post('/proxy/deepgram-streaming-key', auth.requireAuth, async (req, res) => {
  const userId = req.user?.id || req.user?.userId || 'unknown';

  try {
    const key = await createDeepgramTempKey(userId);
    logger.info('Deepgram temp streaming key issued', { userId });
    res.json({ key });
  } catch (error) {
    // P0-10 — NEVER fall back to the master key. The previous code
    // returned the Deepgram master API key directly to the browser
    // when temp-token creation failed, which is a standing credential
    // leak — that key has full project scope and lives for the
    // lifetime of the secret, not 30s. Temp-token failures are almost
    // always transient (Deepgram /auth/grant rate limit, network
    // blip, clock skew) so the correct response is 503 and let the
    // client retry. A true outage will surface as "recording
    // unavailable" in the UI rather than a silent credential
    // exfiltration.
    logger.error('Deepgram temp token grant failed', {
      userId,
      error: error.message,
    });
    res.status(503).json({
      error: 'Deepgram streaming key temporarily unavailable. Please retry.',
      code: 'deepgram_temp_token_failed',
    });
  }
});

/**
 * Get remote config for CertMate iOS app
 * GET /api/config/certmate
 */
router.get('/config/certmate', async (req, res) => {
  try {
    const configContent = await storage.downloadText('config/certmate_config.json');
    if (configContent) {
      res.setHeader('Content-Type', 'application/json');
      res.send(configContent);
      return;
    }
    res.json({
      config_version: 1,
      last_updated: new Date().toISOString(),
      message: 'No remote config found — using bundled default',
    });
  } catch (error) {
    logger.error('Failed to serve remote config', { error: error.message });
    res.status(500).json({ error: 'Failed to load config' });
  }
});

export default router;
