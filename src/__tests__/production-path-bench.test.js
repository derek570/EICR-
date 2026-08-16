/**
 * Plan 08C-A — committed regression suite for the benchmark decision logic.
 *
 * Sonnet-max cycle-3 finding (2026-08-16): three consecutive BLOCKER classes
 * in production-path-bench-analyze.mjs (parity skipped for cache-stratified
 * blocks; parity skipped for turn-count-mismatched blocks; per-arm unprovable
 * accounting) were each verified only by ad-hoc /tmp selftests that the repo
 * never captured — the exact file whose header promises a decision
 * "reproducible from the evidence artifact alone" had zero committed
 * coverage. These are those selftests, promoted: every scenario below is one
 * a dual adversarial review (Codex sol-high + Sonnet-max, cycles 1-3) found
 * as a live defect, so a regression here means a previously-shipped bug
 * class has returned.
 */

import { analyzeResults } from '../../scripts/voice-latency-bench/production-path-bench-analyze.mjs';
import {
  findEmittedAudibleFrame,
  PROD_ENV_DEFAULTS,
  FORCE_DELETED_ENV,
  DELIBERATE_TASK_DEF_DIVERGENCES,
} from '../../scripts/voice-latency-bench/production-path-bench.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// --------------------------------------------------------------------------
// Synthetic evidence builders (mirror the runner's rep/turn/ledger shapes)
// --------------------------------------------------------------------------
function turn(cache, { dest = null, val = null, ms = 1000, audible = true, unprovable = false, asks = 0 } = {}) {
  const t = {
    round_usage:
      cache === 'none'
        ? []
        : [
            {
              cache_write_input_tokens: cache === 'write' ? 100 : 0,
              cache_read_input_tokens: cache === 'read' ? 35000 : 0,
            },
          ],
    round_timings: [{ stream_ms: ms }],
    ledger: [],
    ask_users_count: asks,
  };
  if (dest) {
    const frame = unprovable ? 'unprovable' : audible ? { type: 'extraction.confirmation' } : null;
    t.ledger.push({
      applied_mutation: true,
      dispatch_outcome: 'ok',
      canonical_destination: dest,
      normalised_value: val,
      emitted_audible_frame: frame,
    });
  }
  return t;
}
const rep = (fixture_id, arm, block_id, turns) => ({ fixture_id, arm, block_id, turns, rate_limited: false });

// --------------------------------------------------------------------------
// Cycle-1/2 classes: value-divergence parity, whole-block stratification,
// coverage gap blocking a single-fixture win
// --------------------------------------------------------------------------
describe('analyzer — value parity, stratification, coverage (dual-review cycles 1-2)', () => {
  const reps = [
    // fixA block0: warm-matched; ascending diverges on VALUE; window_6 matches
    rep('fixA', 'recent_3', 'fixA:b0', [turn('write'), turn('read', { dest: 'c3.zs', val: '0.80', ms: 1200 }), turn('read', { dest: 'c4.zs', val: '0.50', ms: 1100 })]),
    rep('fixA', 'ascending', 'fixA:b0', [turn('write'), turn('read', { dest: 'c3.zs', val: '0.70', ms: 900 }), turn('read', { dest: 'c4.zs', val: '0.50', ms: 800 })]),
    rep('fixA', 'window_6', 'fixA:b0', [turn('write'), turn('read', { dest: 'c3.zs', val: '0.80', ms: 900 }), turn('read', { dest: 'c4.zs', val: '0.50', ms: 800 })]),
    // fixB block0: cross-arm cache-outcome mismatch → whole block stratified out
    rep('fixB', 'recent_3', 'fixB:b0', [turn('write'), turn('read', { dest: 'c1.zs', val: '0.30' })]),
    rep('fixB', 'ascending', 'fixB:b0', [turn('write'), turn('miss', { dest: 'c1.zs', val: '0.30', ms: 700 })]),
    rep('fixB', 'window_6', 'fixB:b0', [turn('write'), turn('read', { dest: 'c1.zs', val: '0.30', ms: 700 })]),
  ];
  const r = analyzeResults(reps);

  test('a candidate writing 0.70 where baseline wrote 0.80 fails parity (destination-set comparison passed this)', () => {
    expect(r.fixtures.fixA.parity.ascending.destination_mismatch_blocks).toBe(1);
    expect(r.fixtures.fixA.parity.ascending.mismatch_details[0].reasons).toContain('final_state_divergence');
  });

  test('an identical-value arm stays parity-clean', () => {
    expect(r.fixtures.fixA.parity.window_6.destination_mismatch_blocks).toBe(0);
  });

  test('a cross-arm cache-outcome mismatch stratifies the WHOLE block out', () => {
    expect(r.fixtures.fixB.blocks_stratified_out.some((b) => b.reason === 'cache_outcome_mismatch')).toBe(true);
  });

  test('a fixture with no paired data blocks the win and is NAMED (single-fixture wins were possible)', () => {
    expect(r.decision.per_arm.window_6.fixtures_without_paired_data).toEqual(['fixB']);
    expect(r.decision.per_arm.window_6.wins).toBe(false);
    expect(r.decision.outcome).toContain('NO ARM WINS');
  });
});

