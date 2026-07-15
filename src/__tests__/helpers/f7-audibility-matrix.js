/**
 * f7-audibility-matrix.js — shared fixtures / builders for the F7
 * audibility-invariant sweep (task #17, PLAN f7-hardening-2026-07 Item 1).
 *
 * The sweep is the class-killer test harness for the 28 Stage-6 review
 * findings the PWA replay harness (web-composition scope) does not cover.
 * This module holds PURE, side-effect-free builders shared by BOTH lanes:
 *
 *   - the integration lane (`stage6-audibility-invariants.test.js`) — real
 *     registry / dispatcher / gate composition + real `runToolLoop` driven by
 *     a mock Anthropic client + a WS stub + fake timers;
 *   - the fast matrix lane (`stage6-audibility-matrix.test.js`) — fabricated
 *     tool-loop sequences through the REAL `runShadowHarness` with a mocked
 *     tool loop + logger (the existing fixture pattern).
 *
 * ZERO production behaviour is encoded here — the enum classification sets are
 * DERIVED from the real production exports (`ASK_USER_ANSWER_OUTCOMES`,
 * `isPreEmitNonFireReason`) so a future enum change fails the completeness
 * assertion in the test suite rather than silently drifting.
 */

import { jest } from '@jest/globals';
import { ASK_USER_ANSWER_OUTCOMES } from '../../extraction/stage6-dispatcher-logger.js';
import { isPreEmitNonFireReason } from '../../extraction/stage6-ask-gate-wrapper.js';

// ───────────────────────────────────────────────────────────────────────────
// Ask-outcome classification (enum-driven, NOT hand-listed).
//
// The two EXPLICIT sets below partition the 15-member closed enum
// `ASK_USER_ANSWER_OUTCOMES` by "is audibility guaranteed pre-emission (the
// ask never crossed the wire)" vs "audibility is decided by whether an
// `ask_user_started` was ACTUALLY emitted".
//
// GUARANTEED_PRE_EMIT_OUTCOMES is built via the exported predicate
// `isPreEmitNonFireReason` (5 members: validation_error /
// duplicate_tool_call_id / prompt_leak_blocked / shadow_mode /
// dispatcher_error) PLUS an explicit harness-only literal set for the three
// wrapper-LAYER suppressions (`restrained_mode` / `ask_budget_exhausted` are
// synthesised pre-dispatch by the gate wrapper; `gated` is a wrapper
// short-circuit). We do NOT build the union via `isWrapperShortCircuitReason`
// — that also matches `session_terminated` (emission-evidence-classified) and
// the reserved `gate_dispatcher_error` (not an enum member).
// ───────────────────────────────────────────────────────────────────────────

/** The three wrapper-LAYER suppressions that are pre-emission but are NOT
 *  members of `isPreEmitNonFireReason` (they originate in the gate wrapper's
 *  own pre-dispatch synth, not the inner dispatcher). Harness-only literal. */
export const WRAPPER_LAYER_PRE_EMIT_OUTCOMES = Object.freeze([
  'restrained_mode',
  'ask_budget_exhausted',
  'gated',
]);

/** GUARANTEED_PRE_EMIT_OUTCOMES = { m ∈ enum : isPreEmitNonFireReason(m) }
 *  ∪ { restrained_mode, ask_budget_exhausted, gated }. Should total 8. */
export const GUARANTEED_PRE_EMIT_OUTCOMES = Object.freeze(
  Array.from(
    new Set([
      ...ASK_USER_ANSWER_OUTCOMES.filter((m) => isPreEmitNonFireReason(m)),
      ...WRAPPER_LAYER_PRE_EMIT_OUTCOMES,
    ])
  )
);

/** EMISSION_EVIDENCE_REQUIRED_OUTCOMES — an EXPLICIT immutable set of exactly
 *  the seven members whose audibility is decided by emission evidence
 *  (`ask_user_started` actually sent), NEVER by outcome name. It is NOT the
 *  complement of the pre-emit set — a complement would auto-absorb any future
 *  enum member and the "fails until classified" guard would silently break.
 *  `session_terminated` in particular can occur pre-dispatch in the gate OR
 *  after a sent ask, so a name-only classification cannot encode it. */
export const EMISSION_EVIDENCE_REQUIRED_OUTCOMES = Object.freeze([
  'answered',
  'timeout',
  'user_moved_on',
  'transcript_already_extracted',
  'session_terminated',
  'session_stopped',
  'session_reconnected',
]);

/** A4-only broker outcomes. NOT members of `ASK_USER_ANSWER_OUTCOMES` — kept
 *  in a separately declared set so the enum completeness assertion stays
 *  exact. */
export const A4_BROKER_OUTCOMES = Object.freeze(['broker_register_failed', 'broker_emit_failed']);

// ───────────────────────────────────────────────────────────────────────────
// WS-stub fixtures.
//
// Production checks `ws.readyState === ws.OPEN` before sending, so a stub
// with only `readyState: 1` (and no `OPEN`) makes EVERY send look closed —
// a missing-`OPEN` double already burned the field-feedback wave. Every stub
// therefore carries `OPEN: 1`. The `send` records the PARSED frame in `sent`.
// ───────────────────────────────────────────────────────────────────────────

