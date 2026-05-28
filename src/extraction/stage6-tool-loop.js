/**
 * Stage 6 Phase 1 — Multi-round tool-call loop (STD-02, STD-10, STO-01).
 *
 * WHAT: runToolLoop drives a model.stream() -> assemble -> dispatch -> append
 * tool_result -> re-invoke cycle until the model returns stop_reason:'end_turn'
 * OR the loop-cap (LOOP_CAP = 8 rounds) is hit. On cap-hit, the round-N
 * assistant response's tool_use blocks are NOT dispatched; instead the loop
 * iterates the round-N tool_use records and appends ONE synthetic tool_result
 * per tool_use_id with content = JSON.stringify({aborted:true, reason:'loop_cap'})
 * and is_error:true. This shape is mandated verbatim by STD-10 and is what
 * the Phase 8 stage6.tool_loop_cap_hit_rate analyzer metric expects.
 *
 * WHY a separate module (not inlined in sonnet-stream.js): The loop is pure
 * control flow over a streaming SDK client + a dispatcher + a logger. Keeping
 * it dependency-light makes Phase 2 (real dispatchers) a drop-in at the
 * `dispatcher` arg; Phase 3 (blocking ask_user) a dispatcher-internal detail;
 * Phase 7 (shadow -> live) a call-site concern in sonnet-stream.js. Pulling it
 * out also makes STD-10's cap-hit contract unit-testable without standing up
 * a WebSocket or a real Anthropic client.
 *
 * WHY count ROUNDS, not tool calls (Research §Pitfall 5): "8 tool calls" in
 * a single response must NOT trip the cap. REQUIREMENTS.md STD-10 says "8
 * rounds per user turn"; a single round may emit an arbitrary number of
 * parallel tool_use blocks (Phase 2 same-turn correction: clear_reading +
 * record_reading fits in one round).
 *
 * WHY push the assistant message BEFORE the tool_result user message, on
 * EVERY round including the cap-hit round (Research §Pitfall 3): Anthropic's
 * API rejects a request whose messages list contains a tool_use block without
 * a matching tool_result in the subsequent user message. On the cap-hit round
 * we still owe tool_result(s) for the round-N tool_use(s) the model just
 * emitted — we satisfy that obligation with the synthetic abort payload.
 * If we return WITHOUT appending the assistant message, a subsequent user
 * turn in the same session could re-use the extended `messages` and
 * inadvertently produce the legal form (assistant with tool_use followed by
 * user with tool_result) — but we'd have no traceability. Appending both
 * makes the cap-hit visible in the message log and keeps the conversation
 * coherent for the next turn.
 *
 * WHY a NOOP_DISPATCHER export (Phase 1 only): real dispatchers are Phase 2.
 * Phase 1 ships the plumbing and every log shape downstream tooling
 * (analyzer, dashboards) expects. NOOP returns {ok: true} so the assertion
 * surface in loop tests doesn't couple to payload details that don't exist
 * yet.
 */

import { createAssembler } from './stage6-stream-assembler.js';

// ---------------------------------------------------------------------------
// Loaded Barrel Phase 2.C — perTurnWrites snapshot/diff helpers (plan v10 §C)
// ---------------------------------------------------------------------------
//
// The speculator (loaded-barrel-speculator.js) needs to see EVERY mutation
// each dispatcher applies to the per-turn accumulator: added readings to
// speculate on, cleared / overwritten readings to invalidate, boardOps to
// drive prune decisions. Rather than re-implement the dispatcher chain
// to emit per-mutation events, we snapshot the accumulator BEFORE the
// dispatcher call and diff AFTER. The diff is shipped to the
// onSnapshotPatch hook.
//
// Snapshot complexity: O(n) on each readings/boardReadings Map size. At
// ~20 readings per session worst case, this is negligible vs the
// dispatcher's own work. Arrays use length-only snapshots (append-only
// invariant per createPerTurnWrites docstring).
//
// Why diff vs event emission: the existing dispatchers are unaware of
// the speculator and we don't want to thread an observer through every
// dispatcher signature. Diff keeps the speculator-vs-bundler shape
// contract in ONE place (this file) — if a future dispatcher mutates
// readings via a new code path, the diff catches it automatically.

function captureSnapshot(perTurnWrites) {
  if (!perTurnWrites) return null;
  return {
    // Map copies preserve key+value references. Equality on the value
    // reference detects same-turn overwrites (dispatchRecordReading
    // replaces the Map value object on a re-record, not mutates it).
    readingsMap: new Map(perTurnWrites.readings),
    boardReadingsMap: new Map(perTurnWrites.boardReadings),
    // Arrays are append-only per createPerTurnWrites contract. Length
    // alone is enough to slice the tail in the diff.
    clearedLen: perTurnWrites.cleared.length,
    observationsLen: perTurnWrites.observations.length,
    deletedObservationsLen: perTurnWrites.deletedObservations.length,
    circuitOpsLen: perTurnWrites.circuitOps.length,
    boardOpsLen: perTurnWrites.boardOps.length,
    fieldCorrectionsLen: Array.isArray(perTurnWrites.fieldCorrections)
      ? perTurnWrites.fieldCorrections.length
      : 0,
  };
}

