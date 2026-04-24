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
// Plan 04-10 r4-#2: the divergence harness must exercise the REAL
// agentic prompt + the REAL buildSystemBlocks() cached-prefix structure.
// Pre-r4 this script used a hand-rolled session stub with a placeholder
// system prompt, so the SC #6 "0% divergence" claim was validated
// against a fake prompt. Importing EICRExtractionSession here means each
// fixture replay now runs through the same constructor that production
// shadow sessions use (fs.readFileSync of sonnet_agentic_system.md,
// mode-gated systemPrompt selection, buildSystemBlocks two-block
// cached-prefix layout). See runToolCallPath below.
import {
  EICRExtractionSession,
  // Plan 04-17 r11-#1 — track production value directly so the
  // harness's fail-fast guard can't drift from the builder's
  // detailed-view window size.
  SNAPSHOT_RECENT_CIRCUITS,
} from '../src/extraction/eicr-extraction-session.js';

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
    // Plan 04-13 r7-#3: widen the sort to cover the FULL canonical
    // tuple. Mirrors the Plan 04-11 r5-#2 fix for observations:
    // normaliseCircuitOp post-r5-#3 emits
    // {action, circuit_ref, from_ref, designation, phase, rating_amps,
    // cable_csa_mm2}, but the sort was still keyed on (action,
    // circuit_ref) only. Two ops with identical primary tuple but
    // differing metadata compared equal under the old sort → output
    // order matched INPUT order, so callers doing deep-equal canonical
    // comparisons would see false positives/negatives driven by
    // emission order alone. Full-tuple sort makes the comparator
    // order-invariant across input permutations.
    //
    // Ordering convention (nullable-last via compareNullableString /
    // compareNullableScalar, matching r5-#2):
    //   - circuit_ref: string/number tolerant, numbers compared
    //     numerically when both are numbers (rare — fixtures tend to
    //     use strings), string-compare otherwise.
    //   - from_ref / designation / phase: string, case-preserving,
    //     null sorts last.
    //   - rating_amps / cable_csa_mm2: numeric, null sorts last.
    .sort((a, b) => {
      if (a.action !== b.action) return a.action.localeCompare(b.action);
      const refCmp = compareNullableString(
        a.circuit_ref == null ? null : String(a.circuit_ref),
        b.circuit_ref == null ? null : String(b.circuit_ref),
      );
      if (refCmp !== 0) return refCmp;
      const fromCmp = compareNullableString(a.from_ref, b.from_ref);
      if (fromCmp !== 0) return fromCmp;
      const desCmp = compareNullableString(a.designation, b.designation);
      if (desCmp !== 0) return desCmp;
      const phaCmp = compareNullableString(a.phase, b.phase);
      if (phaCmp !== 0) return phaCmp;
      const ratCmp = compareNullableScalar(a.rating_amps, b.rating_amps);
      if (ratCmp !== 0) return ratCmp;
      return compareNullableScalar(a.cable_csa_mm2, b.cable_csa_mm2);
    });

  const observations = (Array.isArray(src.observations) ? src.observations : [])
    .map((o) => normaliseObservation(o))
    .filter(Boolean)
    // Plan 04-11 r5-#2: sort on the FULL canonical tuple. r3 (Plan 04-09)
    // widened normaliseObservation to return {code, text, location,
    // circuit, suggested_regulation} but the sort was still keyed on
    // (code, text) alone. Two observations with matching (code, text)
    // but differing metadata compared in input-order, producing order-
    // dependent false divergences. Full-tuple sort makes the comparator
    // order-invariant across input permutations.
    //
    // Ordering convention for the three new fields:
    //   - location: string | null. Nulls sort LAST for easier digest
    //     reading ("Kitchen" before null). localeCompare on non-null
    //     pairs; null handling via explicit checks below.
    //   - circuit: number | null. Integer compare on number pairs;
    //     string compare when types mismatch (shouldn't happen under
    //     the schema but defensive); nulls last.
    //   - suggested_regulation: string | null. Same as location.
    .sort((a, b) => {
      if (a.code !== b.code) return a.code.localeCompare(b.code);
      if (a.text !== b.text) return a.text.localeCompare(b.text);
      const locCmp = compareNullableString(a.location, b.location);
      if (locCmp !== 0) return locCmp;
      const circCmp = compareNullableScalar(a.circuit, b.circuit);
      if (circCmp !== 0) return circCmp;
      return compareNullableString(a.suggested_regulation, b.suggested_regulation);
    });

  return { readings, clears, circuit_ops, observations };
}

/**
 * Compare two values that may be null, preserving a stable "nulls last"
 * ordering so sort output is deterministic even when some entries have
 * missing metadata. Plan 04-11 r5-#2 helper — used by the observation
 * sort (and the circuit-op sort where appropriate).
 *
 * Semantics:
 *   - Both null → equal (0).
 *   - Only a is null → a sorts AFTER b → return +1.
 *   - Only b is null → a sorts BEFORE b → return -1.
 *   - Neither null → caller-provided comparator.
 */
function compareNullableString(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return String(a).localeCompare(String(b));
}

function compareNullableScalar(a, b) {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
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
  // Rename ops carry `from_ref` (schema-required — stage6-tool-schemas.js
  // :198-203). Bundler puts this flat at the top level
  // (stage6-dispatchers-circuit.js:366-376). Legacy record_extraction
  // hasn't historically emitted rename but if a future shape lands it
  // nested under meta, accept either. Null for non-rename ops.
  const from_ref = c.from_ref ?? (c.meta && c.meta.from_ref) ?? null;

  // Plan 04-11 r5-#3: widen the canonical field set to match the full
  // create_circuit / rename_circuit schema (stage6-tool-schemas.js
  // :149-230). Pre-r5 only `designation` was canonicalised; phase,
  // rating_amps, cable_csa_mm2 were silently dropped, so two ops
  // agreeing on (action, circuit_ref, designation) but disagreeing on
  // any of the three compared EQUAL — a real gap in the divergence
  // gate.
  //
  // Layout tolerance: legacy record_extraction emits fields flat at the
  // top level of each circuit_updates entry (sample-03 fixture style);
  // the tool-call bundler nests them under `meta` per Plan 02-05
  // (stage6-event-bundler.js:40). The helper `metaValue` accepts both
  // and produces the canonical value.
  const designation = normaliseDesignationField(c);
  const phase = normalisePhaseField(c);
  const rating_amps = normaliseIntegerField(c, 'rating_amps');
  const cable_csa_mm2 = normaliseNumberField(c, 'cable_csa_mm2');

  return { action, circuit_ref, from_ref, designation, phase, rating_amps, cable_csa_mm2 };
}

