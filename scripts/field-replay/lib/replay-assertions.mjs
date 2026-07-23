/**
 * replay-assertions.mjs — the per-turn assertion engine (plan Item 2
 * "Assertions per turn" + "Jest-independent invariant module").
 *
 * Applicability is MACHINE-DRIVEN by the fixture's expected_operations[] /
 * expected_audible_outputs[], never unconditional: an unconditional
 * per-turn check would wrongly fail an observation-only turn for lacking
 * readings, the marker-① zero-output fixture for lacking both writes, and
 * an interceptor's intentionally-deferred intermediate round — spawning
 * extra failures that break the exactly-one-expected_failure_id RED
 * contract.
 *
 * Assertion IDs are ATOMIC per audible contract: when
 * expected_audible_outputs[] exists, `audibility.output.<output_id>`
 * JOINTLY checks presence, count, text, field/circuit, and identity — no
 * separate turn-level missing-audio failure is emitted; the generic
 * `audibility.turn` fires only when no explicit audible-output oracle
 * exists. Matching is ONE-TO-ONE bipartite; an ambiguous match FAILS;
 * every unclaimed audible result/frame FAILS.
 */

import {
  turnIsAudible,
  audibleConfirmations,
  askStartedFrames,
  anyConfidenceKeyOnWire,
  anySentinelInSpokenText,
  iosSendAttempts,
  isAudibleText,
} from '../../../src/__tests__/helpers/f7-audibility-core.js';

export const OUTCOME = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  INFRASTRUCTURE: 'infrastructure_error',
});

// ask_user answer_outcomes that mean the dispatcher DECLINED to pose the ask
// (a "reject" for dispatcher_expectation purposes) — the ask never reached the
// user. The complement (answered/timeout/user_moved_on/session_*) means the
// ask WAS posed (an "accept"). Mirrors ASK_USER_ANSWER_OUTCOMES.
const ASK_DISPATCH_REJECT_OUTCOMES = new Set([
  'restrained_mode',
  'ask_budget_exhausted',
  'gated',
  'shadow_mode',
  'validation_error',
  'duplicate_tool_call_id',
  'dispatcher_error',
  'prompt_leak_blocked',
]);

function norm(v) {
  return v == null ? null : String(v);
}

/** Does an audible-output matcher accept this candidate confirmation? */
function confirmationMatches(matcher, conf) {
  if (matcher.field !== undefined && norm(conf.field) !== norm(matcher.field)) return false;
  if (matcher.circuit !== undefined && norm(conf.circuit) !== norm(matcher.circuit)) return false;
  if (matcher.circuits !== undefined) {
    const got = (conf.circuits ?? []).map(norm).sort();
    const want = matcher.circuits.map(norm).sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) return false;
  }
  if (matcher.board_id !== undefined && norm(conf.board_id) !== norm(matcher.board_id)) return false;
  if (matcher.value !== undefined && norm(conf.value) !== norm(matcher.value)) return false;
  if (matcher.dedupe_token !== undefined && norm(conf.dedupe_token) !== norm(matcher.dedupe_token)) return false;
  if (matcher.expected_key !== undefined && norm(conf.expected_key ?? conf.dedupe_token) !== norm(matcher.expected_key)) return false;
  if (matcher.text_exact !== undefined && String(conf.text ?? '').trim() !== matcher.text_exact) return false;
  return true;
}

function askFrameMatches(matcher, frame) {
  if (matcher.tool_call_id !== undefined) {
    return frame.tool_call_id === matcher.tool_call_id;
  }
  if (matcher.reason !== undefined && frame.reason !== matcher.reason) return false;
  if (matcher.context_field !== undefined && frame.context_field !== matcher.context_field) return false;
  if (matcher.context_circuit !== undefined && norm(frame.context_circuit) !== norm(matcher.context_circuit)) return false;
  if (matcher.question_contains !== undefined && !String(frame.question ?? '').toLowerCase().includes(String(matcher.question_contains).toLowerCase())) return false;
  return true;
}

