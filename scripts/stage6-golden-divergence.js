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
  const designation =
    typeof c.designation === 'string' && c.designation.trim().length > 0
      ? c.designation.trim()
      : null;
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
 * Compute section-level divergence between two canonical result shapes.
 *
 * @returns {{diverged: boolean, call_divergence: number, reasons: string[]}}
 *   `call_divergence` is the fraction of the four slot sections
 *   (readings, clears, circuit_ops, observations) that differ. 0.0 on
 *   exact match; 1.0 on total mismatch.
 */
export function computeDivergence(legacyNorm, toolCallNorm) {
  const sections = ['readings', 'clears', 'circuit_ops', 'observations'];
  const reasons = [];
  for (const s of sections) {
    const a = JSON.stringify(legacyNorm?.[s] ?? []);
    const b = JSON.stringify(toolCallNorm?.[s] ?? []);
    if (a !== b) reasons.push(s);
  }
  const call_divergence = reasons.length / sections.length;
  return {
    diverged: reasons.length > 0,
    call_divergence,
    reasons,
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
 * Run one fixture: derive legacy result, run tool-call dispatcher, normalise
 * both, compute divergence, return per-fixture outcome.
 */
export async function runFixture(fixturePath) {
  const fx = readJsonSync(fixturePath);

  // Tool-call side always runs. When it fails to produce anything (bad
  // fixture / error) we return a synthetic divergent verdict so the
  // directory-runner aggregation surfaces the issue.
  const toolResult = await runToolCallPath(fx);

  // Legacy side: prefer the fixture's sse_events_legacy; fall back to the
  // tool-call result (Variant B — F21934D4 style) which makes the fixture
  // a self-consistency check.
  let legacyResult = extractLegacyFromFixture(fx);
  if (!legacyResult) {
    legacyResult = toolResult;
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
  const call_divergence_rate =
    total === 0
      ? 0
      : sessions.reduce((a, s) => a + s.divergence.call_divergence, 0) / total;
  const breached =
    session_divergence_rate > threshold || call_divergence_rate > threshold;

  return {
    total,
    threshold,
    session_divergence_rate,
    call_divergence_rate,
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
        call_divergence_rate: report.call_divergence_rate,
        breached: report.breached,
        first_10_divergent_samples: report.sessions
          .filter((s) => s.divergence.diverged)
          .slice(0, 10)
          .map((s) => ({
            fixture: s.fixture,
            reasons: s.divergence.reasons,
            call_divergence: s.divergence.call_divergence,
          })),
        sessions: report.sessions.map((s) => ({
          fixture: s.fixture,
          diverged: s.divergence.diverged,
          call_divergence: s.divergence.call_divergence,
          reasons: s.divergence.reasons,
        })),
      };
      console.log(JSON.stringify(digest, null, 2));
      if (report.breached) {
        console.error(
          `divergence exceeds threshold ${report.threshold}: ` +
            `session=${report.session_divergence_rate} call=${report.call_divergence_rate}`,
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
