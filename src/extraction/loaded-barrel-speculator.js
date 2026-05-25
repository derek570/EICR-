/**
 * Loaded Barrel Phase 2.B — per-session speculator (plan v10 §C + §A).
 *
 * Subscribes to runToolLoop's onSnapshotPatch + onLoopComplete hooks
 * (Phase 2.C). For every new/overwritten reading that produces a
 * meaningful confirmation text, opens an ElevenLabs WS to pre-synth
 * the audio, parks the MP3 buffer in the loaded-barrel-cache, and
 * lets iOS's TTS POST claim it on arrival.
 *
 * Architecture (plan v10 §C):
 *
 *   onSnapshotPatch({patch, raw, ctx}) →
 *     1. invalidate matching cache entries for cleared / overwritten /
 *        removed readings (so we don't serve audio for stale slots).
 *     2. prune-on-board-transition: add_board → drop unboarded entries;
 *        select_board → drop entries whose boardId doesn't match.
 *     3. speculate(slot) for each added or overwritten reading. The
 *        speculator computes the same buildConfirmationText the bundler
 *        will compute, expandForTTS it, mints a correlationId, opens
 *        an MP3 synth, parks a pending cache entry. On synth complete:
 *        markReady → resolve promise → record terminal.
 *
 * Concurrency:
 *   - Per-turn cap (default 2 via VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN)
 *     prevents a single multi-write turn from blowing out ElevenLabs
 *     quota.
 *   - Per-correlation idempotency on the cost-tracker side (Started +
 *     Terminal both dedupe).
 *   - Multiple in-flight synths per session are allowed.
 *
 * Cost attribution (plan v10 §D):
 *   - Every speculative synth: recordElevenLabsSpeculativeStarted
 *     (billed when text-sent) + Terminal (completed/cancelled/failed).
 *   - keys.js HIT path: promoteSpeculativeToCanonical (credits charsServed,
 *     so reports can split HIT vs WASTED).
 *
 * Hard rule (plan v10 § hooks invariant):
 *   - Speculator MUST NOT throw out of onSnapshotPatch / onLoopComplete.
 *     The runToolLoop wraps both in try/catch but exceptions still cost
 *     a log line and an analyst's attention — keep the speculator's
 *     internal try/catch tight.
 */

import { ElevenLabsStreamClient } from './elevenlabs-stream-client.js';
import { shouldGenerateConfirmation, buildConfirmationText } from './confirmation-text.js';
import { expandForTTS } from './tts-text-expander.js';
import {
  buildCacheKey,
  set as cacheSet,
  peek as cachePeek,
  markReady,
  markSuperseded,
  invalidateBySlot,
  pruneSessionUnboardedEntries,
  pruneMismatchedBoardEntries,
  pruneForSession,
} from './loaded-barrel-cache.js';
import { mintCorrelationId, recordOutcome } from './voice-latency-telemetry.js';
import { getLoadedBarrelMaxPerTurn } from './voice-latency-config.js';
import { decodeReadingKey, decodeBoardReadingKey } from './stage6-per-turn-writes.js';
import { coerceRecordReadingValue } from './record-reading-coercion.js';

const DEFAULT_OUTPUT_FORMAT = 'mp3_22050_32';

/**
 * Parse a circuit string back to an integer if it round-trips cleanly,
 * else null. Mirrors the bundler's circuit-coercion logic.
 */
function parseCircuit(circuitStr) {
  if (circuitStr == null || circuitStr === '') return null;
  const n = Number(circuitStr);
  if (Number.isInteger(n) && String(n) === String(circuitStr)) return n;
  return null;
}

/**
 * Build the default ElevenLabs client factory. Tests inject an
 * alternative via `clientFactory` so they don't open real WSes.
 */
function defaultClientFactory({ apiKey, outputFormat }) {
  return new ElevenLabsStreamClient({
    apiKey,
    outputFormat: outputFormat || DEFAULT_OUTPUT_FORMAT,
    // Always single-shot (plan v10 §F1) — multi-context pooling is
    // intentionally out of scope so we don't introduce cross-turn
    // audio-bleed risk in v10.
  });
}

