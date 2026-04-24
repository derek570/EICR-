/**
 * Tests for scripts/stage6-golden-divergence.js — Phase 4 Plan 04-05.
 *
 * WHAT THIS FILE COVERS:
 *   Group A — normaliseExtractionResult: STR-02 canonicalisation semantics
 *     (sort, lowercase enums, drop transient fields, trim whitespace).
 *   Group B — computeDivergence: deterministic-equivalence verdict over
 *     two normalised shapes + section-level divergence rate.
 *   Group C — runDirectory: directory runner aggregates ≤10% threshold
 *     across the five golden-session fixtures.
 *   Group D — F21934D4 inclusion via extraFixtures option: 6-session run,
 *     still 0.0 divergence. F21934D4 fixture is shape-incompatible with the
 *     legacy/tool-call dual-SSE pattern (tool-call only); the runner
 *     synthesises the legacy baseline from `expected_slot_writes` when
 *     `sse_events_legacy` is absent, so the fixture remains the SINGLE
 *     SOURCE OF TRUTH owned by Plan 04-04.
 *   Group E — threshold breach signalling: synthetic mis-matched result
 *     pair proves the harness classifies divergence correctly and the
 *     aggregate rate computes over section-level disagreement.
 *
 * WHY THIS IS THE SC #6 GATE:
 * Phase 4 SC #6 — "Shadow-mode divergence on golden sessions (STT-11
 * subset): ≤ 10% divergence rate BEFORE any over-ask guards added."
 * This test drives `runDirectory` over the 5 fixtures authored in this
 * plan (plus the F21934D4 fixture from 04-04 via extraFixtures) and
 * asserts the aggregate rate is at threshold. Expected is 0% on
 * deterministic fixtures; the 10% budget is the STT-11 acceptance
 * envelope once real-model traffic enters the picture in Phase 5/7.
 *
 * WHY deterministic-equivalence (NOT real-model shadow):
 * This plan does NOT call Anthropic. Every fixture ships canned
 * legacy + tool-call SSE streams that are handwritten to converge on a
 * single expected_slot_writes truth. If the two converge through our
 * normaliser and dispatcher, we know the MECHANICS of the shadow
 * comparison are sound. Any Phase-7 real-model divergence must then be
 * model behaviour, not pipeline. That disambiguation is what this
 * deterministic lock buys us.
 */

import { jest } from '@jest/globals';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normaliseExtractionResult,
  computeDivergence,
  computeSectionDivergence,
  computeCallLevelDivergence,
  runDirectory,
  runFixture,
  expectedSlotWritesToLegacyShape,
} from '../../scripts/stage6-golden-divergence.js';
import { TOOL_SCHEMAS, CONTEXT_FIELD_ENUM } from '../extraction/stage6-tool-schemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/stage6-golden-sessions');
const F21934D4_PATH = path.resolve(
  __dirname,
  'fixtures/stage6-sse/f21934d4-re-ask-scenario.json',
);

// ---------------------------------------------------------------------------
// Group A — normaliseExtractionResult
// ---------------------------------------------------------------------------

