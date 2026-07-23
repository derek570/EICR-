/**
 * A1 agentic-voice (2026-07-23) — answer_user + inspect_session_state
 * dispatchers.
 *
 * These are READ-ONLY output/query tools, deliberately NOT registered in
 * WRITE_DISPATCHERS: that table feeds WRITE_TOOL_NAMES and every consumer
 * keyed on it (composer delegation, bundler write accounting, marker-net
 * write classification), and an answer is not a write. They get dedicated
 * named branches in createToolDispatcher instead.
 *
 * Emission model — STAGE, DON'T SEND: dispatchers have no WebSocket access.
 * The answer dispatcher stages the first successfully-normalised,
 * leak-filter-passed answer into the turn-local accumulator
 * (`perTurnWrites.answer`), and runLiveMode/bundleToolCallsIntoResult
 * projects it as `result.spoken_response`, which the EXISTING
 * voice_command_response emit machinery (sync + P4d reconnect replay,
 * sonnet-stream.js) delivers — with the utterance_id stamp, socket-down
 * buffering, and FIFO replay for free.
 *
 * Every return path satisfies the real Stage-6 dispatcher contract
 * `{tool_use_id: call.tool_call_id, content: JSON.stringify(...), is_error}`
 * (stage6-tool-loop.js) — never a bare {ok} object.
 *
 * is_error semantics (PLAN Item 1/1b outcome matrix — `is_error: true` is a
 * RETRY signal to the model):
 *   answer_user:   success → false · empty_answer (first) → true (one
 *                  corrected attempt invited) · empty_answer_retry_exhausted
 *                  → false (no loop-to-cap) · answer_filtered → false (no
 *                  retry loop on the leak filter) · answer_already_given →
 *                  false.
 *   inspect:       success → false · invalid_scope / not_found → true (the
 *                  model may correct its arguments and re-call; safe because
 *                  both tools are name-guard-excluded from the A3 orphan
 *                  net's allRejected).
 *
 * LEAK RULE: model-controlled answer text is NEVER logged raw — input_summary
 * carries char counts / flags only.
 */

import { logToolCall } from './stage6-dispatcher-logger.js';
import { checkForPromptLeak } from './stage6-prompt-leak-filter.js';
import {
  projectSummary,
  projectBoard,
  projectCircuit,
  projectField,
  capInspectResult,
  resolveBoardTarget,
  isKnownFieldKey,
  isCircuitFieldKey,
  isBoardLevelFieldKey,
} from './stage6-inspect-projector.js';

/** Resolved decision 1 (Derek 2026-07-22): terse answers, hard cap. */
export const ANSWER_USER_MAX_CHARS = 300;

/**
 * PLAN Item 4 — the FIXED server-controlled fallback answer. Staged by
 * runLiveMode's post-loop finalization when the answer feature was attempted
 * (any answer_user OR inspect_session_state call) but nothing was staged and
 * the turn produced no successful write and no emitted ask. A fixed string —
 * no leak filter needed — that projects into result.spoken_response like a
 * real answer and counts as speech-intent for every marker net, so a failed
 * answer is never silent in EITHER confirmation-toggle state (the apology
 * nets are confirmationsEnabled-gated and cannot cover confirmation-OFF).
 */
export const ANSWER_FALLBACK_TEXT = "Sorry, I couldn't answer that — please ask it another way.";

/**
 * Deterministic answer normaliser (PLAN Item 1.2). Pure; unit-tested.
 *
 *   1. trim — empty → null.
 *   2. retain at most the first two sentence segments (split on
 *      terminator+whitespace so decimals "0.42" and refs "61009." mid-number
 *      never split).
 *   3. enforce ANSWER_USER_MAX_CHARS: prefer the last sentence boundary under
 *      the cap; else cut at the last whitespace before the cap and append an
 *      ellipsis; a boundary-less hard string cuts at the cap.
 *   4. empty result → null.
 *
 * @returns {{text: string, truncated: boolean} | null}
 */
