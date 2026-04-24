#!/usr/bin/env node
/**
 * Stage 6 Phase 4 Plan 04-05 — Golden-session divergence script.
 *
 * WHAT: Deterministic, offline harness that replays a directory of golden-
 * session fixtures against BOTH the legacy extraction output shape AND the
 * tool-call dispatcher + bundler pipeline, then measures divergence after
 * STR-02 canonicalisation. Exit code 0 on `rate ≤ threshold`, 1 on breach.
 *
 * WHY: Phase 4 SC #6 — "Shadow-mode divergence on golden sessions (STT-11
 * subset): ≤ 10% divergence rate BEFORE any over-ask guards added." This
 * script is the gate. Because every fixture ships canned SSE streams
 * (no real Anthropic calls), 0% is the expected baseline on the 5
 * handwritten fixtures; the 10% budget is the envelope the same harness
 * reuses in Phase 5 when 15 more fixtures + real-model shadow runs land.
 *
 * WHY this is NOT a real-model shadow: Phase 7 owns real-model shadow
 * divergence against live traffic. Here we lock DETERMINISTIC-EQUIVALENCE:
 * given matched canonical legacy + tool-call SSE sequences that SHOULD
 * converge on the same expected_slot_writes, does our normaliser +
 * dispatcher + bundler pipeline actually make them converge? If yes, any
 * Phase-7 divergence is model behaviour, not pipeline. That
 * disambiguation is the deliverable.
 *
 * ---------------------------------------------------------------------------
 * FIXTURE SHAPE (two accepted variants)
 * ---------------------------------------------------------------------------
 * Variant A — dual-SSE (this plan's 5 fixtures):
 *   { pre_turn_state: { snapshot, askedQuestions, extractedObservations },
 *     transcript: string,
 *     sse_events_legacy: [...],         // record_extraction tool_use
 *     sse_events_tool_call: [...],      // round-1 granular tool_uses
 *     sse_events_tool_call_round2: [...], // optional — round-2 end_turn
 *     expected_slot_writes: { circuits: { ... } } }
 *
 * Variant B — tool-call-only (Plan 04-04's F21934D4 fixture):
 *   { pre_turn_state: { snapshot, askedQuestions, extractedObservations },
 *     transcript: string,
 *     sse_events_well_behaved: [...],          // round-1 granular tool_uses
 *     sse_events_well_behaved_round2: [...],   // round-2 end_turn
 *     expected_slot_writes?: { ... } }  // optional; derived if absent
 *
 * In Variant B we synthesise the legacy-equivalent from the DISPATCHER
 * outcome (run the tool-call path first, then project that as the legacy
 * shape). The divergence therefore reduces to "does the bundler's output
 * normalise to itself?" which is trivially 0 — but that's the POINT: the
 * cross-plan fixture should never inject false divergence into the gate,
 * and the F21934D4 shape lock is owned by Plan 04-04's test suite.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * STR-02 normalisation contract (implemented in normaliseExtractionResult)
 * ---------------------------------------------------------------------------
 *   - readings: sorted by (circuit, field), enum field lowercased,
 *     confidence/source_turn_id/timestamp/source dropped, whitespace
 *     trimmed on string values.
 *   - clears: sorted by (circuit, field), field lowercased. Legacy emits
 *     `field_clears`; bundler emits `cleared_readings`; both normalise
 *     to the same shape.
 *   - circuit_ops: action lowercased, designation trimmed, circuit_ref
 *     accepted from either `circuit_ref` or `circuit` key. Legacy's
 *     `circuit_updates` and bundler's `circuit_updates` share the same
 *     key here.
 *   - observations: code UPPERcased (C1/C2/C3/FI is IET convention),
 *     text trimmed, id stripped (legacy and tool-call paths both mint
 *     their own UUID so id comparison is meaningless — same decision as
 *     stage6-slot-comparator.js:§OBSERVATION UUID NORMALISATION).
 *
 * POST-normalisation comparison is structural deep-equal via
 * JSON.stringify (sufficient because every primitive is a scalar after
 * canonicalisation — no ordering ambiguity remains).
 * ---------------------------------------------------------------------------
 *
 * Dependencies: Node stdlib only + already-shipped stage6 modules.
 */