/**
 * One-to-one bipartite matching of expected_audible_outputs against the
 * captured audible candidates. Candidates: audible confirmations (kind
 * reading_confirmation / state_confirmation / field_null_fallback) and
 * emitted ask frames (kind ask_user). Returns { failures, claims }.
 */
export function matchAudibleOutputs(expectedOutputs, { result, wsFrames }) {
  const failures = [];
  const confs = audibleConfirmations(result).map((c, i) => ({ kind: 'confirmation', c, idx: `conf_${i}` }));
  const asks = askStartedFrames(wsFrames).map((f, i) => ({ kind: 'ask', f, idx: `ask_${i}` }));
  const claimed = new Set();
  const claims = new Map();

  for (const out of expectedOutputs) {
    const id = `audibility.output.${out.output_id}`;
    const pool =
      out.kind === 'ask_user'
        ? asks.filter((a) => askFrameMatches(out.match ?? {}, a.f))
        : confs.filter((x) => {
            if (out.kind === 'field_null_fallback') {
              // field_null_fallback implies field:null + circuit:null on the
              // wire, plus the byte-exact text + token from the matcher.
              if (x.c.field != null || x.c.circuit != null) return false;
            }
            return confirmationMatches(out.match ?? {}, x.c);
          });
    const unclaimedPool = pool.filter((x) => !claimed.has(x.idx));
    if (out.count === 0) {
      if (unclaimedPool.length > 0) {
        failures.push({ id, outcome: OUTCOME.FAIL, message: `expected count 0, found ${unclaimedPool.length} matching audible output(s)` });
      }
      continue;
    }
    if (unclaimedPool.length < out.count) {
      failures.push({ id, outcome: OUTCOME.FAIL, message: `expected ${out.count} audible output(s), found ${unclaimedPool.length}` });
      continue;
    }
    if (unclaimedPool.length > out.count) {
      // Ambiguity: more candidates than the expected count → FAILS (the
      // matcher must be UNIQUE; never executor judgment).
      failures.push({ id, outcome: OUTCOME.FAIL, message: `ambiguous match: ${unclaimedPool.length} candidates for expected count ${out.count}` });
      continue;
    }
    for (const x of unclaimedPool) {
      claimed.add(x.idx);
      claims.set(x.idx, out.output_id);
    }
  }

  // Every unclaimed audible result/frame FAILS (exactly-once: nothing
  // audible may cross the wire unaccounted).
  for (const x of [...confs, ...asks]) {
    if (!claimed.has(x.idx)) {
      const desc = x.kind === 'confirmation'
        ? `confirmation field=${x.c.field ?? 'null'} circuit=${x.c.circuit ?? 'null'} text="${String(x.c.text ?? '').slice(0, 60)}"`
        : `ask_user_started tool_call_id=${x.f.tool_call_id} question="${String(x.f.question ?? '').slice(0, 60)}"`;
      failures.push({ id: 'audibility.unclaimed', outcome: OUTCOME.FAIL, message: `unclaimed audible output: ${desc}` });
    }
  }
  return { failures, claims };
}

/** Reading/observation write assertions from expected_operations[].
 *  Fail-closed: an operation kind the oracle cannot faithfully verify latches
 *  an INFRASTRUCTURE outcome (which can never satisfy required_green OR an
 *  expected_red) rather than silently passing an un-checked expectation. */