export function normaliseAnswerText(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  let text = sentences.slice(0, 2).join(' ');
  let truncated = sentences.length > 2;

  if (text.length > ANSWER_USER_MAX_CHARS) {
    truncated = true;
    const window = text.slice(0, ANSWER_USER_MAX_CHARS);
    // Prefer a sentence boundary inside the window…
    const lastBoundary = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? ')
    );
    if (lastBoundary > 0) {
      text = window.slice(0, lastBoundary + 1);
    } else {
      // …else the last whitespace before the cap, with an ellipsis.
      const lastSpace = window.lastIndexOf(' ');
      text = lastSpace > 0 ? `${window.slice(0, lastSpace).trimEnd()}…` : window;
    }
  }

  text = text.trim();
  if (!text) return null;
  return { text, truncated };
}

function envelope(call, body, isError) {
  return {
    tool_use_id: call.tool_call_id,
    content: JSON.stringify(body),
    is_error: isError,
  };
}

/**
 * Factory for the answer_user dispatcher. Same (session, logger, turnId,
 * perTurnWrites) binding shape as createWriteDispatcher; constructed
 * INDEPENDENTLY of pendingAsks so the tool always has a dispatch route on
 * both composition paths.
 */
export function createAnswerDispatcher(session, logger, turnId, perTurnWrites) {
  let round = 0;
  return async (call, _ctx) => {
    round += 1;
    const state = perTurnWrites.answer;
    state.featureTouched = true;

    const emit = (outcome, body, isError, inputSummary = {}) => {
      logToolCall(logger, {
        sessionId: session.sessionId,
        turnId,
        tool_use_id: call.tool_call_id,
        tool: 'answer_user',
        round,
        is_error: isError,
        outcome,
        validation_error: body.ok ? undefined : { code: body.code },
        input_summary: inputSummary, // NEVER raw answer text (leak rule)
      });
      return envelope(call, body, isError);
    };

    // At-most-once: latched ONLY on successful staging, so a rejected first
    // attempt leaves the model free to correct itself within the turn.
    if (state.stagedText != null) {
      return emit('noop', { ok: false, code: 'answer_already_given' }, false);
    }

    const normalised = normaliseAnswerText(call.input?.answer_text);
    if (normalised == null) {
      if (!state.emptyRetryUsed) {
        state.emptyRetryUsed = true;
        state.outcomes.push({ tool: 'answer_user', code: 'empty_answer' });
        return emit('rejected', { ok: false, code: 'empty_answer' }, true);
      }
      state.outcomes.push({ tool: 'answer_user', code: 'empty_answer_retry_exhausted' });
      return emit('rejected', { ok: false, code: 'empty_answer_retry_exhausted' }, false);
    }

    // Prompt-leak OUTPUT filter (not a PII sanitiser — certificate content
    // MAY be spoken; the active inspector already hears exactly this data via
    // read-backs and asks). Reject shape carries no retry signal.
    const leak = checkForPromptLeak(normalised.text, { field: 'question' });
    if (!leak.safe) {
      state.outcomes.push({ tool: 'answer_user', code: 'answer_filtered', reason: leak.reason });
      return emit('rejected', { ok: false, code: 'answer_filtered' }, false, {
        filter_reason: leak.reason,
      });
    }

    state.stagedText = normalised.text;
    state.stagedMeta = { truncated: normalised.truncated, chars: normalised.text.length };
    state.outcomes.push({ tool: 'answer_user', code: 'ok' });
    return emit('ok', { ok: true }, false, {
      chars: normalised.text.length,
      truncated: normalised.truncated,
    });
  };
}

const INSPECT_SCOPES = new Set(['summary', 'board', 'circuit', 'field']);