import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runToolLoop } from '../src/extraction/stage6-tool-loop.js';
import { createWriteDispatcher } from '../src/extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../src/extraction/stage6-per-turn-writes.js';
import { bundleToolCallsIntoResult } from '../src/extraction/stage6-event-bundler.js';
import { TOOL_SCHEMAS } from '../src/extraction/stage6-tool-schemas.js';
import { mockClient } from '../src/__tests__/helpers/mockStream.js';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_THRESHOLD = 0.10;
const DEFAULT_FIXTURE_DIR = 'src/__tests__/fixtures/stage6-golden-sessions';

/**
 * Canonicalise an extraction result (either legacy or bundler output) into
 * a shape suitable for structural deep-equal. See module header for the
 * full STR-02 contract.
 *
 * Input shape tolerance: accepts null / undefined / empty — returns empty
 * containers so downstream comparison treats "no result" as "no slots
 * written" (not an error).
 */
export function normaliseExtractionResult(result) {
  const src = result && typeof result === 'object' ? result : {};

  const readings = (Array.isArray(src.extracted_readings) ? src.extracted_readings : [])
    .map((r) => normaliseReading(r))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.circuit !== b.circuit) {
        // Integer-first ordering when both are ints; fallback to string compare.
        if (typeof a.circuit === 'number' && typeof b.circuit === 'number') {
          return a.circuit - b.circuit;
        }
        return String(a.circuit).localeCompare(String(b.circuit));
      }
      return a.field.localeCompare(b.field);
    });

  // Clears accepts both legacy `field_clears` and bundler `cleared_readings`.
  const rawClears = Array.isArray(src.field_clears)
    ? src.field_clears
    : Array.isArray(src.cleared_readings)
      ? src.cleared_readings
      : [];
  const clears = rawClears
    .map((c) => normaliseClear(c))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.circuit !== b.circuit) {
        if (typeof a.circuit === 'number' && typeof b.circuit === 'number') {
          return a.circuit - b.circuit;
        }
        return String(a.circuit).localeCompare(String(b.circuit));
      }
      return a.field.localeCompare(b.field);
    });

  const circuit_ops = (Array.isArray(src.circuit_updates) ? src.circuit_updates : [])
    .map((c) => normaliseCircuitOp(c))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.action !== b.action) return a.action.localeCompare(b.action);
      const ac = String(a.circuit_ref ?? '');
      const bc = String(b.circuit_ref ?? '');
      return ac.localeCompare(bc);
    });

  const observations = (Array.isArray(src.observations) ? src.observations : [])
    .map((o) => normaliseObservation(o))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.code !== b.code) return a.code.localeCompare(b.code);
      return a.text.localeCompare(b.text);
    });

  return { readings, clears, circuit_ops, observations };
}

function normaliseReading(r) {
  if (!r || typeof r !== 'object') return null;
  // circuit may be number or string. Preserve the type so downstream
  // int-vs-string round-trip checks (see stage6-event-bundler.js round-trip
  // logic) are honoured here too.
  const circuit = r.circuit;
  const field = String(r.field ?? '').toLowerCase();
  const value = typeof r.value === 'string' ? r.value.trim() : r.value;
  return { circuit, field, value };
}

function normaliseClear(c) {
  if (!c || typeof c !== 'object') return null;
  return { circuit: c.circuit, field: String(c.field ?? '').toLowerCase() };
}