export function matchOperations(expectedOps, { result, toClearWireField }) {
  const failures = [];
  const readings = result?.extracted_readings ?? [];
  const observations = [...(result?.observations ?? []), ...(result?.observationUpdates ?? [])];
  const matchReading = (op, c) =>
    readings.filter((r) => {
      if (op.field !== undefined && norm(r.field) !== norm(op.field)) return false;
      if (c != null && norm(r.circuit) !== norm(c)) return false;
      if (op.board_id !== undefined && op.board_id !== null && norm(r.board_id) !== norm(op.board_id)) return false;
      if (op.value !== undefined && norm(r.value) !== norm(op.value)) return false;
      return true;
    });
  for (const op of expectedOps) {
    // P5 (2026-07-23, marker T10) — clear_then_write JOINT assertion. On broken
    // main the wiped write IS present in extracted_readings (the wipe is the
    // post-envelope field_corrected frame), so the plain reading oracle GREENs;
    // this branch additionally proves the stale clear was collapsed away. ONE
    // reading.<operation_id> failure covers BOTH the missing-replacement and
    // the surviving-stale-clear conditions. Board comparison is EXACT (never
    // matchReading's null-wildcard): board_id = the replacement reading's
    // outward board, clear_board_id = the collapsed correction's outward board.
    if (op.kind === 'reading' && op.state_transition === 'clear_then_write') {
      const id = `reading.${op.operation_id}`;
      // A2 wire-dialect mapping is INJECTED (never statically imported here —
      // the recorded lane installs a fake clock before the extraction graph
      // loads). Absent → INFRASTRUCTURE, never a spurious pass/fail.
      if (typeof toClearWireField !== 'function') {
        failures.push({ id, outcome: OUTCOME.INFRASTRUCTURE, message: 'clear_then_write oracle needs the injected A2 field mapping (toClearWireField) — unavailable' });
        continue;
      }
      const problems = [];
      // (a) replacement reading present — exact (field, circuit, value, board_id).
      const replHits = readings.filter(
        (r) =>
          norm(r.field) === norm(op.field) &&
          norm(r.circuit) === norm(op.circuit) &&
          norm(r.value) === norm(op.value) &&
          norm(r.board_id ?? null) === norm(op.board_id ?? null),
      );
      if (replHits.length === 0) {
        problems.push(`replacement ${op.field} c${op.circuit} = ${JSON.stringify(op.value)} (board ${JSON.stringify(op.board_id ?? null)}) not written`);
      } else if (replHits.length > 1 && op.audibility === 'exactly_once') {
        problems.push(`expected exactly one replacement ${op.field} c${op.circuit}, found ${replHits.length}`);
      }
      // (b) zero same-slot clear_reading field_corrections. field_corrections
      // carry the A2-canonicalised wire field, so map the raw expected field
      // through the injected mapping for the lookup. Board compared exactly
      // against clear_board_id.
      const wireField = toClearWireField(op.field);
      const staleClears = (result?.field_corrections ?? []).filter(
        (c) =>
          c?.reason === 'clear_reading' &&
          norm(c.field) === norm(wireField) &&
          norm(c.circuit) === norm(op.circuit) &&
          norm(c.board_id ?? null) === norm(op.clear_board_id ?? null),
      );
      if (staleClears.length > 0) {
        problems.push(`stale clear_reading correction survived for ${wireField} c${op.circuit} (board ${JSON.stringify(op.clear_board_id ?? null)}) — the write is wiped on the client`);
      }
      if (problems.length) {
        failures.push({ id, outcome: OUTCOME.FAIL, message: `clear_then_write: ${problems.join('; ')}` });
      }
      continue;
    }
    if (op.kind === 'reading' || op.kind === 'board_reading') {
      const id = `reading.${op.operation_id}`;
      // Grouped ops carry `circuits[]` — EVERY declared circuit must have its
      // write, not just one (the any-one-match bug). A single-circuit op uses
      // `circuit`. exactly_once additionally requires no duplicate write.
      const circuits = op.circuits ?? (op.circuit != null ? [op.circuit] : [null]);
      for (const c of circuits) {
        const hits = matchReading(op, c);
        if (hits.length === 0) {
          failures.push({ id, outcome: OUTCOME.FAIL, message: `expected ${op.kind} ${op.field ?? ''} c${c ?? '?'} not written` });
        } else if (hits.length > 1 && op.audibility === 'exactly_once') {
          failures.push({ id, outcome: OUTCOME.FAIL, message: `expected exactly one ${op.kind} ${op.field ?? ''} c${c ?? '?'}, found ${hits.length}` });
        }
      }
    } else if (op.kind === 'observation' || op.kind === 'observation_update') {
      const id = `observation.${op.operation_id}`;
      const hits = observations.filter((o) => {
        if (op.value?.code !== undefined && String(o.code ?? '').toUpperCase() !== String(op.value.code).toUpperCase()) return false;
        if (op.value?.text_contains !== undefined && !String(o.observation_text ?? o.text ?? '').toLowerCase().includes(String(op.value.text_contains).toLowerCase())) return false;
        return true;
      });
      if (hits.length === 0) {
        failures.push({ id, outcome: OUTCOME.FAIL, message: `expected ${op.kind} not committed this turn` });
      } else if (hits.length > 1 && op.audibility === 'exactly_once') {
        failures.push({ id, outcome: OUTCOME.FAIL, message: `expected exactly one ${op.kind}, found ${hits.length}` });
      }
    } else {
      // FAIL-CLOSED: clear / rename / create_circuit (and any future kind)
      // cannot yet be faithfully verified against post-turn state via the
      // harness result. Latch INFRASTRUCTURE so a fixture declaring one can
      // NEVER spuriously satisfy required_green or an expected_red — implement
      // the oracle before admitting the assertion (see fixture-schema.mjs
      // which also rejects these kinds at validation time).
      failures.push({
        id: `operation.unverifiable.${op.operation_id}`,
        outcome: OUTCOME.INFRASTRUCTURE,
        message: `operation kind '${op.kind}' has no faithful oracle yet — refusing to assert (infrastructure)`,
      });
    }
  }
  return failures;
}

