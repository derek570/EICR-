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
 * Single-round latency sprint Phase 1 (PLAN_v8, Pivots 9 / 11.4 / 11.6 /
 * 11.7 / 11.9 / 11.10 / 11.11):
 *
 *   - The Mode-A fast-TTS route writes (turnId, slotKey) into
 *     `entry.pendingFastTtsSlots` BEFORE responding to iOS. _speculate's
 *     shared preflight checks this set and short-circuits BEFORE
 *     opening a cost ledger — iOS will play the fast-path audio and
 *     ignore the speculator buffer anyway, so we save the ElevenLabs
 *     character spend entirely.
 *
 *   - recordElevenLabsSpeculativeStarted is now called IMMEDIATELY
 *     before client.synth() rather than upfront. The pre-text path
 *     (api-key resolve / client construction / abort already fired)
 *     never opens a cost ledger entry, so a pre-text abort emits
 *     `loaded_barrel_pretext_abort` and exits cleanly with no
 *     Terminal owed.
 *
 *   - `costOpenByCorrelation: Set` is per-speculator state. Membership
 *     = "ledger is open and owes exactly one Terminal on THIS
 *     instance's costTracker." The shutdown sweep + late terminals
 *     route through _maybeRecordTerminal which dedupes (Set.has →
 *     Set.delete → costTracker call) so the cost-integrity invariant
 *     `charsCompleted + charsCancelled + charsFailed === charsStarted`
 *     holds across every code path.
 *
 *   - The Set is scoped INSIDE createSpeculator's closure (alongside
 *     pendingControllers / pendingByCorrelation), so shutdown can ONLY
 *     touch this instance's costTracker. Cross-session contamination
 *     is structurally impossible.
 *
 *   - abortBySlot({sessionId, turnId, boardId, field, circuit}) lets
 *     the fast-TTS route cancel an in-flight speculation when iOS just
 *     posted for the same slot. slotMatches normalises empty-string
 *     boardId to null and coerces circuit via Number() so the route's
 *     loose input shape matches the speculator's strict-typed
 *     internal shape.
 *
 *   - The two new telemetry events (`speculative_terminal_reason`,
 *     `speculative_terminal_skipped`) emit via direct logger.info,
 *     NOT recordOutcome — they are observability events, not outcome
 *     waterfall states. SERVER_OUTCOMES enum is untouched.
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
import { getActiveSessionEntry } from './active-sessions.js';

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
 * Build the slotKey string used by both pendingFastTtsSlots writes
 * (from voice-latency-fast-tts route) and the speculator's preflight
 * skip check. Stable across both sides — boardId normalised so the
 * route's "" doesn't miss the speculator's null.
 */
function buildSlotKey({ field, circuit, boardId }) {
  const normBoardId = typeof boardId === 'string' && boardId.length > 0 ? boardId : '';
  return `${field}::${circuit ?? 'null'}::${normBoardId}`;
}

/**
 * slotMatches predicate for abortBySlot. The fast-TTS route passes
 * loose-typed input (boardId may be empty string for single-board,
 * circuit may be a number or numeric string). Normalise into the
 * speculator's stricter internal shape: empty boardId → null;
 * circuit via Number(); circuit:0 stays distinct from circuit:null.
 */
