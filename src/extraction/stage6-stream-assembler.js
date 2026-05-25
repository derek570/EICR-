/**
 * Stage 6 streaming event assembler — pure reducer over Anthropic Messages-API
 * tool_use streaming events (STD-01, STT-02).
 *
 * WHAT: Given the parsed event objects emitted by @anthropic-ai/sdk's
 * messages.stream() helper (equivalently, the SSE wire events with the
 * "event:/data:" framing stripped), reconstruct completed tool-call records:
 *   { index, tool_call_id, name, input }  // happy path
 *   { index, tool_call_id, name, error, raw_partial }  // malformed JSON or orphan
 *
 * WHY: Anthropic streams tool_use payloads as a sequence of input_json_delta
 * fragments that are string-concatenated per-block and JSON-parsed ONCE at
 * content_block_stop. Blocks can interleave — two tool_use blocks with
 * indices 0 and 1 may have deltas arriving in alternating order. The only
 * reliable dispatch key is event.index; tool_use.id is opaque and serves a
 * different purpose (threading tool_result back in the next turn). Getting
 * this reducer wrong is Phase 1's biggest risk (Project §Risk #2), so it
 * lives in its own module with fixture-based tests.
 *
 * WHY THIS SHAPE: factory returning { handle, finalize } rather than a class
 * because every caller wants one assembler per message (not per session) and
 * never needs inheritance/identity. handle() is a state-transition function;
 * finalize() is idempotent and can also be called manually if the caller
 * prefers finishing on message_delta rather than message_stop.
 *
 * INVARIANTS (enforced by tests):
 *   - Keyed by event.index — never by content_block.id.
 *   - partial_json concatenated verbatim; empty strings are no-ops via String +.
 *   - JSON.parse called ONCE per block, inside content_block_stop, in try/catch.
 *   - Invalid JSON -> error record, never thrown.
 *   - Orphan delta (no preceding content_block_start at that index) -> logged
 *     warn + recorded as error record, never thrown.
 *   - Assembler has no side effects beyond in-memory state + optional logger.warn.
 */

/**
 * @param {Object} [opts]
 * @param {{ warn?: Function }} [opts.logger] Optional logger with .warn. If
 *   absent, orphan deltas are silently recorded but not logged. We duck-type
 *   rather than importing the project logger so this module is trivially
 *   reusable in unit tests.
 * @param {(record: object) => void} [opts.onRecordComplete] Optional callback
 *   invoked as each `content_block_stop` finalises a tool_use record.
 *   Receives the same record shape that ends up in `finalize().records`
 *   (`{index, tool_call_id, name, input}` happy-path; `{index, tool_call_id,
 *   name, error, raw_partial}` on parse failure). Used by the Loaded
 *   Barrel streamed-speculation hook (Phase 2.D, 2026-05-25) to fire the
 *   speculator AS SOON AS each tool_use's input is available, instead
 *   of waiting for `message_stop` + the post-stream dispatch loop. For
 *   multi-tool turns the latency win is ~hundreds of ms per tool. The
 *   callback MUST NOT throw — wrap in try/catch and never bubble; the
 *   assembler's contract is "no observable side effects beyond
 *   recording" and a hook exception would corrupt the stream loop.
 *   Default is a no-op so existing callers see byte-identical behaviour.
 * @returns {{
 *   handle: (event: any) => ({ records: any[], stop_reason: string | null } | null),
 *   finalize: () => ({ records: any[], stop_reason: string | null }),
 * }}
 */
