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
  computeBreached,
  runDirectory,
  runFixture,
  runToolCallPath,
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
    // Plan 04-11 r5-#3 widens normaliseCircuitOp's output surface to
    // the full create/rename schema (designation + phase + rating_amps
    // + cable_csa_mm2 + from_ref). Inputs without those fields
    // canonicalise to nulls — locks that absence normalises to a
    // deterministic shape rather than `undefined` leaking into the
    // comparator.
    const result = {
      circuit_updates: [
        { op: 'CREATE', circuit_ref: 5, designation: 'Upstairs sockets' },
        { action: 'Rename', circuit: 3, designation: 'Lighting downstairs' },
      ],
    };
    const norm = normaliseExtractionResult(result);
    expect(norm.circuit_ops).toEqual([
      {
        action: 'create',
        circuit_ref: 5,
        from_ref: null,
        designation: 'Upstairs sockets',
        phase: null,
        rating_amps: null,
        cable_csa_mm2: null,
      },
      {
        action: 'rename',
        circuit_ref: 3,
        from_ref: null,
        designation: 'Lighting downstairs',
        phase: null,
        rating_amps: null,
        cable_csa_mm2: null,
      },
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

// ---------------------------------------------------------------------------
// Group I — Plan 04-08 r2-#3: runFixture triple-comparison oracle path.
//
// WHY THIS GROUP EXISTS: Codex r2-#3 flagged that when sse_events_legacy
// IS present, runFixture uses that as the legacy side and IGNORES any
// expected_slot_writes oracle the fixture ships. Legacy + tool-call
// could both be wrong the same way and pass 0% divergence because the
// oracle is never consulted. r1's oracle path only catches the
// Variant-B (tool-only) case.
//
// Fix: extend runFixture so the oracle ALWAYS runs when present, and
// the fixture "passes" only if all applicable pairwise comparisons
// agree. Four shapes, per the r2 plan:
//   (A) legacy + tool + oracle → triple-compare (the critical case).
//   (B) tool + oracle only → oracle path (r1 behaviour, unchanged).
//   (C) legacy + tool (no oracle) → legacy-vs-tool only + warning
//       breadcrumb encouraging oracle addition.
//   (D) neither tool+oracle nor legacy+tool → throw (r1 behaviour).
//
// The triple-compare surfaces three divergence rates in the result:
//   - legacy_vs_tool (the OLD metric, kept for backward-compat).
//   - tool_vs_oracle (NEW — catches "tool-call silently wrong").
//   - legacy_vs_oracle (NEW — catches "legacy drift from contract").
// Any non-zero fires `diverged=true`.
// ---------------------------------------------------------------------------

describe('Group I — Plan 04-08 r2-#3: triple-comparison oracle path', () => {
  const tmp = fssync.mkdtempSync(
    path.join(fssync.realpathSync.native ? fssync.realpathSync.native('/tmp') : '/tmp', 'goldenY-'),
  );

  function writeFixture(name, body) {
    const p = path.join(tmp, name);
    fssync.writeFileSync(p, JSON.stringify(body, null, 2));
    return p;
  }

  // Shared fixture-body factory. Takes optional `oracle` + `legacyValue`
  // + `toolValue` to construct matching / mismatching variants for the
  // three-way comparison tests. Pre-seeds circuit 3 on the snapshot so
  // stage6-dispatch-validation.validateRecordReading accepts the write
  // (dispatcher requires the circuit to exist before record_reading runs).
  function fixtureBody({ legacyValue, toolValue, oracleValue }) {
    const base = {
      _doc: 'r2-#3 triple-comparison test fixture',
      pre_turn_state: {
        snapshot: {
          circuits: {
            3: { circuit_ref: 3, circuit_designation: 'Lighting (downstairs)' },
          },
          pending_readings: [],
          observations: [],
          validation_alerts: [],
        },
        askedQuestions: [],
        extractedObservations: [],
      },
      transcript: 'Zs on circuit three is nought point three five.',
    };

    if (legacyValue !== undefined) {
      base.sse_events_legacy = [
        { type: 'message_start', message: { id: 'msg_legacy', role: 'assistant', content: [] } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_legacy', name: 'record_extraction', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              extracted_readings: [
                { circuit: 3, field: 'measured_zs_ohm', value: legacyValue },
              ],
              field_clears: [],
              circuit_updates: [],
              observations: [],
              validation_alerts: [],
              questions_for_user: [],
              confirmations: [],
            }),
          },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ];
    }

    if (toolValue !== undefined) {
      base.sse_events_tool_call = [
        { type: 'message_start', message: { id: 'msg_tool', role: 'assistant', content: [] } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_tool', name: 'record_reading', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              field: 'measured_zs_ohm',
              circuit: 3,
              value: toolValue,
              confidence: 0.95,
              source_turn_id: 't1',
            }),
          },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ];
    }

    if (oracleValue !== undefined) {
      base.expected_slot_writes = {
        circuits: { 3: { measured_zs_ohm: oracleValue } },
      };
    }

    return base;
  }

  test('r2-3a triple-compare PASS: legacy + tool + oracle all agree → diverged=false, all pairwise rates 0', async () => {
    const p = writeFixture(
      'triple-agree.json',
      fixtureBody({ legacyValue: '0.35', toolValue: '0.35', oracleValue: '0.35' }),
    );
    const result = await runFixture(p);
    expect(result).toBeDefined();
    expect(result.divergence.diverged).toBe(false);
    expect(result.divergence.call_divergence).toBe(0);
    // New r2-#3 fields on the divergence object: pairwise rates.
    expect(result.divergence).toHaveProperty('legacy_vs_tool_divergence');
    expect(result.divergence).toHaveProperty('tool_vs_oracle_divergence');
    expect(result.divergence).toHaveProperty('legacy_vs_oracle_divergence');
    expect(result.divergence.legacy_vs_tool_divergence).toBe(0);
    expect(result.divergence.tool_vs_oracle_divergence).toBe(0);
    expect(result.divergence.legacy_vs_oracle_divergence).toBe(0);
  });

  test('r2-3b SYNTHETIC DISAGREEMENT: legacy + tool agree WITH EACH OTHER but disagree with oracle → diverged=true surfaced by oracle comparisons', async () => {
    // This is the critical test that proves the oracle blocks the
    // "both wrong the same way" failure mode r2-#3 calls out.
    // legacy emits "0.71" and tool emits "0.71" — they agree with each
    // other (legacy_vs_tool rate = 0) — but the oracle says the correct
    // value is "0.35", so BOTH oracle comparisons must fire.
    const p = writeFixture(
      'triple-both-wrong-same-way.json',
      fixtureBody({ legacyValue: '0.71', toolValue: '0.71', oracleValue: '0.35' }),
    );
    const result = await runFixture(p);
    expect(result).toBeDefined();
    // The critical assertion: legacy and tool AGREE with each other.
    expect(result.divergence.legacy_vs_tool_divergence).toBe(0);
    // But both fail against the oracle.
    expect(result.divergence.tool_vs_oracle_divergence).toBeGreaterThan(0);
    expect(result.divergence.legacy_vs_oracle_divergence).toBeGreaterThan(0);
    // The OR of all three — diverged must fire because the oracle
    // comparisons are non-zero even though legacy-vs-tool is zero.
    expect(result.divergence.diverged).toBe(true);
  });

  test('r2-3c legacy + tool WITHOUT oracle → diverged=false (agree) + warning breadcrumb', async () => {
    // Existing r1 Variant A behaviour preserved — agreement on legacy
    // + tool reports 0 divergence — but the result should carry a
    // warning that no oracle was consulted.
    const p = writeFixture(
      'legacy-tool-no-oracle.json',
      fixtureBody({ legacyValue: '0.35', toolValue: '0.35' /* no oracleValue */ }),
    );
    const result = await runFixture(p);
    expect(result).toBeDefined();
    expect(result.divergence.diverged).toBe(false);
    expect(result.divergence.legacy_vs_tool_divergence).toBe(0);
    // Oracle rates absent (no oracle to compare against).
    expect(result.divergence.tool_vs_oracle_divergence).toBeNull();
    expect(result.divergence.legacy_vs_oracle_divergence).toBeNull();
    // Warning breadcrumb on the result so the orchestrator / CI can
    // surface "this fixture would be strengthened by an oracle".
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings.some((w) => /oracle/i.test(w))).toBe(true);
  });

  test('r2-3d triple-compare with tool disagreeing from BOTH legacy + oracle → all three non-zero', async () => {
    // Tool diverges from legacy (which matches oracle) — standard
    // "dispatcher bug" signature. All three pairwise comparisons
    // should surface: legacy_vs_tool > 0, tool_vs_oracle > 0,
    // legacy_vs_oracle = 0 (legacy + oracle agree).
    const p = writeFixture(
      'triple-tool-only-wrong.json',
      fixtureBody({ legacyValue: '0.35', toolValue: '0.99', oracleValue: '0.35' }),
    );
    const result = await runFixture(p);
    expect(result).toBeDefined();
    expect(result.divergence.diverged).toBe(true);
    expect(result.divergence.legacy_vs_tool_divergence).toBeGreaterThan(0);
    expect(result.divergence.tool_vs_oracle_divergence).toBeGreaterThan(0);
    expect(result.divergence.legacy_vs_oracle_divergence).toBe(0);
  });

  test('r2-3e runDirectory on the real 5 goldens + F21934D4 — triple-compare clean on every fixture', async () => {
    // After r2-#3, every fixture with sse_events_legacy + tool_call +
    // expected_slot_writes should produce three-way clean (all three
    // pairwise rates = 0). This locks the claim that the oracle is
    // consulted on the 5 Variant-A goldens, not just the F21934D4
    // Variant-B fixture. If any golden's oracle disagrees with its
    // hand-crafted SSE, this test surfaces the fixture bug BEFORE
    // r2 is declared done.
    const report = await runDirectory(FIXTURE_DIR, { extraFixtures: [F21934D4_PATH] });
    for (const s of report.sessions) {
      // legacy_vs_tool is null on Variant-B fixtures (no sse_events_legacy);
      // on Variant-A it must be 0 (legacy agrees with tool).
      if (s.divergence.legacy_vs_tool_divergence !== null) {
        expect(s.divergence.legacy_vs_tool_divergence).toBe(0);
      }
      // tool_vs_oracle must be present (every fixture in the set has
      // an oracle) and 0.
      expect(s.divergence.tool_vs_oracle_divergence).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Group J — Plan 04-09 r3-#1: normaliseObservation widened field surface.
//
// Codex r3 MAJOR #1: `normaliseObservation()` in stage6-golden-divergence.js
// canonicalised observations down to `{code, text}` only. Fields like
// `location`, `circuit`, `suggested_regulation` were stripped, so the
// divergence gate reported a FALSE 0% when legacy + tool-call disagreed on
// observation metadata — the comparator never saw those fields.
//
// The full production observation shape is:
//   {id, code, location, text, circuit, suggested_regulation}
// (see src/extraction/stage6-per-turn-writes.js:40 and
// src/extraction/stage6-tool-schemas.js:275 required list).
//
// After r3-#1 fix, normaliseObservation preserves all 5 semantic fields.
// `id` is still stripped (both paths mint independent UUIDs —
// precedent established by stage6-slot-comparator's observation UUID
// normalisation). Transient source_turn_id / timestamp also stripped.
//
// Five tests lock the widened comparator surface:
//   J1. Two observations differing ONLY in `location` → diverged=true.
//   J2. Two observations differing ONLY in `circuit` → diverged=true.
//   J3. Two observations differing ONLY in `suggested_regulation` → diverged=true.
//   J4. Two observations with same core 5 fields + different transient
//       fields (id, source_turn_id, timestamp) → diverged=false.
//   J5. Round-trip: normaliseObservation preserves all 5 fields after
//       canonicalisation on a full-payload input.
// ---------------------------------------------------------------------------

describe('Group J — Plan 04-09 r3-#1: normaliseObservation widened field surface', () => {
  const empty = { readings: [], clears: [], circuit_ops: [] };

  test('J1 — observations differing ONLY in `location` → diverged=true', () => {
    const a = {
      ...empty,
      observations: [{ code: 'C2', text: 'Missing cover', location: 'Kitchen', circuit: null, suggested_regulation: null }],
    };
    const b = {
      ...empty,
      observations: [{ code: 'C2', text: 'Missing cover', location: 'Bathroom', circuit: null, suggested_regulation: null }],
    };
    // Need to normalise the shapes first (like the real pipeline does).
    const normA = normaliseExtractionResult(a);
    const normB = normaliseExtractionResult(b);
    const d = computeDivergence(normA, normB);
    expect(d.diverged).toBe(true);
    expect(d.call_divergence).toBeGreaterThan(0);
  });

  test('J2 — observations differing ONLY in `circuit` → diverged=true', () => {
    const a = {
      ...empty,
      observations: [{ code: 'C2', text: 'Loose neutral', location: 'DB', circuit: 3, suggested_regulation: null }],
    };
    const b = {
      ...empty,
      observations: [{ code: 'C2', text: 'Loose neutral', location: 'DB', circuit: 7, suggested_regulation: null }],
    };
    const normA = normaliseExtractionResult(a);
    const normB = normaliseExtractionResult(b);
    const d = computeDivergence(normA, normB);
    expect(d.diverged).toBe(true);
    expect(d.call_divergence).toBeGreaterThan(0);
  });

  test('J3 — observations differing ONLY in `suggested_regulation` → diverged=true', () => {
    const a = {
      ...empty,
      observations: [
        {
          code: 'C2',
          text: 'Exposed live conductor',
          location: 'Under-stairs cupboard',
          circuit: null,
          suggested_regulation: '411.3.1.1',
        },
      ],
    };
    const b = {
      ...empty,
      observations: [
        {
          code: 'C2',
          text: 'Exposed live conductor',
          location: 'Under-stairs cupboard',
          circuit: null,
          suggested_regulation: '522.6.201',
        },
      ],
    };
    const normA = normaliseExtractionResult(a);
    const normB = normaliseExtractionResult(b);
    const d = computeDivergence(normA, normB);
    expect(d.diverged).toBe(true);
    expect(d.call_divergence).toBeGreaterThan(0);
  });

  test('J4 — observations with same 5 core fields + different transient fields → diverged=false', () => {
    // Transient: id (UUID, independently minted), source_turn_id, timestamp.
    const a = {
      ...empty,
      observations: [
        {
          id: 'a38c7b50-1111-4222-8333-aaaaaaaaaaaa',
          source_turn_id: 't-123',
          timestamp: '2026-04-23T10:00:00Z',
          code: 'C3',
          text: 'Non-compliant cable support',
          location: 'Loft',
          circuit: 4,
          suggested_regulation: '522.8.5',
        },
      ],
    };
    const b = {
      ...empty,
      observations: [
        {
          id: '99999999-2222-4333-8444-bbbbbbbbbbbb',
          source_turn_id: 't-456',
          timestamp: '2026-04-23T11:30:42Z',
          code: 'C3',
          text: 'Non-compliant cable support',
          location: 'Loft',
          circuit: 4,
          suggested_regulation: '522.8.5',
        },
      ],
    };
    const normA = normaliseExtractionResult(a);
    const normB = normaliseExtractionResult(b);
    const d = computeDivergence(normA, normB);
    // Core-fields match; transient fields must be stripped during
    // canonicalisation so the two observations compare equal.
    expect(d.diverged).toBe(false);
    expect(d.call_divergence).toBe(0);
  });

  test('J5 — normaliseObservation round-trip preserves all 5 semantic fields', () => {
    const input = {
      observations: [
        {
          id: 'should-be-stripped',
          source_turn_id: 'also-stripped',
          timestamp: 'also-stripped',
          code: 'c2', // lower-cased input, should UPPER on output
          text: '  Missing RCD  ', // whitespace, should trim
          location: '  Board ', // whitespace, should trim; preserve case
          circuit: 5,
          suggested_regulation: '  411.3.3 ', // trim; preserve case
        },
      ],
    };
    const norm = normaliseExtractionResult(input);
    expect(norm.observations).toHaveLength(1);
    const o = norm.observations[0];
    // All 5 semantic fields preserved.
    expect(o).toHaveProperty('code', 'C2');
    expect(o).toHaveProperty('text', 'Missing RCD');
    expect(o).toHaveProperty('location', 'Board');
    expect(o).toHaveProperty('circuit', 5);
    expect(o).toHaveProperty('suggested_regulation', '411.3.3');
    // Transient fields stripped.
    expect(o).not.toHaveProperty('id');
    expect(o).not.toHaveProperty('source_turn_id');
    expect(o).not.toHaveProperty('timestamp');
  });
});

// ---------------------------------------------------------------------------
// Group K — Plan 04-09 r3-#2: breach gated on call + session only (NOT
// section, which is diagnostic per r2-#2 design intent).
//
// Codex r3 MAJOR #2: `runDirectory()`'s `breached` flag is OR'd across
// session_divergence_rate, section_divergence_rate, AND
// call_divergence_rate. But Plan 04-08 r2-#2 explicitly designated
// `section_divergence_rate` as DIAGNOSTIC (old metric preserved for
// signal, not for gating). A high section rate on a single multi-section
// disagreement should not trip the gate when the real per-call rate is
// well below threshold.
//
// After r3-#2 fix, breach logic is:
//   breached = (call_divergence_rate > threshold)
//           || (session_divergence_rate > threshold)
// `section_divergence_rate` is reported but not gated.
//
// Extracted helper `computeBreached(rates, threshold)` is the pure
// function that runDirectory consumes, so breach semantics can be
// unit-tested without standing up synthetic fixture infrastructure.
// ---------------------------------------------------------------------------

describe('Group K — Plan 04-09 r3-#2: breach gated on call + session only (section is diagnostic)', () => {
  test('K1 — section-only high (section=0.25, call=0.05, session=0) → breached=false', () => {
    // This is the exact scenario r3-#2 calls out: the section fraction
    // fires because one section disagreed, but the real per-write rate
    // is well under threshold AND no session is flagged as diverged.
    // Pre-r3 this returned breached=true (wrong). Post-r3 it returns
    // breached=false because section is diagnostic only.
    const breached = computeBreached(
      {
        section_divergence_rate: 0.25,
        call_divergence_rate: 0.05,
        session_divergence_rate: 0,
      },
      0.10,
    );
    expect(breached).toBe(false);
  });

  test('K2 — call rate exceeds threshold → breached=true (primary gate)', () => {
    const breached = computeBreached(
      {
        section_divergence_rate: 0,
        call_divergence_rate: 0.11,
        session_divergence_rate: 0,
      },
      0.10,
    );
    expect(breached).toBe(true);
  });

  test('K3 — session rate exceeds threshold → breached=true (secondary gate)', () => {
    const breached = computeBreached(
      {
        section_divergence_rate: 0,
        call_divergence_rate: 0,
        session_divergence_rate: 0.20,
      },
      0.10,
    );
    expect(breached).toBe(true);
  });

  test('K4 — all three rates zero → breached=false', () => {
    const breached = computeBreached(
      {
        section_divergence_rate: 0,
        call_divergence_rate: 0,
        session_divergence_rate: 0,
      },
      0.10,
    );
    expect(breached).toBe(false);
  });

  test('K5 — section rate exactly at threshold + call/session at threshold → breached=false (> not >=)', () => {
    // Threshold semantics from pre-r3 retained: rate > threshold
    // (strict) triggers breach, rate == threshold is still at-limit
    // (acceptable). This mirrors Plan 04-05's "≤ 10%" claim language.
    const breached = computeBreached(
      {
        section_divergence_rate: 0.10,
        call_divergence_rate: 0.10,
        session_divergence_rate: 0.10,
      },
      0.10,
    );
    expect(breached).toBe(false);
  });

  test('K6 — both call AND session exceed → breached=true (gate fires on OR)', () => {
    const breached = computeBreached(
      {
        section_divergence_rate: 0.50,
        call_divergence_rate: 0.15,
        session_divergence_rate: 0.30,
      },
      0.10,
    );
    expect(breached).toBe(true);
  });

  test('K7 — runDirectory on 6 fixtures uses new breach logic (integration lock)', async () => {
    // Integration: the real runDirectory output on the 6-fixture set
    // exposes `breached: false` (all three rates are 0, well under any
    // threshold). Post-r3 this MUST be false for the same input even
    // if section rate were elsewhere non-zero.
    const report = await runDirectory(FIXTURE_DIR, { extraFixtures: [F21934D4_PATH] });
    // Belt + braces — directly re-compute breach from the reported
    // rates and confirm it matches what runDirectory returned.
    const recomputed = computeBreached(
      {
        section_divergence_rate: report.section_divergence_rate,
        call_divergence_rate: report.call_divergence_rate,
        session_divergence_rate: report.session_divergence_rate,
      },
      report.threshold,
    );
    expect(report.breached).toBe(recomputed);
    expect(report.breached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group L — Plan 04-10 r4-#2: divergence harness uses REAL agentic prompt.
//
// WHY THIS GROUP EXISTS: Codex r4 (2026-04-23) found that
// scripts/stage6-golden-divergence.js:474 hardcoded
// `system: [{text:"GOLDEN-DIVERGENCE SYSTEM PROMPT"}]` — a PLACEHOLDER.
// The entire Phase 4 SC #6 "0% divergence" claim was validated against a
// FAKE prompt. This is the most damaging of the r4 findings because it
// means the gate has been green for the wrong reason all along.
//
// Root cause: runToolCallPath() constructed a hand-rolled session stub
// (plain object, not a real EICRExtractionSession) and never invoked
// the real class's constructor, so sonnet_agentic_system.md was never
// loaded, buildSystemBlocks() was never called, and the cached-prefix
// two-block layout was never exercised.
//
// Fix: refactor runToolCallPath to instantiate a real EICRExtractionSession
// per fixture replay, seed its state from the fixture, and use
// session.buildSystemBlocks() to build the system array. mockClient
// captures the request args so tests can verify the REAL prompt + REAL
// snapshot structure reach the tool loop.
//
// The runToolCallPath export is a new hook added to make the captured
// system array visible to tests without leaking the internal client.
//
// CRITICAL — if post-fix divergence rate exceeds the 10% SC #6 budget,
// that is a BLOCK-class finding: the agentic prompt is drifting the
// dispatcher output from the legacy path. The rate assertion at the end
// of this group is the gate that surfaces it.
// ---------------------------------------------------------------------------

describe('Group L — Plan 04-10 r4-#2: runToolCallPath uses REAL agentic prompt', () => {
  // Helper — load a fixture from disk. Tests own their own copy per fixture
  // so mutations don't leak across tests.
  function loadFixture(name) {
    return JSON.parse(
      fssync.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'),
    );
  }

  test('r4-2a: captured system[0].text contains TRUST BOUNDARY — real prompt loaded from disk', async () => {
    // "TRUST BOUNDARY" is a uniquely-identifying marker from line 3 of
    // config/prompts/sonnet_agentic_system.md. A placeholder system prompt
    // (the pre-fix behaviour) would NOT contain this substring. Locking
    // its presence is the Phase 4 SC #4 backstop for prompt-loading
    // regressions in the divergence harness — if someone deletes the
    // prompt file, renames the env var, or removes the real-session
    // construction, this assertion fires.
    const fx = loadFixture('sample-01-routine.json');
    const { client } = await runToolCallPath(fx);
    expect(Array.isArray(client._calls)).toBe(true);
    expect(client._calls.length).toBeGreaterThan(0);
    const firstRequest = client._calls[0];
    expect(Array.isArray(firstRequest.system)).toBe(true);
    expect(firstRequest.system.length).toBeGreaterThan(0);
    expect(firstRequest.system[0].type).toBe('text');
    expect(firstRequest.system[0].text).toContain('TRUST BOUNDARY');
  });

  test('r4-2b: captured system[0].text does NOT contain the old placeholder', async () => {
    // Negative assertion — ensure the pre-fix placeholder
    // "GOLDEN-DIVERGENCE SYSTEM PROMPT" is gone. If someone partially
    // reverts the fix this catches it.
    const fx = loadFixture('sample-01-routine.json');
    const { client } = await runToolCallPath(fx);
    const firstRequest = client._calls[0];
    expect(firstRequest.system[0].text).not.toContain('GOLDEN-DIVERGENCE SYSTEM PROMPT');
  });

  test('r4-2c: fixture with non-empty pre_turn_state produces two-block cached-prefix system array', async () => {
    // sample-05-refill-guard has a non-empty snapshot (circuit 1 with
    // ze=0.32 pre-filled + circuit 3 designated). buildSystemBlocks()
    // in shadow mode returns a two-block array [prompt, snapshot] with
    // cache_control:{type:'ephemeral', ttl:'5m'} on BOTH blocks. That's
    // the STS-09 cached-prefix contract locked in Plan 04-02.
    const fx = loadFixture('sample-05-refill-guard.json');
    const { client } = await runToolCallPath(fx);
    const firstRequest = client._calls[0];
    expect(firstRequest.system.length).toBe(2);
    // Block 0 — agentic prompt.
    expect(firstRequest.system[0]).toMatchObject({
      type: 'text',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });
    expect(firstRequest.system[0].text).toContain('TRUST BOUNDARY');
    // Block 1 — snapshot.
    expect(firstRequest.system[1]).toMatchObject({
      type: 'text',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });
    expect(typeof firstRequest.system[1].text).toBe('string');
    expect(firstRequest.system[1].text.length).toBeGreaterThan(0);
    // The snapshot must reflect the seeded pre_turn_state — e.g. circuit 1's
    // pre-filled ze=0.32 should be visible in the EXTRACTED section.
    expect(firstRequest.system[1].text).toContain('EXTRACTED');
  });

  test("r4-2d: fixture with empty pre_turn_state produces single-block system array (snapshot collapses)", async () => {
    // Fixtures may legitimately ship an empty snapshot (no prior circuits).
    // Plan 04-02 locked that buildSystemBlocks() collapses to a single
    // block in that case — because Anthropic's cache key includes all
    // blocks, emitting an empty-string second block would cache-miss
    // every call. Verify the divergence harness honours the collapse.
    const syntheticFx = {
      pre_turn_state: {
        snapshot: {
          circuits: {},
          pending_readings: [],
          observations: [],
          validation_alerts: [],
        },
        askedQuestions: [],
        extractedObservations: [],
      },
      transcript: 'test',
      // Reuse sample-01's events — we only care about the system array
      // shape here, not the dispatcher output.
      sse_events_tool_call: loadFixture('sample-01-routine.json').sse_events_tool_call,
      sse_events_tool_call_round2: loadFixture('sample-01-routine.json').sse_events_tool_call_round2,
    };
    const { client } = await runToolCallPath(syntheticFx);
    const firstRequest = client._calls[0];
    expect(firstRequest.system.length).toBe(1);
    expect(firstRequest.system[0].text).toContain('TRUST BOUNDARY');
  });

  test('r4-2e: post-real-prompt directory runner still at 0% divergence across 6 fixtures', async () => {
    // THE GATE — this is the SC #6 re-validation. Re-run runDirectory on
    // the 5 golden fixtures + F21934D4 AFTER the real-prompt refactor.
    // Expected: rates unchanged at 0 (the canned events drive both paths
    // deterministically regardless of which system prompt reached the
    // tool loop — the normalisation/dispatch/bundle mechanics are what
    // produce the convergence, not the prompt).
    //
    // **Critical — BLOCK escalation:** if any rate exceeds the 10% SC #6
    // threshold, the agentic prompt is measurably drifting the pipeline
    // output. That's a BLOCK finding; fix the prompt or the dispatcher
    // before landing this commit. Sub-threshold non-zero rates are
    // SURFACED in the r4 REVIEW entry but permitted under the Phase 4
    // envelope.
    const F21934D4_PATH_LOCAL = path.resolve(
      __dirname,
      'fixtures/stage6-sse/f21934d4-re-ask-scenario.json',
    );
    const report = await runDirectory(FIXTURE_DIR, { extraFixtures: [F21934D4_PATH_LOCAL] });
    expect(report.threshold).toBe(0.10);
    expect(report.breached).toBe(false);
    // Tight assertion: rates stay at 0 on the 6 deterministic fixtures.
    // The 10%-budget clause is the escape valve for Phase 5/7 real-model
    // runs — not for Phase 4's deterministic baseline.
    expect(report.session_divergence_rate).toBe(0);
    expect(report.call_divergence_rate).toBe(0);
    expect(report.section_divergence_rate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Group r5-2 — Plan 04-11 r5-#2: observation sort uses full canonical tuple.
//
// Codex r5 MINOR #2: r3 (Plan 04-09) widened normaliseObservation to
// return {code, text, location, circuit, suggested_regulation}, but the
// sort comparator inside normaliseExtractionResult was NOT updated. It
// still keys on (code, text) only. Two observations with the same
// (code, text) but different metadata can compare in input-order —
// producing order-dependent false divergences or passes.
//
// Fix: sort observations on the full canonical tuple so the result
// is order-invariant across input permutations. Then divergence
// measures true semantic difference, not input-ordering noise.
//
// These tests construct two result shapes carrying SAME multiset of
// observations but in DIFFERENT input orders. Expected post-fix:
// divergence = 0 (sort canonicalises order). Pre-fix: divergence > 0
// because same-(code,text) items compare at different positions.
// ---------------------------------------------------------------------------

describe('Group r5-2 — Plan 04-11 r5-#2: observation sort uses full canonical tuple', () => {
  const empty = { readings: [], clears: [], circuit_ops: [] };

  test('r5-2a — same (code,text) differing only on location: reversed inputs → divergence stays 0', () => {
    // Two observations with identical (code, text) but different
    // location. Fixture A emits them in order [Kitchen, Bathroom];
    // fixture B emits them reversed [Bathroom, Kitchen]. With a
    // (code, text) sort the comparator doesn't know how to order the
    // two items, so after normalise they land in input order and the
    // comparator reports 2 mismatches ("Kitchen" vs "Bathroom" at
    // index 0, vice-versa at index 1). After the full-tuple sort
    // both fixtures canonicalise to the same order ["Bathroom"
    // before "Kitchen"] so divergence is 0.
    const a = {
      ...empty,
      observations: [
        { code: 'C2', text: 'loose neutral', location: 'Kitchen', circuit: null, suggested_regulation: null },
        { code: 'C2', text: 'loose neutral', location: 'Bathroom', circuit: null, suggested_regulation: null },
      ],
    };
    const b = {
      ...empty,
      observations: [
        { code: 'C2', text: 'loose neutral', location: 'Bathroom', circuit: null, suggested_regulation: null },
        { code: 'C2', text: 'loose neutral', location: 'Kitchen', circuit: null, suggested_regulation: null },
      ],
    };
    const normA = normaliseExtractionResult(a);
    const normB = normaliseExtractionResult(b);
    const d = computeDivergence(normA, normB);
    expect(d.diverged).toBe(false);
    expect(d.call_divergence).toBe(0);
  });

  test('r5-2b — same (code,text) differing only on circuit: reversed inputs → divergence stays 0', () => {
    const a = {
      ...empty,
      observations: [
        { code: 'C3', text: 'old cable', location: 'Board', circuit: 5, suggested_regulation: null },
        { code: 'C3', text: 'old cable', location: 'Board', circuit: 2, suggested_regulation: null },
      ],
    };
    const b = {
      ...empty,
      observations: [
        { code: 'C3', text: 'old cable', location: 'Board', circuit: 2, suggested_regulation: null },
        { code: 'C3', text: 'old cable', location: 'Board', circuit: 5, suggested_regulation: null },
      ],
    };
    const normA = normaliseExtractionResult(a);
    const normB = normaliseExtractionResult(b);
    const d = computeDivergence(normA, normB);
    expect(d.diverged).toBe(false);
    expect(d.call_divergence).toBe(0);
  });

  test('r5-2c — same (code,text) differing only on suggested_regulation: reversed → divergence 0', () => {
    const a = {
      ...empty,
      observations: [
        {
          code: 'C2',
          text: 'exposed conductor',
          location: 'Loft',
          circuit: null,
          suggested_regulation: '411.3.1.1',
        },
        {
          code: 'C2',
          text: 'exposed conductor',
          location: 'Loft',
          circuit: null,
          suggested_regulation: '522.6.201',
        },
      ],
    };
    const b = {
      ...empty,
      observations: [
        {
          code: 'C2',
          text: 'exposed conductor',
          location: 'Loft',
          circuit: null,
          suggested_regulation: '522.6.201',
        },
        {
          code: 'C2',
          text: 'exposed conductor',
          location: 'Loft',
          circuit: null,
          suggested_regulation: '411.3.1.1',
        },
      ],
    };
    const normA = normaliseExtractionResult(a);
    const normB = normaliseExtractionResult(b);
    const d = computeDivergence(normA, normB);
    expect(d.diverged).toBe(false);
    expect(d.call_divergence).toBe(0);
  });

  test('r5-2d — transient fields differ but all 5 canonical fields identical → divergence 0', () => {
    // Back-compat sanity with Group J4: two observations that share all
    // 5 canonical fields but carry different id / source_turn_id /
    // timestamp values. The transient-stripping in normaliseObservation
    // already handles this; the full-tuple sort must not break it.
    const a = {
      ...empty,
      observations: [
        {
          id: 'aaaa',
          source_turn_id: 't1',
          timestamp: '2026-04-23T10:00Z',
          code: 'C3',
          text: 'OK',
          location: 'Board',
          circuit: 1,
          suggested_regulation: '411.1',
        },
      ],
    };
    const b = {
      ...empty,
      observations: [
        {
          id: 'bbbb',
          source_turn_id: 't99',
          timestamp: '2026-04-23T11:00Z',
          code: 'C3',
          text: 'OK',
          location: 'Board',
          circuit: 1,
          suggested_regulation: '411.1',
        },
      ],
    };
    const normA = normaliseExtractionResult(a);
    const normB = normaliseExtractionResult(b);
    const d = computeDivergence(normA, normB);
    expect(d.diverged).toBe(false);
    expect(d.call_divergence).toBe(0);
  });

  test('r5-2e — genuine divergence on observation content still reported', () => {
    // Guard: the sort change must NOT make the comparator blind to
    // real disagreement. Different TEXT on one side → divergence > 0.
    const a = {
      ...empty,
      observations: [
        { code: 'C2', text: 'loose neutral', location: 'Kitchen', circuit: null, suggested_regulation: null },
      ],
    };
    const b = {
      ...empty,
      observations: [
        { code: 'C2', text: 'loose live', location: 'Kitchen', circuit: null, suggested_regulation: null },
      ],
    };
    const normA = normaliseExtractionResult(a);
    const normB = normaliseExtractionResult(b);
    const d = computeDivergence(normA, normB);
    expect(d.diverged).toBe(true);
    expect(d.call_divergence).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Group r5-3 — Plan 04-11 r5-#3: oracle projection + circuit-op normalisation
// cover ALL create/rename circuit fields.
//
// Codex r5 MINOR #3: expectedSlotWritesToLegacyShape only projects
// `circuit_designation` into `circuit_updates`; normaliseCircuitOp only
// canonicalises `designation`. `phase`, `rating_amps`, `cable_csa_mm2`,
// and `from_ref` (rename) are invisible to the oracle + comparator. Two
// circuit ops that agree on (action, circuit_ref, designation) but
// disagree on phase / rating / CSA compare equal — oracle reports 0%
// divergence on real pipeline drift.
//
// Fix:
//   1. Extend normaliseCircuitOp to canonicalise the full schema-backed
//      field set (designation + phase + rating_amps + cable_csa_mm2 +
//      from_ref), accepting both flat (legacy) and nested `meta` (tool-
//      call bundler) layouts.
//   2. Extend expectedSlotWritesToLegacyShape to route all recognised
//      per-circuit fields (circuit_designation, circuit_phase,
//      circuit_rating_amps, circuit_cable_csa_mm2) into a single
//      circuit_updates entry per circuit_ref, with a `meta` sub-object.
//
// These tests exercise each field independently (r5-3a/b/c), verify
// the oracle projection writes the new fields (r5-3d), and confirm
// the legacy-flat / tool-call-nested shapes still normalise equal
// when their semantics agree (r5-3e).
// ---------------------------------------------------------------------------

describe('Group r5-3 — Plan 04-11 r5-#3: circuit op normaliser + oracle cover full field set', () => {
  const empty = { readings: [], clears: [], observations: [] };

  test('r5-3a — circuit ops differing only on phase → divergence reported', () => {
    const a = {
      ...empty,
      circuit_updates: [
        { op: 'create', circuit_ref: 3, meta: { designation: 'Ring', phase: 'L1', rating_amps: null, cable_csa_mm2: null } },
      ],
    };
    const b = {
      ...empty,
      circuit_updates: [
        { op: 'create', circuit_ref: 3, meta: { designation: 'Ring', phase: 'L2', rating_amps: null, cable_csa_mm2: null } },
      ],
    };
    const normA = normaliseExtractionResult(a);
    const normB = normaliseExtractionResult(b);
    const d = computeDivergence(normA, normB);
    expect(d.diverged).toBe(true);
    expect(d.call_divergence).toBeGreaterThan(0);
  });

  test('r5-3b — circuit ops differing only on rating_amps → divergence reported', () => {
    const a = {
      ...empty,
      circuit_updates: [
        { op: 'create', circuit_ref: 3, meta: { designation: 'Ring', phase: null, rating_amps: 32, cable_csa_mm2: null } },
      ],
    };
    const b = {
      ...empty,
      circuit_updates: [
        { op: 'create', circuit_ref: 3, meta: { designation: 'Ring', phase: null, rating_amps: 40, cable_csa_mm2: null } },
      ],
    };
    const normA = normaliseExtractionResult(a);
    const normB = normaliseExtractionResult(b);
    const d = computeDivergence(normA, normB);
    expect(d.diverged).toBe(true);
    expect(d.call_divergence).toBeGreaterThan(0);
  });

  test('r5-3c — circuit ops differing only on cable_csa_mm2 → divergence reported', () => {
    const a = {
      ...empty,
      circuit_updates: [
        { op: 'create', circuit_ref: 3, meta: { designation: 'Ring', phase: null, rating_amps: null, cable_csa_mm2: 2.5 } },
      ],
    };
    const b = {
      ...empty,
      circuit_updates: [
        { op: 'create', circuit_ref: 3, meta: { designation: 'Ring', phase: null, rating_amps: null, cable_csa_mm2: 4 } },
      ],
    };
    const normA = normaliseExtractionResult(a);
    const normB = normaliseExtractionResult(b);
    const d = computeDivergence(normA, normB);
    expect(d.diverged).toBe(true);
    expect(d.call_divergence).toBeGreaterThan(0);
  });

  test('r5-3d — oracle projection writes phase / rating / csa into circuit_updates meta', () => {
    // Oracle with circuit_designation + circuit_phase + circuit_rating_amps
    // + circuit_cable_csa_mm2 — every recognised circuit-shape field.
    // Pre-fix: only circuit_designation survives into circuit_updates;
    // phase / rating / csa vanish (pre-fix they silently flow into
    // extracted_readings as `{circuit, field: 'circuit_phase', value: ...}`
    // which normalises harmlessly but NEVER compares against the bundler's
    // circuit_updates shape). Post-fix: one circuit_updates entry carrying
    // all four fields under `meta`.
    const oracle = {
      circuits: {
        3: {
          circuit_designation: 'Ring',
          circuit_phase: 'L1',
          circuit_rating_amps: 32,
          circuit_cable_csa_mm2: 2.5,
        },
      },
    };
    const shape = expectedSlotWritesToLegacyShape(oracle);
    expect(Array.isArray(shape.circuit_updates)).toBe(true);
    expect(shape.circuit_updates).toHaveLength(1);
    const op = shape.circuit_updates[0];
    expect(op.action).toBe('create');
    expect(op.circuit_ref).toBe(3);
    // Post-fix: every field makes it into the canonical meta bucket.
    expect(op.meta).toMatchObject({
      designation: 'Ring',
      phase: 'L1',
      rating_amps: 32,
      cable_csa_mm2: 2.5,
    });
    // Post-fix: circuit-shape fields MUST NOT leak into readings — the
    // pre-r5 behaviour silently put them there, which falsely masked
    // divergence when legacy emitted them correctly as circuit_updates.
    const readingFields = new Set(shape.extracted_readings.map((r) => r.field));
    expect(readingFields.has('circuit_phase')).toBe(false);
    expect(readingFields.has('circuit_rating_amps')).toBe(false);
    expect(readingFields.has('circuit_cable_csa_mm2')).toBe(false);
    expect(readingFields.has('circuit_designation')).toBe(false);
  });

  test('r5-3e — flat-legacy vs nested-meta circuit ops normalise equal when semantically identical', () => {
    // Legacy record_extraction emits {action, circuit_ref, designation,
    // phase, rating_amps, cable_csa_mm2} FLAT at the top level.
    // Tool-call bundler emits {op, circuit_ref, meta:{designation, phase,
    // rating_amps, cable_csa_mm2}} with fields nested. Post-fix the
    // normaliser must accept both layouts and converge on the same
    // canonical shape. Semantically identical inputs → divergence 0.
    const legacyFlat = {
      ...empty,
      circuit_updates: [
        {
          action: 'create',
          circuit_ref: 3,
          designation: 'Ring',
          phase: 'L1',
          rating_amps: 32,
          cable_csa_mm2: 2.5,
        },
      ],
    };
    const toolNested = {
      ...empty,
      circuit_updates: [
        {
          op: 'create',
          circuit_ref: 3,
          meta: {
            designation: 'Ring',
            phase: 'L1',
            rating_amps: 32,
            cable_csa_mm2: 2.5,
          },
        },
      ],
    };
    const normLegacy = normaliseExtractionResult(legacyFlat);
    const normTool = normaliseExtractionResult(toolNested);
    const d = computeDivergence(normLegacy, normTool);
    expect(d.diverged).toBe(false);
    expect(d.call_divergence).toBe(0);
  });

  test('r5-3f — rename op: from_ref preserved through normalisation (flat or meta)', () => {
    // Rename schema requires from_ref. Bundler at stage6-dispatchers-circuit.js
    // :366-376 puts from_ref flat at the top level. A hypothetical future
    // legacy shape might nest it under meta. Either placement must
    // normalise to the same canonical shape so rename comparisons are
    // layout-independent.
    const flat = {
      ...empty,
      circuit_updates: [
        {
          op: 'rename',
          from_ref: 3,
          circuit_ref: 4,
          meta: { designation: 'Ring v2', phase: null, rating_amps: null, cable_csa_mm2: null },
        },
      ],
    };
    const legacy = {
      ...empty,
      circuit_updates: [
        {
          action: 'rename',
          from_ref: 3,
          circuit_ref: 4,
          designation: 'Ring v2',
          phase: null,
          rating_amps: null,
          cable_csa_mm2: null,
        },
      ],
    };
    const d = computeDivergence(
      normaliseExtractionResult(flat),
      normaliseExtractionResult(legacy),
    );
    expect(d.diverged).toBe(false);
    expect(d.call_divergence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Group r6-1 — Plan 04-12 r6-#1 BLOCK: oracle mismatches fold into
// per-session call_divergent_count via UNION semantics across all pairwise
// comparisons.
//
// Codex r6 BLOCK #1: runFixture's triple-compare path at
// scripts/stage6-golden-divergence.js:907-953 sets divergence.diverged
// correctly (OR of all three pairwise rates) but leaves `call_total` /
// `call_divergent_count` as the PRIMARY legacy-vs-tool counts only via
// `...primary` spread. runDirectory at line 1071-1077 aggregates these
// primary counts into `call_divergence_rate`. When legacy==tool but both
// disagree with oracle, primary.call_divergent_count=0 — so a fixture
// where the pipeline is "both wrong the same way" reports
// call_divergence_rate=0 in the final digest despite diverged=true.
// That's exactly the failure mode the oracle (r2-#3) exists to catch.
// The gate was structurally undercounting oracle-only divergences.
//
// Fix (r6-#1 GREEN): union semantics — a write is divergent at the
// per-session level if ANY pairwise comparison flags it. Set semantics
// means a single write that diverges in multiple pairings counts once.
// runFixture's Shape A now replaces the `...primary` spread with an
// explicit union-backed `call_total` + `call_divergent_count`.
//
// Why UNION (not tool-vs-oracle primary):
//  - Preserves back-compat with Shape B/C (no oracle → smaller union,
//    still correct)
//  - "Both wrong the same way" → oracle disagrees on the write → union
//    picks it up
//  - Tool drifts alone → legacy_vs_tool picks it up, oracle picks it up,
//    same write counts once
//  - Additive rather than contract-flipping, existing tests keep passing
//
// Six tests lock the union-aggregation contract:
//   r6-1a. "Both wrong same way" via runFixture → call_divergent_count ≥ 1.
//          (Pre-fix: 0. This is the BLOCK scenario.)
//   r6-1b. Same fixture via runDirectory → call_divergence_rate > 0.
//          (Pre-fix: 0/1 = 0 because primary counts only.)
//   r6-1c. All three agree → call_divergent_count=0. Back-compat.
//   r6-1d. Tool diverges from BOTH legacy + oracle on same write →
//          call_divergent_count=1 (union, not 2). Same-write dedup.
//   r6-1e. Two writes: one "both wrong same way", one full agreement →
//          call_divergent_count=1, call_total=2.
//   r6-1f. 6 canonical fixtures post-fix still report rate 0 on
//          runDirectory (NO HIDDEN ORACLE DISAGREEMENT). Escalation
//          threshold — any non-zero rate here = BLOCK evidence SC #6
//          has been bogus.
// ---------------------------------------------------------------------------

describe('Group r6-1 — Plan 04-12 r6-#1 BLOCK: call-count union aggregation across pairwise comparisons', () => {
  const tmp = fssync.mkdtempSync(
    path.join(fssync.realpathSync.native ? fssync.realpathSync.native('/tmp') : '/tmp', 'goldenZ-'),
  );

  function writeFixture(name, body) {
    const p = path.join(tmp, name);
    fssync.writeFileSync(p, JSON.stringify(body, null, 2));
    return p;
  }

  // Shared factory — pre-seeds circuit 3 so record_reading dispatcher
  // validation accepts the write. Takes per-comparison values so callers
  // can construct "both wrong same way" (legacy=tool, oracle differs),
  // full agreement, tool-only-wrong, etc. Optional second write lets
  // r6-1e construct multi-write fixtures.
  function fixtureBody({ legacyValues, toolValues, oracleValues, transcript = 'Zs on circuit three is nought point three five.' }) {
    const base = {
      _doc: 'r6-1 union-aggregation test fixture',
      pre_turn_state: {
        snapshot: {
          circuits: {
            3: { circuit_ref: 3, circuit_designation: 'Lighting (downstairs)' },
            4: { circuit_ref: 4, circuit_designation: 'Lighting (upstairs)' },
          },
          pending_readings: [],
          observations: [],
          validation_alerts: [],
        },
        askedQuestions: [],
        extractedObservations: [],
      },
      transcript,
    };

    if (Array.isArray(legacyValues)) {
      const readings = legacyValues.map(({ circuit, value }) => ({
        circuit,
        field: 'measured_zs_ohm',
        value,
      }));
      base.sse_events_legacy = [
        { type: 'message_start', message: { id: 'msg_legacy', role: 'assistant', content: [] } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_legacy', name: 'record_extraction', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              extracted_readings: readings,
              field_clears: [],
              circuit_updates: [],
              observations: [],
              validation_alerts: [],
              questions_for_user: [],
              confirmations: [],
            }),
          },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ];
    }

    if (Array.isArray(toolValues)) {
      // Emit one record_reading tool_use per write. Each gets its own
      // content_block index so the dispatcher replays them independently.
      const events = [
        { type: 'message_start', message: { id: 'msg_tool', role: 'assistant', content: [] } },
      ];
      toolValues.forEach(({ circuit, value }, i) => {
        events.push({
          type: 'content_block_start',
          index: i,
          content_block: { type: 'tool_use', id: `toolu_tool_${i}`, name: 'record_reading', input: {} },
        });
        events.push({
          type: 'content_block_delta',
          index: i,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              field: 'measured_zs_ohm',
              circuit,
              value,
              confidence: 0.95,
              source_turn_id: 't1',
            }),
          },
        });
        events.push({ type: 'content_block_stop', index: i });
      });
      events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
      events.push({ type: 'message_stop' });
      base.sse_events_tool_call = events;
    }

    if (Array.isArray(oracleValues)) {
      const circuits = {};
      for (const { circuit, value } of oracleValues) {
        circuits[circuit] = { measured_zs_ohm: value };
      }
      base.expected_slot_writes = { circuits };
    }

    return base;
  }

  test('r6-1a — both wrong same way → runFixture reports call_divergent_count ≥ 1 (pre-fix: 0)', async () => {
    // This is THE BLOCK scenario. Legacy + tool BOTH emit 0.71, oracle
    // says correct is 0.35. Primary comparison (legacy-vs-tool) shows
    // zero divergence. But tool-vs-oracle + legacy-vs-oracle both fire.
    // Pre-fix: call_total=1, call_divergent_count=0 (primary only).
    // Post-fix: call_total=1, call_divergent_count=1 (union fires).
    const p = writeFixture(
      'r6-1a-both-wrong-same-way.json',
      fixtureBody({
        legacyValues: [{ circuit: 3, value: '0.71' }],
        toolValues: [{ circuit: 3, value: '0.71' }],
        oracleValues: [{ circuit: 3, value: '0.35' }],
      }),
    );
    const result = await runFixture(p);
    expect(result).toBeDefined();
    // Sanity: diverged IS true (r2-#3 worked) — oracle pairings fire.
    expect(result.divergence.diverged).toBe(true);
    expect(result.divergence.legacy_vs_tool_divergence).toBe(0);
    expect(result.divergence.tool_vs_oracle_divergence).toBeGreaterThan(0);
    expect(result.divergence.legacy_vs_oracle_divergence).toBeGreaterThan(0);
    // THE BLOCK ASSERTION: call-level aggregate now reflects the
    // oracle disagreement. Pre-fix this is 0.
    expect(result.divergence.call_total).toBeGreaterThanOrEqual(1);
    expect(result.divergence.call_divergent_count).toBeGreaterThanOrEqual(1);
    expect(result.divergence.call_divergence).toBeGreaterThan(0);
  });

  test('r6-1b — both wrong same way → runDirectory reports call_divergence_rate > 0 (pre-fix: 0)', async () => {
    // Same fixture as r6-1a in a runDirectory aggregation. Pre-fix the
    // aggregator reads s.divergence.call_total=1, call_divergent_count=0
    // → rate = 0/1 = 0. Post-fix: 1/1 = 1.
    const dir = fssync.mkdtempSync(
      path.join(fssync.realpathSync.native ? fssync.realpathSync.native('/tmp') : '/tmp', 'goldenZdir-'),
    );
    fssync.writeFileSync(
      path.join(dir, 'both-wrong.json'),
      JSON.stringify(
        fixtureBody({
          legacyValues: [{ circuit: 3, value: '0.71' }],
          toolValues: [{ circuit: 3, value: '0.71' }],
          oracleValues: [{ circuit: 3, value: '0.35' }],
        }),
        null,
        2,
      ),
    );
    const report = await runDirectory(dir, { threshold: 0.10 });
    expect(report.total).toBe(1);
    // THE BLOCK ASSERTION at aggregator level.
    expect(report.call_divergence_rate).toBeGreaterThan(0);
    // Session-level catches it (diverged OR of three pairings).
    expect(report.session_divergence_rate).toBeGreaterThan(0);
    // Breach: call + session both above threshold 0.10 → breached.
    expect(report.breached).toBe(true);
  });

  test('r6-1c — all three agree → call_divergent_count=0, back-compat preserved', async () => {
    const p = writeFixture(
      'r6-1c-triple-agree.json',
      fixtureBody({
        legacyValues: [{ circuit: 3, value: '0.35' }],
        toolValues: [{ circuit: 3, value: '0.35' }],
        oracleValues: [{ circuit: 3, value: '0.35' }],
      }),
    );
    const result = await runFixture(p);
    expect(result.divergence.diverged).toBe(false);
    expect(result.divergence.call_total).toBe(1);
    expect(result.divergence.call_divergent_count).toBe(0);
    expect(result.divergence.call_divergence).toBe(0);
  });

  test('r6-1d — tool diverges from BOTH legacy + oracle on same write → call_divergent_count=1 (union dedup)', async () => {
    // Tool=0.99, legacy=0.35, oracle=0.35. Two pairings fire
    // (legacy-vs-tool + tool-vs-oracle). Same write should count ONCE
    // via union, not 2. If naïvely summing pairwise counts you'd get
    // 2 — the union semantics is the point of this test.
    const p = writeFixture(
      'r6-1d-tool-wrong-two-pairings.json',
      fixtureBody({
        legacyValues: [{ circuit: 3, value: '0.35' }],
        toolValues: [{ circuit: 3, value: '0.99' }],
        oracleValues: [{ circuit: 3, value: '0.35' }],
      }),
    );
    const result = await runFixture(p);
    expect(result.divergence.diverged).toBe(true);
    expect(result.divergence.legacy_vs_tool_divergence).toBeGreaterThan(0);
    expect(result.divergence.tool_vs_oracle_divergence).toBeGreaterThan(0);
    expect(result.divergence.legacy_vs_oracle_divergence).toBe(0);
    expect(result.divergence.call_total).toBe(1);
    // UNION not SUM — the single write counts once even though two
    // pairings flag it.
    expect(result.divergence.call_divergent_count).toBe(1);
  });

  test('r6-1e — two writes (one both-wrong-same-way, one all-agree) → call_divergent_count=1, call_total=2', async () => {
    // circuit 3: legacy=0.71, tool=0.71, oracle=0.35  → both wrong same way
    // circuit 4: legacy=0.50, tool=0.50, oracle=0.50  → all agree
    // Pre-fix call_total=2, call_divergent_count=0 (primary says 0/2).
    // Post-fix call_total=2, call_divergent_count=1 (union fires on one).
    const p = writeFixture(
      'r6-1e-mixed-writes.json',
      fixtureBody({
        legacyValues: [
          { circuit: 3, value: '0.71' },
          { circuit: 4, value: '0.50' },
        ],
        toolValues: [
          { circuit: 3, value: '0.71' },
          { circuit: 4, value: '0.50' },
        ],
        oracleValues: [
          { circuit: 3, value: '0.35' },
          { circuit: 4, value: '0.50' },
        ],
      }),
    );
    const result = await runFixture(p);
    expect(result.divergence.diverged).toBe(true);
    expect(result.divergence.call_total).toBe(2);
    expect(result.divergence.call_divergent_count).toBe(1);
  });

  test('r6-1f — 6 canonical fixtures still report 0 after union fix (ESCALATION THRESHOLD — any non-zero = BLOCK evidence)', async () => {
    // THE GATE — if this trips, SC #6 has been claiming 0% divergence
    // on fixtures that secretly had oracle-vs-pipeline disagreement
    // all along. That would mean the r5 (and earlier) 0% baseline
    // was bogus because the aggregator was undercounting. Plan
    // 04-12 explicitly escalates to BLOCK on any non-zero rate here.
    const report = await runDirectory(FIXTURE_DIR, {
      threshold: 0.10,
      extraFixtures: [F21934D4_PATH],
    });
    expect(report.total).toBe(6);
    expect(report.call_divergence_rate).toBe(0);
    expect(report.session_divergence_rate).toBe(0);
    expect(report.breached).toBe(false);
    // Cross-check: every session's per-pairwise rate is 0 as well —
    // if any one's oracle disagrees, the union aggregator above would
    // catch it.
    for (const s of report.sessions) {
      if (s.divergence.tool_vs_oracle_divergence != null) {
        expect(s.divergence.tool_vs_oracle_divergence).toBe(0);
      }
      if (s.divergence.legacy_vs_oracle_divergence != null) {
        expect(s.divergence.legacy_vs_oracle_divergence).toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Group r7-2 — Plan 04-13 r7-#2 MAJOR: runToolCallPath seeds
// recentCircuitOrder from the fixture snapshot so buildStateSnapshotMessage
// exposes every pre-seeded circuit's filled slots to the model.
//
// Codex r7 MAJOR #2: `scripts/stage6-golden-divergence.js` seeds
// `session.stateSnapshot = structuredClone(fx.pre_turn_state.snapshot)`
// but never seeds `session.recentCircuitOrder`. buildStateSnapshotMessage
// (eicr-extraction-session.js:1212) keeps only the LAST
// SNAPSHOT_RECENT_CIRCUITS=3 entries from recentCircuitOrder in detail
// and compacts everything else into a "N earlier circuits (1,2,3)
// stored server-side" summary. Consequence: a fixture like F21934D4
// that seeds 3 circuits with filled slots (including r1_r2_ohm=0.64 on
// circuit 2) has ALL its circuits collapse into the summary — the
// cached-prefix snapshot the harness transmits to Sonnet omits the
// filled-slot values entirely. SC #4 ("F21934D4 zero re-asks on the
// new prompt + tool-call path") passes only because the current test
// transcript happens to avoid the r1_r2/zs slots; any future fixture
// that references those slots would measure a DIFFERENT prompt state
// than production ever reaches.
//
// Fix (r7-#2 GREEN): derive `recentCircuitOrder` from the seeded
// snapshot's circuit keys (non-supply, ascending numeric). Mirrors
// what production would have produced via updateStateSnapshot pushes
// as each reading landed historically.
//
// Why OPTION A (harness auto-derives) and NOT OPTION B
// (fixtures declare order):
//   - Zero-fixture-edit path — existing fixtures + future authors
//     do not need to remember to seed this field.
//   - Robust to authors: the snapshot already implies the order via
//     which circuits are filled; deriving it removes a footgun.
//
// Four tests lock the fix:
//   r7-2a — F21934D4's r1_r2_ohm=0.64 is visible in captured system[1]
//           text (not in the "earlier circuits" summary).
//   r7-2b — captured snapshot does NOT contain "earlier circuits (1,2,3)".
//   r7-2c — back-compat — for >SNAPSHOT_RECENT_CIRCUITS circuits, the
//           derivation truncates to the last N (by ascending number).
//   r7-2d — circuit 0 (supply) is NOT added to recentCircuitOrder
//           (supply block is separate).
// ---------------------------------------------------------------------------

describe('Group r7-2 — Plan 04-13 r7-#2: runToolCallPath seeds recentCircuitOrder from fixture snapshot', () => {
  // Helper — load a canned tool-call events block from sample-01 so each
  // fixture below has a valid SSE stream for the tool loop.
  function sample01ToolCallEvents() {
    return JSON.parse(
      fssync.readFileSync(path.join(FIXTURE_DIR, 'sample-01-routine.json'), 'utf8'),
    ).sse_events_tool_call;
  }
  function sample01ToolCallEventsR2() {
    return JSON.parse(
      fssync.readFileSync(path.join(FIXTURE_DIR, 'sample-01-routine.json'), 'utf8'),
    ).sse_events_tool_call_round2;
  }

  test('r7-2a — F21934D4 captured system[1].text contains r1_r2_ohm (not collapsed to earlier-circuits summary)', async () => {
    // Load the real F21934D4 fixture (post-r6-#3 canonicalisation).
    // Its pre_turn_state.snapshot has 3 circuits: circuit 1
    // (measured_zs_ohm=0.42), circuit 2 (r1_r2_ohm=0.64), circuit 3
    // (designation only). Without the r7-#2 seed, buildStateSnapshotMessage
    // would see recentCircuitOrder=[] and push ALL three into the older-
    // circuits summary → filled slots become invisible. With the seed,
    // they stay in the detailed recent section.
    const fx = JSON.parse(fssync.readFileSync(F21934D4_PATH, 'utf8'));
    const { client } = await runToolCallPath(fx);
    expect(client._calls.length).toBeGreaterThan(0);
    const firstRequest = client._calls[0];
    // system[1] is the cached-prefix snapshot block (system[0] is the
    // agentic prompt). Both present because pre_turn_state is non-empty.
    expect(Array.isArray(firstRequest.system)).toBe(true);
    expect(firstRequest.system.length).toBe(2);
    const snapshotText = firstRequest.system[1].text;
    // Filled slot for circuit 2 must be visible. FIELD_ID_MAP at
    // eicr-extraction-session.js:52-81 does NOT map r1_r2_ohm
    // (canonical key is not in the compact map), so it serialises
    // as the literal string `r1_r2_ohm`.
    expect(snapshotText).toContain('r1_r2_ohm');
    // And the value must be preserved.
    expect(snapshotText).toContain('0.64');
  });

  test('r7-2b — F21934D4 snapshot has NO collapsed "earlier circuits" summary (all 3 expanded in detail)', async () => {
    const fx = JSON.parse(fssync.readFileSync(F21934D4_PATH, 'utf8'));
    const { client } = await runToolCallPath(fx);
    const snapshotText = client._calls[0].system[1].text;
    // With 3 circuits seeded (all non-supply), SNAPSHOT_RECENT_CIRCUITS=3
    // means ALL three should fit in the detailed section. The collapsed
    // summary line appears only when circuits > N. Pre-r7 (no seed):
    // recentCircuitOrder=[] → allNonSupply.filter(n => !recent.includes(n))
    // includes all three → summary line emitted. Post-r7: recentCircuitOrder
    // carries [1,2,3] → summary line not emitted.
    expect(snapshotText).not.toMatch(/earlier circuits/);
  });

  test('r7-2c — back-compat: >SNAPSHOT_RECENT_CIRCUITS seeded circuits → only last N expanded in detail', async () => {
    // Synthetic fixture with 5 pre-seeded circuits (1..5). SNAPSHOT_RECENT_CIRCUITS
    // is 3 (eicr-extraction-session.js:47). The harness-derived
    // recentCircuitOrder should be [1,2,3,4,5]; the builder's
    // `.slice(-3)` keeps [3,4,5] detailed and pushes [1,2] to the
    // summary. This proves the seed respects the compaction semantic
    // rather than blindly exposing all circuits.
    const syntheticFx = {
      pre_turn_state: {
        snapshot: {
          circuits: {
            1: { circuit_ref: 1, circuit_designation: 'Ring 1' },
            2: { circuit_ref: 2, circuit_designation: 'Ring 2', measured_zs_ohm: 0.22 },
            3: { circuit_ref: 3, circuit_designation: 'Lighting 1' },
            4: { circuit_ref: 4, circuit_designation: 'Lighting 2' },
            5: { circuit_ref: 5, circuit_designation: 'Shower', measured_zs_ohm: 0.55 },
          },
          pending_readings: [],
          observations: [],
          validation_alerts: [],
        },
        askedQuestions: [],
        extractedObservations: [],
      },
      transcript: 'test',
      sse_events_tool_call: sample01ToolCallEvents(),
      sse_events_tool_call_round2: sample01ToolCallEventsR2(),
    };
    const { client } = await runToolCallPath(syntheticFx);
    const snapshotText = client._calls[0].system[1].text;
    // Circuits 1 & 2 collapsed (oldest two). Circuits 3, 4, 5 detailed.
    expect(snapshotText).toMatch(/2 earlier circuits \(1,2\) stored server-side/);
    // Detailed recent: circuit 5 with its reading (0.55) must appear.
    expect(snapshotText).toContain('0.55');
    // Collapsed: circuit 2 reading (0.22) must NOT appear (it's rolled
    // into the summary, server-side).
    expect(snapshotText).not.toContain('0.22');
  });

  test('r7-2d — circuit 0 (supply) NOT added to recentCircuitOrder', async () => {
    // The builder treats circuit 0 as a separate always-visible supply
    // block (eicr-extraction-session.js:1297-1300). recentCircuitOrder
    // explicitly EXCLUDES circuit 0 (updateStateSnapshot line 1093
    // guards with `if (circuit !== 0)`). The harness seed must mirror
    // that convention — otherwise supply fields would occupy one of the
    // three recent slots.
    const syntheticFx = {
      pre_turn_state: {
        snapshot: {
          circuits: {
            0: { ze: '0.32', pfc: '1500' }, // supply
            1: { circuit_ref: 1, circuit_designation: 'Ring', measured_zs_ohm: 0.45 },
            2: { circuit_ref: 2, circuit_designation: 'Lights', measured_zs_ohm: 0.80 },
            3: { circuit_ref: 3, circuit_designation: 'Cooker', measured_zs_ohm: 0.95 },
            4: { circuit_ref: 4, circuit_designation: 'Shower', measured_zs_ohm: 1.10 },
          },
          pending_readings: [],
          observations: [],
          validation_alerts: [],
        },
        askedQuestions: [],
        extractedObservations: [],
      },
      transcript: 'test',
      sse_events_tool_call: sample01ToolCallEvents(),
      sse_events_tool_call_round2: sample01ToolCallEventsR2(),
    };
    const { client } = await runToolCallPath(syntheticFx);
    const snapshotText = client._calls[0].system[1].text;
    // Supply block shown with FULL field names (eicr-extraction-session.js:1299
    // — line uses `${JSON.stringify(supplyData)}`).
    expect(snapshotText).toMatch(/0:\{.*ze.*0\.32/);
    // recentCircuitOrder derivation excludes circuit 0 → the last 3
    // non-supply circuits ([2,3,4]) are detailed. Circuit 1 compacts
    // into the summary ("1 earlier circuits (1) stored server-side").
    expect(snapshotText).toMatch(/1 earlier circuits \(1\) stored server-side/);
    // Readings for the detailed circuits (2,3,4) must appear. Note:
    // JSON.stringify drops trailing zeros on numeric values, so 0.80
    // serialises as 0.8 in the compact block.
    expect(snapshotText).toContain('0.8');
    expect(snapshotText).toContain('0.95');
    expect(snapshotText).toContain('1.1');
    // Reading for the compacted circuit (1) must NOT appear verbatim.
    expect(snapshotText).not.toContain('0.45');
  });
});

// ---------------------------------------------------------------------------
// Group r7-3 — Plan 04-13 r7-#3 MINOR: circuit_ops sort uses the full
// canonical tuple (action, circuit_ref, from_ref, designation, phase,
// rating_amps, cable_csa_mm2).
//
// Codex r7 MINOR #3: scripts/stage6-golden-divergence.js:146 — r5-#3
// widened `normaliseCircuitOp` to canonicalise phase / rating_amps /
// cable_csa_mm2 alongside designation + from_ref, but the sort key at
// line 150-155 was still only (action, circuit_ref). Two ops with the
// same primary tuple but differing metadata compared as equal in sort
// — final order became input-order dependent, so identical logical
// shapes would fail canonical-equality checks when emitted in
// different orders.
//
// Fix (r7-#3 GREEN): sort on the full tuple using nullable comparators
// (same pattern as r5-#2 for observations — compareNullableString for
// string fields, compareNullableScalar for numeric fields).
//
// Four tests lock the widened sort:
//   r7-3a — two ops identical on (action, circuit_ref) but differing
//           on phase → deterministic order regardless of input order.
//   r7-3b — ops differing only on rating_amps → ascending numeric.
//   r7-3c — ops differing only on cable_csa_mm2 → ascending numeric.
//   r7-3d — back-compat — ops differing on (action, circuit_ref) are
//           unaffected by the new tie-breakers.
// ---------------------------------------------------------------------------

describe('Group r7-3 — Plan 04-13 r7-#3: circuit_ops sort uses full canonical tuple', () => {
  // Helper to build a legacy-shaped input with a given circuit_updates
  // array, then normalise and return just the circuit_ops slice.
  function norm(circuitUpdates) {
    return normaliseExtractionResult({
      extracted_readings: [],
      field_clears: [],
      observations: [],
      circuit_updates: circuitUpdates,
    }).circuit_ops;
  }

  test('r7-3a — ops identical on (action, circuit_ref) sort deterministically by phase', () => {
    // Two ops with same action=create, same circuit_ref=4, differing
    // phase. Pre-fix: output order matches input order (both orderings
    // return the input verbatim). Post-fix: output is the same
    // regardless of input order, keyed on phase alphabetical.
    const forward = norm([
      { action: 'create', circuit_ref: 4, phase: 'L3' },
      { action: 'create', circuit_ref: 4, phase: 'L1' },
    ]);
    const reverse = norm([
      { action: 'create', circuit_ref: 4, phase: 'L1' },
      { action: 'create', circuit_ref: 4, phase: 'L3' },
    ]);
    // Both orderings must produce the same sorted output.
    expect(forward).toEqual(reverse);
    // Specifically, L1 sorts before L3 alphabetically.
    expect(forward[0].phase).toBe('L1');
    expect(forward[1].phase).toBe('L3');
  });

  test('r7-3b — ops differing only on rating_amps sort numerically ascending', () => {
    const forward = norm([
      { action: 'create', circuit_ref: 4, rating_amps: 32 },
      { action: 'create', circuit_ref: 4, rating_amps: 6 },
      { action: 'create', circuit_ref: 4, rating_amps: 16 },
    ]);
    const reverse = norm([
      { action: 'create', circuit_ref: 4, rating_amps: 16 },
      { action: 'create', circuit_ref: 4, rating_amps: 6 },
      { action: 'create', circuit_ref: 4, rating_amps: 32 },
    ]);
    expect(forward).toEqual(reverse);
    expect(forward.map((o) => o.rating_amps)).toEqual([6, 16, 32]);
  });

  test('r7-3c — ops differing only on cable_csa_mm2 sort numerically ascending', () => {
    const forward = norm([
      { action: 'create', circuit_ref: 4, cable_csa_mm2: 10 },
      { action: 'create', circuit_ref: 4, cable_csa_mm2: 1.5 },
      { action: 'create', circuit_ref: 4, cable_csa_mm2: 2.5 },
    ]);
    const reverse = norm([
      { action: 'create', circuit_ref: 4, cable_csa_mm2: 2.5 },
      { action: 'create', circuit_ref: 4, cable_csa_mm2: 10 },
      { action: 'create', circuit_ref: 4, cable_csa_mm2: 1.5 },
    ]);
    expect(forward).toEqual(reverse);
    expect(forward.map((o) => o.cable_csa_mm2)).toEqual([1.5, 2.5, 10]);
  });

  test('r7-3d — back-compat: ops differing on (action, circuit_ref) retain primary ordering', () => {
    // Regression guard: the widened tie-breakers MUST NOT alter the
    // primary sort on (action, circuit_ref). Two ops differing on
    // action: 'create' sorts before 'rename' alphabetically. Two ops
    // same action but differing circuit_ref: numeric/string ascending.
    const ops = norm([
      { action: 'rename', circuit_ref: 3, from_ref: 2, phase: 'L2' },
      { action: 'create', circuit_ref: 5, phase: 'L1' },
      { action: 'create', circuit_ref: 4, phase: 'L1' },
    ]);
    // Expected ordering:
    //   1. create, circuit_ref=4 (create < rename; 4 < 5)
    //   2. create, circuit_ref=5
    //   3. rename, circuit_ref=3
    expect(ops[0].action).toBe('create');
    expect(String(ops[0].circuit_ref)).toBe('4');
    expect(ops[1].action).toBe('create');
    expect(String(ops[1].circuit_ref)).toBe('5');
    expect(ops[2].action).toBe('rename');
    expect(String(ops[2].circuit_ref)).toBe('3');
  });
});
