/**
 * 2026-06-03 — IR bare-bridge single-digit regression guard.
 *
 * Production repro (session 284CBBCD-D6E9-463E-A57B-8A374223D3A4,
 * 08:26:40): inspector finished the IR walk-through for Circuit 4
 * cleanly, then started a second IR walk-through for Circuit 1
 * (Cooker). Engine asked "What's the live-to-live?". Inspector said
 * "Greater than 299". The IR script completed with values
 *   ir_test_voltage_v: "250"
 *   ir_live_live_mohm: "2"          ← BUG (BS 7671 floor is 1 MΩ, but
 *                                       a hand-dictated >299 should NEVER
 *                                       certify as 2)
 *   ir_live_earth_mohm: ">299"
 *
 * The named-extractor for L-L exposed a bare-bridge form:
 *   /\b(?:live\s+to\s+live|l\s+to\s+l|...)\b
 *     [^a-z\d∞]{0,6}?              ← bare bridge (0-6 punctuation chars)
 *     (MEGAOHMS_VALUE_GROUP)/i
 * which let a Flux-garbled "L L 2 L E greater than 299" sequence
 * certify L-L=2 and L-E=">299" from a single utterance. The "L L 2"
 * fragment matched the L-L label + 1-char bridge + bare-digit value;
 * the trailing "L E greater than 299" then matched the L-E pattern
 * with the safer connector form.
 *
 * Fix (`MEGAOHMS_BARE_SAFE_VALUE_GROUP`): the BARE-bridge arm now
 * rejects single-digit integers — only sentinels (>X, OL, infinite,
 * max, off-scale, out-of-range), decimals (0.5, .43, 2.5), and
 * multi-digit integers (200, 999, 10) can match via the loose bridge.
 * The CONNECTOR arm (`is/was/of/reads/measures/equals/...`) keeps the
 * full value group because the explicit connector is a strong intent
 * signal — "L-L is 2" is unambiguous. The bare-value fallback path
 * (parseMegaohms over the whole text when no named matched) also
 * still accepts single digits because the full text is the context.
 *
 * What this protects against: only the very specific class of Flux
 * mishearing where a saturation-sentinel utterance gets a leading
 * single-digit fragment garbled in. Inspectors who legitimately
 * dictate a single-digit IR reading either:
 *   - say it bare ("five") → bare-value path catches it
 *   - say it with a connector ("L-L is five") → connector path catches it
 *   - say it with a decimal ("0.5") → bare-bridge still accepts decimals
 *   - say it with a unit ("five megaohms") → parseBareMegaohmsWithUnit
 *     handles entry-time + bare-value fallback handles in-script.
 *
 * Tests below split into three groups:
 *   1. Repro guards — pin the specific Flux-garble shapes from
 *      session 284CBBCD.
 *   2. Single-digit acceptance — pin that legitimate single-digit
 *      readings continue to land via the connector / bare-value
 *      fallback paths.
 *   3. Multi-digit / decimal / sentinel preservation — pin that the
 *      bare-bridge path still accepts every form that's not a
 *      lone single-digit integer.
 */

import { extractNamedFieldValues } from '../extraction/dialogue-engine/helpers/extraction.js';
import {
  insulationResistanceSchema,
  processInsulationResistanceTurn,
} from '../extraction/dialogue-engine/index.js';
import {
  parseMegaohms,
  MEGAOHMS_BARE_SAFE_VALUE_GROUP,
} from '../extraction/dialogue-engine/parsers/megaohms.js';

class FakeWS {
  constructor() {
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
  }
  send(d) {
    this.sent.push(JSON.parse(d));
  }
}

const SESSION_ID = 'sess_ir_bare_bridge';