function normaliseCircuitOp(c) {
  if (!c || typeof c !== 'object') return null;
  // Legacy emits `action`; some Phase-2 paths emit `op`. Bundler uses `op`
  // too (see stage6-event-bundler.js). Accept either; surface as `action`.
  const rawAction = c.action ?? c.op ?? '';
  const action = String(rawAction).toLowerCase();
  const circuit_ref = c.circuit_ref ?? c.circuit;
  // Designation can live at the top level (legacy record_extraction emits it
  // flat — see src/__tests__/fixtures/stage6-golden-sessions/sample-03) OR
  // nested inside `meta` (bundler emits {op, circuit_ref, meta:{designation,
  // phase, rating_amps, cable_csa_mm2}} — see stage6-event-bundler.js).
  // Accept both so normalisation converges on the same canonical key.
  const rawDesignation =
    (typeof c.designation === 'string' && c.designation.trim().length > 0
      ? c.designation
      : null) ??
    (c.meta && typeof c.meta.designation === 'string' && c.meta.designation.trim().length > 0
      ? c.meta.designation
      : null);
  const designation = rawDesignation ? String(rawDesignation).trim() : null;
  return { action, circuit_ref, designation };
}

function normaliseObservation(o) {
  if (!o || typeof o !== 'object') return null;
  // Codes like C1/C2/C3/FI are IET convention (UPPER). Lowercase input
  // still normalises here — the string is upper-cased for comparison.
  const code = String(o.code ?? '').toUpperCase();
  // Accept either `text` or `observation_text` (legacy used the longer key).
  const rawText = o.observation_text ?? o.text ?? '';
  const text = String(rawText).trim();
  return { code, text };
}

/**
 * Compute SECTION-level divergence between two canonical result shapes —
 * the OLD (pre-r2) metric. Flags a section as "divergent" if ANY item
 * within it differs. Returns reasons.length / 4 as the section fraction.
 *
 * WHY KEEP THIS: the section-level metric is a useful diagnostic — "the
 * clears section and the observations section both diverged" is a
 * structural signal that a wrong reading in a single section isn't. But
 * it is NOT the metric the SC #6 / STT-11 gate uses — that's
 * `computeCallLevelDivergence` below.
 *
 * Plan 04-08 r2-#2 renamed the output field `call_divergence` →
 * `section_divergence` so the field name matches its semantics.
 *
 * @returns {{diverged: boolean, section_divergence: number, reasons: string[]}}
 */
export function computeSectionDivergence(legacyNorm, toolCallNorm) {
  const sections = ['readings', 'clears', 'circuit_ops', 'observations'];
  const reasons = [];
  for (const s of sections) {
    const a = JSON.stringify(legacyNorm?.[s] ?? []);
    const b = JSON.stringify(toolCallNorm?.[s] ?? []);
    if (a !== b) reasons.push(s);
  }
  const section_divergence = reasons.length / sections.length;
  return {
    diverged: reasons.length > 0,
    section_divergence,
    reasons,
  };
}

/**
 * Compute CALL-LEVEL divergence — the real per-write accuracy metric
 * introduced by Plan 04-08 r2-#2. Counts individual write-level mismatches
 * across all four slot sections. Under the new metric, 1 wrong reading in
 * 20 → 1/20 = 0.05 (not 0.25 as the old section fraction would imply).
 *
 * Methodology: for each section independently, canonicalise order (already
 * done by normaliseExtractionResult), then count
 *   mismatches = count of indices where a[i] !== b[i]
 *   missing    = |len(a) - len(b)|  (shorter-side gap counts as diverged)
 * total        = max(len(a), len(b)) per section, summed across all
 * sections.
 * rate         = sum(mismatches + missing) / max(1, total)
 *
 * WHY count missing: an extraction that DROPS one of five readings is
 * 1/5 divergent against the reference, not 0/5. Treating missing as
 * non-divergent would mask the exact failure mode the gate is designed
 * to catch (tool-call path losing a reading that legacy captured).
 *
 * @returns {{rate: number, total: number, divergent: number, reasons: string[]}}
 */