/** Expected backend/model asks (assertion (d) — clarification follow-up). */
export function matchExpectedAsks(expectedAsks, { wsFrames, askOrigins }) {
  const failures = [];
  const frames = askStartedFrames(wsFrames);
  for (const [i, want] of expectedAsks.entries()) {
    const id = `clarification.ask_${i}`;
    const hits = frames.filter((f) => {
      if (want.origin && askOrigins) {
        const origin = askOrigins.get(f.tool_call_id) ?? 'backend_interceptor';
        const wantOrigin = want.origin === 'model' ? 'model_emitted' : 'backend_interceptor';
        if (origin !== wantOrigin) return false;
      }
      return askFrameMatches(want, f);
    });
    if (hits.length === 0) {
      // A DECLARED expected backend-generated ask that is NEVER observed is
      // NOT an infrastructure failure — it is the clean failure of this
      // assertion (exactly keystone ⑤'s expected_failure_id on baseline).
      failures.push({ id, outcome: OUTCOME.FAIL, message: `expected ${want.origin ?? ''} clarification ask not emitted` });
    }
  }
  return failures;
}

/**
 * Verify each declared tool call's `schema_expectation` / `dispatcher_expectation`
 * against what ACTUALLY happened, so a fixture cannot pass while exercising a
 * materially different path (declared accept but the real schema/dispatcher
 * rejected, or vice-versa).
 *   - schema_expectation: validated deterministically via `captured.validateToolInput`
 *     (the REAL production tool schema compiled with the shared Ajv config) when
 *     the runner injects it. A mismatch is an assertion FAILURE.
 *   - dispatcher_expectation: cross-checked against the REAL dispatch log rows
 *     (`stage6_tool_call` / `stage6.tool_call`) by tool id. A row that
 *     CONTRADICTS the declaration FAILS; an ABSENT row (accept declared, no
 *     dispatch row found) latches INFRASTRUCTURE — the call never reached the
 *     real dispatcher, so no assertion about it can be trusted.
 */