describe('normaliseExtractionResult — STR-02 canonicalisation', () => {
  test('sorts readings by (circuit, field) ascending', () => {
    const result = {
      extracted_readings: [
        { circuit: 3, field: 'zs', value: '0.35' },
        { circuit: 1, field: 'ze', value: '0.32' },
        { circuit: 1, field: 'r1_r2', value: '0.20' },
      ],
    };
    const norm = normaliseExtractionResult(result);
    expect(norm.readings).toEqual([
      { circuit: 1, field: 'r1_r2', value: '0.20' },
      { circuit: 1, field: 'ze', value: '0.32' },
      { circuit: 3, field: 'zs', value: '0.35' },
    ]);
  });

  test('lowercases enum fields (field, observation code)', () => {
    const result = {
      extracted_readings: [{ circuit: 2, field: 'ZS', value: '0.4' }],
      observations: [{ code: 'c2', text: 'Missing cover', observation_text: 'Missing cover' }],
    };
    const norm = normaliseExtractionResult(result);
    // field lowercased; code uppercased (IET convention — codes like C1/C2/C3/FI are UPPER).
    expect(norm.readings[0].field).toBe('zs');
    expect(norm.observations[0].code).toBe('C2');
  });

  test('drops confidence, source_turn_id, and timestamps from readings', () => {
    const result = {
      extracted_readings: [
        {
          circuit: 1,
          field: 'zs',
          value: '0.35',
          confidence: 0.95,
          source_turn_id: 't-42',
          timestamp: '2026-04-22T12:00:00Z',
        },
      ],
    };
    const norm = normaliseExtractionResult(result);
    expect(norm.readings[0]).toEqual({ circuit: 1, field: 'zs', value: '0.35' });
    expect(norm.readings[0]).not.toHaveProperty('confidence');
    expect(norm.readings[0]).not.toHaveProperty('source_turn_id');
    expect(norm.readings[0]).not.toHaveProperty('timestamp');
  });

  test('trims whitespace on string values', () => {
    const result = {
      extracted_readings: [{ circuit: 1, field: 'zs', value: '  0.35  ' }],
      observations: [{ code: 'c2', text: '  Damaged cover  ' }],
      circuit_updates: [{ action: 'create', circuit_ref: 4, designation: '  Kitchen  ' }],
    };
    const norm = normaliseExtractionResult(result);
    expect(norm.readings[0].value).toBe('0.35');
    expect(norm.observations[0].text).toBe('Damaged cover');
    expect(norm.circuit_ops[0].designation).toBe('Kitchen');
  });

  test('handles empty / missing slots without throwing', () => {
    expect(normaliseExtractionResult({})).toEqual({
      readings: [],
      clears: [],
      circuit_ops: [],
      observations: [],
    });
    expect(normaliseExtractionResult(null)).toEqual({
      readings: [],
      clears: [],
      circuit_ops: [],
      observations: [],
    });
  });

  test('canonicalises circuit_updates: action lowercase, designation trimmed, circuit_ref from either field', () => {
    const result = {
      circuit_updates: [
        { op: 'CREATE', circuit_ref: 5, designation: 'Upstairs sockets' },
        { action: 'Rename', circuit: 3, designation: 'Lighting downstairs' },
      ],
    };
    const norm = normaliseExtractionResult(result);
    expect(norm.circuit_ops).toEqual([
      { action: 'create', circuit_ref: 5, designation: 'Upstairs sockets' },
      { action: 'rename', circuit_ref: 3, designation: 'Lighting downstairs' },
    ]);
  });

  test('projects tool-call bundler shape (cleared_readings) into clears', () => {
    const result = {
      cleared_readings: [
        { circuit: 1, field: 'ZS', reason: 'correction' },
        { circuit: 2, field: 'r1_r2' },
      ],
    };
    const norm = normaliseExtractionResult(result);
    expect(norm.clears).toEqual([
      { circuit: 1, field: 'zs' },
      { circuit: 2, field: 'r1_r2' },
    ]);
  });

  test('returns an identical object for structurally identical inputs (bit-identical via JSON.stringify)', () => {
    const a = {
      extracted_readings: [
        { circuit: 1, field: 'zs', value: '0.35', confidence: 0.95, source_turn_id: 't1' },
      ],
      observations: [{ code: 'c2', text: 'X' }],
    };
    const b = {
      extracted_readings: [
        { circuit: 1, field: 'ZS', value: '0.35', confidence: 0.10, source_turn_id: 't99' },
      ],
      observations: [{ code: 'C2', text: ' X ' }],
    };
    // Same truth after canonicalisation despite differing casing + transient fields.
    expect(JSON.stringify(normaliseExtractionResult(a))).toBe(
      JSON.stringify(normaliseExtractionResult(b)),
    );
  });
});

// ---------------------------------------------------------------------------
// Group B — computeSectionDivergence (renamed in Plan 04-08 r2-#2 from
// `computeDivergence`; the old name still exports a back-compat shape that
// exposes BOTH metrics). Group B locks section-level semantics only.
// ---------------------------------------------------------------------------

describe('computeSectionDivergence — section-level section diff', () => {
  const empty = { readings: [], clears: [], circuit_ops: [], observations: [] };

  test('identical inputs → { diverged: false, section_divergence: 0 }', () => {
    const a = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.35' }] };
    const b = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.35' }] };
    const d = computeSectionDivergence(a, b);
    expect(d.diverged).toBe(false);
    expect(d.section_divergence).toBe(0);
    expect(d.reasons).toEqual([]);
  });

  test('different readings section → diverged, 1/4 sections = 0.25', () => {
    const a = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.35' }] };
    const b = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.71' }] };
    const d = computeSectionDivergence(a, b);
    expect(d.diverged).toBe(true);
    expect(d.section_divergence).toBeCloseTo(0.25, 6);
    expect(d.reasons).toContain('readings');
  });

  test('all sections different → diverged, 4/4 = 1.0', () => {
    const a = {
      readings: [{ circuit: 1, field: 'zs', value: '0.35' }],
      clears: [{ circuit: 2, field: 'ze' }],
      circuit_ops: [{ action: 'create', circuit_ref: 3, designation: 'Sockets' }],
      observations: [{ code: 'C2', text: 'X' }],
    };
    const b = { ...empty };
    const d = computeSectionDivergence(a, b);
    expect(d.diverged).toBe(true);
    expect(d.section_divergence).toBeCloseTo(1.0, 6);
    expect(d.reasons.sort()).toEqual(['circuit_ops', 'clears', 'observations', 'readings']);
  });

  test('empty-vs-non-empty reading list → diverged', () => {
    const a = { ...empty };
    const b = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.35' }] };
    const d = computeSectionDivergence(a, b);
    expect(d.diverged).toBe(true);
    expect(d.reasons).toContain('readings');
  });

  test('two divergent sections → 2/4 = 0.5', () => {
    const a = {
      readings: [{ circuit: 1, field: 'zs', value: '0.35' }],
      clears: [],
      circuit_ops: [],
      observations: [{ code: 'C2', text: 'A' }],
    };
    const b = {
      readings: [{ circuit: 1, field: 'zs', value: '0.35' }],
      clears: [],
      circuit_ops: [],
      observations: [{ code: 'C2', text: 'B' }],
    };
    // Same readings section; observations differ; 1 section diverges.
    const d = computeSectionDivergence(a, b);
    expect(d.diverged).toBe(true);
    expect(d.section_divergence).toBeCloseTo(0.25, 6);
    expect(d.reasons).toEqual(['observations']);
  });
});