// --------------------------------------------------------------------------
// Sonnet-max cycle-2 class: unprovable audibility must not read as silence
// --------------------------------------------------------------------------
describe('analyzer — three-state audibility (Sonnet-max cycle 2)', () => {
  const reps = ['recent_3', 'ascending', 'window_6'].map((arm, i) =>
    rep('fixC', arm, 'fixC:b0', [
      turn('write'),
      turn('read', { dest: 'board.new_circuit', val: 'created', ms: [1000, 600, 990][i], unprovable: true }),
      turn('read', { dest: 'c2.zs', val: '0.44', ms: [1000, 600, 990][i] }),
    ])
  );
  const r = analyzeResults(reps);

  test('an identical-across-arms unprovable structural call does NOT fail parity, and a genuine 40% win STANDS', () => {
    expect(r.fixtures.fixC.parity.ascending.destination_mismatch_blocks).toBe(0);
    expect(r.decision.per_arm.ascending.wins).toBe(true);
  });

  test('unprovable calls are surfaced per-arm, not silently dropped', () => {
    expect(r.fixtures.fixC.parity_unprovable_audibility_calls.recent_3).toBe(1);
  });

  test('a PROVABLY silent write (explicit null frame) still fails parity', () => {
    const silent = [
      rep('fixS', 'recent_3', 'fixS:b0', [turn('write'), turn('read', { dest: 'c1.zs', val: '0.1' })]),
      rep('fixS', 'ascending', 'fixS:b0', [turn('write'), turn('read', { dest: 'c1.zs', val: '0.1', audible: false })]),
      rep('fixS', 'window_6', 'fixS:b0', [turn('write'), turn('read', { dest: 'c1.zs', val: '0.1' })]),
    ];
    const rs = analyzeResults(silent);
    expect(rs.fixtures.fixS.parity.ascending.destination_mismatch_blocks).toBe(1);
    expect(rs.fixtures.fixS.parity.ascending.mismatch_details[0].reasons).toContain('candidate_unspoken_write');
  });
});