export function matchToolExpectations(turn, captured) {
  const failures = [];
  const rows = captured.logRows ?? [];
  // ONLY the authoritative `stage6_tool_call` rows carry the real dispatch
  // outcome (is_error + validation_error). The thin `stage6.tool_call`
  // (outcome:'stub_ok') rows do NOT carry is_error and are never consulted for
  // a dispatch outcome, so an errored call logged there cannot satisfy accept.
  // Normalise a validation_error that may be a string OR a structured object
  // ({code}) — String(obj) would collapse to "[object Object]" and never match.
  const errCode = (ve) => (ve == null ? '' : typeof ve === 'string' ? ve : String(ve.code ?? JSON.stringify(ve)));
  for (const round of turn.model_rounds ?? []) {
    if (round.stop_reason !== 'tool_use') continue;
    for (const tc of round.tool_calls ?? []) {
      // (1) schema_expectation — deterministic Ajv against the REAL tool schema.
      // Distinct id from the dispatcher assertion so two independent failures
      // never collapse into one (an expected_red requires EXACTLY one failure).
      if (tc.schema_expectation) {
        if (!captured.validateToolInput) {
          failures.push({ id: `tool.schema.${tc.id}`, outcome: OUTCOME.INFRASTRUCTURE, message: `cannot verify schema_expectation for '${tc.name}' — tool-schema validator unavailable` });
        } else {
          const v = captured.validateToolInput(tc.name, tc.input);
          if (tc.schema_expectation === 'accept' && !v.ok) {
            failures.push({ id: `tool.schema.${tc.id}`, outcome: OUTCOME.FAIL, message: `tool '${tc.name}' declared schema_expectation:accept but the REAL schema REJECTS its input (${v.errors})` });
          } else if (tc.schema_expectation === 'reject' && v.ok) {
            failures.push({ id: `tool.schema.${tc.id}`, outcome: OUTCOME.FAIL, message: `tool '${tc.name}' declared schema_expectation:reject but the REAL schema ACCEPTS its input` });
          }
        }
      }
      // (2) dispatcher_expectation — verified against the ONE authoritative
      // stage6_tool_call row. Every non-ask tool call MUST leave exactly one;
      // its absence (including a dispatcher-exception that logs only the thin
      // stub_ok/dispatcher_error row) means the outcome is UNVERIFIABLE →
      // infrastructure, which can never satisfy accept OR reject (so a missing
      // row cannot vacuously pass either). ask-like tools have no
      // stage6_tool_call row — they are verified through the ask lifecycle /
      // expected_asks, so their absence is not asserted here.
      if (tc.dispatcher_expectation && tc.name === 'ask_user') {
        // ask_user has NO stage6_tool_call row — verified through its lifecycle
        // with EMISSION as the authoritative signal: an ask_user_started frame
        // means the dispatcher POSED the ask (accept-satisfied, reject-violated),
        // REGARDLESS of any later terminal outcome (answered / timeout /
        // transcript_already_extracted / session_terminated are all
        // post-emission and must not flip a posed ask to "rejected"). ONLY when
        // the ask was NOT emitted does a pre-emission decline outcome satisfy a
        // declared reject; anything else is unverifiable → infrastructure.
        const id = `tool.dispatcher.${tc.id}`;
        const emitted = askStartedFrames(captured.wsFrames ?? []).some((f) => f.tool_call_id === tc.id);
        if (emitted) {
          if (tc.dispatcher_expectation === 'reject') {
            failures.push({ id, outcome: OUTCOME.FAIL, message: `ask_user (${tc.id}) declared dispatcher_expectation:reject but the dispatcher POSED it (emitted)` });
          }
        } else {
          const askRow = rows.find((r) => r.name === 'stage6.ask_user' && r.meta?.tool_call_id === tc.id);
          const outcome = askRow?.meta?.answer_outcome;
          const declinedPreEmit = outcome != null && ASK_DISPATCH_REJECT_OUTCOMES.has(outcome);
          if (!declinedPreEmit) {
            failures.push({ id, outcome: OUTCOME.INFRASTRUCTURE, message: `ask_user (${tc.id}) was not emitted and has no pre-emission decline outcome — unverifiable (outcome '${outcome ?? 'none'}')` });
          } else if (tc.dispatcher_expectation === 'accept') {
            failures.push({ id, outcome: OUTCOME.FAIL, message: `ask_user declared dispatcher_expectation:accept but was declined pre-emission (answer_outcome '${outcome}')` });
          } else if (tc.dispatcher_reject_code && outcome !== tc.dispatcher_reject_code) {
            failures.push({ id, outcome: OUTCOME.FAIL, message: `ask_user rejected as '${outcome}', not the declared '${tc.dispatcher_reject_code}'` });
          }
        }
      } else if (tc.dispatcher_expectation) {
        // Non-ask: require EXACTLY ONE authoritative stage6_tool_call row for
        // THIS tool id AND tool name. Zero / multiple / wrong-tool rows are
        // unverifiable → infrastructure (a duplicate or same-id-different-tool
        // row must never silently satisfy the expectation via first-match).
        const id = `tool.dispatcher.${tc.id}`;
        const matching = rows.filter(
          (r) => r.name === 'stage6_tool_call' && (r.meta?.tool_use_id === tc.id || r.meta?.tool_call_id === tc.id),
        );
        const row = matching.length === 1 && matching[0].meta?.tool === tc.name ? matching[0] : null;
        if (!row) {
          const detail = matching.length !== 1 ? `${matching.length} rows` : `tool '${matching[0].meta?.tool}' ≠ '${tc.name}'`;
          failures.push({ id, outcome: OUTCOME.INFRASTRUCTURE, message: `tool '${tc.name}' (${tc.id}) declared dispatcher_expectation:${tc.dispatcher_expectation} but has no single authoritative stage6_tool_call row (${detail}) — unverifiable` });
        } else if (tc.dispatcher_expectation === 'accept') {
          if (row.meta?.is_error === true) {
            failures.push({ id, outcome: OUTCOME.FAIL, message: `tool '${tc.name}' declared dispatcher_expectation:accept but the REAL dispatcher REJECTED it (${errCode(row.meta?.validation_error) || 'is_error'})` });
          }
        } else if (tc.dispatcher_expectation === 'reject') {
          if (row.meta?.is_error !== true) {
            failures.push({ id, outcome: OUTCOME.FAIL, message: `tool '${tc.name}' declared dispatcher_expectation:reject but the REAL dispatcher ACCEPTED it` });
          } else if (tc.dispatcher_reject_code) {
            // Require a non-empty code and compare EXACTLY (no substring
            // collision between distinct codes; a missing code cannot confirm).
            const actual = errCode(row.meta?.validation_error);
            if (actual !== tc.dispatcher_reject_code) {
              failures.push({ id, outcome: OUTCOME.FAIL, message: `tool '${tc.name}' rejected for '${actual || '(no code)'}', not the declared '${tc.dispatcher_reject_code}'` });
            }
          }
        }
      }
    }
  }
  return failures;
}

