/**
 * PLAN-C Phase 4 — the client watchdog fallback line must be full-string
 * distinct from EVERY backend spoken-line family that rides the field-nil
 * confirmation channel (the client dedupe is a 30 s text-keyed TTL, so a
 * collision would swallow one line). Covers the three fixed apology arrays,
 * the two fixed single-literal apologies, and a representative render sweep of
 * the two templated F/U-2/3 notice families (counts 1–6, both rotation
 * variants, both calc friendly names + the rename family).
 */

import { jest } from '@jest/globals';
import { CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT } from '../extraction/client-watchdog-fallback.js';
import {
  NOOP_AUDIBILITY_PROMPTS,
  CATCHALL_AUDIBILITY_PROMPTS,
  ASK_AUDIBILITY_FALLBACK_TEXT,
} from '../extraction/stage6-shadow-harness.js';
import {
  dispatchCalculateZs,
  dispatchCalculateR1PlusR2,
  dispatchRenameCircuit,
} from '../extraction/stage6-dispatchers-circuit.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mkLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

// Drive the REAL dispatchers to obtain the ACTUAL F/U-2/3 voice-notice
// renderings (not local retypes) — Codex diff-review r1: production wording
// must be the source of truth so template drift can't silently pass this pin.
// Both rotation variants come from two turnIds whose djb2 index picks 0 and 1
// (djb2('t1')%2===0, djb2('t2')%2===1).
async function realNoticeSweep() {
  const out = [];
  const ctx = (perTurnWrites, turnId) => ({
    session: {
      sessionId: 'cw-fallback-test',
      stateSnapshot: {
        circuits: {},
        boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
        currentBoardId: 'main',
        pending_readings: [],
        observations: [],
        validation_alerts: [],
      },
    },
    logger: mkLogger(),
    turnId,
    perTurnWrites,
    round: 0,
  });

  // wholly-already_set calc notices — calculate_zs ('Zs') + calculate_r1_plus_r2
  // ('R1 plus R2'), circuit counts 1–6, both rotation variants (t1 / t2).
  for (let n = 1; n <= 6; n += 1) {
    const refs = Array.from({ length: n }, (_, i) => i + 1);
    for (const turnId of ['t1', 't2']) {
      // Zs: every selected circuit already has measured_zs_ohm → already_set.
      {
        const c = ctx(createPerTurnWrites(), turnId);
        refs.forEach((r) => (c.session.stateSnapshot.circuits[r] = { measured_zs_ohm: '1.10' }));
        await dispatchCalculateZs(
          { tool_call_id: `z${n}`, name: 'calculate_zs', input: { circuit_refs: refs } },
          c
        );
        out.push(...c.perTurnWrites.voiceNotices.map((v) => v.text));
      }
      // R1+R2: every selected circuit already has r1_r2_ohm → already_set.
      {
        const c = ctx(createPerTurnWrites(), turnId);
        refs.forEach((r) => (c.session.stateSnapshot.circuits[r] = { r1_r2_ohm: '0.42' }));
        await dispatchCalculateR1PlusR2(
          {
            tool_call_id: `r${n}`,
            name: 'calculate_r1_plus_r2',
            input: { circuit_refs: refs, method: 'zs_minus_ze' },
          },
          c
        );
        out.push(...c.perTurnWrites.voiceNotices.map((v) => v.text));
      }
    }
  }

  // rename-to-same notices, both rotation variants.
  for (const turnId of ['t1', 't2']) {
    const c = ctx(createPerTurnWrites(), turnId);
    c.session.stateSnapshot.circuits[4] = { circuit_designation: 'Cooker' };
    await dispatchRenameCircuit(
      { tool_call_id: 'rn', name: 'rename_circuit', input: { from_ref: 4, circuit_ref: 4 } },
      c
    );
    out.push(...c.perTurnWrites.voiceNotices.map((v) => v.text));
  }
  return out;
}

describe('CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT — cross-family distinctness', () => {
  let ALL_BACKEND_LINES;
  beforeAll(async () => {
    ALL_BACKEND_LINES = [
      ...NOOP_AUDIBILITY_PROMPTS,
      ...CATCHALL_AUDIBILITY_PROMPTS,
      ASK_AUDIBILITY_FALLBACK_TEXT,
      // pending-value apology (stage6-dispatcher-ask.js PENDING_VALUE_APOLOGY —
      // a private const; mirrored here so a change to it fails this pin).
      "Sorry, I couldn't place that reading — could you say the field and value together again?",
      ...(await realNoticeSweep()),
    ];
  });

  test('is a non-empty string', () => {
    expect(typeof CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT).toBe('string');
    expect(CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT.trim().length).toBeGreaterThan(0);
  });

  test('the real-dispatcher notice sweep produced renderings for counts 1–6 both families', () => {
    // Sanity: prove the sweep actually exercised the production path (a silent
    // empty sweep would make the distinctness test vacuously pass).
    expect(ALL_BACKEND_LINES).toContain(
      'Zs for circuit 1 is already recorded — say a new reading to replace it.'
    );
    expect(ALL_BACKEND_LINES).toContain(
      'R1 plus R2 for circuit 1 is already recorded — say a new reading to replace it.'
    );
    // A >4 count renders the "those N circuits" scope.
    expect(ALL_BACKEND_LINES.some((l) => /those 5 circuits/.test(l))).toBe(true);
    expect(ALL_BACKEND_LINES.some((l) => /those 6 circuits/.test(l))).toBe(true);
    // The rename family is present.
    expect(ALL_BACKEND_LINES.some((l) => /Circuit 4 is unchanged/.test(l))).toBe(true);
  });

  test('differs (full-string) from every backend field-nil spoken line', () => {
    for (const line of ALL_BACKEND_LINES) {
      expect(CLIENT_CHIME_WATCHDOG_FALLBACK_TEXT).not.toBe(line);
    }
  });
});