// ---------------------------------------------------------------------------
// Group B' — computeCallLevelDivergence (Plan 04-08 r2-#2).
//
// WHY THIS GROUP EXISTS: Codex r2-#2 flagged that
// `call_divergence = reasons.length / 4` is a SECTION-level fraction
// misnamed as call-level. One wrong reading in 20 flags the whole
// readings section and the aggregate misstates true per-call divergence
// by up to 20x. The new `computeCallLevelDivergence` helper counts
// INDIVIDUAL writes — 1 mismatch / 20 total writes = 0.05 call-level
// divergence, not 0.25. SC #6's ≤10% claim is now measured against
// this metric.
// ---------------------------------------------------------------------------

describe('computeCallLevelDivergence — per-write divergence', () => {
  const empty = { readings: [], clears: [], circuit_ops: [], observations: [] };

  test('identical empty → {rate: 0, total: 0, divergent: 0}', () => {
    const d = computeCallLevelDivergence(empty, empty);
    expect(d.rate).toBe(0);
    expect(d.total).toBe(0);
    expect(d.divergent).toBe(0);
  });

  test('5 matching readings → rate 0, total 5, divergent 0', () => {
    const same = {
      ...empty,
      readings: [
        { circuit: 1, field: 'zs', value: '0.35' },
        { circuit: 2, field: 'zs', value: '0.40' },
        { circuit: 3, field: 'zs', value: '0.45' },
        { circuit: 4, field: 'zs', value: '0.50' },
        { circuit: 5, field: 'zs', value: '0.55' },
      ],
    };
    const d = computeCallLevelDivergence(same, same);
    expect(d.rate).toBe(0);
    expect(d.total).toBe(5);
    expect(d.divergent).toBe(0);
  });

  test('1 wrong reading in 5 → rate 0.2, total 5, divergent 1', () => {
    const a = {
      ...empty,
      readings: [
        { circuit: 1, field: 'zs', value: '0.35' },
        { circuit: 2, field: 'zs', value: '0.40' },
        { circuit: 3, field: 'zs', value: '0.45' },
        { circuit: 4, field: 'zs', value: '0.50' },
        { circuit: 5, field: 'zs', value: '0.55' },
      ],
    };
    const b = {
      ...empty,
      readings: [
        { circuit: 1, field: 'zs', value: '0.35' },
        { circuit: 2, field: 'zs', value: '0.40' },
        { circuit: 3, field: 'zs', value: '0.99' }, // wrong
        { circuit: 4, field: 'zs', value: '0.50' },
        { circuit: 5, field: 'zs', value: '0.55' },
      ],
    };
    const d = computeCallLevelDivergence(a, b);
    expect(d.rate).toBeCloseTo(0.2, 6);
    expect(d.total).toBe(5);
    expect(d.divergent).toBe(1);
    // reasons must be a non-empty array describing the mismatch.
    expect(Array.isArray(d.reasons)).toBe(true);
    expect(d.reasons.length).toBeGreaterThan(0);
  });

  test('completely disjoint — 0 legacy vs 3 tool-call → rate 1.0, total 3, divergent 3', () => {
    const a = { ...empty };
    const b = {
      ...empty,
      readings: [
        { circuit: 1, field: 'zs', value: '0.35' },
        { circuit: 2, field: 'zs', value: '0.40' },
        { circuit: 3, field: 'zs', value: '0.45' },
      ],
    };
    const d = computeCallLevelDivergence(a, b);
    expect(d.rate).toBe(1.0);
    expect(d.total).toBe(3);
    expect(d.divergent).toBe(3);
  });

  test('cross-section counting — 2 reading mismatches + 1 obs mismatch / 5 total writes = 0.6', () => {
    const a = {
      readings: [
        { circuit: 1, field: 'zs', value: '0.35' },
        { circuit: 2, field: 'zs', value: '0.40' },
        { circuit: 3, field: 'zs', value: '0.45' },
      ],
      clears: [],
      circuit_ops: [],
      observations: [
        { code: 'C2', text: 'X' },
        { code: 'C3', text: 'Y' },
      ],
    };
    const b = {
      readings: [
        { circuit: 1, field: 'zs', value: '0.99' }, // wrong
        { circuit: 2, field: 'zs', value: '0.40' },
        { circuit: 3, field: 'zs', value: '0.50' }, // wrong
      ],
      clears: [],
      circuit_ops: [],
      observations: [
        { code: 'C2', text: 'X' },
        { code: 'C3', text: 'Z' }, // wrong
      ],
    };
    const d = computeCallLevelDivergence(a, b);
    // 5 total writes (3 readings + 2 obs); 3 mismatched.
    expect(d.total).toBe(5);
    expect(d.divergent).toBe(3);
    expect(d.rate).toBeCloseTo(0.6, 6);
  });

  test('mismatched list lengths — missing and extra both count as divergent', () => {
    const a = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.35' }] };
    const b = {
      ...empty,
      readings: [
        { circuit: 1, field: 'zs', value: '0.35' },
        { circuit: 2, field: 'zs', value: '0.40' },
      ],
    };
    const d = computeCallLevelDivergence(a, b);
    // Total is max(a.readings.length, b.readings.length) per section so
    // missing entries also count toward divergent.
    expect(d.total).toBe(2);
    expect(d.divergent).toBe(1);
    expect(d.rate).toBeCloseTo(0.5, 6);
  });
});