/**
 * Evaluate ONE turn. `captured` = { result, wsFrames, logRows,
 * chimeObserved, askOrigins, infrastructureViolations, validateToolInput }.
 * Returns the list of failures (possibly empty). Infrastructure violations
 * are returned as a DISTINCT outcome class that can never satisfy expected_red.
 */
export function evaluateTurn(turn, captured) {
  const failures = [];

  // Infrastructure first: a cursor throw / unmatched ask / harness throw /
  // swallowed stage6_live_error must never masquerade as the expected RED.
  for (const v of captured.infrastructureViolations ?? []) {
    failures.push({ id: 'infrastructure', outcome: OUTCOME.INFRASTRUCTURE, message: v });
  }
  const liveErrors = (captured.logRows ?? []).filter(
    (r) => r.name === 'stage6_live_error' || r.name === 'stage6_live_cancelled',
  );
  for (const e of liveErrors) {
    failures.push({
      id: 'infrastructure',
      outcome: OUTCOME.INFRASTRUCTURE,
      message: `${e.name}: production swallowed a non-control-flow error and returned the empty extraction — this can never satisfy expected_red (${JSON.stringify(e.meta?.error ?? e.meta ?? {}).slice(0, 120)})`,
    });
  }

  // An oracle EXISTS whenever the array is declared — a declared-EMPTY
  // array is an explicit silence assertion (unclaimed accounting still
  // runs); an ABSENT array leaves only the generic chime check.
  const declaredOutputs = Array.isArray(turn.expected_audible_outputs)
    ? turn.expected_audible_outputs
    : null;

  // (a) audibility — atomic per audible contract when an oracle exists;
  // the generic audibility.turn fires only when no explicit oracle does
  // (and only on chime-producing turns).
  if (declaredOutputs) {
    const { failures: audFails } = matchAudibleOutputs(declaredOutputs, captured);
    failures.push(...audFails);
  }
  if (turn.chime_observed === true && (declaredOutputs == null || declaredOutputs.length === 0)) {
    if (!turnIsAudible(captured.result, captured.wsFrames)) {
      failures.push({ id: 'audibility.turn', outcome: OUTCOME.FAIL, message: 'chime-producing turn ended with ZERO audible output (beep-then-silence)' });
    }
  }

  // (b)+(c) writes — only for declared operations.
  failures.push(...matchOperations(turn.expected_operations ?? [], captured));

  // (d) clarification follow-ups — only when declared.
  failures.push(...matchExpectedAsks(turn.expected_asks ?? [], captured));

  // (f) tool-call schema/dispatcher expectations — the fixture's declared
  // accept/reject verified against the REAL schema + dispatcher outcome.
  failures.push(...matchToolExpectations(turn, captured));

  // (e) F7 wire invariants — HARNESS-OWNED outputs only.
  if (anyConfidenceKeyOnWire(captured.result)) {
    failures.push({ id: 'wire.confidence', outcome: OUTCOME.FAIL, message: 'a wire confirmation carries a _confidence key' });
  }
  if (anySentinelInSpokenText(captured.result, captured.wsFrames)) {
    failures.push({ id: 'wire.sentinel', outcome: OUTCOME.FAIL, message: 'spoken text (incl. emitted ask questions) contains a __ sentinel' });
  }
  // one ios_send_attempt per surviving audible confirmation.
  const audible = audibleConfirmations(captured.result);
  const attempts = iosSendAttempts(
    (captured.logRows ?? []).map((r) => ({ name: r.name, meta: r.meta })),
  );
  if (audible.length > 0 && attempts.length !== audible.length) {
    failures.push({
      id: 'telemetry.send_attempts',
      outcome: OUTCOME.FAIL,
      message: `${audible.length} surviving audible confirmation(s) but ${attempts.length} ios_send_attempt row(s)`,
    });
  }
  return failures;
}

