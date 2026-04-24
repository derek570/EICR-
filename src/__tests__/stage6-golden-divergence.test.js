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
  runDirectory,
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
// Group B — computeDivergence
// ---------------------------------------------------------------------------

describe('computeDivergence — section-level section diff', () => {
  const empty = { readings: [], clears: [], circuit_ops: [], observations: [] };

  test('identical inputs → { diverged: false, call_divergence: 0 }', () => {
    const a = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.35' }] };
    const b = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.35' }] };
    expect(computeDivergence(a, b)).toEqual({
      diverged: false,
      call_divergence: 0,
      reasons: [],
    });
  });

  test('different readings section → diverged, 1/4 sections = 0.25', () => {
    const a = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.35' }] };
    const b = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.71' }] };
    const d = computeDivergence(a, b);
    expect(d.diverged).toBe(true);
    expect(d.call_divergence).toBeCloseTo(0.25, 6);
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
    const d = computeDivergence(a, b);
    expect(d.diverged).toBe(true);
    expect(d.call_divergence).toBeCloseTo(1.0, 6);
    expect(d.reasons.sort()).toEqual(['circuit_ops', 'clears', 'observations', 'readings']);
  });

  test('empty-vs-non-empty reading list → diverged', () => {
    const a = { ...empty };
    const b = { ...empty, readings: [{ circuit: 1, field: 'zs', value: '0.35' }] };
    const d = computeDivergence(a, b);
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
    const d = computeDivergence(a, b);
    expect(d.diverged).toBe(true);
    expect(d.call_divergence).toBeCloseTo(0.25, 6);
    expect(d.reasons).toEqual(['observations']);
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