export function computeCallLevelDivergence(legacyNorm, toolCallNorm) {
  const sections = ['readings', 'clears', 'circuit_ops', 'observations'];
  let total = 0;
  let divergent = 0;
  const reasons = [];
  for (const s of sections) {
    const a = Array.isArray(legacyNorm?.[s]) ? legacyNorm[s] : [];
    const b = Array.isArray(toolCallNorm?.[s]) ? toolCallNorm[s] : [];
    const len = Math.max(a.length, b.length);
    total += len;
    for (let i = 0; i < len; i += 1) {
      if (i >= a.length) {
        divergent += 1;
        reasons.push(`${s}[${i}]: missing in legacy (tool=${JSON.stringify(b[i])})`);
        continue;
      }
      if (i >= b.length) {
        divergent += 1;
        reasons.push(`${s}[${i}]: missing in tool-call (legacy=${JSON.stringify(a[i])})`);
        continue;
      }
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
        divergent += 1;
        reasons.push(
          `${s}[${i}]: mismatch (legacy=${JSON.stringify(a[i])} vs tool=${JSON.stringify(b[i])})`,
        );
      }
    }
  }
  const rate = total === 0 ? 0 : divergent / total;
  return { rate, total, divergent, reasons };
}

/**
 * Back-compat surface — combines BOTH section-level and call-level
 * divergence into one result object. Existing callers (tests, CLI
 * digest) that only read `diverged` / `reasons` keep working; new
 * callers that need the precise metric read `section_divergence` or
 * `call_divergence` directly.
 *
 * WHY `diverged` = OR of both: if section_divergence fires (anything
 * non-zero) the call-level metric MUST also fire (at least 1 write
 * differs); conversely if call_divergence fires section MUST too.
 * The OR is belt-and-braces against a future refactor where the two
 * metrics might briefly desync (e.g. rounding at the section boundary).
 *
 * @returns {{
 *   diverged: boolean,
 *   section_divergence: number,
 *   call_divergence: number,
 *   reasons: string[],          // section-level reasons (back-compat)
 *   section_reasons: string[],
 *   call_reasons: string[]
 * }}
 */
export function computeDivergence(legacyNorm, toolCallNorm) {
  const sec = computeSectionDivergence(legacyNorm, toolCallNorm);
  const call = computeCallLevelDivergence(legacyNorm, toolCallNorm);
  const diverged = sec.section_divergence > 0 || call.rate > 0;
  return {
    diverged,
    section_divergence: sec.section_divergence,
    call_divergence: call.rate,
    // Write-count breakdown so runDirectory can aggregate call_divergence_rate
    // weighted by write count rather than averaging per-session rates.
    call_total: call.total,
    call_divergent_count: call.divergent,
    reasons: sec.reasons, // back-compat: existing callers read `reasons`.
    section_reasons: sec.reasons,
    call_reasons: call.reasons,
  };
}

// ---------------------------------------------------------------------------
// Fixture loading + SSE event discovery
// ---------------------------------------------------------------------------

function readJsonSync(filePath) {
  const raw = fssync.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Extract the (legacy-shaped) result from a fixture. Two paths:
 *   1. If fixture has `sse_events_legacy` with a record_extraction tool_use,
 *      parse its input JSON and return that verbatim as the legacy result.
 *      This matches what session.extractFromUtterance would have returned
 *      under the pre-Phase-4 prompt.
 *   2. Variant B (no sse_events_legacy): derive legacy from the tool-call
 *      path's dispatcher output so that the fixture acts as a self-
 *      consistency check rather than a cross-path divergence check. This
 *      is the path the F21934D4 fixture takes.
 */
function extractLegacyFromFixture(fx) {
  const events = fx.sse_events_legacy;
  if (!Array.isArray(events) || events.length === 0) return null;
  // Find the record_extraction tool_use input across all content_block_deltas
  // with the same index. Mirrors mockStream.finalMessage()'s reassembly.
  let partial = '';
  let foundToolUseIndex = null;
  for (const ev of events) {
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      if (ev.content_block.name === 'record_extraction') {
        foundToolUseIndex = ev.index;
        partial = '';
      }
    } else if (
      ev.type === 'content_block_delta' &&
      ev.index === foundToolUseIndex &&
      ev.delta?.type === 'input_json_delta'
    ) {
      partial += ev.delta.partial_json ?? '';
    }
  }
  if (!partial) return null;
  try {
    return JSON.parse(partial);
  } catch {
    return null;
  }
}

