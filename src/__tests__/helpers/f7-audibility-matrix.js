/**
 * f7-audibility-matrix.js — JEST-LANE fixtures / adapters for the F7
 * audibility-invariant sweep (task #17, PLAN f7-hardening-2026-07 Item 1;
 * refactored by replay-corpus-gate-2026-07 Item 2).
 *
 * The ENVIRONMENT-NEUTRAL builders and predicates now live in
 * f7-audibility-core.js (accepting plain captured arrays; zero jest, zero
 * production imports) so the standalone field-replay runner can share them.
 * This module keeps everything jest- or production-bound:
 *   - the enum-derived ask-outcome classification sets (import production
 *     exports — deliberately NOT in the core, which must stay free of
 *     src/extraction imports for the replay bootstrap's import-graph rule);
 *   - makeLogger / makeLiveSession (jest factories);
 *   - THIN ADAPTERS converting jest captures (logger.info.mock.calls,
 *     ws.sent) to the core's plain-array interfaces, preserving the
 *     original call signatures for the existing F7 test consumers.
 * Parity tests (f7-adapter-parity.test.js) prove the jest and standalone
 * adapters return identical verdicts.
 */

import { jest } from '@jest/globals';
import { ASK_USER_ANSWER_OUTCOMES } from '../../extraction/stage6-dispatcher-logger.js';
import { isPreEmitNonFireReason } from '../../extraction/stage6-ask-gate-wrapper.js';
import * as core from './f7-audibility-core.js';

// Re-export the env-neutral pieces so existing consumers keep one import.
export {
  makeOpenWs,
  makeClosedWs,
  makeThrowingWs,
  toolUseRound,
  endTurnRound,
  isAudibleText,
  audibleConfirmations,
  anyConfidenceKeyOnWire,
} from './f7-audibility-core.js';

// ───────────────────────────────────────────────────────────────────────────
// Ask-outcome classification (enum-driven, NOT hand-listed).
//
// The two EXPLICIT sets below partition the 15-member closed enum
// `ASK_USER_ANSWER_OUTCOMES` by "is audibility guaranteed pre-emission (the
// ask never crossed the wire)" vs "audibility is decided by whether an
// `ask_user_started` was ACTUALLY emitted".
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
// Session / logger factories (jest-bound).
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
// Jest ADAPTERS over the env-neutral core (original signatures preserved).
// ───────────────────────────────────────────────────────────────────────────

/** Count `ask_user_started` frames a WS stub actually recorded. */
export function askStartedFrames(ws) {
  return core.askStartedFrames(ws?.sent ?? []);
}

/** Integration-lane audibility oracle over a WS stub. */
export function turnIsAudible(result, ws) {
  return core.turnIsAudible(result, ws?.sent ?? []);
}

/** Convert `logger.info.mock.calls` (jest-mock API) to plain log rows. */
function jestLoggerRows(logger) {
  const calls = logger?.info?.mock?.calls ?? [];
  return calls.map(([name, meta]) => ({ name, meta }));
}

/** Extract every `ios_send_attempt` telemetry row from a jest logger. */
export function iosSendAttempts(logger) {
  return core.iosSendAttempts(jestLoggerRows(logger));
}

/** Spoken-text collection; pass the WS stub to include emitted ask
 *  questions in the scan (the pre-refactor form was blind to them). */
export function spokenTexts(result, ws = null) {
  return core.spokenTexts(result, ws?.sent ?? []);
}

/** `__`-sentinel scan over confirmations + readings + emitted ask questions. */
export function anySentinelInSpokenText(result, ws = null) {
  return core.anySentinelInSpokenText(result, ws?.sent ?? []);
}