function buildActiveIRSession(circuit_ref, preexistingValues = {}) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: {
      circuits: {
        [circuit_ref]: { circuit_designation: 'Cooker', ...preexistingValues },
      },
    },
    dialogueScriptState: {
      active: true,
      schemaName: 'insulation_resistance',
      circuit_ref,
      values: { ...preexistingValues },
      pending_writes: [],
      skipped_slots: new Set(),
      entered_at: 1000,
      last_activity_at: 1000,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Repro guards — Flux-garbled "L L 2 L E greater than 299" shapes
// ---------------------------------------------------------------------------

describe('IR bare-bridge single-digit rejection — session 284CBBCD repro', () => {
  test('extractNamedFieldValues: "L L 2 L E greater than 299" yields ONLY L-E=>299 (no L-L=2)', () => {
    const out = extractNamedFieldValues(
      'L L 2 L E greater than 299',
      insulationResistanceSchema.slots
    );
    expect(out).toEqual([{ field: 'ir_live_earth_mohm', value: '>299' }]);
  });

  test('extractNamedFieldValues: "L to L 2 L to E greater than 299" yields ONLY L-E=>299', () => {
    const out = extractNamedFieldValues(
      'L to L 2 L to E greater than 299',
      insulationResistanceSchema.slots
    );
    expect(out).toEqual([{ field: 'ir_live_earth_mohm', value: '>299' }]);
  });

  test('extractNamedFieldValues: "live to live 2 live to earth greater than 299" yields ONLY L-E=>299', () => {
    const out = extractNamedFieldValues(
      'live to live 2 live to earth greater than 299',
      insulationResistanceSchema.slots
    );
    expect(out).toEqual([{ field: 'ir_live_earth_mohm', value: '>299' }]);
  });

  test('extractNamedFieldValues: "L L 5 L E OL" yields ONLY L-E=>999 (single-digit L-L rejected)', () => {
    const out = extractNamedFieldValues('L L 5 L E OL', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_earth_mohm', value: '>999' }]);
  });

  test('engine end-to-end: garbled input completes script with L-L unfilled (re-ask pending)', () => {
    const session = buildActiveIRSession(1, { ir_test_voltage_v: '250' });
    const ws = new FakeWS();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'L L 2 L E greater than 299',
      now: 5000,
    });
    // L-L should NOT be filled — engine re-asks via the next turn.
    expect(session.stateSnapshot.circuits[1].ir_live_live_mohm).toBeUndefined();
    expect(session.stateSnapshot.circuits[1].ir_live_earth_mohm).toBe('>299');
    expect(session.stateSnapshot.circuits[1].ir_test_voltage_v).toBe('250');
  });

  test('engine: clean "Greater than 299." still writes L-L=>299 (regression guard)', () => {
    const session = buildActiveIRSession(1, { ir_test_voltage_v: '250' });
    const ws = new FakeWS();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Greater than 299.',
      now: 5000,
    });
    expect(session.stateSnapshot.circuits[1].ir_live_live_mohm).toBe('>299');
  });
});

// ---------------------------------------------------------------------------
// 2. Single-digit acceptance — legitimate single-digit readings
// ---------------------------------------------------------------------------