/**
 * Gate-state verdict for one fixture (plan Item 2 "gate_state semantics
 * implemented natively"). `allFailures` = flat list over all turns.
 * Returns { verdict: 'pass'|'fail'|'xpass'|'infrastructure_error',
 * detail }. `proofState==='required_green'` bypasses ONLY the expected_red
 * XPASS inversion (the GREEN-evidence proof mode) — every validation and
 * infrastructure failure is retained.
 */
export function evaluateGateState(fixture, allFailures, { proofState = null } = {}) {
  const infra = allFailures.filter((f) => f.outcome === OUTCOME.INFRASTRUCTURE);
  if (infra.length > 0) {
    return { verdict: 'infrastructure_error', detail: infra.map((f) => f.message).join('; ') };
  }
  const failed = allFailures.filter((f) => f.outcome === OUTCOME.FAIL);
  const failedIds = [...new Set(failed.map((f) => f.id))];

  if (fixture.gate_state === 'required_green' || proofState === 'required_green') {
    return failed.length === 0
      ? { verdict: 'pass', detail: null }
      : { verdict: 'fail', detail: `failed: ${failedIds.join(', ')}` };
  }
  if (fixture.gate_state === 'expected_red') {
    const target = fixture.expected_failure_id;
    if (failed.length === 0) {
      // XPASS fails the gate — an expected-red passing means the fixture no
      // longer proves the regression (flip to required_green via the tail).
      return { verdict: 'xpass', detail: `expected ${target} to fail; every assertion passed` };
    }
    if (failedIds.length === 1 && failedIds[0] === target) {
      return { verdict: 'pass', detail: `expected RED confirmed: ${target}` };
    }
    return {
      verdict: 'fail',
      detail: `expected EXACTLY ${target} to fail; got: ${failedIds.join(', ')}`,
    };
  }
  return { verdict: 'pass', detail: `non-executable gate_state ${fixture.gate_state} (validated, not executed)` };
}