/**
 * Construct a per-session speculator. Each session WS gets one of
 * these on session_start; the hooks pipe into runToolLoop opts.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string|Function} opts.apiKey — string OR async function
 *   returning the key. The fn form lets the speculator survive a
 *   secret-rotation without restart.
 * @param {CostTracker} opts.costTracker — session-local CostTracker
 *   instance. The speculator records every speculative Started +
 *   Terminal on it; the keys.js HIT path later calls
 *   promoteSpeculativeToCanonical via the same instance.
 * @param {object} [opts.logger] — Winston-shaped logger.
 * @param {Function} [opts.clientFactory] — test injection. Defaults
 *   to a fresh ElevenLabsStreamClient.
 * @param {string} [opts.outputFormat] — overrides MP3 default.
 *
 * @returns {{
 *   onSnapshotPatch: Function,
 *   onLoopComplete: Function,
 *   shutdown: Function,
 *   _internalState: object  // test-only inspection
 * }}
 */
export function createSpeculator({
  sessionId,
  apiKey,
  costTracker,
  logger = null,
  clientFactory = defaultClientFactory,
  outputFormat = DEFAULT_OUTPUT_FORMAT,
}) {
  if (!sessionId) throw new TypeError('createSpeculator: sessionId required');
  if (!costTracker) throw new TypeError('createSpeculator: costTracker required');

  let currentTurnId = null;
  let perTurnCount = 0;
  // Pending AbortControllers so shutdown can abort every in-flight
  // synth in one shot. Cleared on terminal of each speculation.
  const pendingControllers = new Set();

  function _resetTurnCapIfNew(turnId) {
    if (currentTurnId !== turnId) {
      currentTurnId = turnId;
      perTurnCount = 0;
    }
  }

  function _resolveApiKey() {
    if (typeof apiKey === 'function') return apiKey();
    return apiKey;
  }

  async function _speculate({ field, circuit, boardId, value, confidence, turnId }) {
    // Confidence + friendly-name gate. shouldGenerateConfirmation is
    // a fast-path skip that doesn't touch buildConfirmationText.
    if (!shouldGenerateConfirmation({ field, confidence })) return;
    const text = buildConfirmationText(field, value, circuit);
    if (!text) return;
    const expandedText = expandForTTS(text);
    if (!expandedText) return;

    _resetTurnCapIfNew(turnId);
    const cap = getLoadedBarrelMaxPerTurn();
    if (perTurnCount >= cap) {
      // Mint a throwaway correlationId for telemetry so cap-skipped
      // events are still attributable to a session+slot.
      const capCid = mintCorrelationId(sessionId, 'loaded_barrel');
      recordOutcome(capCid, 'loaded_barrel_cap_skipped', {
        meta: { sessionId, turnId, field, circuit, boardId, cap },
      });
      return;
    }
    perTurnCount += 1;

    const cacheKey = buildCacheKey({
      sessionId,
      turnId,
      boardId,
      field,
      circuit,
      expandedText,
    });
    // Dedupe: if there's already an entry for this exact slot+text
    // (same dispatch resurfaced via re-record_reading of identical
    // value), skip — the existing entry will serve.
    if (cachePeek(cacheKey)) {
      perTurnCount -= 1; // un-count the cap; this wasn't really new
      return;
    }

    const correlationId = mintCorrelationId(sessionId, 'loaded_barrel');
    if (!costTracker.recordElevenLabsSpeculativeStarted(expandedText.length, correlationId)) {
      // Dedupe or invalid input — bail. The Started call already
      // logged a warning if invalid.
      return;
    }

    const controller = new AbortController();
    pendingControllers.add(controller);

    let resolvePromise;
    const promise = new Promise((r) => {
      resolvePromise = r;
    });
    cacheSet({
      cacheKey,
      sessionId,
      turnId,
      boardId,
      field,
      circuit,
      expandedText,
      correlationId,
      promise,
      resolvePromise,
      controller,
    });

    recordOutcome(correlationId, 'loaded_barrel_started', {
      meta: {
        sessionId,
        turnId,
        field,
        circuit,
        boardId,
        textLength: expandedText.length,
      },
    });

    // Synth fires asynchronously — the speculator's onSnapshotPatch
    // returns immediately so runToolLoop's dispatch isn't blocked by
    // ElevenLabs latency. Errors logged + recorded; never thrown.
    let resolvedApiKey;
    try {
      resolvedApiKey = await _resolveApiKey();
    } catch (err) {
      _onSynthError(correlationId, cacheKey, controller, resolvePromise, err);
      return;
    }
    if (!resolvedApiKey) {
      _onSynthError(
        correlationId,
        cacheKey,
        controller,
        resolvePromise,
        new Error('no_elevenlabs_api_key')
      );
      return;
    }

    let client;
    try {
      client = clientFactory({ apiKey: resolvedApiKey, outputFormat });
    } catch (err) {
      _onSynthError(correlationId, cacheKey, controller, resolvePromise, err);
      return;
    }

    const audioChunks = [];
    client
      .synth(expandedText, {
        onAudio: (buf) => {
          if (buf && buf.length) audioChunks.push(buf);
        },
        signal: controller.signal,
      })
      .then((_timings) => {
        pendingControllers.delete(controller);
        const mp3Buffer = Buffer.concat(audioChunks);
        // Plan §A determinism: CAS pending→ready BEFORE resolving
        // promise. If CAS fails the entry was already terminated by
        // a prune/invalidate while synth was in flight — discard the
        // audio.
        const casOk = markReady(cacheKey, mp3Buffer);
        if (casOk) {
          try {
            resolvePromise(mp3Buffer);
          } catch (_e) {
            /* never throw from resolve */
          }
          recordOutcome(correlationId, 'loaded_barrel_fired', {
            meta: { sessionId, bytes: mp3Buffer.length },
          });
          costTracker.recordElevenLabsSpeculativeTerminal(correlationId, 'completed');
        } else {
          // Late synth completion after abort. The buffer is thrown
          // away. Terminal is 'cancelled' for cost-tracking purposes.
          recordOutcome(correlationId, 'loaded_barrel_discarded', {
            meta: { sessionId, reason: 'late_synth_completion_after_abort' },
          });
          costTracker.recordElevenLabsSpeculativeTerminal(correlationId, 'cancelled');
        }
        if (client && typeof client.close === 'function') {
          try {
            client.close();
          } catch (_e) {
            /* ignore */
          }
        }
      })
      .catch((err) =>
        _onSynthError(correlationId, cacheKey, controller, resolvePromise, err, client)
      );
  }

  function _onSynthError(correlationId, cacheKey, controller, resolvePromise, err, client) {
    pendingControllers.delete(controller);
    const msg = err?.message || String(err);
    const aborted = msg.includes('aborted');
    if (aborted) {
      recordOutcome(correlationId, 'loaded_barrel_aborted', {
        meta: { sessionId, reason: msg },
      });
      costTracker.recordElevenLabsSpeculativeTerminal(correlationId, 'cancelled');
    } else {
      recordOutcome(correlationId, 'loaded_barrel_discarded', {
        meta: { sessionId, error: msg },
      });
      costTracker.recordElevenLabsSpeculativeTerminal(correlationId, 'failed');
    }
    // Belt-and-braces: mark cache entry superseded if still pending so
    // any peer awaiter unblocks.
    markSuperseded(cacheKey, aborted ? 'synth_aborted' : 'synth_failed');
    try {
      resolvePromise(null);
    } catch (_e) {
      /* ignore */
    }
    if (client && typeof client.close === 'function') {
      try {
        client.close();
      } catch (_e) {
        /* ignore */
      }
    }
    logger?.warn?.('voice_latency.loaded_barrel.synth_error', {
      sessionId,
      correlationId,
      aborted,
      error: msg,
    });
  }

  function onSnapshotPatch({ patch, raw: _raw, ctx }) {
    if (!patch || !ctx) return;
    const turnId = ctx.turnId;
    try {
      // 1. Invalidate stale entries FIRST so we don't speculate on a
      //    slot the same dispatch is about to overwrite.
      for (const removed of patch.readings.removed) {
        const slot = decodeReadingKey(removed.key);
        invalidateBySlot(sessionId, {
          boardId: slot.boardId,
          field: slot.field,
          circuit: slot.circuit,
        });
      }
      for (const overwritten of patch.readings.overwritten) {
        const slot = decodeReadingKey(overwritten.key);
        invalidateBySlot(sessionId, {
          boardId: slot.boardId,
          field: slot.field,
          circuit: slot.circuit,
        });
      }
      for (const removed of patch.boardReadings.removed) {
        const slot = decodeBoardReadingKey(removed.key);
        invalidateBySlot(sessionId, { boardId: slot.boardId, field: slot.field, circuit: null });
      }
      for (const overwritten of patch.boardReadings.overwritten) {
        const slot = decodeBoardReadingKey(overwritten.key);
        invalidateBySlot(sessionId, { boardId: slot.boardId, field: slot.field, circuit: null });
      }
      for (const cleared of patch.cleared) {
        invalidateBySlot(sessionId, {
          boardId: cleared.board_id ?? null,
          field: cleared.field,
          circuit: cleared.circuit,
        });
      }

      // 2. Board-op pruning. add_board → drop the session's unboarded
      //    entries because the model may re-attribute existing readings.
      //    select_board → drop entries for boards other than the new
      //    working one.
      for (const op of patch.boardOps) {
        if (op.op === 'add_board') {
          pruneSessionUnboardedEntries(sessionId);
        } else if (op.op === 'select_board') {
          pruneMismatchedBoardEntries(sessionId, op.board_id ?? null);
        }
      }

      // 3. Speculate on added + overwritten (the new value, not the old).
      for (const added of patch.readings.added) {
        const slot = decodeReadingKey(added.key);
        const entry = added.value;
        _speculate({
          field: slot.field,
          circuit: parseCircuit(slot.circuit),
          boardId: slot.boardId,
          value: entry.value,
          confidence: entry.confidence,
          turnId,
        });
      }
      for (const overwritten of patch.readings.overwritten) {
        const slot = decodeReadingKey(overwritten.key);
        const entry = overwritten.after;
        _speculate({
          field: slot.field,
          circuit: parseCircuit(slot.circuit),
          boardId: slot.boardId,
          value: entry.value,
          confidence: entry.confidence,
          turnId,
        });
      }
      for (const added of patch.boardReadings.added) {
        const slot = decodeBoardReadingKey(added.key);
        const entry = added.value;
        _speculate({
          field: slot.field,
          circuit: null,
          boardId: slot.boardId,
          value: entry.value,
          confidence: entry.confidence,
          turnId,
        });
      }
      for (const overwritten of patch.boardReadings.overwritten) {
        const slot = decodeBoardReadingKey(overwritten.key);
        const entry = overwritten.after;
        _speculate({
          field: slot.field,
          circuit: null,
          boardId: slot.boardId,
          value: entry.value,
          confidence: entry.confidence,
          turnId,
        });
      }
    } catch (err) {
      logger?.error?.('voice_latency.loaded_barrel.patch_handler_error', {
        sessionId,
        turnId,
        error: err?.message,
      });
      // Swallow — runToolLoop's outer try/catch is the safety net,
      // but we don't want to surface a speculator bug as a dispatch
      // error in the logs.
    }
  }

  /**
   * Phase 5 drift-detector stub. Today: no-op. Future commits add
   * compute-bundler-text-now-vs-speculator-text comparison and emit
   * loaded_barrel_text_drift_detected on mismatch.
   */
  function onLoopComplete(_evt) {
    // intentional no-op for Phase 2.B. Phase 5 drift detector lands
    // separately and may simply replace this function.
  }

  /**
   * Loaded Barrel Phase 2.D (2026-05-25) — streamed-tool hook.
   *
   * Fires from inside runToolLoop's per-round stream loop the moment a
   * tool_use's `content_block_stop` finalises its input. The phase 2.B
   * onSnapshotPatch path still fires LATER (after the post-stream
   * dispatch loop runs the dispatcher); this hook gives the
   * speculator a head start of ~hundreds of ms per multi-tool turn
   * because Sonnet's stream is still emitting subsequent tool_use
   * blocks when we start the ElevenLabs pre-synth.
   *
   * Dedup is via the existing cachePeek check in `_speculate` — the
   * onSnapshotPatch fire that arrives later for the same slot sees
   * the cache key already populated and bails without double-billing
   * the cap.
   *
   * Value coercion: applies the same record_reading coercion the
   * dispatcher applies (BS-EN canonicalisation, polarity enum), so
   * the speculator-text doesn't drift from the bundler-text the
   * dispatcher will produce. Shared helper at
   * `record-reading-coercion.js`.
   *
   * Scope: ONLY `record_reading` is handled. board_reading,
   * observations, circuit ops, and dialogue-script writes go through
   * onSnapshotPatch as before. Extending to other tools is a
   * follow-up; record_reading is by far the dominant multi-tool
   * pattern (3+ readings per OCPD utterance, multi-circuit batches,
   * etc.) so this covers the highest-value cases first.
   *
   * Error records (invalid_json / orphan_delta from the assembler)
   * have no input — silently skipped.
   *
   * @param {{record: object, ctx: {sessionId, turnId, roundIdx}}} evt
   */
  function onToolUseStreamed({ record, ctx }) {
    if (!record || !ctx) return;
    if (record.error) return; // assembler couldn't parse — no input to speculate from
    if (record.name !== 'record_reading') return;
    const input = record.input;
    if (!input || typeof input !== 'object') return;

    const field = input.field;
    const rawValue = input.value;
    if (typeof field !== 'string' || typeof rawValue !== 'string') return;

    const circuit = parseCircuit(input.circuit);
    if (circuit == null) return;

    // Apply the same coercion the dispatcher applies — otherwise the
    // pre-synth text would drift from the bundler's post-coercion text
    // (e.g. "polarity confirmed true" vs "polarity confirmed Y"),
    // producing a parity_mismatch + cache MISS at iOS POST time.
    const value = coerceRecordReadingValue(field, rawValue);

    _speculate({
      field,
      circuit,
      boardId: typeof input.board_id === 'string' ? input.board_id : null,
      value,
      confidence: typeof input.confidence === 'number' ? input.confidence : 1.0,
      turnId: ctx.turnId,
    }).catch((err) => {
      // _speculate already swallows synth errors internally; this
      // catch is belt-and-braces for any sync-throw before the synth
      // promise is even attached.
      logger?.warn?.('voice_latency.loaded_barrel.streamed_speculate_error', {
        sessionId,
        turnId: ctx.turnId,
        field,
        circuit,
        error: err?.message,
      });
    });
  }

  /**
   * Tear down on session_stop / WS close. Aborts every in-flight
   * controller + drops every session entry from the cache (which also
   * resolves their pending promises with null).
   */
  function shutdown() {
    for (const c of pendingControllers) {
      try {
        c.abort();
      } catch (_e) {
        /* ignore */
      }
    }
    pendingControllers.clear();
    pruneForSession(sessionId);
    currentTurnId = null;
    perTurnCount = 0;
  }

  return {
    onSnapshotPatch,
    onLoopComplete,
    onToolUseStreamed,
    shutdown,
    _internalState: {
      get pendingCount() {
        return pendingControllers.size;
      },
      get perTurnCount() {
        return perTurnCount;
      },
      get currentTurnId() {
        return currentTurnId;
      },
    },
  };
}