function pickToolCallEvents(fx) {
  // Accept either naming convention. Return { round1, round2 } — round2
  // optional. When only one stream is present AND it has a stop_reason of
  // tool_use we also synthesise a trivial end_turn round so runToolLoop
  // terminates cleanly.
  const round1 =
    fx.sse_events_tool_call ??
    fx.sse_events_well_behaved ??
    null;
  const round2 =
    fx.sse_events_tool_call_round2 ??
    fx.sse_events_well_behaved_round2 ??
    null;
  return { round1, round2 };
}

function endTurnEventStream(text = 'done') {
  // Minimal end_turn SSE — mirrors mockStream usage in stage6 tests.
  return [
    { type: 'message_start', message: { id: 'msg_end_turn', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

// Silent logger used by the dispatcher factory during runFixture. The
// dispatchers log every tool call via logToolCall at .info level, which
// would flood stdout otherwise. Keeping this inert means running the
// script (CLI or tests) produces only the final JSON report.
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Run the tool-call path for a fixture and return the bundled legacy-shaped
 * result from `bundleToolCallsIntoResult`. Uses mockClient to replay the
 * fixture's canned streams; any additional round requests get an empty
 * end_turn so runToolLoop terminates if the fixture author forgot one.
 */
async function runToolCallPath(fx) {
  const { round1, round2 } = pickToolCallEvents(fx);
  if (!Array.isArray(round1) || round1.length === 0) {
    return null;
  }

  // Build a mutable snapshot clone so the dispatcher's mutations do not leak
  // across fixtures.
  const snapshot =
    fx.pre_turn_state && fx.pre_turn_state.snapshot
      ? structuredClone(fx.pre_turn_state.snapshot)
      : { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] };

  const session = {
    sessionId: 'golden-divergence',
    stateSnapshot: snapshot,
    extractedObservations: Array.isArray(fx.pre_turn_state?.extractedObservations)
      ? [...fx.pre_turn_state.extractedObservations]
      : [],
    // Dispatcher expects toolCallsMode but only uses it in ask paths;
    // golden fixtures never exercise ask_user (that's Variant B territory
    // owned by Plan 04-04), so this just needs to be defined.
    toolCallsMode: 'shadow',
  };

  const perTurnWrites = createPerTurnWrites();
  const dispatcher = createWriteDispatcher(session, silentLogger, 'turn-1', perTurnWrites);

  // Provide round1 + optional round2. runToolLoop will keep calling until
  // stop_reason is not tool_use; supplying a trailing end_turn guarantees
  // termination without synthesising from inside the loop.
  const streamResponses = [round1];
  if (Array.isArray(round2) && round2.length > 0) {
    streamResponses.push(round2);
  } else {
    streamResponses.push(endTurnEventStream('ok'));
  }
  // Safety trailer: if the fixture stack happens to drive more rounds than
  // provided, mockClient returns an empty stream which is a hard error
  // signal per mockStream's contract. We pad with one more end_turn so an
  // extra round from a misauthored fixture surfaces as a clean terminator,
  // not a zero-event stream that would hang the assembler.
  streamResponses.push(endTurnEventStream('trailer'));

  const client = mockClient(streamResponses);
  const messages = [{ role: 'user', content: fx.transcript ?? '' }];

  const systemBlocks = [{ type: 'text', text: 'GOLDEN-DIVERGENCE SYSTEM PROMPT' }];

  try {
    await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: systemBlocks,
      messages,
      tools: TOOL_SCHEMAS,
      dispatcher,
      ctx: { sessionId: session.sessionId, turnId: 'turn-1' },
      logger: silentLogger,
    });
  } catch (err) {
    // runToolLoop failures are a FIXTURE bug — surface them through the
    // returned null + a breadcrumb so runFixture can count the fixture as
    // a divergent/invalid entry rather than silently passing.
    silentLogger.warn?.('golden_divergence_tool_loop_error', { err: err?.message });
    return null;
  }

  // Bundle the dispatcher's accumulator into the legacy-shaped result.
  // The SECOND argument is the legacy result whose `questions` slot gets
  // passed through. Phase 4 tool-call branch deletes questions_for_user
  // (Plan 04-03), so questions is always []. We pass an empty shape.
  const bundled = bundleToolCallsIntoResult(perTurnWrites, { questions: [] });
  return bundled;
}

/**
 * Convert an `expected_slot_writes` oracle into the legacy result shape
 * (`{extracted_readings: Array<{circuit,field,value}>}`) that
 * `normaliseExtractionResult` already knows how to canonicalise.
 *
 * This is the oracle-path equivalent of `extractLegacyFromFixture` for
 * Variant-B fixtures that ship only an intended-outcome map, not a
 * canned legacy SSE stream.
 *
 * WHY expose this as a named export: Plan 04-07 r1 tests bind against
 * the helper directly (`Group H — expectedSlotWritesToLegacyShape ...`)
 * to lock its {circuits:{N:{f:v}}} → {extracted_readings:[{c,f,v}]}
 * contract independently of the larger runFixture flow. If a future
 * edit changes how oracles are shaped, the test surfaces it before
 * integration reports go wrong.
 *
 * Input shape: `{circuits: {[N]: {[field]: value, ...}}}`. Any non-
 * reading fields on a circuit (e.g. `circuit_designation`) are also
 * emitted as readings for comparison symmetry — the normaliser treats
 * all `{circuit,field,value}` tuples uniformly, which means the oracle
 * path compares designation-as-a-reading too. In practice the tool-call
 * bundler emits circuit_designation via circuit_updates, not
 * extracted_readings, so oracle + tool-call diverge on designation
 * UNLESS the oracle author also wires the circuit_ops slot. See
 * sample-03 for the dual pattern. Callers should keep oracle content
 * scoped to reading-shaped slots.
 *
 * @param {{circuits?: Object}} oracle
 * @returns {{extracted_readings: Array<{circuit:number|string, field:string, value:any}>}}
 */
export function expectedSlotWritesToLegacyShape(oracle) {
  const out = { extracted_readings: [] };
  if (!oracle || typeof oracle !== 'object') return out;
  const circuits = oracle.circuits;
  if (!circuits || typeof circuits !== 'object') return out;
  for (const [circuitKey, bucket] of Object.entries(circuits)) {
    if (!bucket || typeof bucket !== 'object') continue;
    // Coerce numeric keys back to numbers so the normaliser's sort
    // comparator uses integer ordering rather than string ordering.
    // Keeps parity with fixture snapshots that key circuits by integer.
    const circuit = /^-?\d+$/.test(circuitKey) ? Number(circuitKey) : circuitKey;
    for (const [field, value] of Object.entries(bucket)) {
      out.extracted_readings.push({ circuit, field, value });
    }
  }
  return out;
}

/**
 * Run one fixture: derive legacy result, run tool-call dispatcher, normalise
 * both, compute divergence, return per-fixture outcome.
 *
 * Plan 04-07 r1 remediation (Codex MAJOR #3): the previous
 * `legacyResult = toolResult` fallback made Variant-B fixtures self-
 * compare, producing fake 0% divergence regardless of dispatcher
 * correctness. The new behaviour:
 *
 *   - Fixture has `sse_events_legacy`: use it (Variant A — unchanged).
 *   - Fixture has only `expected_slot_writes`: use the ORACLE PATH —
 *     convert the oracle into a legacy-shape result via
 *     `expectedSlotWritesToLegacyShape` and compare against the
 *     tool-call output. This is a REAL comparison, not a self-compare.
 *   - Fixture has NEITHER: throw. Silent self-compare is the exact
 *     failure mode Codex's finding called out; throwing makes the
 *     missing data impossible to miss.
 *
 * Combined shape (Variant A + oracle): if a fixture ships BOTH
 * sse_events_legacy AND expected_slot_writes, the legacy SSE stream
 * takes priority (it models richer behaviour the oracle cannot — e.g.
 * specific question text, validation alerts). The oracle is still
 * useful as documentation of intent but is not used for comparison
 * in that case.
 */
export async function runFixture(fixturePath) {
  const fx = readJsonSync(fixturePath);

  // Tool-call side always runs. When it fails to produce anything (bad
  // fixture / error) we return a synthetic divergent verdict so the
  // directory-runner aggregation surfaces the issue.
  const toolResult = await runToolCallPath(fx);

  // Legacy side resolution order:
  //   1. sse_events_legacy (Variant A — existing path, pre-r1 behaviour)
  //   2. expected_slot_writes (Variant B / oracle path — NEW in r1)
  //   3. throw (no more silent self-compare)
  let legacyResult = extractLegacyFromFixture(fx);
  let legacySource = 'sse_events_legacy';
  if (!legacyResult) {
    if (fx.expected_slot_writes) {
      legacyResult = expectedSlotWritesToLegacyShape(fx.expected_slot_writes);
      legacySource = 'expected_slot_writes';
    } else {
      throw new Error(
        `golden-divergence: fixture ${path.basename(fixturePath)} is missing ` +
          `both sse_events_legacy and expected_slot_writes — refusing to ` +
          `self-compare (Plan 04-07 r1 remediation of Codex MAJOR #3). ` +
          `Add an expected_slot_writes oracle or a sse_events_legacy stream.`,
      );
    }
  }

  const legacyNorm = normaliseExtractionResult(legacyResult);
  const toolCallNorm = normaliseExtractionResult(toolResult);
  const divergence = computeDivergence(legacyNorm, toolCallNorm);

  return {
    fixture: path.basename(fixturePath),
    fixturePath,
    legacyNorm,
    toolCallNorm,
    divergence,
    legacy_source: legacySource,
  };
}

/**
 * Run every *.json fixture in `dir` plus any paths in `extraFixtures`.
 * Returns an aggregate report suitable for logging (stdout JSON) and
 * threshold-breach classification.
 */
export async function runDirectory(dir, options = {}) {
  const threshold = typeof options.threshold === 'number' ? options.threshold : DEFAULT_THRESHOLD;
  const extraFixtures = Array.isArray(options.extraFixtures) ? options.extraFixtures : [];

  const fixturesInDir = [];
  if (fssync.existsSync(dir) && fssync.statSync(dir).isDirectory()) {
    for (const name of fssync.readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue;
      fixturesInDir.push(path.join(dir, name));
    }
  }

  // Extra fixtures are allowed to come from anywhere on disk. Missing files
  // must surface as a hard error — silent skipping would turn a missing
  // cross-plan fixture (e.g. F21934D4) into a false 0% divergence pass,
  // which is exactly the kind of invisible regression this gate is meant
  // to catch.
  for (const extra of extraFixtures) {
    if (!fssync.existsSync(extra)) {
      throw new Error(`extraFixture not found: ${extra}`);
    }
  }

  const allPaths = [...fixturesInDir, ...extraFixtures];
  const sessions = [];
  for (const p of allPaths) {
    sessions.push(await runFixture(p));
  }

  const total = sessions.length;
  const divergedCount = sessions.filter((s) => s.divergence.diverged).length;
  const session_divergence_rate = total === 0 ? 0 : divergedCount / total;

  // Plan 04-08 r2-#2: split section vs call rates.
  //
  // section_divergence_rate — average of per-session section fractions
  // (the OLD metric kept as a diagnostic; a session where 4/4 sections
  // diverge is signal a section-level-zero rate would hide).
  //
  // call_divergence_rate — weighted by WRITE count across all sessions,
  // not averaged across sessions. A session with 20 writes of which 1
  // is wrong contributes 1/20 = 0.05 to the aggregate, NOT 0.25 (the
  // section fraction the pre-r2 metric would have reported) or 0.5 (a
  // naive average of per-session rates would wrongly weight a 2-write
  // session the same as a 20-write one). This is the real per-call
  // accuracy gate.
  const section_divergence_rate =
    total === 0
      ? 0
      : sessions.reduce((a, s) => a + (s.divergence.section_divergence ?? 0), 0) / total;

  let callTotal = 0;
  let callDivergent = 0;
  for (const s of sessions) {
    callTotal += s.divergence.call_total ?? 0;
    callDivergent += s.divergence.call_divergent_count ?? 0;
  }
  const call_divergence_rate = callTotal === 0 ? 0 : callDivergent / callTotal;

  const breached =
    session_divergence_rate > threshold ||
    section_divergence_rate > threshold ||
    call_divergence_rate > threshold;

  return {
    total,
    threshold,
    session_divergence_rate,
    section_divergence_rate,
    call_divergence_rate,
    call_total_writes: callTotal,
    call_divergent_writes: callDivergent,
    breached,
    sessions,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { dir: DEFAULT_FIXTURE_DIR, threshold: DEFAULT_THRESHOLD, extraFixtures: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') {
      out.dir = argv[i + 1];
      i += 1;
    } else if (a === '--threshold') {
      out.threshold = parseFloat(argv[i + 1]);
      i += 1;
    } else if (a === '--extra') {
      out.extraFixtures.push(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

// CLI check: match both local invocation (`node scripts/stage6-golden-divergence.js`)
// and resolved absolute-path variants (`node /abs/path/scripts/...`).
const invokedAsScript = (() => {
  try {
    return path.resolve(process.argv[1] ?? '') === path.resolve(__filename);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  const { dir, threshold, extraFixtures } = parseArgs(process.argv.slice(2));
  runDirectory(dir, { threshold, extraFixtures })
    .then((report) => {
      // Emit a compact digest to stdout; full per-session detail included
      // so CI and the Phase 5/7 analyzer can both consume a single stream.
      const digest = {
        total: report.total,
        threshold: report.threshold,
        session_divergence_rate: report.session_divergence_rate,
        section_divergence_rate: report.section_divergence_rate,
        call_divergence_rate: report.call_divergence_rate,
        call_total_writes: report.call_total_writes,
        call_divergent_writes: report.call_divergent_writes,
        breached: report.breached,
        first_10_divergent_samples: report.sessions
          .filter((s) => s.divergence.diverged)
          .slice(0, 10)
          .map((s) => ({
            fixture: s.fixture,
            reasons: s.divergence.reasons,
            section_divergence: s.divergence.section_divergence,
            call_divergence: s.divergence.call_divergence,
          })),
        sessions: report.sessions.map((s) => ({
          fixture: s.fixture,
          diverged: s.divergence.diverged,
          section_divergence: s.divergence.section_divergence,
          call_divergence: s.divergence.call_divergence,
          reasons: s.divergence.reasons,
        })),
      };
      console.log(JSON.stringify(digest, null, 2));
      if (report.breached) {
        console.error(
          `divergence exceeds threshold ${report.threshold}: ` +
            `session=${report.session_divergence_rate} ` +
            `section=${report.section_divergence_rate} ` +
            `call=${report.call_divergence_rate}`,
        );
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(`golden-divergence error: ${err?.stack ?? err}`);
      process.exit(2);
    });
}