function slotMatches(entrySlot, target) {
  const entryBoardId =
    typeof entrySlot.boardId === 'string' && entrySlot.boardId.length > 0
      ? entrySlot.boardId
      : null;
  const targetBoardId =
    typeof target.boardId === 'string' && target.boardId.length > 0 ? target.boardId : null;
  if (entryBoardId !== targetBoardId) return false;
  if (entrySlot.field !== target.field) return false;

  const entryCircuit = entrySlot.circuit == null ? null : Number(entrySlot.circuit);
  const targetCircuit = target.circuit == null ? null : Number(target.circuit);
  // circuit:0 must not match circuit:null (board-readings are 0; null
  // means "any" which we deliberately don't support here).
  if (entryCircuit === null && targetCircuit === null) return true;
  if (entryCircuit === null || targetCircuit === null) return false;
  return entryCircuit === targetCircuit;
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
 *   onToolUseStreamed: Function,
 *   abortBySlot: Function,
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

  // Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 4 / 11).
  // Map from correlationId → { slot: {field, circuit, boardId},
  // controller, cacheKey }. Lets abortBySlot walk every in-flight
  // speculation and match by slot tuple. Cleared via .delete on
  // terminal AND on shutdown.clear().
  const pendingByCorrelation = new Map();

  // Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 11.9 — scope
  // correction).  Set of correlation ids whose Started call has
  // succeeded but whose Terminal has not yet fired. Membership is the
  // ONLY source of truth for "is this correlation's ledger entry
  // open?" — we do NOT consult the cache (entries can be
  // pruned/superseded BEFORE deferred terminal handlers run, which
  // would leave orphan charsStarted without a matching terminal
  // bucket).
  //
  // SCOPE: instance-local (same lifetime as pendingControllers). The
  // shutdown sweep iterates only this instance's Set, so cross-session
  // contamination is structurally impossible — both the Set and the
  // _maybeRecordTerminal closure are captured in createSpeculator's
  // scope.
  const costOpenByCorrelation = new Set();

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

  /**
   * Dedupe-gated terminal recorder. Routes ALL terminal calls through
   * one helper so the cost-integrity invariant holds across every
   * code path: synth-complete, synth-error, abort, supersede,
   * prune-on-board-transition, TTL expiry, abortBySlot, shutdown
   * sweep. cacheKey is DIAGNOSTIC ONLY — never used for the cost
   * decision. The decision is `costOpenByCorrelation.has(correlationId)`.
   *
   * On first terminal call for an open ledger:
   *   - Set.delete(correlationId) — idempotency (subsequent calls
   *     skip).
   *   - costTracker.recordElevenLabsSpeculativeTerminal(...) — credits
   *     the right bucket.
   *   - logger.info('voice_latency.speculative_terminal_reason', ...)
   *     if opts.reason — observability emission, NOT through
   *     recordOutcome (Pivot 11.10).
   *
   * On terminal for a closed ledger (pre-text abort, or duplicate
   * terminal):
   *   - Emits logger.info('voice_latency.speculative_terminal_skipped',
   *     ...) so we have a paper trail. Both branches are legitimate.
   */
  function _maybeRecordTerminal(correlationId, cacheKey, terminal, opts = {}) {
    if (costOpenByCorrelation.has(correlationId)) {
      costOpenByCorrelation.delete(correlationId);
      costTracker.recordElevenLabsSpeculativeTerminal(correlationId, terminal, opts);
      if (opts.reason) {
        // Direct logger.info — NOT recordOutcome. See module header.
        logger?.info?.('voice_latency.speculative_terminal_reason', {
          correlationId,
          terminal,
          reason: opts.reason,
          cacheKey,
          sessionId,
        });
      }
      return true;
    }
    // Either pre-text abort OR prior terminal already closed the
    // ledger. Both legitimate; direct logger.info for telemetry.
    logger?.info?.('voice_latency.speculative_terminal_skipped', {
      correlationId,
      terminal_attempted: terminal,
      reason: opts.reason ?? null,
      cacheKey,
      sessionId,
    });
    return false;
  }

  async function _speculate({ field, circuit, boardId, value, confidence, turnId }) {
    // Confidence + friendly-name gate. shouldGenerateConfirmation is
    // a fast-path skip that doesn't touch buildConfirmationText.
    if (!shouldGenerateConfirmation({ field, confidence })) return;
    const text = buildConfirmationText(field, value, circuit);
    if (!text) return;
    const expandedText = expandForTTS(text);
    if (!expandedText) return;

    // Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 9). If the
    // fast-TTS route has already accepted a POST for this exact slot
    // this turn, iOS is going to play the MP3 itself and IGNORE
    // whatever the speculator produces — so don't even open a cost
    // ledger entry. Both entry points to the speculator (onToolUseStreamed
    // AND onSnapshotPatch) route through here, so a single check covers
    // both.
    const slotKey = buildSlotKey({ field, circuit, boardId });
    const entry = getActiveSessionEntry(sessionId);
    const pendingFastTtsForTurn = entry?.pendingFastTtsSlots?.get(turnId);
    if (pendingFastTtsForTurn?.has(slotKey)) {
      logger?.info?.('voice_latency.loaded_barrel_skipped_fast_tts_hint', {
        sessionId,
        turnId,
        field,
        circuit,
        boardId,
      });
      return;
    }

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
    // Dedupe gate #1 — cachePeek before any work. If there's already
    // an entry for this exact slot+text (same dispatch resurfaced via
    // re-record_reading of identical value), skip — the existing entry
    // will serve.
    if (cachePeek(cacheKey)) {
      perTurnCount -= 1; // un-count the cap; this wasn't really new
      return;
    }

    const correlationId = mintCorrelationId(sessionId, 'loaded_barrel');
    const controller = new AbortController();
    pendingControllers.add(controller);
    pendingByCorrelation.set(correlationId, {
      slot: { field, circuit, boardId },
      controller,
      cacheKey,
    });

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

    // Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 11.4) —
    // Started moved past the text-sent boundary. The pre-text path
    // below (api-key resolve / client construction / abort already
    // fired) MUST NOT open a cost ledger entry; if any of these
    // synchronous steps fail or the controller already fired we
    // unwind cleanly with `loaded_barrel_pretext_abort` and no
    // matching Terminal owed.
    let resolvedApiKey;
    try {
      resolvedApiKey = await _resolveApiKey();
    } catch (err) {
      _onPreTextAbort(correlationId, cacheKey, controller, resolvePromise, err);
      return;
    }
    if (!resolvedApiKey) {
      _onPreTextAbort(
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
      _onPreTextAbort(correlationId, cacheKey, controller, resolvePromise, err);
      return;
    }

    // Abort-already-fired guard (Pivot 11.4): if abortBySlot or
    // shutdown beat us to the punch during the async api-key /
    // factory step, exit BEFORE Started so the ledger stays closed.
    if (controller.signal.aborted) {
      _onPreTextAbort(
        correlationId,
        cacheKey,
        controller,
        resolvePromise,
        new Error('aborted_before_text_sent')
      );
      if (client && typeof client.close === 'function') {
        try {
          client.close();
        } catch (_e) {
          /* ignore */
        }
      }
      return;
    }

    // Dedupe gate #2 — Started returns false on duplicate correlationId
    // (defensive against logic-error double-Start). Pre-text dedupe;
    // belt-and-braces against cachePeek (gate #1) which is the braces.
    // On rejection the ledger NEVER opens and the Set is NOT populated,
    // so the cost invariant holds without further work.
    if (!costTracker.recordElevenLabsSpeculativeStarted(expandedText.length, correlationId)) {
      pendingControllers.delete(controller);
      pendingByCorrelation.delete(correlationId);
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
      return;
    }

    // LEDGER OPEN. Add to durable instance-Set so _maybeRecordTerminal
    // can dedupe later terminal calls.
    costOpenByCorrelation.add(correlationId);

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
        pendingByCorrelation.delete(correlationId);
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
          _maybeRecordTerminal(correlationId, cacheKey, 'completed');
        } else {
          // Late synth completion after abort. The buffer is thrown
          // away. Terminal is 'cancelled' for cost-tracking purposes.
          recordOutcome(correlationId, 'loaded_barrel_discarded', {
            meta: { sessionId, reason: 'late_synth_completion_after_abort' },
          });
          _maybeRecordTerminal(correlationId, cacheKey, 'cancelled', {
            reason: 'late_synth_completion_after_abort',
          });
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

  /**
   * Pre-text failure path (api-key resolve / client construction /
   * abort already fired BEFORE Started). NO ledger entry was opened,
   * so we do NOT call _maybeRecordTerminal — that would emit a
   * `speculative_terminal_skipped` row for an event that didn't owe
   * a terminal in the first place.
   *
   * Instead emit `loaded_barrel_pretext_abort` so dashboards can
   * count pre-text failures distinctly from synth-time errors.
   */
  function _onPreTextAbort(correlationId, cacheKey, controller, resolvePromise, err) {
    pendingControllers.delete(controller);
    pendingByCorrelation.delete(correlationId);
    const msg = err?.message || String(err);
    recordOutcome(correlationId, 'loaded_barrel_pretext_abort', {
      meta: { sessionId, reason: msg },
    });
    markSuperseded(cacheKey, 'pretext_abort');
    try {
      resolvePromise(null);
    } catch (_e) {
      /* ignore */
    }
    logger?.warn?.('voice_latency.loaded_barrel.pretext_abort', {
      sessionId,
      correlationId,
      error: msg,
    });
  }

  function _onSynthError(correlationId, cacheKey, controller, resolvePromise, err, client) {
    pendingControllers.delete(controller);
    pendingByCorrelation.delete(correlationId);
    const msg = err?.message || String(err);
    const aborted = msg.includes('aborted');
    if (aborted) {
      recordOutcome(correlationId, 'loaded_barrel_aborted', {
        meta: { sessionId, reason: msg },
      });
      _maybeRecordTerminal(correlationId, cacheKey, 'cancelled', { reason: 'synth_aborted' });
    } else {
      recordOutcome(correlationId, 'loaded_barrel_discarded', {
        meta: { sessionId, error: msg },
      });
      _maybeRecordTerminal(correlationId, cacheKey, 'failed', { reason: 'synth_failed' });
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
   * Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 11).
   *
   * Cancel any in-flight speculations whose slot matches the given
   * tuple. Called by the fast-TTS route the moment it accepts a POST
   * for a slot the speculator may already have started synthesising —
   * the iOS client will play the fast-path MP3 within ~500ms so
   * letting the speculator finish wastes ElevenLabs chars + ledger.
   *
   * boardId-empty-string is normalised to null; circuit is coerced
   * via Number(); circuit:0 stays distinct from circuit:null. See
   * `slotMatches` for the predicate.
   *
   * @returns {number} count of speculations cancelled.
   */
  function abortBySlot({ sessionId: targetSessionId, turnId: _turnId, field, circuit, boardId }) {
    if (targetSessionId && targetSessionId !== sessionId) return 0;
    if (!field) return 0;
    const target = { field, circuit, boardId };
    let count = 0;
    for (const [correlationId, entry] of pendingByCorrelation) {
      if (!slotMatches(entry.slot, target)) continue;
      try {
        entry.controller.abort();
      } catch (_e) {
        /* ignore */
      }
      // The synth's .catch will fire _onSynthError → _maybeRecordTerminal
      // with reason 'synth_aborted'. We ALSO emit a more specific
      // reason here so dashboards can distinguish abortBySlot
      // cancellations from "natural" aborts (controller.abort triggered
      // by shutdown / TTL / etc). _maybeRecordTerminal dedupes on the
      // Set, so whichever path fires first wins the cost decision.
      _maybeRecordTerminal(correlationId, entry.cacheKey, 'cancelled', {
        reason: 'cancelled_by_fast_tts_hint',
        cancelledBeforeTextSent: !costOpenByCorrelation.has(correlationId),
      });
      count += 1;
    }
    return count;
  }

  /**
   * Tear down on session_stop / WS close. Aborts every in-flight
   * controller + drops every session entry from the cache (which also
   * resolves their pending promises with null).
   *
   * Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 11.9):
   * sweep any still-open ledger entries through _maybeRecordTerminal
   * with reason 'speculator_shutdown' BEFORE pruning the cache. The
   * snapshot-before-iteration pattern (Array.from) avoids
   * modify-during-iteration when _maybeRecordTerminal deletes from
   * the Set inside the loop. Cross-session contamination is
   * impossible because both costOpenByCorrelation and
   * _maybeRecordTerminal close over THIS instance's costTracker.
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
    pendingByCorrelation.clear();

    // Sweep open ledger entries. snapshot-before-iteration: Array.from
    // captures the current membership BEFORE the loop body deletes
    // entries via _maybeRecordTerminal. Without this the for-of would
    // skip every other entry as the Set mutates.
    const orphans = Array.from(costOpenByCorrelation);
    for (const correlationId of orphans) {
      // cacheKey is unavailable here — pendingByCorrelation has already
      // been cleared above. Pass null; _maybeRecordTerminal accepts
      // null for diagnostic-only use and the cost decision doesn't
      // depend on it.
      _maybeRecordTerminal(correlationId, /*cacheKey=*/ null, 'cancelled', {
        reason: 'speculator_shutdown',
      });
    }
    // costOpenByCorrelation is now empty.

    pruneForSession(sessionId);
    currentTurnId = null;
    perTurnCount = 0;
  }

  return {
    onSnapshotPatch,
    onLoopComplete,
    onToolUseStreamed,
    abortBySlot,
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
      // Single-round latency sprint Phase 1 — exposed for test-only
      // assertions on the cost-integrity invariant.
      get costOpenCount() {
        return costOpenByCorrelation.size;
      },
      get pendingByCorrelationCount() {
        return pendingByCorrelation.size;
      },
    },
  };
}