function diffSnapshot(before, perTurnWrites) {
  const patch = {
    readings: { added: [], overwritten: [], removed: [] },
    boardReadings: { added: [], overwritten: [], removed: [] },
    cleared: perTurnWrites.cleared.slice(before.clearedLen),
    observations: perTurnWrites.observations.slice(before.observationsLen),
    deletedObservations: perTurnWrites.deletedObservations.slice(before.deletedObservationsLen),
    circuitOps: perTurnWrites.circuitOps.slice(before.circuitOpsLen),
    boardOps: perTurnWrites.boardOps.slice(before.boardOpsLen),
    fieldCorrections: Array.isArray(perTurnWrites.fieldCorrections)
      ? perTurnWrites.fieldCorrections.slice(before.fieldCorrectionsLen)
      : [],
  };
  for (const [key, value] of perTurnWrites.readings) {
    if (!before.readingsMap.has(key)) {
      patch.readings.added.push({ key, value });
    } else if (before.readingsMap.get(key) !== value) {
      patch.readings.overwritten.push({ key, before: before.readingsMap.get(key), after: value });
    }
  }
  for (const [key, value] of before.readingsMap) {
    if (!perTurnWrites.readings.has(key)) {
      patch.readings.removed.push({ key, before: value });
    }
  }
  for (const [key, value] of perTurnWrites.boardReadings) {
    if (!before.boardReadingsMap.has(key)) {
      patch.boardReadings.added.push({ key, value });
    } else if (before.boardReadingsMap.get(key) !== value) {
      patch.boardReadings.overwritten.push({
        key,
        before: before.boardReadingsMap.get(key),
        after: value,
      });
    }
  }
  for (const [key, value] of before.boardReadingsMap) {
    if (!perTurnWrites.boardReadings.has(key)) {
      patch.boardReadings.removed.push({ key, before: value });
    }
  }
  return patch;
}

function patchHasChanges(patch) {
  return (
    patch.readings.added.length > 0 ||
    patch.readings.overwritten.length > 0 ||
    patch.readings.removed.length > 0 ||
    patch.boardReadings.added.length > 0 ||
    patch.boardReadings.overwritten.length > 0 ||
    patch.boardReadings.removed.length > 0 ||
    patch.cleared.length > 0 ||
    patch.observations.length > 0 ||
    patch.deletedObservations.length > 0 ||
    patch.circuitOps.length > 0 ||
    patch.boardOps.length > 0 ||
    patch.fieldCorrections.length > 0
  );
}