/**
 * Factory for the inspect_session_state dispatcher. Pure read: projects the
 * authoritative snapshot through stage6-inspect-projector (multi-board-safe,
 * USER_TEXT-wrapped, size-capped per the approved appendix). No wire frames,
 * no TTS — purely model-facing.
 */
export function createInspectDispatcher(session, logger, turnId, perTurnWrites) {
  let round = 0;
  return async (call, _ctx) => {
    round += 1;
    const state = perTurnWrites.answer;
    state.featureTouched = true;

    const emit = (outcome, body, isError, inputSummary = {}) => {
      logToolCall(logger, {
        sessionId: session.sessionId,
        turnId,
        tool_use_id: call.tool_call_id,
        tool: 'inspect_session_state',
        round,
        is_error: isError,
        outcome,
        validation_error: body.ok ? undefined : { code: body.code },
        input_summary: inputSummary,
      });
      if (!body.ok) {
        state.outcomes.push({ tool: 'inspect_session_state', code: body.code });
      } else {
        state.outcomes.push({ tool: 'inspect_session_state', code: 'ok' });
      }
      return envelope(call, body, isError);
    };

    const input = call.input && typeof call.input === 'object' ? call.input : {};
    const scope = input.scope;
    if (!INSPECT_SCOPES.has(scope)) {
      return emit('rejected', { ok: false, code: 'invalid_scope' }, true, { scope: null });
    }

    const snapshot = session.stateSnapshot;
    const certType = session.certType === 'eic' ? 'EIC' : 'EICR';

    const boardId = resolveBoardTarget(snapshot, input.board_id);
    if (boardId == null) {
      return emit('rejected', { ok: false, code: 'not_found' }, true, { scope });
    }

    // Circuit arg validation: integer ≥ 1 when present (string digits accepted).
    let circuit = null;
    if (input.circuit != null) {
      const n = Number(input.circuit);
      if (!Number.isInteger(n) || n < 1) {
        return emit('rejected', { ok: false, code: 'invalid_scope' }, true, { scope });
      }
      circuit = n;
    }

    let body;
    switch (scope) {
      case 'summary':
        body = projectSummary(snapshot, {
          certType,
          observationCount: Array.isArray(session.extractedObservations)
            ? session.extractedObservations.length
            : null,
        });
        break;
      case 'board':
        body = projectBoard(snapshot, boardId, { certType });
        break;
      case 'circuit': {
        if (circuit == null) {
          return emit('rejected', { ok: false, code: 'invalid_scope' }, true, { scope });
        }
        body = projectCircuit(snapshot, circuit, boardId, { certType });
        if (body == null) {
          return emit('rejected', { ok: false, code: 'not_found' }, true, { scope, circuit });
        }
        break;
      }
      case 'field': {
        if (typeof input.field !== 'string' || !isKnownFieldKey(input.field)) {
          return emit('rejected', { ok: false, code: 'invalid_scope' }, true, { scope });
        }
        // Codex diff-review r1 — field/circuit pairing validation: a
        // circuit-only field needs a circuit; a board-level-only field must
        // not carry one. A mismatch is a correctable-argument error
        // (invalid_scope, is_error:true) — never a false "not recorded"
        // answer the model would speak as fact. Keys present in BOTH unions
        // accept either form.
        if (circuit == null && !isBoardLevelFieldKey(input.field)) {
          return emit('rejected', { ok: false, code: 'invalid_scope' }, true, { scope });
        }
        if (circuit != null && !isCircuitFieldKey(input.field)) {
          return emit('rejected', { ok: false, code: 'invalid_scope' }, true, { scope });
        }
        body = projectField(snapshot, { field: input.field, circuit, boardId });
        if (body == null) {
          return emit('rejected', { ok: false, code: 'not_found' }, true, { scope, circuit });
        }
        break;
      }
      default:
        return emit('rejected', { ok: false, code: 'invalid_scope' }, true, { scope: null });
    }

    return emit('ok', capInspectResult(body), false, { scope, circuit });
  };
}
