/**
 * Audit-2026-06-02 Phase 3 — dialogue-engine wire emit applies
 * canonical → legacy field-name correction inline.
 *
 * Pre-Phase-3 a dialogue-driven write of `ir_live_live_mohm`
 * shipped to iOS with the canonical name (the
 * `validateAndCorrectFields` rewrite in sonnet-stream.js ran only
 * on Sonnet's `result.extracted_readings`, not on the engine's
 * buildExtractionPayload emits). iOS handled both via dual aliases
 * in `applySonnetReadings` (DeepgramRecordingViewModel.swift:4702,
 * 4709, etc.) but the wire shape documented the leak as reality.
 *
 * Phase 3 wires `applyFieldNameCorrection` into
 * buildExtractionPayload so canonical names get rewritten to the
 * legacy form before they hit `extracted_readings.readings`. Two
 * audit probes (probe_insulation_garbled_installation +
 * probe_ring_garbled_wing) shifted their assertions from canonical
 * to legacy names alongside this change.
 */

import { applyFieldNameCorrection } from '../extraction/field-name-corrections.js';
import { buildExtractionPayload } from '../extraction/dialogue-engine/helpers/wire-emit.js';

describe('applyFieldNameCorrection — pure helper', () => {
  test('rewrites a canonical name to its legacy form', () => {
    const reading = { field: 'ir_live_live_mohm', circuit: 3, value: '200' };
    const result = applyFieldNameCorrection(reading);
    expect(result).toBe(reading); // mutated in place + returned
    expect(reading.field).toBe('insulation_resistance_l_l');
  });

  test('rewrites ring_r1_ohm to ring_continuity_r1', () => {
    const reading = { field: 'ring_r1_ohm', circuit: 1, value: '0.43' };
    applyFieldNameCorrection(reading);
    expect(reading.field).toBe('ring_continuity_r1');
  });

  test('rewrites measured_zs_ohm to zs', () => {
    const reading = { field: 'measured_zs_ohm', circuit: 4, value: '0.5' };
    applyFieldNameCorrection(reading);
    expect(reading.field).toBe('zs');
  });

  test('no-op when the name has no FIELD_CORRECTIONS entry (passes through unchanged)', () => {
    const reading = { field: 'ocpd_bs_en', circuit: 2, value: 'BS EN 61009' };
    applyFieldNameCorrection(reading);
    expect(reading.field).toBe('ocpd_bs_en');
  });

  test('no-op on missing field — defensive guard', () => {
    const reading = { circuit: 2, value: 'x' };
    expect(() => applyFieldNameCorrection(reading)).not.toThrow();
    expect(reading.field).toBeUndefined();
  });

  test('logs "Field corrected" via the optional logger when a rewrite fires', () => {
    const events = [];
    const logger = {
      info: (msg, meta) => events.push({ msg, meta }),
    };
    const reading = { field: 'ir_live_live_mohm', circuit: 3, value: '200' };
    applyFieldNameCorrection(reading, 'sess_abc', logger);
    expect(events).toEqual([
      {
        msg: 'Field corrected',
        meta: { sessionId: 'sess_abc', from: 'ir_live_live_mohm', to: 'insulation_resistance_l_l' },
      },
    ]);
  });

  test('does NOT log when no rewrite fires', () => {
    const events = [];
    const logger = { info: (msg, meta) => events.push({ msg, meta }) };
    applyFieldNameCorrection(
      { field: 'ocpd_bs_en', circuit: 2, value: 'BS EN 61009' },
      'sess',
      logger
    );
    expect(events).toEqual([]);
  });
});

describe('buildExtractionPayload — Phase 3 inline correction', () => {
  test('canonical ir_live_live_mohm rewritten to legacy on the wire', () => {
    const payload = buildExtractionPayload(
      3,
      [{ field: 'ir_live_live_mohm', value: '200' }],
      'ir_script'
    );
    expect(payload.result.readings[0].field).toBe('insulation_resistance_l_l');
    expect(payload.result.readings[0].value).toBe('200');
    expect(payload.result.readings[0].circuit).toBe(3);
  });

  test('canonical ring_r1_ohm rewritten to legacy on the wire', () => {
    const payload = buildExtractionPayload(
      1,
      [{ field: 'ring_r1_ohm', value: '0.43' }],
      'ring_script'
    );
    expect(payload.result.readings[0].field).toBe('ring_continuity_r1');
  });

  test('non-rewriteable fields pass through unchanged (RCBO BS-EN slot)', () => {
    const payload = buildExtractionPayload(
      2,
      [{ field: 'ocpd_bs_en', value: 'BS EN 61009' }],
      'rcbo_script'
    );
    expect(payload.result.readings[0].field).toBe('ocpd_bs_en');
  });

  test('auto_resolved flag preserved across the rewrite', () => {
    const payload = buildExtractionPayload(
      2,
      [
        { field: 'ocpd_bs_en', value: 'BS EN 61009' },
        { field: 'ir_live_live_mohm', value: '200', auto_resolved: true },
      ],
      'rcbo_script'
    );
    expect(payload.result.readings[1].field).toBe('insulation_resistance_l_l');
    expect(payload.result.readings[1].auto_resolved).toBe(true);
  });

  test('multi-reading payload rewrites each independently', () => {
    const payload = buildExtractionPayload(
      5,
      [
        { field: 'ring_r1_ohm', value: '0.43' },
        { field: 'ring_rn_ohm', value: '0.41' },
        { field: 'ring_r2_ohm', value: '0.71' },
      ],
      'ring_script'
    );
    expect(payload.result.readings.map((r) => r.field)).toEqual([
      'ring_continuity_r1',
      'ring_continuity_rn',
      'ring_continuity_r2',
    ]);
  });
});