describe('IR bare-bridge fix — legitimate single-digit IR readings continue to land', () => {
  test('connector form: "L L is 5" writes L-L=5 (connector keeps full value group)', () => {
    const out = extractNamedFieldValues('L L is 5', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_live_mohm', value: '5' }]);
  });

  test('connector form: "live to live was 2" writes L-L=2', () => {
    const out = extractNamedFieldValues('live to live was 2', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_live_mohm', value: '2' }]);
  });

  test('connector form: "L to L equals 1" writes L-L=1', () => {
    const out = extractNamedFieldValues('L to L equals 1', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_live_mohm', value: '1' }]);
  });

  test('bare-value fallback: engine receives bare "5" and writes L-L=5', () => {
    const session = buildActiveIRSession(1, { ir_test_voltage_v: '250' });
    const ws = new FakeWS();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '5',
      now: 5000,
    });
    expect(session.stateSnapshot.circuits[1].ir_live_live_mohm).toBe('5');
  });

  test('bare-value fallback: engine receives bare "5." (with period) and writes L-L=5', () => {
    const session = buildActiveIRSession(1, { ir_test_voltage_v: '250' });
    const ws = new FakeWS();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '5.',
      now: 5000,
    });
    expect(session.stateSnapshot.circuits[1].ir_live_live_mohm).toBe('5');
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-digit / decimal / sentinel preservation via bare-bridge
// ---------------------------------------------------------------------------

describe('IR bare-bridge fix — multi-digit / decimal / sentinel forms still match via bare bridge', () => {
  test('"L-L 200" matches via bare bridge', () => {
    const out = extractNamedFieldValues('L-L 200', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_live_mohm', value: '200' }]);
  });

  test('"L-L 999" matches via bare bridge', () => {
    const out = extractNamedFieldValues('L-L 999', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_live_mohm', value: '999' }]);
  });

  test('"L-L >299" matches via bare bridge (sentinel)', () => {
    const out = extractNamedFieldValues('L-L >299', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_live_mohm', value: '>299' }]);
  });

  test('"L-L 0.5" matches via bare bridge (decimal)', () => {
    const out = extractNamedFieldValues('L-L 0.5', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_live_mohm', value: '0.5' }]);
  });

  test('"L-L .43" matches via bare bridge (leading-zero decimal)', () => {
    const out = extractNamedFieldValues('L-L .43', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_live_mohm', value: '0.43' }]);
  });

  test('"L-L OL" matches via bare bridge (saturation sentinel)', () => {
    const out = extractNamedFieldValues('L-L OL', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_live_mohm', value: '>999' }]);
  });

  test('"L-L infinite" matches via bare bridge', () => {
    const out = extractNamedFieldValues('L-L infinite', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_live_mohm', value: '>999' }]);
  });

  test('"L-L 10" matches via bare bridge (two-digit)', () => {
    const out = extractNamedFieldValues('L-L 10', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_live_mohm', value: '10' }]);
  });

  test('"L-E 200" matches via bare bridge (symmetric to L-L)', () => {
    const out = extractNamedFieldValues('L-E 200', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_earth_mohm', value: '200' }]);
  });

  test('"L-E >999" matches via bare bridge', () => {
    const out = extractNamedFieldValues('L-E >999', insulationResistanceSchema.slots);
    expect(out).toEqual([{ field: 'ir_live_earth_mohm', value: '>999' }]);
  });
});

// ---------------------------------------------------------------------------
// 4. Sanity — the BARE_SAFE value group exists + parseMegaohms unchanged
// ---------------------------------------------------------------------------

describe('MEGAOHMS_BARE_SAFE_VALUE_GROUP — module shape', () => {
  test('exports a string regex fragment', () => {
    expect(typeof MEGAOHMS_BARE_SAFE_VALUE_GROUP).toBe('string');
    expect(MEGAOHMS_BARE_SAFE_VALUE_GROUP.length).toBeGreaterThan(0);
  });

  test('does NOT contain the loose bare-digit `\\d*\\.?\\d+` form', () => {
    expect(MEGAOHMS_BARE_SAFE_VALUE_GROUP).not.toMatch(/\\d\*\\\.\?\\d\+/);
  });

  test('contains the multi-digit `\\d{2,}` form', () => {
    expect(MEGAOHMS_BARE_SAFE_VALUE_GROUP).toContain('\\d{2,}');
  });

  test('contains decimal forms', () => {
    expect(MEGAOHMS_BARE_SAFE_VALUE_GROUP).toContain('\\d+\\.\\d+');
    expect(MEGAOHMS_BARE_SAFE_VALUE_GROUP).toContain('\\.\\d+');
  });
});

describe('parseMegaohms — unchanged by the fix (still handles all forms incl. single-digit)', () => {
  test('"Greater than 299." still returns ">299"', () => {
    expect(parseMegaohms('Greater than 299.')).toBe('>299');
  });

  test('"2" still returns "2" (used by bare-value fallback)', () => {
    expect(parseMegaohms('2')).toBe('2');
  });

  test('"OL" still returns ">999"', () => {
    expect(parseMegaohms('OL')).toBe('>999');
  });

  test('"0.5" still returns "0.5"', () => {
    expect(parseMegaohms('0.5')).toBe('0.5');
  });
});