/**
 * Plan 04-11 r5-#3 helper — pull a field from either the flat top-level
 * position (`c[key]`) or the nested `meta` position (`c.meta[key]`).
 * Returns undefined if neither is set — callers convert to null per
 * field-specific null semantics.
 */
function metaValue(c, key) {
  if (c[key] !== undefined) return c[key];
  if (c.meta && c.meta[key] !== undefined) return c.meta[key];
  return undefined;
}

function normaliseDesignationField(c) {
  const raw = metaValue(c, 'designation');
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return null;
}

function normalisePhaseField(c) {
  const raw = metaValue(c, 'phase');
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return null;
}

function normaliseIntegerField(c, key) {
  const raw = metaValue(c, key);
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) ? n : null;
}

function normaliseNumberField(c, key) {
  const raw = metaValue(c, key);
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normaliseObservation(o) {
  if (!o || typeof o !== 'object') return null;
  // Codes like C1/C2/C3/FI are IET convention (UPPER). Lowercase input
  // still normalises here — the string is upper-cased for comparison.
  const code = String(o.code ?? '').toUpperCase();
  // Accept either `text` or `observation_text` (legacy used the longer key).
  const rawText = o.observation_text ?? o.text ?? '';
  const text = String(rawText).trim();

  // Plan 04-09 r3-#1: widen the canonical surface to include the three
  // semantic fields the production observation payload actually carries.
  // Pre-r3 this function returned only {code, text}, which meant the
  // divergence comparator silently ignored `location` / `circuit` /
  // `suggested_regulation` — paths could disagree on observation
  // metadata and still report 0% divergence. The full production shape
  // (per stage6-per-turn-writes.js:40 + stage6-tool-schemas.js:275
  // required list) is {id, code, location, text, circuit,
  // suggested_regulation}.
  //
  // TRANSIENT (stripped below via omission):
  //   - id                — both paths mint independent UUIDs
  //                          (stage6-slot-comparator precedent).
  //   - source_turn_id    — per-event trace metadata.
  //   - timestamp         — per-event trace metadata.
  //
  // SEMANTIC (preserved below):
  //   - code                  — UPPER-cased.
  //   - text                  — trimmed (alias observation_text accepted).
  //   - location              — trimmed, case preserved (inspector-facing
  //                              text e.g. "Under-stairs cupboard").
  //   - circuit               — integer | null preserved verbatim. No
  //                              coercion: diverging `circuit: 3` vs
  //                              `circuit: "3"` is a real failure mode
  //                              the gate wants to catch.
  //   - suggested_regulation  — trimmed, case preserved (regulation
  //                              refs are case-insensitive but inspectors
  //                              write "411.3.1.1" literally; preserve).
  const rawLocation = typeof o.location === 'string' ? o.location.trim() : null;
  const location = rawLocation && rawLocation.length > 0 ? rawLocation : null;

  // circuit is integer | null in the schema; accept number, numeric string,
  // or null. Non-null is preserved AS-IS (no int/string coercion — that's
  // a real divergence case, mirrors the reading-level circuit policy).
  const circuit = o.circuit === undefined ? null : o.circuit;

  const rawRegulation =
    typeof o.suggested_regulation === 'string' ? o.suggested_regulation.trim() : null;
  const suggested_regulation =
    rawRegulation && rawRegulation.length > 0 ? rawRegulation : null;

  return { code, text, location, circuit, suggested_regulation };
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
 * Plan 04-12 r6-#1 BLOCK — UNION call-count aggregator for triple-
 * compare fixtures.
 *
 * Problem it fixes: r2-#3 added the oracle path so runFixture reports
 * tool_vs_oracle_divergence and legacy_vs_oracle_divergence pairwise
 * rates, and r2-#3 set `divergence.diverged = OR of all three pairings`.
 * BUT `call_total` / `call_divergent_count` were still the PRIMARY
 * legacy-vs-tool counts. runDirectory's aggregate at line 1071-1077
 * reads from those primary counts, so a fixture where legacy+tool
 * agree but both disagree with oracle ("both wrong the same way")
 * reports call_divergence_rate=0 despite diverged=true. The exact
 * failure mode the oracle exists to catch was silently zeroed.
 *
 * Fix methodology: UNION. For each section, for each index (up to max
 * length across the three sources), check every pairwise comparison
 * independently. If any pair disagrees on that write, the write is
 * counted ONCE as divergent. Total writes = max(lengths) per section,
 * summed. Missing on any source counts as divergent (matches the
 * pre-r6 computeCallLevelDivergence semantics — dropping a slot is
 * divergence, not a free pass).
 *
 * Rationale for UNION over Option B (tool-vs-oracle as primary):
 *   - Back-compat with Shape B (oracle only) and Shape C (legacy+tool
 *     only) — those have only 1 pairwise comparison each; the union
 *     degenerates to that single comparison.
 *   - A write divergent in multiple pairings (tool drifts from both
 *     legacy AND oracle) counts ONCE — set semantics, not sum. Prevents
 *     double-counting while still catching the divergence.
 *   - Additive on top of the existing three pairwise rates rather than
 *     flipping the contract.
 *
 * @param {Object} legacyNorm   normaliseExtractionResult output (or null)
 * @param {Object} toolNorm     normaliseExtractionResult output (or null)
 * @param {Object} oracleNorm   normaliseExtractionResult output (or null)
 *                              — for triple-compare. Pass null when only
 *                              two-way comparison is possible.
 * @returns {{total: number, divergent: number, rate: number, reasons: string[]}}
 */
export function unionPairwiseCallCounts(legacyNorm, toolNorm, oracleNorm) {
  const sections = ['readings', 'clears', 'circuit_ops', 'observations'];
  let total = 0;
  let divergent = 0;
  const reasons = [];
  for (const s of sections) {
    const a = Array.isArray(legacyNorm?.[s]) ? legacyNorm[s] : [];
    const b = Array.isArray(toolNorm?.[s]) ? toolNorm[s] : [];
    const c = Array.isArray(oracleNorm?.[s]) ? oracleNorm[s] : [];
    // Determine which sources are PRESENT for this comparison. A null
    // norm means "no data at all from this source" — not "empty
    // section". The distinction matters: if oracle is null (Shape C —
    // no oracle), we do NOT count "missing in oracle" as divergence;
    // the oracle simply isn't in the comparison set.
    const hasLegacy = legacyNorm != null;
    const hasTool = toolNorm != null;
    const hasOracle = oracleNorm != null;
    const len = Math.max(
      hasLegacy ? a.length : 0,
      hasTool ? b.length : 0,
      hasOracle ? c.length : 0,
    );
    total += len;
    for (let i = 0; i < len; i += 1) {
      const ai = hasLegacy ? (i < a.length ? JSON.stringify(a[i]) : null) : null;
      const bi = hasTool ? (i < b.length ? JSON.stringify(b[i]) : null) : null;
      const ci = hasOracle ? (i < c.length ? JSON.stringify(c[i]) : null) : null;

      // Compare each pair that has both sources present AT THIS INDEX.
      // A source missing at this index OR null (source absent) both
      // count as "no contribution to the comparison from that pair"
      // — but a present-vs-missing counts as divergent (dropping a
      // write is divergence, matching pre-r6 semantics).
      let divAtIndex = false;
      const mismatches = [];

      // legacy vs tool
      if (hasLegacy && hasTool) {
        if (ai !== bi) {
          divAtIndex = true;
          mismatches.push(`legacy_vs_tool[${s}][${i}]`);
        }
      }
      // tool vs oracle
      if (hasTool && hasOracle) {
        if (bi !== ci) {
          divAtIndex = true;
          mismatches.push(`tool_vs_oracle[${s}][${i}]`);
        }
      }
      // legacy vs oracle
      if (hasLegacy && hasOracle) {
        if (ai !== ci) {
          divAtIndex = true;
          mismatches.push(`legacy_vs_oracle[${s}][${i}]`);
        }
      }

      if (divAtIndex) {
        divergent += 1; // UNION — count once even if multiple pairs fire
        reasons.push(
          `${s}[${i}]: ${mismatches.join(' + ')} (legacy=${ai ?? 'MISSING'} tool=${bi ?? 'MISSING'} oracle=${ci ?? 'MISSING'})`,
        );
      }
    }
  }
  const rate = total === 0 ? 0 : divergent / total;
  return { total, divergent, rate, reasons };
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
 *
 * Plan 04-10 r4-#2 — this function now instantiates a REAL
 * EICRExtractionSession per fixture replay. Pre-r4 it used a hand-rolled
 * session stub with a placeholder system prompt, so the harness never
 * exercised sonnet_agentic_system.md loading or buildSystemBlocks(). The
 * SC #6 "0% divergence" claim was therefore measuring a fake-prompt self-
 * agreement, not the actual agentic-prompt pipeline. Post-r4:
 *   - `new EICRExtractionSession('test-key', ..., {toolCallsMode:'shadow'})`
 *     loads the real agentic prompt via the module-top fs.readFileSync.
 *   - `session.buildSystemBlocks()` constructs the two-block cached-prefix
 *     layout (prompt + snapshot, both cache_control ephemeral 5m).
 *   - `session.client = mockClient(...)` replaces the real Anthropic
 *     client so no network call fires; mockClient._calls captures the
 *     request args for test assertions.
 *
 * Return shape:
 *   { bundled, client } — `bundled` is the legacy-shaped result from the
 *     dispatcher/bundler stack (same as pre-r4). `client` is the mockClient
 *     instance, exposed so tests can inspect `client._calls` to verify the
 *     real prompt + cached-prefix structure reached the tool loop. Pre-r4
 *     callers received just `bundled`; runFixture has been updated to
 *     destructure the new shape.
 *
 * Returns `null` when the fixture has no tool-call round1 events — same
 * semantics as pre-r4 so runFixture's downstream "tool path empty"
 * handling is unchanged.
 */
export async function runToolCallPath(fx) {
  const { round1, round2 } = pickToolCallEvents(fx);
  if (!Array.isArray(round1) || round1.length === 0) {
    return null;
  }

  // Instantiate a real EICRExtractionSession in shadow mode. 'test-key' is
  // a placeholder — the Anthropic client constructor accepts it, and we
  // replace session.client with mockClient immediately below so no real
  // API call is ever attempted. 'eicr' certType is arbitrary because shadow
  // mode uses the cert-agnostic agentic prompt regardless.
  const session = new EICRExtractionSession('test-key', 'golden-divergence', 'eicr', {
    toolCallsMode: 'shadow',
  });

  // Seed state from the fixture. Deep-clone the snapshot so dispatcher
  // mutations during replay don't leak across fixtures or trip the
  // structuredClone safety in other session methods.
  if (fx.pre_turn_state && fx.pre_turn_state.snapshot) {
    session.stateSnapshot = structuredClone(fx.pre_turn_state.snapshot);

    // Plan 04-13 r7-#2 (MAJOR) / Plan 04-14 r8-#3 (MINOR) /
    // Plan 04-15 r9-#3 (MINOR) — seed session.recentCircuitOrder
    // so the builder's compaction logic at
    // eicr-extraction-session.js:1212 doesn't collapse every
    // seeded circuit into "N earlier circuits (...) stored
    // server-side". Without a seed, filled-slot VALUES never reach
    // the model-facing snapshot — for F21934D4 specifically that
    // hid the r1_r2_ohm=0.64 prefill (the entire point of the
    // fixture).
    //
    // r8-#3 added a fixture-declared override path. Production's
    // recentCircuitOrder is CHRONOLOGICAL (each record_reading
    // moves the circuit to the END of the array, so .slice(-3)
    // returns the three most-recently-edited). The fallback below
    // is NUMERIC ASCENDING — coincides with chronology for
    // fixtures with <=SNAPSHOT_RECENT_CIRCUITS seeded circuits
    // (all fit in the detailed window regardless of order), but
    // diverges for fixtures with >3 seeded circuits where the
    // implied chronology isn't numeric.
    //
    // r9-#3 hardens the fixture-declared path's normalisation to
    // match what production would produce. Production's
    // splice+push idiom at updateStateSnapshot line 1218-1221
    // guarantees:
    //   (a) No duplicates (splice removes the prior slot before
    //       push appends).
    //   (b) Only circuits the session knows about (you can only
    //       record_reading on a circuit after create_circuit has
    //       seeded it into stateSnapshot.circuits).
    //   (c) Circuit 0 (supply) is never pushed — line 1218 guards
    //       with `if (circuit !== 0)`.
    //
    // The harness normalises fixture input the same way so
    // pathological declarations (duplicates, unknown refs,
    // circuit-0 leaks, non-integers) can't silently corrupt the
    // test's model inputs.
    //
    // Plan 04-16 r10-#1 — the dedupe must be LAST-OCCURRENCE-WINS,
    // mirroring production's `indexOf` + `splice` + `push` idiom.
    // r9-#3 shipped first-wins with the rationale "preserves
    // fixture author's intended ordering position" — r10-#1
    // rejected that rationale. Chronology-by-construction IS
    // last-wins: if `record_reading(circuit=1)` fires after
    // `record_reading(circuit=2)` which itself fires after an
    // earlier `record_reading(circuit=1)`, circuit 1's position
    // in recentCircuitOrder is at the END (most recent). A
    // fixture author typing `[1, 2, 1, 3]` is declaring a
    // chronology, and the only chronology-consistent answer is
    // `[2, 1, 3]` — the EARLIER 1 removed, the LATER 1 kept.
    //
    // Filter rules (fixture-declared path):
    //   - Non-integer values dropped (defensive for JSON-authored
    //     fixtures that might include strings or nulls).
    //   - Negative values dropped (circuits are non-negative by
    //     schema; negatives are corrupt fixture input).
    //   - Circuit 0 (supply) dropped — production-invariant match.
    //   - Unknown refs (not seeded in stateSnapshot.circuits)
    //     dropped — production could not reach this state.
    //   - Duplicates deduped, LAST occurrence wins via inline
    //     splice+push — mirrors production's idiom at
    //     eicr-extraction-session.js:1218-1221 byte-for-byte.
    //     For `[1, 2, 1, 3]` the trace is push 1 → push 2 →
    //     splice idx 0 + push → `[2, 1]` → push 3 → `[2, 1, 3]`.
    //   - If normalisation empties the array (pathological
    //     declaration where every entry fails a filter), fall back
    //     to numeric ascending of seeded circuits — same as the
    //     no-declared-order path. Keeps the harness
    //     deterministic; a silent empty array would collapse all
    //     circuits into older-summary which masks the fixture bug.
    const declaredOrder = fx.pre_turn_state.recentCircuitOrder;
    const seededKeys = new Set(
      Object.keys(session.stateSnapshot.circuits ?? {})
        .map(Number)
        .filter((n) => Number.isInteger(n) && n !== 0),
    );

    // Plan 04-17 r11-#1 [MAJOR] — fail-fast when the numeric fallback
    // would be UNSAFE. The fallback (`[...seededKeys].sort((a, b) => a - b)`)
    // matches production chronology only incidentally: production's
    // `recentCircuitOrder` is CHRONOLOGICAL (splice+push per
    // record_reading at eicr-extraction-session.js:1218-1221), not
    // numeric. The fallback is safe-by-size when seeded circuits fit
    // entirely in the detailed-view window
    // (`seededKeys.size <= SNAPSHOT_RECENT_CIRCUITS`) — the builder's
    // `.slice(-SNAPSHOT_RECENT_CIRCUITS)` compaction at line 1470
    // trims nothing, so order doesn't affect which circuits land in
    // the detailed block.
    //
    // When a fixture has MORE seeded circuits than the detail window,
    // the numeric fallback silently guesses an ordering that may not
    // match production chronology. Previously the harness accepted
    // this silently — sample-03 has 4 seeded circuits + no declared
    // order and was exercising this silent divergence since Plan 04-05.
    // r11-#1 makes it explicit: the fixture author MUST declare
    // `recentCircuitOrder` when seeded circuits exceed the detail-view
    // window. The error message surfaces the seeded-circuit list and
    // the constant value so the author can act on it without digging
    // into the harness source.
    //
    // Plan 04-18 r12-#2 [MAJOR] — the original r11-#1 guard gate keyed
    // off `!Array.isArray(declaredOrder)`, which let a fixture bypass
    // by declaring `recentCircuitOrder: []` (empty array IS an array;
    // the guard did not fire; normalisation produced empty; the
    // pathological-fallback else branch below assigned numeric
    // ascending silently). r12-#2 tightens the check — the guard now
    // computes the POST-normalisation order preemptively and fires
    // when the result would be empty (covers both "no declaration"
    // and "declared degenerately empty" cases uniformly).
    //
    // The `_force_numeric_recency: true` escape hatch on
    // pre_turn_state is the EXPLICIT opt-in for test fixtures that
    // deliberately exercise the pathological numeric fallback (e.g.
    // the r12-2c test case). Fixtures with seededKeys <=
    // SNAPSHOT_RECENT_CIRCUITS don't need the flag because the
    // guard only fires when seededKeys exceed the window — r9-3c's
    // 3-circuit pathological fixture passes unchanged.
    const forceNumeric = fx.pre_turn_state?._force_numeric_recency === true;

    if (!forceNumeric && seededKeys.size > SNAPSHOT_RECENT_CIRCUITS) {
      // Compute the post-normalisation order preemptively so we can
      // detect the empty-normalisation case before falling through to
      // the branch below. This duplicates the normalisation logic —
      // the duplication is deliberate, the guard needs to know the
      // RESULT of normalisation to decide whether to throw without
      // hoisting the normalisation out of its if-branch (which would
      // change observable control flow for non-guard-fire cases).
      const preview = [];
      if (Array.isArray(declaredOrder)) {
        for (const raw of declaredOrder) {
          const n = Number(raw);
          if (!Number.isInteger(n)) continue;
          if (n <= 0) continue; // drops 0 (supply) + any negatives
          if (!seededKeys.has(n)) continue; // drops unknown refs
          // Last-occurrence-wins dedupe, mirrors the branch below +
          // production's splice+push idiom.
          const idx = preview.indexOf(n);
          if (idx !== -1) preview.splice(idx, 1);
          preview.push(n);
        }
      }

      if (preview.length === 0) {
        const seededList = [...seededKeys].sort((a, b) => a - b).join(', ');
        // Preserve the r11-#1 "does not declare" phrasing for the
        // no-declaration case so r11-1a's assertion chain still
        // matches; append the "normalises to empty" wording in the
        // degenerate-declaration case r12-#2 closes.
        const declaredShape = Array.isArray(declaredOrder)
          ? `declared as \`${JSON.stringify(declaredOrder)}\` which normalises to empty`
          : `does not declare \`pre_turn_state.recentCircuitOrder\``;
        throw new Error(
          `golden-divergence: fixture seeds ${seededKeys.size} non-supply ` +
            `circuits (${seededList}) and ${declaredShape}. The ` +
            `detailed-view window is SNAPSHOT_RECENT_CIRCUITS=` +
            `${SNAPSHOT_RECENT_CIRCUITS}, so a numeric-ascending ` +
            `fallback may silently diverge from production chronology. ` +
            `Either (a) declare a non-empty recentCircuitOrder array ` +
            `listing the chronological order the inspector dictated ` +
            `these circuits (most recent at the end), or (b) for test ` +
            `fixtures that deliberately need the pathological ` +
            `numeric-fallback behaviour, set ` +
            `\`pre_turn_state._force_numeric_recency: true\` to bypass ` +
            `this guard explicitly.`,
        );
      }

      // Plan 04-19 r13-#1 [MAJOR] — PARTIAL declared order coverage
      // check. r12-#2's empty-normalisation check passes for a
      // declaration like `[5]` on a 5-circuit fixture (non-empty,
      // length 1 > 0) but the OTHER 4 circuits get silently handed
      // to the numeric-ascending summary-view ordering. The detail
      // view shows circuit 5; the summary view iterates
      // stateSnapshot.circuits object keys in JS integer-ascending
      // order (ECMAScript spec for numeric keys), guessing a
      // chronology for the omitted positions that may silently
      // diverge from production.
      //
      // r13-#1 closes the gap: require the declared order to cover
      // EVERY seeded non-supply circuit when seededKeys exceeds
      // SNAPSHOT_RECENT_CIRCUITS. The `_force_numeric_recency`
      // escape hatch bypasses this check identically to the way
      // it bypasses the empty check above (uniform "one escape
      // hatch, numeric fallback for the rest" semantics — the
      // forceNumeric branch short-circuits before reaching either
      // guard arm).
      if (preview.length < seededKeys.size) {
        const declaredSet = new Set(preview);
        const missing = [...seededKeys]
          .filter((n) => !declaredSet.has(n))
          .sort((a, b) => a - b);
        const seededList = [...seededKeys].sort((a, b) => a - b).join(', ');
        throw new Error(
          `golden-divergence: fixture seeds ${seededKeys.size} non-supply ` +
            `circuits (${seededList}) and declares ` +
            `\`recentCircuitOrder\` as \`${JSON.stringify(declaredOrder)}\` ` +
            `which normalises to ${preview.length} circuit(s), ` +
            `missing ${missing.join(', ')}. The detailed-view window ` +
            `is SNAPSHOT_RECENT_CIRCUITS=${SNAPSHOT_RECENT_CIRCUITS}; ` +
            `partial declarations hand the omitted circuits to a ` +
            `numeric-ascending summary-view guess that may silently ` +
            `diverge from production chronology. Either (a) declare ` +
            `the FULL chronological order covering all ` +
            `${seededKeys.size} seeded circuits (most recent at the ` +
            `end), or (b) for test fixtures that deliberately need ` +
            `the pathological numeric-fallback behaviour, set ` +
            `\`pre_turn_state._force_numeric_recency: true\` to bypass ` +
            `this guard explicitly.`,
        );
      }
    }

    if (forceNumeric) {
      // Plan 04-20 r14-#1 [MAJOR] — `_force_numeric_recency: true`
      // short-circuits BEFORE the declaration is read. Flag name
      // + error text promise numeric ascending of seeded circuits;
      // pre-r14 the flag only bypassed the guard arms and the
      // non-empty declaration was then honoured verbatim, so a
      // fixture with `[5]` + flag ended up at
      // `session.recentCircuitOrder = [5]` — contradicting the
      // documented semantics.
      //
      // Post-r14: flag ⇒ numeric ascending unconditionally.
      // Declaration shape (empty, partial, full, ordered, unordered)
      // is ignored. r12-2c's empty-case contract is preserved
      // byte-for-byte because empty → numeric was already the
      // fallback path. r13-1c (flipped) + r14-1a pin the new
      // partial-declaration contract.
      session.recentCircuitOrder = [...seededKeys].sort((a, b) => a - b);
    } else if (Array.isArray(declaredOrder)) {
      const normalised = [];
      for (const raw of declaredOrder) {
        const n = Number(raw);
        if (!Number.isInteger(n)) continue;
        if (n <= 0) continue; // drops 0 (supply) + any negatives
        if (!seededKeys.has(n)) continue; // drops unknown refs
        // Last-occurrence-wins dedupe — inline mirror of
        // updateStateSnapshot's splice+push. If the ref already
        // exists in `normalised`, remove its prior slot before
        // appending so a re-declared circuit moves to the end.
        const idx = normalised.indexOf(n);
        if (idx !== -1) normalised.splice(idx, 1);
        normalised.push(n);
      }
      if (normalised.length > 0) {
        session.recentCircuitOrder = normalised;
      } else {
        // Pathological declaration — fall back to numeric
        // ascending so the harness stays deterministic.
        session.recentCircuitOrder = [...seededKeys].sort((a, b) => a - b);
      }
    } else {
      // No declared order → numeric ascending of seeded circuits.
      // Sufficient for the 6 current fixtures (all have <=3
      // seeded circuits or 4 with no meaningful chronology).
      session.recentCircuitOrder = [...seededKeys].sort((a, b) => a - b);
    }
  }
  if (Array.isArray(fx.pre_turn_state?.extractedObservations)) {
    session.extractedObservations = [...fx.pre_turn_state.extractedObservations];
  }
  if (Array.isArray(fx.pre_turn_state?.askedQuestions)) {
    session.askedQuestions = [...fx.pre_turn_state.askedQuestions];
  }

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

  // Replace the real Anthropic client with the replay mock. mockClient
  // captures request args per stream() invocation on its `_calls`
  // accumulator — tests in Group L assert against this to prove the
  // real prompt + real cached-prefix structure flowed through the tool
  // loop.
  session.client = mockClient(streamResponses);
  const messages = [{ role: 'user', content: fx.transcript ?? '' }];

  // REAL buildSystemBlocks() — loads sonnet_agentic_system.md from disk
  // (via EICR_AGENTIC_SYSTEM_PROMPT module constant) AND constructs the
  // two-block cached-prefix layout when the seeded snapshot is non-empty.
  // This is THE fix — pre-r4 the script hardcoded a placeholder string
  // that short-circuited both of these surfaces.
  const systemBlocks = session.buildSystemBlocks();

  try {
    await runToolLoop({
      client: session.client,
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
  //
  // Plan 04-15 r9-#3 — also return the `session` reference so tests
  // can inspect post-normalisation state (notably
  // session.recentCircuitOrder) directly. The mockClient captures
  // prompt-text-side behaviour; the session reference captures the
  // state side. Both are needed because e.g. the `.slice(-N)` in
  // buildStateSnapshotMessage can hide duplicates or unknown refs
  // when the declared array happens to be ≤N entries.
  const bundled = bundleToolCallsIntoResult(perTurnWrites, { questions: [] });
  return { bundled, client: session.client, session };
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
 * Input shape: `{circuits: {[N]: {[field]: value, ...}}}`.
 *
 * Plan 04-08 r2-#3 update — route `circuit_designation` into
 * `circuit_updates` rather than `extracted_readings`, because that's
 * where the real legacy (`record_extraction`) and tool-call (`create_circuit`
 * via bundler) paths BOTH emit it. Pre-r2, the oracle naively flattened
 * every field into readings, causing the oracle to diverge from both
 * pipelines on sample-03 (designation sat in circuit_ops on both sides,
 * but readings on the oracle). Now the oracle converges with both paths
 * and the triple-compare can run cleanly.
 *
 * Action is inferred as `create` when the oracle lists a designation —
 * that's the only production path that puts designation into the write
 * stream (rename also emits designation but is a RARE case in Stage 6
 * fixtures; if a future fixture needs rename-oracle, extend the input
 * shape with an explicit action key then).
 *
 * @param {{circuits?: Object}} oracle
 * @returns {{extracted_readings: Array, circuit_updates: Array}}
 */
/**
 * Project a normalised extraction result to END STATE for oracle
 * comparison (Plan 04-08 r2-#3).
 *
 * The oracle shape (`expected_slot_writes`) models WHAT ENDS UP IN THE
 * STATE after a turn — it does not model transient events. But both the
 * legacy path and the tool-call path emit transient intermediates
 * (notably `clears` — a `clear_reading` + `record_reading` on the same
 * (circuit, field) in one turn is how "correct my Zs from 0.35 to 0.71"
 * renders in both pipelines).
 *
 * End-state projection rules:
 *  - Drop `clears` entries that are SUPERSEDED by a subsequent
 *    `readings` entry on the same (circuit, field). End state of a
 *    clear-then-record pair is just the record.
 *  - Preserve `clears` entries that have no matching reading — those
 *    represent a genuine "end with this slot empty" outcome. These
 *    are rare in the current fixture set but keep them for symmetry.
 *
 * Input/output shape: same 4-section container as normaliseExtractionResult.
 */
function projectToEndState(norm) {
  const src = norm ?? { readings: [], clears: [], circuit_ops: [], observations: [] };
  const readingKeys = new Set(
    (src.readings ?? []).map((r) => `${r.circuit}::${r.field}`),
  );
  const clearsProjected = (src.clears ?? []).filter((c) => {
    const key = `${c.circuit}::${c.field}`;
    return !readingKeys.has(key);
  });
  return {
    readings: Array.isArray(src.readings) ? src.readings : [],
    clears: clearsProjected,
    circuit_ops: Array.isArray(src.circuit_ops) ? src.circuit_ops : [],
    observations: Array.isArray(src.observations) ? src.observations : [],
  };
}

// Plan 04-11 r5-#3: recognised oracle-side fields that describe a
// circuit's IDENTITY/META (create/rename inputs on the tool-call schema)
// rather than a per-circuit READING. These route into circuit_updates
// with their corresponding tool-schema key; anything else flows to
// extracted_readings as pre-r5.
//
// Mapping matches stage6-tool-schemas.js:149-230 (create_circuit +
// rename_circuit) and stage6-event-bundler.js:40 (circuit_updates
// output shape nested under `meta`).
const ORACLE_CIRCUIT_SHAPE_FIELDS = {
  circuit_designation: 'designation',
  circuit_phase: 'phase',
  circuit_rating_amps: 'rating_amps',
  circuit_cable_csa_mm2: 'cable_csa_mm2',
};

export function expectedSlotWritesToLegacyShape(oracle) {
  const out = { extracted_readings: [], circuit_updates: [] };
  if (!oracle || typeof oracle !== 'object') return out;
  const circuits = oracle.circuits;
  if (!circuits || typeof circuits !== 'object') return out;
  for (const [circuitKey, bucket] of Object.entries(circuits)) {
    if (!bucket || typeof bucket !== 'object') continue;
    // Coerce numeric keys back to numbers so the normaliser's sort
    // comparator uses integer ordering rather than string ordering.
    // Keeps parity with fixture snapshots that key circuits by integer.
    const circuit = /^-?\d+$/.test(circuitKey) ? Number(circuitKey) : circuitKey;

    // Plan 04-11 r5-#3: accumulate circuit-shape fields into a single
    // per-circuit `meta` bucket instead of one circuit_updates entry
    // per field. That matches what the tool-call bundler emits (one
    // create_circuit call → one circuit_updates entry with a
    // fully-populated meta). Unset fields default to null to mirror
    // the bundler's null-padding at stage6-dispatchers-circuit.js
    // :256-262.
    let circuitMeta = null;
    for (const [field, value] of Object.entries(bucket)) {
      if (field === 'circuit_ref') continue; // pure shape field; skip
      if (ORACLE_CIRCUIT_SHAPE_FIELDS[field]) {
        if (circuitMeta === null) {
          circuitMeta = {
            designation: null,
            phase: null,
            rating_amps: null,
            cable_csa_mm2: null,
          };
        }
        const canonicalKey = ORACLE_CIRCUIT_SHAPE_FIELDS[field];
        circuitMeta[canonicalKey] = value;
        continue;
      }
      out.extracted_readings.push({ circuit, field, value });
    }
    if (circuitMeta !== null) {
      out.circuit_updates.push({
        action: 'create',
        circuit_ref: circuit,
        meta: circuitMeta,
      });
    }
  }
  return out;
}

/**
 * Run one fixture: derive legacy result, run tool-call dispatcher, normalise
 * both, compute divergence, return per-fixture outcome.
 *
 * Plan 04-07 r1 (Codex MAJOR #3): the previous `legacyResult = toolResult`
 * fallback made Variant-B fixtures self-compare — fixed by the oracle
 * path.
 *
 * Plan 04-08 r2-#3 (Codex MAJOR r2-#3): extend the oracle path to engage
 * ALSO when sse_events_legacy is present. Without this, legacy + tool-call
 * could agree on wrong output (both wrong the same way) and pass 0%
 * because the oracle is never consulted. Four shapes:
 *
 *   (A) sse_events_legacy + sse_events_tool_call + expected_slot_writes
 *       → TRIPLE COMPARE. Compute three pairwise rates:
 *         legacy_vs_tool   — the primary divergence (existing).
 *         tool_vs_oracle   — NEW. Catches "tool-call silently wrong".
 *         legacy_vs_oracle — NEW. Catches "legacy drift from contract".
 *       `diverged` = OR of all three. Primary `divergence` stays
 *       legacy-vs-tool for back-compat; the pairwise rates are surfaced
 *       as additional fields on the divergence object.
 *
 *   (B) sse_events_tool_call + expected_slot_writes only (no
 *       sse_events_legacy) → r1 ORACLE PATH. Oracle acts as the
 *       legacy-equivalent; tool-vs-oracle IS the primary rate.
 *
 *   (C) sse_events_legacy + sse_events_tool_call (no oracle) → r1
 *       Variant A path. Emit a `warnings` breadcrumb encouraging oracle
 *       addition; the gate still runs on legacy-vs-tool only.
 *
 *   (D) Neither tool+oracle nor legacy+tool → THROW (r1 behaviour).
 *
 * Returns `.warnings: string[]` on the fixture result so the CLI digest
 * and the aggregation runner can surface "this fixture could be
 * strengthened" without failing the gate.
 */
export async function runFixture(fixturePath) {
  const fx = readJsonSync(fixturePath);
  const warnings = [];

  // Tool-call side always runs. When it fails to produce anything (bad
  // fixture / error) we return a synthetic divergent verdict so the
  // directory-runner aggregation surfaces the issue.
  //
  // Plan 04-10 r4-#2: runToolCallPath now returns `{bundled, client}` or
  // null. `bundled` is the legacy-shaped result (same as pre-r4); `client`
  // is exposed for test assertions on captured request args (Group L in
  // stage6-golden-divergence.test.js). runFixture only needs `bundled`
  // here, but accept both shapes defensively in case the fixture path
  // errored and returned null early.
  // Plan 04-17 r11-#1 — wrap the toolCallPath call so a fail-fast
  // recency error (or any other `golden-divergence:`-namespaced harness
  // error) can be enriched with the fixture path before it propagates
  // up the stack. This lets the CLI + batch runner surface which
  // fixture failed without the caller having to walk the stack. The
  // wrapper is narrow — only errors whose message begins with
  // `golden-divergence:` are re-thrown with path context; everything
  // else (including network errors from the tool loop) re-throws
  // as-is so the original stack trace is preserved for debugging.
  let runOut;
  try {
    runOut = await runToolCallPath(fx);
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.startsWith('golden-divergence:')) {
      throw new Error(`${err.message} (fixture: ${path.basename(fixturePath)})`);
    }
    throw err;
  }
  const toolResult = runOut ? runOut.bundled : null;

  // Resolve the three possible inputs to the comparison:
  const legacyRaw = extractLegacyFromFixture(fx); // may be null
  const oracleRaw = fx.expected_slot_writes
    ? expectedSlotWritesToLegacyShape(fx.expected_slot_writes)
    : null;
  const hasLegacy = !!legacyRaw;
  const hasOracle = !!oracleRaw;

  // Plan 04-08 r2-#3: Shape D — throw when neither comparison is possible.
  if (!hasLegacy && !hasOracle) {
    throw new Error(
      `golden-divergence: fixture ${path.basename(fixturePath)} is missing ` +
        `both sse_events_legacy and expected_slot_writes — refusing to ` +
        `self-compare (Plan 04-07 r1 remediation of Codex MAJOR #3). ` +
        `Add an expected_slot_writes oracle or a sse_events_legacy stream.`,
    );
  }

  const toolCallNorm = normaliseExtractionResult(toolResult);

  let divergence;
  let legacySource;

  if (hasLegacy && hasOracle) {
    // Shape A — triple-compare. Primary rate stays legacy-vs-tool for
    // back-compat with existing tests + callers; pairwise rates against
    // the oracle are surfaced as additional fields.
    legacySource = 'sse_events_legacy+expected_slot_writes';
    const legacyNorm = normaliseExtractionResult(legacyRaw);
    const oracleNorm = normaliseExtractionResult(oracleRaw);
    const primary = computeDivergence(legacyNorm, toolCallNorm);
    // Plan 04-08 r2-#3: oracle-vs-pipeline comparisons use END STATE
    // projection (see projectToEndState) — clears are an intermediate
    // event stream, not an end-state property. A clear-then-record on
    // (circuit, field) collapses to just the record for end-state
    // comparison. Without this projection, fixtures like sample-02
    // (where both paths emit a clear + a record for the same slot but
    // the oracle only describes the final value) would diverge against
    // the oracle even though they're operationally equivalent.
    const toolEndState = projectToEndState(toolCallNorm);
    const legacyEndState = projectToEndState(legacyNorm);
    const oracleEndState = projectToEndState(oracleNorm);
    const toolVsOracle = computeCallLevelDivergence(oracleEndState, toolEndState);
    const legacyVsOracle = computeCallLevelDivergence(oracleEndState, legacyEndState);

    // Plan 04-12 r6-#1 BLOCK — UNION call-count aggregation. Before r6,
    // `...primary` spread left `call_total` + `call_divergent_count` at
    // the PRIMARY (legacy-vs-tool) counts, so "both wrong the same way"
    // reported call_divergence=0 despite diverged=true. runDirectory's
    // headline call_divergence_rate was built off these primary counts
    // and therefore undercounted oracle-only divergences to zero. The
    // union aggregator folds ALL pairwise comparisons into a single
    // per-write divergent-or-not verdict (set semantics — a write
    // divergent in multiple pairings counts once). End-state projection
    // applies consistently: the oracle describes end-state so all three
    // normsare projected for the union to compare on the same basis.
    const union = unionPairwiseCallCounts(legacyEndState, toolEndState, oracleEndState);

    divergence = {
      // Section-level + primary back-compat fields (unchanged from r5).
      section_divergence: primary.section_divergence,
      section_reasons: primary.section_reasons,
      reasons: primary.reasons,
      // Primary call-level (legacy-vs-tool) kept for any caller that
      // explicitly wants the pairwise rate.
      call_reasons: primary.call_reasons,
      // Triple-compare surface (Plan 04-08 r2-#3).
      legacy_vs_tool_divergence: primary.call_divergence,
      tool_vs_oracle_divergence: toolVsOracle.rate,
      legacy_vs_oracle_divergence: legacyVsOracle.rate,
      tool_vs_oracle_reasons: toolVsOracle.reasons,
      legacy_vs_oracle_reasons: legacyVsOracle.reasons,
      // Diverged is the OR of ALL THREE pairwise rates (unchanged).
      diverged:
        primary.diverged ||
        toolVsOracle.rate > 0 ||
        legacyVsOracle.rate > 0,
      // CALL-LEVEL aggregate now reflects the UNION (Plan 04-12 r6-#1).
      // runDirectory aggregates these across sessions into the headline
      // call_divergence_rate. Post-r6 the headline correctly surfaces
      // oracle-only divergence; pre-r6 it silently zeroed those.
      call_divergence: union.rate,
      call_total: union.total,
      call_divergent_count: union.divergent,
    };
    // Attach the normalised oracle so downstream tooling can use it.
    return {
      fixture: path.basename(fixturePath),
      fixturePath,
      legacyNorm,
      toolCallNorm,
      oracleNorm,
      divergence,
      legacy_source: legacySource,
      warnings,
    };
  }

  if (!hasLegacy && hasOracle) {
    // Shape B — r1 oracle path. Oracle IS the legacy-equivalent; the
    // triple-compare degenerates to a single pairwise comparison.
    legacySource = 'expected_slot_writes';
    const legacyNorm = normaliseExtractionResult(oracleRaw);
    const primary = computeDivergence(legacyNorm, toolCallNorm);
    divergence = {
      ...primary,
      // tool_vs_oracle IS the primary comparison here — surface it with
      // the explicit name too so downstream tooling can query it
      // uniformly across shapes.
      legacy_vs_tool_divergence: null, // no legacy to compare against
      tool_vs_oracle_divergence: primary.call_divergence,
      legacy_vs_oracle_divergence: null, // no legacy to compare
      tool_vs_oracle_reasons: primary.call_reasons,
      legacy_vs_oracle_reasons: [],
    };
    return {
      fixture: path.basename(fixturePath),
      fixturePath,
      legacyNorm,
      toolCallNorm,
      oracleNorm: legacyNorm, // same reference — oracle IS legacy here.
      divergence,
      legacy_source: legacySource,
      warnings,
    };
  }

  // Shape C — legacy + tool only (no oracle). r1 Variant A preserved.
  // Emit a warning so fixture authors know the gate is weaker here.
  legacySource = 'sse_events_legacy';
  warnings.push(
    `golden-divergence: fixture ${path.basename(fixturePath)} has no ` +
      `expected_slot_writes oracle — legacy-vs-tool comparison only. ` +
      `Consider adding an oracle to strengthen the gate against the ` +
      `"both wrong the same way" failure mode (Plan 04-08 r2-#3).`,
  );
  const legacyNorm = normaliseExtractionResult(legacyRaw);
  const primary = computeDivergence(legacyNorm, toolCallNorm);
  divergence = {
    ...primary,
    legacy_vs_tool_divergence: primary.call_divergence,
    tool_vs_oracle_divergence: null, // no oracle available
    legacy_vs_oracle_divergence: null, // no oracle available
    tool_vs_oracle_reasons: [],
    legacy_vs_oracle_reasons: [],
  };
  return {
    fixture: path.basename(fixturePath),
    fixturePath,
    legacyNorm,
    toolCallNorm,
    oracleNorm: null,
    divergence,
    legacy_source: legacySource,
    warnings,
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

  // Plan 04-09 r3-#2: breach is gated on call + session only.
  // `section_divergence_rate` is diagnostic (see Plan 04-08 r2-#2 design
  // intent) — gating on it was a bug; a high section fraction on a
  // single multi-section disagreement would trip the gate even when
  // the real per-write rate is well below threshold. See
  // `computeBreached` below for the authoritative gate logic.
  const breached = computeBreached(
    {
      section_divergence_rate,
      call_divergence_rate,
      session_divergence_rate,
    },
    threshold,
  );

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

/**
 * Plan 04-09 r3-#2: breach-determination helper. Pure function over
 * three rates + threshold.
 *
 * Gate semantics:
 *   breached = (call_divergence_rate > threshold)
 *           || (session_divergence_rate > threshold)
 *
 * `section_divergence_rate` is DIAGNOSTIC (Plan 04-08 r2-#2 design
 * intent) — it is reported in the final digest but NOT included in the
 * breach OR. A high section fraction on a single multi-section
 * disagreement (one reading wrong in one fixture makes the readings
 * section diverge, giving section_divergence=0.25) should not trip the
 * gate when the real per-write rate is well below threshold (1/20 =
 * 0.05 under the same scenario).
 *
 * `session_divergence_rate` IS a legitimate gate: fraction of sessions
 * that had ANY divergence. If a large fraction of sessions fail
 * end-to-end, the per-call average may hide broad-but-shallow drift
 * behind a small number of matched slots — the session rate surfaces
 * that pattern.
 *
 * Threshold semantics: strict `>` (the pre-r3 code used strict `>` too
 * and Plan 04-05's claim is "≤ 10%"). A rate exactly at threshold is
 * still at-limit, not a breach.
 *
 * @param {{section_divergence_rate:number, call_divergence_rate:number, session_divergence_rate:number}} rates
 * @param {number} threshold
 * @returns {boolean}
 */
export function computeBreached(rates, threshold) {
  const call = typeof rates?.call_divergence_rate === 'number' ? rates.call_divergence_rate : 0;
  const session =
    typeof rates?.session_divergence_rate === 'number' ? rates.session_divergence_rate : 0;
  // section_divergence_rate DELIBERATELY NOT IN THIS EXPRESSION.
  // See JSDoc above — it is diagnostic, not a gate.
  return call > threshold || session > threshold;
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
        // Plan 04-09 r3-#2: label metrics clearly.
        //   call_divergence_rate    — primary gate (STR-02/STR-03 budget)
        //   session_divergence_rate — secondary gate (session-level drift)
        //   section_divergence_rate — diagnostic ONLY (not gated)
        console.error(
          `divergence exceeds threshold ${report.threshold}: ` +
            `call=${report.call_divergence_rate} (primary gate), ` +
            `session=${report.session_divergence_rate} (secondary gate). ` +
            `Diagnostic: section=${report.section_divergence_rate} (not gated).`,
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
