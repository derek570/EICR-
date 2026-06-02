/**
 * Audit-2026-06-02 Phase 2 — derivation mirror writes reach the wire.
 *
 * Pre-Phase-2 applyDerivations only mutated the snapshot + state.values.
 * Engine call sites that built buildExtractionPayload(circuit_ref, writes)
 * pushed only the originating slot write to the writes array — mirrors
 * never appeared in extracted_readings. Two consequences:
 *
 *   1. iOS column for the mirrored field never updated until the next
 *      user-driven re-render. The inspector dictated "RCBO on circuit 2
 *      BS EN 61009" and only saw ocpd_bs_en go green; rcd_bs_en stayed
 *      empty visually despite the snapshot carrying both values.
 *
 *   2. Audit probes probe_rcd_bs_en_61009_pivots_to_rcbo +
 *      probe_ocpd_bs_en_61009_enters_rcbo asserted has_reading on the
 *      mirrored field and FAILed because the wire envelope never
 *      carried it.
 *
 * Phase 2 surface: applyDerivations now returns {pivotTo, mirrorWrites,
 * setWrites}. Callers prepend mirrors + sets to writes[] with
 * auto_resolved:true. buildExtractionPayload propagates the flag onto
 * the reading. tryEnterScriptFromWrites seed loop returns mirrorWrites
 * so the shadow-harness can fold them onto result.extracted_readings
 * in the SAME envelope as Sonnet's originating write (ordering matters
 * — a separate safeSend from inside the seed loop would arrive on the
 * wire before the originating extraction).
 */

import { applyDerivations } from '../extraction/dialogue-engine/helpers/derivations.js';
import { buildExtractionPayload } from '../extraction/dialogue-engine/helpers/wire-emit.js';
import { rcboSchema } from '../extraction/dialogue-engine/index.js';

// ---------------------------------------------------------------------------
// applyDerivations — Phase 2 return shape
// ---------------------------------------------------------------------------

describe('applyDerivations — Phase 2 return shape', () => {
  function buildSession(circuits = {}) {
    return {
      stateSnapshot: { circuits: JSON.parse(JSON.stringify(circuits)) },
      dialogueScriptState: { circuit_ref: 5, values: {} },
    };
  }

  test('returns {pivotTo, mirrorWrites, setWrites} with empty arrays for slots without derivations', () => {
    const session = buildSession({ 5: {} });
    const slot = { field: 'rcd_type', derivations: undefined };
    const r = applyDerivations({ session, schema: rcboSchema, slot, value: 'AC' });
    expect(r).toEqual({ pivotTo: null, mirrorWrites: [], setWrites: [] });
  });

  test('mirrorWrites populated for unconditional mirror derivation', () => {
    const session = buildSession({ 5: {} });
    const slot = {
      field: 'ocpd_bs_en',
      kind: 'bs_code',
      derivations: [{ mirrors: ['rcd_bs_en'] }],
    };
    const r = applyDerivations({ session, schema: rcboSchema, slot, value: 'BS EN 61009' });
    expect(r.mirrorWrites).toEqual([{ field: 'rcd_bs_en', value: 'BS EN 61009' }]);
    expect(r.setWrites).toEqual([]);
    expect(r.pivotTo).toBeNull();
  });

  test('mirrorWrites empty when derivation value does not match (literal-gated)', () => {
    const session = buildSession({ 5: {} });
    const slot = {
      field: 'ocpd_bs_en',
      kind: 'bs_code',
      derivations: [{ value: '61009', mirrors: ['rcd_bs_en'] }],
    };
    const r = applyDerivations({ session, schema: rcboSchema, slot, value: 'BS EN 60898' });
    expect(r.mirrorWrites).toEqual([]);
    expect(r.setWrites).toEqual([]);
  });

  test('setWrites populated for sets derivation; mirrors empty', () => {
    const session = buildSession({ 5: {} });
    const slot = {
      field: 'ocpd_bs_en',
      kind: 'bs_code',
      derivations: [{ value: '3036', sets: { ocpd_type: 'Rew' } }],
    };
    const r = applyDerivations({ session, schema: rcboSchema, slot, value: 'BS 3036' });
    expect(r.setWrites).toEqual([{ field: 'ocpd_type', value: 'Rew' }]);
    expect(r.mirrorWrites).toEqual([]);
  });

  test('snapshot + state.values still mutated alongside the return shape', () => {
    const session = buildSession({ 5: {} });
    const slot = {
      field: 'ocpd_bs_en',
      kind: 'bs_code',
      derivations: [{ mirrors: ['rcd_bs_en'] }],
    };
    applyDerivations({ session, schema: rcboSchema, slot, value: 'BS EN 61008' });
    expect(session.stateSnapshot.circuits[5].rcd_bs_en).toBe('BS EN 61008');
    expect(session.dialogueScriptState.values.rcd_bs_en).toBe('BS EN 61008');
  });

  test('pivot + mirror co-exist in one derivation entry', () => {
    const session = buildSession({ 5: {} });
    const slot = {
      field: 'ocpd_bs_en',
      kind: 'bs_code',
      derivations: [{ value: '61009', pivot: 'rcbo', mirrors: ['rcd_bs_en'] }],
    };
    const r = applyDerivations({ session, schema: rcboSchema, slot, value: 'BS EN 61009' });
    expect(r.pivotTo).toBe('rcbo');
    expect(r.mirrorWrites).toEqual([{ field: 'rcd_bs_en', value: 'BS EN 61009' }]);
  });
});

// ---------------------------------------------------------------------------
// buildExtractionPayload — auto_resolved propagation
// ---------------------------------------------------------------------------

describe('buildExtractionPayload — auto_resolved propagation', () => {
  test('readings without auto_resolved keep the legacy wire shape (no extra key)', () => {
    const payload = buildExtractionPayload(
      3,
      [{ field: 'ocpd_bs_en', value: 'BS EN 61009' }],
      'rcbo_script'
    );
    expect(payload.result.readings[0]).toEqual({
      field: 'ocpd_bs_en',
      circuit: 3,
      value: 'BS EN 61009',
      confidence: 1.0,
      source: 'rcbo_script',
    });
    expect(payload.result.readings[0].auto_resolved).toBeUndefined();
  });

  test('readings with auto_resolved:true propagate the flag', () => {
    const payload = buildExtractionPayload(
      3,
      [
        { field: 'ocpd_bs_en', value: 'BS EN 61009' },
        { field: 'rcd_bs_en', value: 'BS EN 61009', auto_resolved: true },
      ],
      'rcbo_script'
    );
    expect(payload.result.readings[1].auto_resolved).toBe(true);
    expect(payload.result.readings[0].auto_resolved).toBeUndefined();
  });

  test('mirror-from-applyDerivations + spread-with-auto_resolved produces wire reading with auto_resolved:true', () => {
    // Simulates the engine call-site pattern: derivation returns
    // {field, value}; caller spreads with auto_resolved:true before
    // pushing to writes[].
    const mirror = { field: 'rcd_bs_en', value: 'BS EN 61009' };
    const writes = [
      { field: 'ocpd_bs_en', value: 'BS EN 61009' },
      { ...mirror, auto_resolved: true },
    ];
    const payload = buildExtractionPayload(2, writes, 'rcbo_script');
    expect(payload.result.readings).toHaveLength(2);
    expect(payload.result.readings[1].field).toBe('rcd_bs_en');
    expect(payload.result.readings[1].auto_resolved).toBe(true);
  });
});