export function createAssembler({ logger, onRecordComplete } = {}) {
  // Per-block in-progress state. Map keyed by content-block index.
  // Entry shape: { id, name, partialJson }
  const assemblers = new Map();

  // Completed tool-call records, populated at each content_block_stop.
  const completed = [];

  // Captured from message_delta.delta.stop_reason — used by the loop driver
  // in Plan 04 to decide whether to re-invoke the model.
  let stopReason = null;

  function handle(event) {
    if (!event || typeof event !== 'object') return null;

    switch (event.type) {
      case 'content_block_start': {
        const cb = event.content_block;
        if (cb && cb.type === 'tool_use') {
          // Start fresh state for this index. Ignore cb.input — it is an
          // Anthropic-typed placeholder ({}), NOT the real payload. Real
          // payload arrives via input_json_delta events.
          assemblers.set(event.index, {
            id: cb.id,
            name: cb.name,
            partialJson: '',
          });
        }
        // Text blocks: intentionally no-op. The assembler only cares about
        // tool_use reconstruction; text is captured elsewhere (if at all).
        return null;
      }

      case 'content_block_delta': {
        const delta = event.delta;
        if (!delta) return null;
        if (delta.type === 'input_json_delta') {
          const state = assemblers.get(event.index);
          if (!state) {
            // Orphan delta: no matching content_block_start at this index.
            // Log warn for observability (Phase 7 analyzer may want to detect
            // this pattern as an SDK/protocol anomaly) and record an error
            // record so the caller can surface it instead of silently losing
            // data. Never throw — a malformed event stream must not crash
            // the extraction loop.
            logger?.warn?.('stage6.assembler.orphan_delta', {
              index: event.index,
            });
            completed.push({
              index: event.index,
              tool_call_id: null,
              name: null,
              error: 'orphan_delta',
              raw_partial: delta.partial_json ?? '',
            });
            return null;
          }
          // Concatenate verbatim. Empty strings (Anthropic's first-delta
          // pattern and occasional mid-stream placeholders) are no-ops via
          // JavaScript string + — no special-casing needed.
          state.partialJson += delta.partial_json ?? '';
        }
        // text_delta: intentionally no-op.
        return null;
      }

      case 'content_block_stop': {
        const state = assemblers.get(event.index);
        if (state) {
          let record;
          try {
            // Empty-input tools (none in our schema set, but defensive) parse
            // as {} instead of throwing on empty string.
            const input = JSON.parse(state.partialJson || '{}');
            record = {
              index: event.index,
              tool_call_id: state.id,
              name: state.name,
              input,
            };
          } catch {
            // max_tokens truncation or (with eager_input_streaming, which we
            // do NOT enable in Phase 1) intra-stream parse failures both
            // surface here. Record as structured error with raw_partial so
            // the divergence log / analyzer can see what actually arrived.
            record = {
              index: event.index,
              tool_call_id: state.id,
              name: state.name,
              error: 'invalid_json',
              raw_partial: state.partialJson,
            };
          }
          completed.push(record);
          assemblers.delete(event.index);
          // Streamed-speculation hook (Loaded Barrel Phase 2.D, 2026-05-25).
          // Fires the moment a tool_use's input has been fully assembled —
          // before message_stop, before any post-stream dispatch loop. The
          // Loaded Barrel speculator subscribes via this so it can begin
          // ElevenLabs pre-synth for the confirmation TTS while Sonnet is
          // still emitting subsequent tool_use blocks in the same response.
          // For multi-tool turns this shaves the pre-synth start time by
          // the gap between content_block_stop and message_stop (~hundreds
          // of ms per tool). The callback is wrapped in try/catch so a
          // hook bug cannot corrupt the assembler's state-transition
          // contract.
          if (typeof onRecordComplete === 'function') {
            try {
              onRecordComplete(record);
            } catch (err) {
              logger?.warn?.('stage6.assembler.on_record_complete_error', {
                index: event.index,
                tool_call_id: record.tool_call_id,
                error: err?.message,
              });
            }
          }
        }
        // content_block_stop for a text block is a no-op here.
        return null;
      }

      case 'message_delta': {
        // NOT terminal. Anthropic emits message_delta purely to carry
        // usage/stop_reason metadata; the stream continues and message_stop
        // is the sole terminal marker. We capture stop_reason here so
        // finalize() can surface it, but we do NOT return the finalized
        // payload — returning it here would make iteration-driven callers
        // (those using `const out = asm.handle(ev)`) believe the stream has
        // completed one event early and race ahead of message_stop.
        if (event.delta && event.delta.stop_reason) {
          stopReason = event.delta.stop_reason;
        }
        return null;
      }

      case 'message_stop': {
        // Sole terminal event. Return the finalized payload so callers
        // driving the stream via `const out = asm.handle(event)` can detect
        // completion without a separate finalize() call. Callers that feed
        // events in a loop without inspecting the return value should still
        // call finalize() on stream end — handle() returning a payload is
        // a convenience, finalize() remains the authoritative terminator.
        return finalize();
      }

      default:
        // Unknown event types (ping, new Anthropic event variants added post
        // Phase 1) are ignored. Forward-compat: never throw on unknown types.
        return null;
    }
  }

  function finalize() {
    // Flush any still-open blocks as `incomplete_stream` error records BEFORE
    // sorting. Without this, a stream truncated after message_delta (network
    // drop, provider-side abort) would have its assistant message containing
    // `tool_use.id` entries that never got a matching content_block_stop —
    // those ids would have NO record here, so the tool-loop's next round
    // would push an `assistant(tool_use=id_X) -> user([])` pair with no
    // tool_result for id_X, which Anthropic's API rejects with a 400 on
    // `tool_use_id_without_result`. Codex's Phase-1 STG re-review flagged
    // this as BLOCK @ assembler:176. Emitting an error record with the real
    // tool_call_id lets the caller (stage6-tool-loop.js's error branch at
    // line ~211) emit a synthetic error tool_result for each orphaned id
    // and keep the turn conversation well-formed. We record raw_partial so
    // Phase 7's analyzer can see how far the stream got before truncation.
    for (const [index, state] of assemblers.entries()) {
      completed.push({
        index,
        tool_call_id: state.id,
        name: state.name,
        error: 'incomplete_stream',
        raw_partial: state.partialJson,
      });
    }
    assemblers.clear();

    // Return in index-ascending order for stable dispatch and stable
    // comparison in divergence logs. content_block_stop order can differ
    // from index order when blocks interleave (see interleaved-blocks
    // fixture — block at index 1 stops before block at index 0).
    const records = [...completed].sort((a, b) => a.index - b.index);
    return { records, stop_reason: stopReason };
  }

  return { handle, finalize };
}