// --------------------------------------------------------------------------
// Codex cycle-3 class: parity precedes ALL stratification
// --------------------------------------------------------------------------
describe('analyzer — parity precedes stratification (Codex cycle 3)', () => {
  const reps = [
    // b0: ascending has an EXTRA turn + divergent value — must dirty parity
    rep('fixD', 'recent_3', 'fixD:b0', [turn('write'), turn('read', { dest: 'c3.zs', val: '0.80', ms: 1200 })]),
    rep('fixD', 'ascending', 'fixD:b0', [turn('write'), turn('read', { dest: 'c3.zs', val: '0.70', ms: 700 }), turn('read', { dest: 'c9.zs', val: '0.99', ms: 700 })]),
    rep('fixD', 'window_6', 'fixD:b0', [turn('write'), turn('read', { dest: 'c3.zs', val: '0.80', ms: 1150 })]),
    // b1: clean warm block, ascending 20% faster — would win if b0 were invisible
    rep('fixD', 'recent_3', 'fixD:b1', [turn('write'), turn('read', { dest: 'c4.zs', val: '0.55', ms: 1000 })]),
    rep('fixD', 'ascending', 'fixD:b1', [turn('write'), turn('read', { dest: 'c4.zs', val: '0.55', ms: 800 })]),
    rep('fixD', 'window_6', 'fixD:b1', [turn('write'), turn('read', { dest: 'c4.zs', val: '0.55', ms: 990 })]),
  ];
  const r = analyzeResults(reps);

  test('a turn-count-divergent block records a parity mismatch instead of silently stratifying (the divergent arm previously WON)', () => {
    const b0 = r.fixtures.fixD.parity.ascending.mismatch_details.find((m) => m.block === 'fixD:b0');
    expect(b0).toBeDefined();
    expect(b0.reasons).toContain('turn_count_2_vs_3');
    expect(b0.reasons).toContain('final_state_divergence');
    expect(r.decision.per_arm.ascending.wins).toBe(false);
  });

  test('the divergent block is still excluded from the LATENCY stats', () => {
    expect(r.fixtures.fixD.blocks_stratified_out.some((b) => b.reason === 'turn_count_mismatch')).toBe(true);
    expect(r.fixtures.fixD.blocks_paired_warm).toBe(1);
  });
});

// --------------------------------------------------------------------------
// Runner seams: three-state audibility contract + env-mirror drift
// --------------------------------------------------------------------------
describe('runner — findEmittedAudibleFrame three-state contract', () => {
  test("a field-less tool returns 'unprovable', never null", () => {
    expect(findEmittedAudibleFrame({ tool: 'create_circuit', input_summary: {} }, [])).toBe('unprovable');
  });

  test('a field-bearing tool with no matching confirmation returns null (provably silent)', () => {
    expect(
      findEmittedAudibleFrame({ tool: 'record_reading', input_summary: { field: 'measured_zs_ohm', circuit: 3 } }, [])
    ).toBeNull();
  });

  test('a field-bearing tool with a matching confirmation returns the frame', () => {
    const frames = [
      { msg: { type: 'extraction', result: { confirmations: [{ field: 'measured_zs_ohm', circuit: 3, text: 'Circuit 3, Zs 0.52' }] } } },
    ];
    expect(
      findEmittedAudibleFrame({ tool: 'record_reading', input_summary: { field: 'measured_zs_ohm', circuit: 3 } }, frames)
    ).toMatchObject({ type: 'extraction.confirmation' });
  });
});

describe('runner — production env mirror stays true to the live task-def', () => {
  const taskDef = JSON.parse(fs.readFileSync(path.join(repoRoot, 'ecs', 'task-def-backend.json'), 'utf8'));
  const taskDefEnv = Object.fromEntries((taskDef.containerDefinitions?.[0]?.environment ?? []).map((e) => [e.name, e.value]));

  test('every mirror key present in the task-def matches it (documented divergences excepted)', () => {
    for (const [k, v] of Object.entries(PROD_ENV_DEFAULTS)) {
      if (k in taskDefEnv) expect({ [k]: v }).toEqual({ [k]: taskDefEnv[k] });
    }
  });

  test('every force-deleted key is genuinely unset in the task-def (deletion = faithful, not divergent)', () => {
    for (const k of FORCE_DELETED_ENV) {
      expect(taskDefEnv[k]).toBeUndefined();
    }
  });

  test('every deliberate divergence is a real divergence from a real task-def key, with a different value', () => {
    for (const [k, v] of Object.entries(DELIBERATE_TASK_DEF_DIVERGENCES)) {
      expect(taskDefEnv[k]).toBeDefined();
      expect(taskDefEnv[k]).not.toBe(v);
    }
  });

  test('the mirror covers every settable VOICE_LATENCY snapshot flag the task-def carries', () => {
    const snapshotFlags = Object.keys(taskDefEnv).filter(
      (k) => k.startsWith('VOICE_LATENCY_') && !k.startsWith('VOICE_LATENCY_LOADED_BARREL')
    );
    for (const k of snapshotFlags) {
      expect(Object.keys(PROD_ENV_DEFAULTS)).toContain(k);
    }
  });
});