/** Open WS stub: OPEN:1, readyState:1, records each parsed frame in `sent`. */
export function makeOpenWs() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(payload) {
      this.sent.push(JSON.parse(payload));
    },
  };
}

/** Closed WS stub: same shape as open but `readyState` differs (3 = CLOSED),
 *  so production's `readyState === OPEN` guard fails and never calls send. */
export function makeClosedWs() {
  const ws = makeOpenWs();
  ws.readyState = 3;
  return ws;
}

/** Throwing WS stub: keeps `readyState === OPEN` so production ATTEMPTS the
 *  send, but `send` throws — modelling a socket that dies mid-write. */
export function makeThrowingWs() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send() {
      throw new Error('ws send failed (throwing-stub)');
    },
  };
}

/** Count `ask_user_started` frames a WS stub actually recorded. */
export function askStartedFrames(ws) {
  if (!ws || !Array.isArray(ws.sent)) return [];
  return ws.sent.filter((f) => f && f.type === 'ask_user_started');
}

// ───────────────────────────────────────────────────────────────────────────
// Mock-Anthropic SSE round builders (for the integration lane's real
// `runToolLoop`). Mirror the shape used across the Stage-6 test suite.
// ───────────────────────────────────────────────────────────────────────────

/** Build one tool_use round's SSE events from an array of {id, name, input}. */
export function toolUseRound(toolCalls) {
  const events = [];
  toolCalls.forEach((tc, i) => {
    events.push({
      type: 'content_block_start',
      index: i,
      content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
    });
    events.push({
      type: 'content_block_delta',
      index: i,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input ?? {}) },
    });
    events.push({ type: 'content_block_stop', index: i });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  return events;
}

/** Build one end_turn round's SSE events (optional trailing text). */
export function endTurnRound(text = '') {
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ];
}

// ───────────────────────────────────────────────────────────────────────────
// Session / logger factories.
// ───────────────────────────────────────────────────────────────────────────

export function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/**
 * Build a live-mode session double shaped like the one `runShadowHarness`
 * consumes. Callers override `client` (mock Anthropic), `stateSnapshot`, etc.
 */
export function makeLiveSession(overrides = {}) {
  return {
    sessionId: overrides.sessionId ?? 'sess-f7-audibility',
    systemPrompt: 'sys',
    toolCallsMode: 'live',
    turnCount: 0,
    client: null,
    stateSnapshot: { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] },
    extractedObservations: [],
    activeTurnTranscript: null,
    buildSystemBlocks() {
      return [
        { type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral', ttl: '5m' } },
      ];
    },
    buildAgenticSystemBlocks() {
      return this.buildSystemBlocks();
    },
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Audibility oracles.
//
// Audible text is defined EVERYWHERE as a trimmed-non-empty string — web trims
// before speaking, so a whitespace-only prompt/confirmation must NOT count as
// audible output.
// ───────────────────────────────────────────────────────────────────────────

/** Audible text predicate — trimmed-non-empty string. */
export function isAudibleText(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

/**
 * Integration-lane audibility oracle: a chime-producing turn is audible iff
 * the WS stub actually recorded ≥1 `ask_user_started` frame OR the result
 * carries ≥1 confirmation with trimmed-non-empty text. NEVER decided by
 * outcome name — only by observed emission + surviving spoken text.
 */
export function turnIsAudible(result, ws) {
  const confs = Array.isArray(result?.confirmations) ? result.confirmations : [];
  const spoke = confs.some((c) => isAudibleText(c?.text));
  const emitted = askStartedFrames(ws).length > 0;
  return spoke || emitted;
}

/** Count surviving wire confirmations with audible text (for invariant (b)). */
export function audibleConfirmations(result) {
  const confs = Array.isArray(result?.confirmations) ? result.confirmations : [];
  return confs.filter((c) => isAudibleText(c?.text));
}

/** Extract every `ios_send_attempt` telemetry row from a logger. */
export function iosSendAttempts(logger) {
  return logger.info.mock.calls.filter((c) => c[0] === 'ios_send_attempt').map((c) => c[1]);
}

// ───────────────────────────────────────────────────────────────────────────
// Sentinel / confidence scanners (invariants (d) + (e)).
// ───────────────────────────────────────────────────────────────────────────

/** True if ANY wire confirmation entry carries a `_confidence` key. */
export function anyConfidenceKeyOnWire(result) {
  const confs = Array.isArray(result?.confirmations) ? result.confirmations : [];
  return confs.some((c) => c && Object.prototype.hasOwnProperty.call(c, '_confidence'));
}

/** Collect every spoken text string in a result (confirmations + expanded_text
 *  + any embedded ask question text) for the `__`-sentinel scan. */
export function spokenTexts(result) {
  const out = [];
  const confs = Array.isArray(result?.confirmations) ? result.confirmations : [];
  for (const c of confs) {
    if (typeof c?.text === 'string') out.push(c.text);
    if (typeof c?.expanded_text === 'string') out.push(c.expanded_text);
  }
  const readings = Array.isArray(result?.extracted_readings) ? result.extracted_readings : [];
  for (const r of readings) {
    if (typeof r?.expanded_text === 'string') out.push(r.expanded_text);
  }
  return out;
}

/** True if any spoken text contains a `__`-sentinel substring. */
export function anySentinelInSpokenText(result) {
  return spokenTexts(result).some((t) => typeof t === 'string' && t.includes('__'));
}