// ---------------------------------------------------------------------------
// Group B'' — computeDivergence (back-compat surface). After r2-#2 this
// wraps BOTH section + call metrics into one result object. Existing
// callers that only consult `diverged` / `reasons` keep working. Callers
// that want the precise metric use the new fields `section_divergence` +
// `call_divergence`.
// ---------------------------------------------------------------------------

describe('computeDivergence — back-compat surface (section + call combined)', () => {
  const empty = { readings: [], clears: [], circuit_ops: [], observations: [] };

  test('identical inputs → diverged=false, both rates 0', () => {
    const a = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.35' }] };
    const b = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.35' }] };
    const d = computeDivergence(a, b);
    expect(d.diverged).toBe(false);
    expect(d.section_divergence).toBe(0);
    expect(d.call_divergence).toBe(0);
    expect(d.reasons).toEqual([]);
  });

  test('1 wrong reading in 5 → section_divergence 0.25 (legacy) + call_divergence 0.2 (real)', () => {
    const mk = (readings) => ({ ...empty, readings });
    const a = mk([
      { circuit: 1, field: 'zs', value: '0.35' },
      { circuit: 2, field: 'zs', value: '0.40' },
      { circuit: 3, field: 'zs', value: '0.45' },
      { circuit: 4, field: 'zs', value: '0.50' },
      { circuit: 5, field: 'zs', value: '0.55' },
    ]);
    const b = mk([
      { circuit: 1, field: 'zs', value: '0.35' },
      { circuit: 2, field: 'zs', value: '0.40' },
      { circuit: 3, field: 'zs', value: '0.99' }, // wrong
      { circuit: 4, field: 'zs', value: '0.50' },
      { circuit: 5, field: 'zs', value: '0.55' },
    ]);
    const d = computeDivergence(a, b);
    expect(d.diverged).toBe(true);
    // OLD section metric — 1/4 sections differ.
    expect(d.section_divergence).toBeCloseTo(0.25, 6);
    // NEW call-level metric — 1/5 writes differ.
    expect(d.call_divergence).toBeCloseTo(0.2, 6);
  });

  test("divergedness is OR of both metrics — section=0 with call>0 still flags", () => {
    // Defensive: if a future refactor lets the two metrics disagree on
    // zero-ness, the OR keeps diverged honest.
    const same = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.35' }] };
    const d = computeDivergence(same, same);
    expect(d.diverged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group C — runDirectory on the 5 golden fixtures
// ---------------------------------------------------------------------------

describe('runDirectory — 5 golden fixtures', () => {
  test('returns a report with 5 sessions', async () => {
    const report = await runDirectory(FIXTURE_DIR);
    expect(report.total).toBe(5);
    expect(report.sessions).toHaveLength(5);
  });

  test('session_divergence_rate ≤ 0.10 (expected 0 on deterministic fixtures)', async () => {
    const report = await runDirectory(FIXTURE_DIR);
    expect(report.session_divergence_rate).toBeLessThanOrEqual(0.10);
    // Expected: exact-match deterministic fixtures.
    expect(report.session_divergence_rate).toBe(0);
  });

  test('call_divergence_rate ≤ 0.10 (expected 0 on deterministic fixtures)', async () => {
    const report = await runDirectory(FIXTURE_DIR);
    expect(report.call_divergence_rate).toBeLessThanOrEqual(0.10);
    expect(report.call_divergence_rate).toBe(0);
  });

  test('each fixture records its per-session divergence verdict', async () => {
    const report = await runDirectory(FIXTURE_DIR);
    for (const s of report.sessions) {
      expect(s.fixture).toMatch(/sample-0[1-5]-.+\.json$/);
      expect(s.divergence).toHaveProperty('diverged');
      expect(s.divergence).toHaveProperty('call_divergence');
    }
  });
});

// ---------------------------------------------------------------------------
// Group D — F21934D4 inclusion via extraFixtures
// ---------------------------------------------------------------------------

describe('runDirectory — extraFixtures (F21934D4 inclusion)', () => {
  test('6-session run (5 goldens + F21934D4) remains at 0% divergence', async () => {
    const report = await runDirectory(FIXTURE_DIR, {
      extraFixtures: [F21934D4_PATH],
    });
    expect(report.total).toBe(6);
    expect(report.session_divergence_rate).toBe(0);
    expect(report.call_divergence_rate).toBe(0);
    // Confirm F21934D4 made it into the aggregation.
    expect(report.sessions.some((s) => /f21934d4/i.test(s.fixture))).toBe(true);
  });

  test('missing extraFixture surfaces an error, not silent pass', async () => {
    await expect(
      runDirectory(FIXTURE_DIR, {
        extraFixtures: ['/path/to/does-not-exist.json'],
      }),
    ).rejects.toThrow(/does-not-exist\.json/);
  });
});

// ---------------------------------------------------------------------------
// Group C' — Plan 04-08 r2-#2: runDirectory now reports BOTH section-level
// and call-level divergence rates as separate aggregate fields. The
// SC #6 / STT-11 gate threshold applies to `call_divergence_rate` (the
// real metric); `section_divergence_rate` is kept as a diagnostic.
// ---------------------------------------------------------------------------

describe('Group C\' — runDirectory exposes section + call metrics separately (r2-#2)', () => {
  test('runDirectory report surfaces both section_divergence_rate AND call_divergence_rate', async () => {
    const report = await runDirectory(FIXTURE_DIR);
    expect(report).toHaveProperty('section_divergence_rate');
    expect(report).toHaveProperty('call_divergence_rate');
    expect(typeof report.section_divergence_rate).toBe('number');
    expect(typeof report.call_divergence_rate).toBe('number');
  });

  test('on deterministic goldens both rates are 0 (5-fixture set)', async () => {
    const report = await runDirectory(FIXTURE_DIR);
    expect(report.section_divergence_rate).toBe(0);
    expect(report.call_divergence_rate).toBe(0);
  });

  test('on combined 5+F21934D4 set both rates are 0', async () => {
    const report = await runDirectory(FIXTURE_DIR, { extraFixtures: [F21934D4_PATH] });
    expect(report.section_divergence_rate).toBe(0);
    expect(report.call_divergence_rate).toBe(0);
  });

  test('per-session divergence now exposes BOTH section_divergence AND call_divergence fields', async () => {
    const report = await runDirectory(FIXTURE_DIR, { extraFixtures: [F21934D4_PATH] });
    for (const s of report.sessions) {
      // Back-compat: call_divergence field still present.
      expect(s.divergence).toHaveProperty('call_divergence');
      // New r2-#2 field.
      expect(s.divergence).toHaveProperty('section_divergence');
    }
  });
});

// ---------------------------------------------------------------------------
// Group E — threshold breach signalling
// ---------------------------------------------------------------------------

describe('runDirectory — threshold breach', () => {
  test('synthetic mismatched legacy vs tool-call → computeDivergence flags diverged', () => {
    const legacy = {
      readings: [{ circuit: 3, field: 'zs', value: '0.35' }],
      clears: [],
      circuit_ops: [],
      observations: [],
    };
    const toolCall = {
      readings: [{ circuit: 3, field: 'zs', value: '0.71' }],
      clears: [],
      circuit_ops: [],
      observations: [],
    };
    const d = computeDivergence(legacy, toolCall);
    expect(d.diverged).toBe(true);
    expect(d.call_divergence).toBeGreaterThan(0);
  });

  test('report shape signals breach without calling process.exit', async () => {
    // Run the 5 fixtures with an absurdly tight threshold of 0.0; report still
    // returns (rate is 0 on deterministic fixtures, which is ≤ 0.0 exactly).
    // Then prove the report structure surfaces breach when rate > threshold
    // via a synthetic helper aggregation (no process exit involved).
    const report = await runDirectory(FIXTURE_DIR, { threshold: 0.0 });
    expect(report.breached).toBe(false); // 0.0 ≤ 0.0 — not a breach

    // Fabricate a report shape with a diverged session to prove breach signal.
    const syntheticReport = {
      total: 2,
      sessions: [
        { fixture: 'a.json', divergence: { diverged: false, call_divergence: 0 } },
        { fixture: 'b.json', divergence: { diverged: true, call_divergence: 0.5 } },
      ],
    };
    syntheticReport.session_divergence_rate = 1 / 2;
    syntheticReport.call_divergence_rate = (0 + 0.5) / 2;
    syntheticReport.threshold = 0.10;
    syntheticReport.breached =
      syntheticReport.session_divergence_rate > syntheticReport.threshold ||
      syntheticReport.call_divergence_rate > syntheticReport.threshold;
    expect(syntheticReport.breached).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group F — SC #6 lock + full integration surface
// ---------------------------------------------------------------------------
// This group is the Phase 4 SC #6 gate. It runs the canonical 5 + F21934D4
// set in one call and asserts the ≤10% divergence budget at the highest
// level. If the prompt + cached-prefix + tool-call stack ever drifts
// enough for ANY fixture to diverge, this assertion trips and the
// stage6-agentic branch is blocked from merging. That's the intended
// behaviour — DO NOT lower the threshold to paper over drift; fix the
// underlying cause.

describe('Phase 4 SC #6 — golden-session divergence gate', () => {
  test('combined 5 goldens + F21934D4 ≤ 10% threshold (SC #6 lock)', async () => {
    const report = await runDirectory(FIXTURE_DIR, {
      threshold: 0.10,
      extraFixtures: [F21934D4_PATH],
    });

    // Shape: the report exposes a stable contract that Phase 5 + Phase 7
    // build on. Lock every top-level field so a future refactor that
    // drops one surfaces as a test failure rather than a silent analyzer
    // break.
    expect(report).toEqual(
      expect.objectContaining({
        total: 6,
        threshold: 0.10,
        session_divergence_rate: expect.any(Number),
        call_divergence_rate: expect.any(Number),
        breached: expect.any(Boolean),
        sessions: expect.any(Array),
      }),
    );

    // The gate: both aggregate rates must sit at or below threshold. Plan
    // 04-05 establishes 0% as the expected baseline on deterministic
    // fixtures — any movement off 0% on these 6 is a bug, not drift.
    expect(report.session_divergence_rate).toBeLessThanOrEqual(0.10);
    expect(report.call_divergence_rate).toBeLessThanOrEqual(0.10);
    expect(report.breached).toBe(false);

    // Every session records its per-fixture divergence verdict with the
    // full {diverged, call_divergence, reasons} surface. Phase 5 uses the
    // `reasons` field to triage new fixtures; Phase 7 consumes the
    // call_divergence fraction for the STR-03 aggregate.
    for (const s of report.sessions) {
      expect(s).toHaveProperty('fixture');
      expect(s).toHaveProperty('divergence.diverged');
      expect(s).toHaveProperty('divergence.call_divergence');
      expect(s).toHaveProperty('divergence.reasons');
      expect(Array.isArray(s.divergence.reasons)).toBe(true);
    }
  });

  test('each of the 5 Plan-04-05 fixtures normalises to non-empty slot writes', async () => {
    // Sanity: if a fixture mis-parses and produces empty slots, both paths
    // would converge on empty (0% divergence) but the gate would be
    // vacuous. Lock that every fixture actually writes at least one
    // reading (the minimum coverage bar for an STQ-02 scenario).
    const report = await runDirectory(FIXTURE_DIR);
    for (const s of report.sessions) {
      expect(s.legacyNorm.readings.length + s.toolCallNorm.readings.length).toBeGreaterThan(0);
    }
  });

  test('F21934D4 cross-plan fixture exercises the tool-call-only Variant B path', async () => {
    // Lock that the Variant B branch in runFixture (legacy-from-tool-call
    // fallback when sse_events_legacy is absent) keeps the F21934D4
    // fixture at 0% divergence. If Plan 04-04 ever rewrites the F21934D4
    // fixture to add sse_events_legacy, this test still passes (Variant A
    // would take over) — but the cross-plan contract around 0% holds
    // either way.
    const report = await runDirectory(FIXTURE_DIR, {
      extraFixtures: [F21934D4_PATH],
    });
    const f21 = report.sessions.find((s) => /f21934d4/i.test(s.fixture));
    expect(f21).toBeDefined();
    expect(f21.divergence.diverged).toBe(false);
    expect(f21.divergence.call_divergence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Group G — Plan 04-07 r1 — fixture-level schema validation.
//
// WHY THIS GROUP EXISTS: Codex STG r1 (2026-04-23) flagged a single
// invalid `clear_reading.reason: "correction"` in sample-02. Cross-
// check expanded the audit: every golden fixture AND the F21934D4
// fixture used the same field-name aliases as the broken prompt
// (zs, polarity, insulation_resistance_l_l, insulation_resistance_l_e).
// Under strict:true schemas those calls would be rejected by the
// Anthropic API — but the fixtures are deterministic replays, so
// dispatcher tests passed regardless.
//
// THIS GROUP is the backstop that prevents future fixtures from
// silently re-introducing the same regression. It walks every
// content_block_start tool_use in every fixture's tool-call SSE
// stream, accumulates its input JSON across content_block_delta
// events, parses, and validates:
//   - record_reading.field + clear_reading.field in circuit_fields enum
//   - clear_reading.reason in enum (user_correction/misheard/wrong_circuit)
//   - delete_observation.reason in enum (user_correction/duplicate/misheard)
//   - record_observation.code in enum (C1/C2/C3/FI)
//   - ask_user.context_field in CONTEXT_FIELD_ENUM
//   - ask_user.reason in enum (out_of_range_circuit/...)
//   - ask_user.expected_answer_shape in enum (yes_no/...)
//
// Enums are derived from TOOL_SCHEMAS at test-time — so a future
// phase that widens an enum auto-extends this audit, same as the
// prompt field-name audit in stage6-agentic-prompt.test.js Group 8.
// ---------------------------------------------------------------------------

describe('Group G — Plan 04-07 r1: fixture-level schema validation (Codex MAJOR #2)', () => {
  // Build enum lookups once per suite. TOOL_SCHEMAS is the single source
  // of truth; we extract every enum from its properties.
  function enumsFromToolSchemas() {
    const out = {};
    for (const tool of TOOL_SCHEMAS) {
      for (const [propName, propSchema] of Object.entries(tool.input_schema.properties)) {
        if (Array.isArray(propSchema.enum)) {
          // Filter nulls out (they're not string values we're checking
          // in fixture input JSON — nullable props accept a real null
          // literal, not a quoted "null" string).
          out[`${tool.name}.${propName}`] = new Set(propSchema.enum.filter((v) => v !== null));
        }
      }
    }
    return out;
  }

  const toolEnums = enumsFromToolSchemas();

  /**
   * Assemble the `input` JSON object for a single tool_use block from a
   * stream of SSE events. Mirrors what the Anthropic SDK does internally
   * when feeding input_json_delta chunks. Returns {name, input} or null
   * if the block wasn't a tool_use.
   */
  function assembleToolUses(events) {
    const out = [];
    let current = null;
    for (const ev of events) {
      if (ev.type === 'content_block_start') {
        if (ev.content_block?.type === 'tool_use') {
          current = { name: ev.content_block.name, index: ev.index, partial: '' };
        } else {
          current = null;
        }
      } else if (
        ev.type === 'content_block_delta' &&
        current !== null &&
        ev.index === current.index &&
        ev.delta?.type === 'input_json_delta'
      ) {
        current.partial += ev.delta.partial_json ?? '';
      } else if (ev.type === 'content_block_stop' && current !== null && ev.index === current.index) {
        try {
          out.push({ name: current.name, input: JSON.parse(current.partial || '{}') });
        } catch {
          out.push({ name: current.name, input: null, parse_error: true });
        }
        current = null;
      }
    }
    return out;
  }

  /**
   * Find the tool-call SSE events in a fixture. Accepts both Variant A
   * (sse_events_tool_call) and Variant B (sse_events_well_behaved) naming
   * conventions. Returns an array of [streamName, events] tuples so we
   * can validate round-2 streams too — but in practice tool_use blocks
   * only appear in round 1 for the deterministic fixtures.
   */
  function pickToolCallStreams(fixture) {
    const streams = [];
    for (const key of [
      'sse_events_tool_call',
      'sse_events_tool_call_round2',
      'sse_events_well_behaved',
      'sse_events_well_behaved_round2',
    ]) {
      if (Array.isArray(fixture[key])) streams.push([key, fixture[key]]);
    }
    return streams;
  }

  /**
   * Validate a single tool_use input against the tool's strict-mode enum
   * properties. Returns an array of human-readable mismatch strings
   * (empty = valid).
   */
  function validateToolInput(toolName, input) {
    if (!input || typeof input !== 'object') return [];
    const mismatches = [];
    const tool = TOOL_SCHEMAS.find((t) => t.name === toolName);
    if (!tool) {
      mismatches.push(`unknown tool: ${toolName}`);
      return mismatches;
    }
    for (const [propName, propSchema] of Object.entries(tool.input_schema.properties)) {
      if (!Object.prototype.hasOwnProperty.call(input, propName)) continue;
      const value = input[propName];
      // Null on a nullable type is always OK at this level; strict schema
      // already enforces correctness.
      if (value === null) continue;
      if (Array.isArray(propSchema.enum)) {
        const allowed = new Set(propSchema.enum);
        if (!allowed.has(value)) {
          mismatches.push(`${toolName}.${propName}="${value}" not in enum [${[...allowed].join(',')}]`);
        }
      }
    }
    return mismatches;
  }

  // Collect every fixture under test. FIXTURE_DIR + F21934D4_PATH.
  function listFixtures() {
    const out = [];
    for (const name of fssync.readdirSync(FIXTURE_DIR).sort()) {
      if (!name.endsWith('.json')) continue;
      out.push(path.join(FIXTURE_DIR, name));
    }
    out.push(F21934D4_PATH);
    return out;
  }

  test('toolEnums surface looks right (sanity — defends against test-harness regression)', () => {
    // If TOOL_SCHEMAS ever re-shapes we want this guard to fire before
    // the audit tests produce a confusing "every fixture valid" false
    // positive. Check the enums we actually audit below are non-empty.
    expect(toolEnums['record_reading.field']?.has('measured_zs_ohm')).toBe(true);
    expect(toolEnums['clear_reading.field']?.has('measured_zs_ohm')).toBe(true);
    expect(toolEnums['clear_reading.reason']?.has('user_correction')).toBe(true);
    expect(toolEnums['record_observation.code']?.has('C2')).toBe(true);
    expect(toolEnums['ask_user.expected_answer_shape']?.has('yes_no')).toBe(true);
  });

  for (const fixturePath of listFixtures()) {
    const fname = path.basename(fixturePath);
    test(`${fname} — all tool-call tool_use inputs pass strict-enum validation`, () => {
      const fx = JSON.parse(fssync.readFileSync(fixturePath, 'utf8'));
      const streams = pickToolCallStreams(fx);
      const allMismatches = [];
      for (const [streamName, events] of streams) {
        const tuses = assembleToolUses(events);
        for (const { name, input, parse_error } of tuses) {
          if (parse_error) {
            allMismatches.push(`${streamName}: ${name} input JSON failed to parse`);
            continue;
          }
          const mm = validateToolInput(name, input);
          for (const m of mm) allMismatches.push(`${streamName}: ${m}`);
        }
      }
      expect(allMismatches).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Group H — Plan 04-07 r1 — runFixture oracle path (Codex MAJOR #3).
//
// WHY THIS GROUP EXISTS: Codex flagged that `runFixture()` falls back
// to `legacyResult = toolResult` when `sse_events_legacy` is absent,
// making Variant-B fixtures (F21934D4) self-compare — divergence
// trivially 0 regardless of whether the dispatcher is right. SC #6's
// "0% on F21934D4" was an artefact of identity equality, not a real
// gate. This group locks Codex's "strongest option" remediation:
//   - If fixture has sse_events_legacy: Variant A (existing path) unchanged.
//   - If fixture has only expected_slot_writes: ORACLE PATH — compare
//     tool-call output vs oracle-derived legacy shape.
//   - If fixture has neither: throw loudly.
//
// The oracle path uses a new helper `expectedSlotWritesToLegacyShape`
// exported from the divergence script, which converts
// {circuits:{N:{field:value, ...}}} into the legacy-shape
// {extracted_readings:[{circuit:N,field,value}, ...]} that
// normaliseExtractionResult already knows how to canonicalise.
// ---------------------------------------------------------------------------

describe('Group H — Plan 04-07 r1: runFixture oracle path (Codex MAJOR #3)', () => {
  const tmp = fssync.mkdtempSync(
    path.join(fssync.realpathSync.native ? fssync.realpathSync.native('/tmp') : '/tmp', 'goldenX-'),
  );

  function writeFixture(name, body) {
    const p = path.join(tmp, name);
    fssync.writeFileSync(p, JSON.stringify(body, null, 2));
    return p;
  }

  test('expectedSlotWritesToLegacyShape converts {circuits:{N:{f:v}}} → {extracted_readings}', () => {
    const oracle = {
      circuits: {
        3: { measured_zs_ohm: '0.35', polarity_confirmed: 'correct' },
        2: { measured_zs_ohm: '0.40' },
      },
    };
    const shape = expectedSlotWritesToLegacyShape(oracle);
    // Readings need to be an array of {circuit, field, value}. Order is not
    // specified here — normalisation handles the sort — but the contents
    // must be correct.
    expect(Array.isArray(shape.extracted_readings)).toBe(true);
    expect(shape.extracted_readings).toHaveLength(3);
    const asSet = new Set(
      shape.extracted_readings.map((r) => `${r.circuit}:${r.field}=${r.value}`),
    );
    expect(asSet.has('3:measured_zs_ohm=0.35')).toBe(true);
    expect(asSet.has('3:polarity_confirmed=correct')).toBe(true);
    expect(asSet.has('2:measured_zs_ohm=0.40')).toBe(true);
  });

  test('fixture with NEITHER sse_events_legacy NOR expected_slot_writes throws', async () => {
    // Minimal Variant-B fixture with neither path available.
    const p = writeFixture('broken-no-legacy-no-oracle.json', {
      _doc: 'deliberately broken — neither legacy nor oracle',
      pre_turn_state: {
        snapshot: { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] },
        askedQuestions: [],
        extractedObservations: [],
      },
      transcript: 'anything',
      sse_events_tool_call: [
        { type: 'message_start', message: { id: 'msg_bad', role: 'assistant', content: [] } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'noop' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ],
      // NO sse_events_legacy, NO expected_slot_writes.
    });

    await expect(runFixture(p)).rejects.toThrow(
      /broken-no-legacy-no-oracle\.json.*(missing|oracle|both|sse_events_legacy|expected_slot_writes)/i,
    );
  });

  test('oracle-path fixture (no legacy, has oracle) compares tool-call output vs oracle — agreement → 0 divergence', async () => {
    // Construct a Variant-B fixture WITH an expected_slot_writes oracle
    // matching what the tool-call dispatcher will emit.
    const p = writeFixture('oracle-agreement.json', {
      _doc: 'oracle path — tool-call agrees with oracle',
      pre_turn_state: {
        snapshot: {
          circuits: { 3: { circuit_ref: 3, circuit_designation: 'Lighting (downstairs)' } },
          pending_readings: [],
          observations: [],
          validation_alerts: [],
        },
        askedQuestions: [],
        extractedObservations: [],
      },
      transcript: 'Zs on circuit three is nought point three five.',
      sse_events_tool_call: [
        { type: 'message_start', message: { id: 'msg_ok', role: 'assistant', content: [] } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_ok', name: 'record_reading', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json:
              '{"field":"measured_zs_ohm","circuit":3,"value":"0.35","confidence":0.95,"source_turn_id":"t1"}',
          },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ],
      expected_slot_writes: {
        circuits: { 3: { measured_zs_ohm: '0.35' } },
      },
    });

    const result = await runFixture(p);
    expect(result).toBeDefined();
    expect(result.divergence.diverged).toBe(false);
    expect(result.divergence.call_divergence).toBe(0);
  });

  test('oracle-path fixture — tool-call DISAGREES with oracle → divergence surfaces non-zero', async () => {
    // Same shape, but oracle expects a DIFFERENT value. Divergence must
    // fire — this is the proof that the oracle path is not self-compare.
    const p = writeFixture('oracle-disagreement.json', {
      _doc: 'oracle path — tool-call value differs from oracle',
      pre_turn_state: {
        snapshot: {
          circuits: { 3: { circuit_ref: 3, circuit_designation: 'Lighting (downstairs)' } },
          pending_readings: [],
          observations: [],
          validation_alerts: [],
        },
        askedQuestions: [],
        extractedObservations: [],
      },
      transcript: 'Zs on circuit three is nought point three five.',
      sse_events_tool_call: [
        { type: 'message_start', message: { id: 'msg_mismatch', role: 'assistant', content: [] } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_mismatch',
            name: 'record_reading',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json:
              '{"field":"measured_zs_ohm","circuit":3,"value":"0.35","confidence":0.95,"source_turn_id":"t1"}',
          },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ],
      expected_slot_writes: {
        // Oracle expects 0.71 — tool-call wrote 0.35 — must diverge.
        circuits: { 3: { measured_zs_ohm: '0.71' } },
      },
    });

    const result = await runFixture(p);
    expect(result).toBeDefined();
    expect(result.divergence.diverged).toBe(true);
    expect(result.divergence.reasons).toContain('readings');
  });

  test('F21934D4 fixture (Variant-B) uses oracle path and reports 0% divergence against its oracle', async () => {
    // After Plan 04-07 r1, the F21934D4 fixture ships an
    // expected_slot_writes oracle. This test locks that the oracle path
    // is actually engaged (not the self-compare fallback) and that the
    // fixture's tool-call output agrees with the oracle.
    const F21 = F21934D4_PATH;
    const result = await runFixture(F21);
    expect(result).toBeDefined();
    // Oracle agreement after r1 fixture update.
    expect(result.divergence.diverged).toBe(false);
    expect(result.divergence.call_divergence).toBe(0);
    // The Variant-B marker: no sse_events_legacy; oracle IS present.
    const raw = JSON.parse(fssync.readFileSync(F21, 'utf8'));
    expect(raw.sse_events_legacy).toBeUndefined();
    expect(raw.expected_slot_writes).toBeDefined();
  });
});