/** Exposed for test introspection — production callers should use the hook. */
export const _loadedBarrelInternals = Object.freeze({
  captureSnapshot,
  diffSnapshot,
  patchHasChanges,
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap on model invocations per user turn (STD-10).
 * Exported so tests + future tuning (Phase 7 / Phase 8) can reference a single
 * source of truth. If raised, the Phase 8 CloudWatch alarm threshold for
 * stage6.tool_loop_cap_hit_rate should be revisited in tandem.
 */
export const LOOP_CAP = 8;

// ---------------------------------------------------------------------------
// No-op dispatcher (Phase 1)
// ---------------------------------------------------------------------------

/**
 * Phase 1 dispatcher stub. Returns a canonical success tool_result without
 * touching session state, emitting iOS events, or making any network calls.
 *
 * Phase 2 replaces this with a dispatcher table mapping tool_name -> real
 * implementation (record_reading writes stateSnapshot, ask_user blocks etc).
 * The signature is stable from Phase 1 onward so sonnet-stream.js doesn't
 * need to change at Phase 2 cutover.
 */
export const NOOP_DISPATCHER = async (call /* , ctx */) => ({
  tool_use_id: call.tool_call_id,
  content: JSON.stringify({ ok: true }),
  is_error: false,
});

/**
 * Extract the tool_use.id set from a finalized assistant message. This is
 * the AUTHORITATIVE set of ids Anthropic expects tool_result pairings for —
 * the assembler's records[] can diverge (orphan_delta adds synthetic
 * records without a matching tool_use in the assistant message;
 * incomplete_stream uses the real id but the record may be intentionally
 * skipped by the caller). Returns [] on malformed / empty content.
 */
function assistantToolUseIds(assistantMsg) {
  const content = assistantMsg && assistantMsg.content;
  if (!Array.isArray(content)) return [];
  const ids = [];
  for (const block of content) {
    if (block && block.type === 'tool_use' && typeof block.id === 'string') {
      ids.push(block.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// runToolLoop
// ---------------------------------------------------------------------------

/**
 * Drive the multi-round tool-call loop for one user turn.
 *
 * @param {Object} opts
 * @param {Object} opts.client Anthropic SDK client exposing messages.stream({...}).
 *   Test suites pass a mockClient from src/__tests__/helpers/mockStream.js.
 * @param {string} opts.model e.g. 'claude-sonnet-4-6'.
 * @param {string} opts.system System-prompt prefix.
 * @param {Array} opts.messages Initial messages array. MUTATED: the loop
 *   appends one assistant message and one user(tool_result) message per
 *   round. Caller retains ownership — this is by design so that sonnet-
 *   stream.js can inspect the post-loop message log for logging/analyzer.
 * @param {Array} opts.tools Tool definitions (from stage6-tool-schemas.js).
 * @param {Function} opts.dispatcher ToolDispatcher. Phase 1 defaults to NOOP.
 * @param {Object} opts.ctx Context { sessionId, turnId } threaded into logs.
 * @param {Object} [opts.logger] Winston-shaped logger with info/warn/error.
 * @param {number} [opts.maxRounds=LOOP_CAP] Override cap (tests / future tuning).
 * @returns {Promise<{
 *   stop_reason: string | null,
 *   rounds: number,
 *   tool_calls: Array<{name: string, input: any, result: any}>,
 *   aborted: boolean,
 *   messages_final: Array,
 *   usage: {
 *     input_tokens: number,
 *     output_tokens: number,
 *     cache_creation_input_tokens: number,
 *     cache_read_input_tokens: number,
 *   },
 * }>}
 *
 * The `usage` field is the summed token usage across every round's
 * `stream.finalMessage().usage`. The shape mirrors Anthropic's
 * `Message.usage` exactly so the caller can pass it straight to
 * `costTracker.addSonnetUsage(toolLoopOut.usage)`. Defensive — any
 * missing field on a per-round usage object contributes 0 to the sum
 * (covers SDK shape drift and the cap-hit branch where the final round
 * may not surface usage from a partial stream).
 */
export async function runToolLoop({
  client,
  model,
  system,
  messages,
  tools,
  dispatcher,
  ctx,
  logger,
  maxRounds = LOOP_CAP,
  /**
   * Phase 3 addition per STA-02. Default identity; do not use this to
   * mutate records — only to re-order. Applied once per round to the
   * output of `assembler.finalize()` BEFORE the per-record dispatch
   * for-loop. When omitted (default), dispatch order is identical to
   * finalize() order and Phase 1/2 behaviour is unchanged.
   *
   * Hook signature: (records: Array<{tool_call_id, name, input, index, ...}>)
   *                 => Array<same shape>
   *
   * If the hook throws, the loop logs `stage6.tool_loop_sort_error` and
   * falls back to identity for that round so the turn does not crash.
   */
  sortRecords,
  /**
   * Loaded Barrel Phase 2.C — accessor returning the perTurnWrites
   * accumulator the dispatchers mutate. Required if onSnapshotPatch
   * is provided; ignored otherwise. The loop calls this fresh each
   * dispatch so the speculator sees the post-mutation state in the
   * patch event.
   */
  perTurnWritesRef,
  /**
   * Loaded Barrel Phase 2.C — fires after each successful (or errored)
   * dispatcher call IF perTurnWritesRef is also provided AND the
   * dispatch produced any state change. Hook signature:
   *
   *   ({patch, raw, ctx}) => void
   *
   * `patch` is the diff (readings/boardReadings/cleared/etc).
   * `raw` exposes the full post-dispatch perTurnWrites for the
   * speculator's prune subscribers (boardOps cumulative state).
   * `ctx` carries sessionId, turnId, toolName, toolCallId, roundIdx.
   *
   * A throw is caught + logged as stage6.snapshot_patch_hook_error;
   * the dispatch continues normally.
   */
  onSnapshotPatch,
  /**
   * Loaded Barrel Phase 2.C — fires AFTER the whole tool loop
   * terminates (end_turn / cap-hit / abort). The speculator uses
   * this for drift detection: the bundler's final confirmation text
   * is computed at this point, so the speculator can compare its
   * predicted text against the bundler's. Signature:
   *
   *   ({perTurnWrites, tool_calls, rounds, stop_reason, aborted, usage}) => void
   *
   * A throw is caught + logged; never affects the return value.
   */
  onLoopComplete,
  /**
   * Loaded Barrel Phase 2.D (2026-05-25) — fires INSIDE the per-round
   * stream loop, the moment each tool_use's `content_block_stop`
   * arrives and the assembler has a complete record. Lets the
   * speculator begin ElevenLabs pre-synth while Sonnet is still
   * emitting subsequent tool_use blocks in the same response. For
   * multi-tool turns (e.g. "32 amp B-curve MCB BS-EN 60898" producing
   * three record_reading calls) the second/third tools' pre-synth
   * starts ~hundreds of ms earlier than the dispatch-driven
   * onSnapshotPatch path. Signature:
   *
   *   ({record, ctx}) => void
   *
   * `record` is the assembler's finalised record (happy-path:
   * `{index, tool_call_id, name, input}`; error path:
   * `{index, tool_call_id, name, error, raw_partial}`).
   * `ctx` mirrors onSnapshotPatch — `{sessionId, turnId, roundIdx}`.
   *
   * A throw is caught + logged by the assembler; never affects the
   * stream or the dispatch loop. Default omitted = byte-identical
   * to pre-Phase-2.D behaviour.
   */
  onToolUseStreamed,
  /**
   * Phase 2 (single-round latency sprint, PLAN_v8 §A Pivot 1 + §E).
   * When true AND the round-1 dispatch produced exactly one clean
   * write tool with no errors and no ask_user, skip the round-2
   * Sonnet invocation entirely and exit the loop with
   * `terminal_reason: 'early_terminated'`.
   *
   * Independent of Loaded Barrel — passed always from runLiveMode
   * regardless of speculator state (closes Codex round-3 I4).
   */
  earlyTerminateEnabled = false,
  /**
   * Phase 2 — the session object the predicate inspects for
   * board-count and currentBoardId. Required when
   * earlyTerminateEnabled is true; ignored otherwise.
   */
  earlyTerminateSession,
  /**
   * 2026-05-26 voice-latency fix — pass `tool_choice: { type: "any" }`
   * on the ROUND-1 stream invocation only. Forces Sonnet to emit a
   * tool_use without preceding text reasoning, which lets the Loaded
   * Barrel streamed-speculation hook (assembler's onRecordComplete
   * → loaded-barrel-speculator.onToolUseStreamed) fire ~1-2s earlier
   * in the response than today.
   *
   * Repro: session 904344CD (2026-05-26). All early-terminated
   * record_reading turns showed `loaded_barrel_started` /
   * `loaded_barrel_fired` / `turn_core_summary` colocated in the
   * SAME CloudWatch second — i.e. the first (and only) tool_use was
   * landing at the END of the ~3s Sonnet stream, not the start.
   * ElevenLabs synth therefore had ~0-500ms (instead of ~2s) to
   * complete before iOS asked for the audio, producing
   * `loaded_barrel_hit_pending` outcomes on every measurable turn.
   *
   * Why round-1 only: round-2+ may need to end_turn (cap-hit / no
   * more tools needed) — forcing tool_choice there would make
   * Sonnet emit an unwanted tool to satisfy the constraint.
   *
   * Safety: `tool_choice: { type: "any" }` still lets Sonnet choose
   * which tool to use (record_reading, ask_user, etc.) — only the
   * "emit no tool, just text + end_turn" path is suppressed. For
   * irrelevant utterances the system prompt's "if you can't extract,
   * call ask_user to clarify" guidance fills the gap. Monitored via
   * a new `voice_latency.tool_choice_any_emitted` log line for early
   * sightings of regression patterns; flag-flippable in the task def
   * env if a class of failures surfaces.
   *
   * Default true so the deploy realises the latency win without an
   * out-of-band env-var toggle; set
   * `VOICE_LATENCY_TOOL_CHOICE_ANY_ROUND1=false` on the task def to
   * disable in production without a code roll.
   */
  toolChoiceAnyOnRound1 = false,
}) {
  let rounds = 0;
  let stopReason = null;
  let aborted = false;
  // Phase 2: terminal_reason carries the SERVER-SIDE termination cause.
  // 'end_turn'         — Anthropic returned end_turn organically.
  // 'tool_use_cap_hit' — rounds === maxRounds with stop_reason='tool_use'.
  // 'early_terminated' — Phase 2 predicate fired after round-1 dispatch.
  // 'aborted'          — runtime aborted before normal termination.
  let terminalReason = null;
  // Phase 0: per-round timings + actual stop_reasons (the API's truth,
  // preserved even when terminalReason supersedes it).
  const roundTimings = [];
  const actualStopReasonPerRound = [];
  const toolNamesPerRound = [];
  const toolCallCountPerRound = [];
  const toolErrorCountPerRound = [];
  // Phase 0: convenience timing for emitTurnCoreSummary (sonnet_round1_ms /
  // sonnet_round2_ms). Bundler/dispatch timings come from elsewhere.
  let earlyTerminated = false;
  const allCalls = [];
  // Per-round usage accumulator. Summed from each round's
  // stream.finalMessage().usage (Anthropic Message.usage shape). Returned
  // verbatim so callers can pipe it into CostTracker.addSonnetUsage. We
  // intentionally do NOT bill per-round here — the call is one billable
  // utterance from the session's perspective, and CostTracker.turns ===
  // utterances is the contract every dashboard relies on (matches the
  // legacy off-mode call site at eicr-extraction-session.js:1614 which
  // also calls addSonnetUsage exactly once per extract()). The round
  // count is preserved on the return value (rounds: number) for
  // diagnostics that want per-round granularity.
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  while (rounds < maxRounds) {
    rounds += 1;

    // Per-round stream. The SDK helper returns both an async-iterable AND a
    // .finalMessage() promise — we consume both for different purposes:
    //   - iteration drives the assembler (records + stop_reason)
    //   - finalMessage() gives us the model's full assistant message to push
    //     onto `messages` so the next round sees the correct prior turn.
    // Phase 0 (single-round latency sprint) — capture started/stream_complete/
    // dispatch_complete timestamps per round for emitTurnCoreSummary.
    const roundStartedNs = process.hrtime.bigint();
    // Round-1 only: force Sonnet to emit a tool_use first (no
    // preamble text). See `toolChoiceAnyOnRound1` docstring above.
    //
    // 2026-05-28 mid-stream emit follow-up: round-1 model override. The
    // dominant short-utterance turn shape (single record_reading on a
    // ~120-token output) is bottlenecked by Sonnet 4.6's ~2.7-3.0 s
    // round-1 stream wall — too slow to clear the 2.5 s audible budget
    // even with cache HIT (~250 ms first-byte) and Loaded Barrel running.
    // VOICE_LATENCY_ROUND1_MODEL lets ops route round-1 to a faster
    // model (typically claude-haiku-4-5-20251001, ~half the wall) while
    // round-2+ stays on the default Sonnet model. Unset / empty = no
    // override = legacy behaviour. The flag is live-read so a flip
    // takes effect on the next API call without a restart.
    const round1ModelOverride = process.env.VOICE_LATENCY_ROUND1_MODEL;
    const effectiveModel =
      rounds === 1 && typeof round1ModelOverride === 'string' && round1ModelOverride
        ? round1ModelOverride
        : model;
    const streamArgs = {
      model: effectiveModel,
      max_tokens: 4096,
      system,
      messages,
      tools,
    };
    if (toolChoiceAnyOnRound1 && rounds === 1) {
      streamArgs.tool_choice = { type: 'any' };
      logger?.info?.('voice_latency.tool_choice_any_emitted', {
        sessionId: ctx?.sessionId,
        turnId: ctx?.turnId,
        roundIdx: rounds,
      });
    }
    if (effectiveModel !== model) {
      logger?.info?.('voice_latency.round1_model_override', {
        sessionId: ctx?.sessionId,
        turnId: ctx?.turnId,
        default_model: model,
        round1_model: effectiveModel,
      });
    }
    const stream = client.messages.stream(streamArgs);

    // Loaded Barrel Phase 2.D (2026-05-25) — pipe each finalised
    // tool_use record into the speculator's streamed hook the moment
    // its content_block_stop fires. The hook fires from inside
    // assembler.handle(); the for-await loop above is unchanged. We
    // capture the closure's roundIdx so the speculator's telemetry
    // can correlate streamed-fire vs dispatch-time-fire.
    const streamedHook =
      typeof onToolUseStreamed === 'function'
        ? (record) => {
            try {
              onToolUseStreamed({
                record,
                ctx: {
                  sessionId: ctx?.sessionId,
                  turnId: ctx?.turnId,
                  roundIdx: rounds,
                },
              });
            } catch (err) {
              logger?.error?.('stage6.tool_loop_streamed_hook_error', {
                sessionId: ctx?.sessionId,
                turnId: ctx?.turnId,
                tool_name: record?.name,
                error: err?.message,
              });
            }
          }
        : undefined;
    const asm = createAssembler({ logger, onRecordComplete: streamedHook });
    for await (const ev of stream) {
      asm.handle(ev);
    }
    const { records, stop_reason } = asm.finalize();
    stopReason = stop_reason;
    // Phase 0 — round-level stream complete time (post-finalize).
    const roundStreamCompleteNs = process.hrtime.bigint();
    actualStopReasonPerRound.push(stop_reason);
    // Per-round tool name + count summary (toolCallCountPerRound /
    // toolErrorCountPerRound populated AFTER the dispatch loop; this is
    // just the streamed-record name list).
    toolNamesPerRound.push(records.map((r) => r.name || 'unknown'));

    // Push the assistant message on EVERY round — tool_use AND end_turn.
    // On tool_use rounds this is the tool_use-before-tool_result ordering
    // invariant (Research §Pitfall 3) — the synthetic or real tool_result(s)
    // below require the referenced tool_use(s) to be present in the prior
    // assistant message or Anthropic's API would 400 on the next
    // invocation. On end_turn rounds the assistant message carries the
    // model's final text reply; dropping it (pre-fix behavior: break before
    // push) meant messages_final lost the model's last turn and any caller
    // building multi-turn history from it would lose context for the next
    // user turn. Codex's Phase-1 STG review flagged this as MAJOR.
    const assistantMsg = await stream.finalMessage();
    messages.push({ role: 'assistant', content: assistantMsg.content });

    // Sum this round's token usage into the loop accumulator. Defensive
    // against missing fields (SDK shape drift / partial-stream rounds /
    // mock streams that don't emit usage) — each missing field is 0.
    // Anthropic's streaming SDK assembles the final usage from message_start
    // (input_tokens, cache_creation_input_tokens, cache_read_input_tokens)
    // and message_delta (output_tokens, accumulating); finalMessage() returns
    // the post-assembly snapshot, which is what we sum here.
    const u = assistantMsg.usage;
    if (u) {
      usage.input_tokens += u.input_tokens || 0;
      usage.output_tokens += u.output_tokens || 0;
      usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
      usage.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    }

    // Happy-path terminator: model said end_turn (or null / unknown — treat
    // anything other than tool_use as "we are done").
    if (stop_reason !== 'tool_use') {
      terminalReason = terminalReason ?? 'end_turn';
      // Phase 0 telemetry: record per-round timing (dispatch_complete = stream_complete on no-dispatch).
      roundTimings.push({
        round_idx: rounds - 1,
        started_ns: roundStartedNs.toString(),
        stream_complete_ns: roundStreamCompleteNs.toString(),
        dispatch_complete_ns: roundStreamCompleteNs.toString(),
        stream_ms: Number((roundStreamCompleteNs - roundStartedNs) / 1000000n),
        dispatch_ms: 0,
      });
      toolCallCountPerRound.push(0);
      toolErrorCountPerRound.push(0);
      break;
    }

    // CAP-HIT BRANCH (STD-10 verbatim).
    // At this point `rounds` has just been incremented to maxRounds (e.g. 8).
    // The model still wants more tool calls (stop_reason === 'tool_use').
    // We MUST NOT invoke the dispatcher on these round-N tool calls. Instead
    // we append one synthetic tool_result per pending tool_use_id with
    //   content = JSON.stringify({aborted: true, reason: 'loop_cap'})
    //   is_error = true
    // and exit cleanly. No further model invocation. Log tool_loop_cap_hit
    // for the Phase 8 stage6.tool_loop_cap_hit_rate CloudWatch metric.
    if (rounds >= maxRounds) {
      const abortResults = [];
      const answeredCap = new Set();
      for (const rec of records) {
        // Skip orphan_delta error records — they have no matching tool_use.id
        // in the assistant message (the assembler synthesised the record
        // without a preceding content_block_start), so Anthropic is not
        // owed a tool_result for them. Including one would produce a
        // tool_use_id referencing nothing.
        if (!rec.tool_call_id) continue;
        abortResults.push({
          type: 'tool_result',
          tool_use_id: rec.tool_call_id,
          content: JSON.stringify({ aborted: true, reason: 'loop_cap' }),
          is_error: true,
        });
        answeredCap.add(rec.tool_call_id);
      }
      // Pad any assistant tool_use ids the assembler did not surface
      // (pathological cases: records loss, SDK race). The authoritative id
      // set is the assistant message, NOT the assembler records — without
      // padding, messages.content=[] would be malformed even in the cap-hit
      // branch if the caller reuses messages_final for another turn.
      for (const id of assistantToolUseIds(assistantMsg)) {
        if (answeredCap.has(id)) continue;
        abortResults.push({
          type: 'tool_result',
          tool_use_id: id,
          content: JSON.stringify({ aborted: true, reason: 'loop_cap' }),
          is_error: true,
        });
      }
      // Invariant (Codex round-4 STG MAJOR): symmetrical to the normal-branch
      // guard at line ~383. If we hit the loop cap with stop_reason='tool_use'
      // but no real tool_use ids to answer (records has only orphan_delta
      // skips AND the assistant message surfaced zero tool_use blocks), the
      // model has emitted a protocol violation. Pushing `content: []` here
      // would malform the conversation history — the next Anthropic call
      // would 400 with tool_use_id_without_result or api_error. Abort cleanly
      // without pushing a user message so messages_final terminates on the
      // assistant turn (already pushed above at line 179).
      if (abortResults.length === 0) {
        logger?.error?.('stage6.tool_loop_invariant', {
          sessionId: ctx?.sessionId,
          turnId: ctx?.turnId,
          rounds,
          reason: 'tool_use_stop_reason_with_no_tool_use_blocks_at_cap',
        });
        aborted = true;
        break;
      }
      messages.push({ role: 'user', content: abortResults });
      aborted = true;
      logger?.warn?.('tool_loop_cap_hit', {
        sessionId: ctx?.sessionId,
        turnId: ctx?.turnId,
        rounds,
        pending_tool_uses: abortResults.length,
      });
      break;
    }

    // NORMAL DISPATCH BRANCH: rounds < maxRounds. Dispatch each tool call in
    // the assembler's index-ascending order (finalize() already sorts), then
    // append one user-role message whose content is the array of tool_result
    // content blocks (one per dispatched call). Anthropic expects all of a
    // round's tool_results in a single user message.
    //
    // Phase 3 (Plan 03-06) STA-02 defense-in-depth: opt-in sortRecords hook.
    // Default identity — Phase 1/2 behaviour preserved. If supplied, the hook
    // reorders records BEFORE dispatch (e.g. createSortRecordsAsksLast moves
    // ask_user blocks to the end so writes commit before the blocking ask).
    // A hook throw is logged and falls back to identity for this round so
    // the turn does not crash.
    let sortedRecords = records;
    if (typeof sortRecords === 'function') {
      try {
        const result = sortRecords(records);
        if (Array.isArray(result)) sortedRecords = result;
      } catch (err) {
        logger?.error?.('stage6.tool_loop_sort_error', {
          sessionId: ctx?.sessionId,
          turnId: ctx?.turnId,
          rounds,
          error: err?.message,
        });
        // r15 MAJOR#1 remediation — emergency STA-02 fallback. Identity
        // order could dispatch ask_user BEFORE writes in the same round,
        // violating the writes-before-asks invariant at its enforcement
        // point. If the hook throws, synthesise the minimum guarantee it
        // was meant to provide: move ask_user records to the tail,
        // preserving relative order of each partition. Pure, allocation-
        // light, no external deps — matches createSortRecordsAsksLast's
        // contract closely enough to preserve STA-02 defensively.
        sortedRecords = [
          ...records.filter((r) => r?.name !== 'ask_user'),
          ...records.filter((r) => r?.name === 'ask_user'),
        ];
      }
    }
    const toolResults = [];
    for (const rec of sortedRecords) {
      // Assembler error records (invalid_json, orphan_delta). For errors
      // that DO carry a tool_call_id (invalid_json from a real tool_use
      // whose inputs never parsed) we still owe Anthropic a tool_result —
      // encoding the assembler error satisfies that obligation. For errors
      // that DON'T carry a tool_call_id (orphan_delta from a content_block_
      // delta with no preceding content_block_start) there is no matching
      // tool_use in the assistant message, so emitting a tool_result with
      // a synthetic "unknown" id would reference nothing — Anthropic would
      // reject the next round with tool_use_id_without_result. Skip those
      // silently, mirroring the cap-hit branch at line ~178. Codex's
      // Phase-1 STG review flagged the old `?? 'unknown'` fallback as BLOCK.
      if (rec.error) {
        if (!rec.tool_call_id) continue;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: rec.tool_call_id,
          content: JSON.stringify({ error: rec.error, raw_partial: rec.raw_partial }),
          is_error: true,
        });
        logger?.warn?.('stage6.tool_call', {
          sessionId: ctx?.sessionId,
          turnId: ctx?.turnId,
          tool_call_id: rec.tool_call_id,
          tool_name: rec.name,
          duration_ms: 0,
          outcome: 'assembler_error',
          error: rec.error,
        });
        continue;
      }

      const started = Date.now();
      // Loaded Barrel Phase 2.C — snapshot perTurnWrites BEFORE dispatch
      // so we can diff after. Only does work when both hook + accessor
      // are wired; otherwise it's a single null-pointer check.
      const speculatorAttached =
        typeof onSnapshotPatch === 'function' && typeof perTurnWritesRef === 'function';
      let snapshotBefore = null;
      let snapshotPtw = null;
      if (speculatorAttached) {
        snapshotPtw = perTurnWritesRef();
        snapshotBefore = captureSnapshot(snapshotPtw);
      }
      try {
        const res = await dispatcher(
          { tool_call_id: rec.tool_call_id, name: rec.name, input: rec.input },
          ctx
        );
        const duration_ms = Date.now() - started;
        // Loaded Barrel Phase 2.C — diff + emit. The hook MUST NOT
        // affect dispatch outcome — wrap in try/catch and never
        // re-throw so a speculator bug can't break extraction.
        if (speculatorAttached && snapshotBefore && snapshotPtw) {
          try {
            const patch = diffSnapshot(snapshotBefore, snapshotPtw);
            if (patchHasChanges(patch)) {
              onSnapshotPatch({
                patch,
                raw: { perTurnWrites: snapshotPtw },
                ctx: {
                  sessionId: ctx?.sessionId,
                  turnId: ctx?.turnId,
                  toolName: rec.name,
                  toolCallId: rec.tool_call_id,
                  roundIdx: rounds,
                },
              });
            }
          } catch (hookErr) {
            logger?.error?.('stage6.snapshot_patch_hook_error', {
              sessionId: ctx?.sessionId,
              turnId: ctx?.turnId,
              tool_name: rec.name,
              error: hookErr?.message,
            });
          }
        }
        // STO-01: per-tool-call structured log. sessionId/turnId are
        // session+turn correlators; tool_call_id threads to the assistant's
        // tool_use.id; tool_name for metric tagging; duration_ms for the
        // Phase 8 latency dashboard; outcome distinguishes success from
        // dispatcher_error for alarming.
        logger?.info?.('stage6.tool_call', {
          sessionId: ctx?.sessionId,
          turnId: ctx?.turnId,
          tool_call_id: rec.tool_call_id,
          tool_name: rec.name,
          duration_ms,
          outcome: 'stub_ok',
        });
        // Surface dispatcher id-threading bugs in observability. The
        // dispatcher SHOULD echo call.tool_call_id back in res.tool_use_id,
        // but we do not trust it — we always key the tool_result to the
        // assembler's rec.tool_call_id (which came directly from the
        // assistant message and is what Anthropic expects paired). If the
        // dispatcher-returned id diverges, that's a Phase 2+ dispatcher
        // bug worth alarming on. Codex's Phase-1 STG re-review (round 3)
        // flagged the pre-fix `tool_use_id: res.tool_use_id` as MAJOR —
        // a buggy dispatcher could silently unpair tool_use/tool_result
        // and the next Anthropic call would 400.
        if (res.tool_use_id !== rec.tool_call_id) {
          logger?.warn?.('stage6.tool_call_id_mismatch', {
            sessionId: ctx?.sessionId,
            turnId: ctx?.turnId,
            tool_call_id: rec.tool_call_id,
            dispatcher_returned_id: res.tool_use_id,
            tool_name: rec.name,
          });
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: rec.tool_call_id,
          content: res.content,
          is_error: res.is_error,
        });
        allCalls.push({ name: rec.name, input: rec.input, result: res });
      } catch (err) {
        const duration_ms = Date.now() - started;
        logger?.error?.('stage6.tool_call', {
          sessionId: ctx?.sessionId,
          turnId: ctx?.turnId,
          tool_call_id: rec.tool_call_id,
          tool_name: rec.name,
          duration_ms,
          outcome: 'dispatcher_error',
          error: err?.message,
        });
        // Surface the error as a tool_result so the model can react rather
        // than the loop crashing the turn — this matches REQUIREMENTS STD-09
        // (every tool execution returns a tool_result, success OR
        // validation_error, before re-invoke).
        toolResults.push({
          type: 'tool_result',
          tool_use_id: rec.tool_call_id,
          content: JSON.stringify({
            error: 'dispatcher_error',
            message: err?.message,
          }),
          is_error: true,
        });
      }
    }
    // Pad any unanswered assistant tool_use ids. Anthropic requires every
    // tool_use in the prior assistant message to be paired with a
    // tool_result in the immediately-following user message — if we skipped
    // some record (orphan_delta above, or a pathological assembler-records-
    // diverged-from-assistant-message case), the API would 400 on the next
    // stream(). Authoritative id set = assistant message content (what the
    // API committed to), NOT the assembler's records (which can synthesise
    // or drop). Codex's Phase-1 STG re-review flagged the unpadded
    // empty-user-content case as MAJOR @ tool-loop:292.
    const answered = new Set(toolResults.map((r) => r.tool_use_id));
    for (const id of assistantToolUseIds(assistantMsg)) {
      if (answered.has(id)) continue;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({
          error: 'internal_no_result',
          reason: 'record_missing_or_skipped',
        }),
        is_error: true,
      });
      logger?.warn?.('stage6.tool_call', {
        sessionId: ctx?.sessionId,
        turnId: ctx?.turnId,
        tool_call_id: id,
        duration_ms: 0,
        outcome: 'internal_no_result',
      });
    }

    // Invariant: we only reached this branch because stop_reason === 'tool_use'.
    // That means the model told Anthropic "I am about to use tools." If the
    // finalized assistant message contains NO tool_use blocks, that's an
    // Anthropic protocol violation, not something we should paper over by
    // pushing an empty user message (which the API would 400 on anyway).
    // Abort the turn cleanly with a logged error so the caller can decide.
    if (toolResults.length === 0) {
      logger?.error?.('stage6.tool_loop_invariant', {
        sessionId: ctx?.sessionId,
        turnId: ctx?.turnId,
        rounds,
        reason: 'tool_use_stop_reason_with_no_tool_use_blocks',
      });
      aborted = true;
      break;
    }

    messages.push({ role: 'user', content: toolResults });

    // Phase 0 telemetry — capture per-round dispatch completion + counts.
    const roundDispatchCompleteNs = process.hrtime.bigint();
    const roundIdx = rounds - 1;
    const toolErrorCount = toolResults.filter((tr) => tr.is_error === true).length;
    roundTimings.push({
      round_idx: roundIdx,
      started_ns: roundStartedNs.toString(),
      stream_complete_ns: roundStreamCompleteNs.toString(),
      dispatch_complete_ns: roundDispatchCompleteNs.toString(),
      stream_ms: Number((roundStreamCompleteNs - roundStartedNs) / 1000000n),
      dispatch_ms: Number((roundDispatchCompleteNs - roundStreamCompleteNs) / 1000000n),
    });
    toolCallCountPerRound.push(records.length);
    toolErrorCountPerRound.push(toolErrorCount);

    // Phase 2 (single-round latency sprint, PLAN_v8 §A Pivot 1 + §E) —
    // server-side round-1 early-terminate. Runs AFTER the dispatch loop
    // pushes the real (non-empty) tool_results user message above. Anthropic
    // protocol balance is preserved.
    //
    // If the predicate fires, we set terminalReason='early_terminated' and
    // break BEFORE the next round's client.messages.stream invocation —
    // saving the ~2.5s Sonnet round-2 wall on the dominant single-clean-
    // record_reading turn shape. The Anthropic-reported stop_reason for
    // round 1 stays 'tool_use' (preserved in actualStopReasonPerRound).
    if (earlyTerminateEnabled && rounds === 1 && earlyTerminateSession) {
      try {
        const ptw = typeof perTurnWritesRef === 'function' ? perTurnWritesRef() : null;
        if (ptw) {
          // Lazy-import the predicate so the loop has no module-load
          // dependency unless the flag is on.

          const { shouldEarlyTerminate } = await import('./stage6-early-terminate.js');
          if (
            shouldEarlyTerminate({
              records,
              toolResults,
              perTurnWrites: ptw,
              session: earlyTerminateSession,
            })
          ) {
            terminalReason = 'early_terminated';
            earlyTerminated = true;
            logger?.info?.('voice_latency.round1_early_terminate_fired', {
              sessionId: ctx?.sessionId,
              turnId: ctx?.turnId,
              rounds,
              tool_count: records.length,
            });
            break;
          }
        }
      } catch (err) {
        logger?.warn?.('voice_latency.early_terminate_predicate_error', {
          sessionId: ctx?.sessionId,
          turnId: ctx?.turnId,
          error: err?.message || String(err),
        });
        // Fall through to normal round-2 invocation on any predicate error.
      }
    }
  }

  // Phase 2: set terminalReason for paths that didn't already set it.
  if (terminalReason === null) {
    if (aborted) terminalReason = 'aborted';
    else if (rounds >= maxRounds && stopReason === 'tool_use') terminalReason = 'tool_use_cap_hit';
    else terminalReason = 'end_turn';
  }

  // Loaded Barrel Phase 2.C — onLoopComplete fires AFTER the loop
  // terminates (end_turn / cap-hit / abort). Speculator uses this for
  // drift detection: compares its predicted confirmation text against
  // the bundler-computable text. Hook errors never affect return.
  if (typeof onLoopComplete === 'function') {
    try {
      onLoopComplete({
        perTurnWrites: typeof perTurnWritesRef === 'function' ? perTurnWritesRef() : null,
        tool_calls: allCalls,
        rounds,
        stop_reason: stopReason,
        aborted,
        usage,
      });
    } catch (hookErr) {
      logger?.error?.('stage6.loop_complete_hook_error', {
        sessionId: ctx?.sessionId,
        turnId: ctx?.turnId,
        error: hookErr?.message,
      });
    }
  }

  return {
    stop_reason: stopReason,
    rounds,
    tool_calls: allCalls,
    aborted,
    messages_final: messages,
    usage,
    // Phase 0 + Phase 2 (single-round latency sprint) — additive return fields.
    // Legacy callers ignore unknown keys, so the back-compat is preserved.
    terminal_reason: terminalReason,
    early_terminated: earlyTerminated,
    actual_stop_reason_per_round: actualStopReasonPerRound,
    tool_names_per_round: toolNamesPerRound,
    tool_call_count_per_round: toolCallCountPerRound,
    tool_error_count_per_round: toolErrorCountPerRound,
    round_timings: roundTimings,
  };
}
