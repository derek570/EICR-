/**
 * Plan 06-23 obs-#52 Fix B — regulation-lookup unit tests.
 *
 * Locks the key-normalisation + table HIT/MISS behaviour the
 * record_observation dispatcher relies on to attach canonical BS 7671 wording.
 */

import fssync from 'node:fs';

import {
  crossCheckObservationRegulation,
  deriveRegulationRef,
  lookupRegulation,
} from '../extraction/regulation-lookup.js';

describe('deriveRegulationRef — bare table-key normalisation', () => {
  test('bare numeric ref → itself', () => {
    expect(deriveRegulationRef('411.3.3')).toBe('411.3.3');
  });

  test('ref + spaced wording → strips the wording tail', () => {
    expect(deriveRegulationRef('411.3.3 — model wording here')).toBe('411.3.3');
    expect(deriveRegulationRef('411.3.3 - model wording')).toBe('411.3.3');
    expect(deriveRegulationRef('411.3.3: model wording')).toBe('411.3.3');
  });

  test('"Regulation <num>" / "Reg <num>" prefix is stripped', () => {
    expect(deriveRegulationRef('Regulation 411.3.3')).toBe('411.3.3');
    expect(deriveRegulationRef('Reg 411.3.3')).toBe('411.3.3');
  });

  test('"BS 7671 <num>" standard prefix is stripped to the bare key', () => {
    expect(deriveRegulationRef('BS 7671 411.3.3')).toBe('411.3.3');
  });

  test('4-component section ref (e.g. 701.411.3.3) preserved', () => {
    expect(deriveRegulationRef('701.411.3.3')).toBe('701.411.3.3');
  });

  test('non-numeric / bare-standard / empty → null', () => {
    expect(deriveRegulationRef('BS 7671 Part 6')).toBeNull();
    expect(deriveRegulationRef('BS 88-2')).toBeNull();
    expect(deriveRegulationRef('')).toBeNull();
    expect(deriveRegulationRef('   ')).toBeNull();
    expect(deriveRegulationRef(null)).toBeNull();
    expect(deriveRegulationRef(42)).toBeNull();
  });
});

describe('lookupRegulation — canonical table lookup', () => {
  test('HIT: 411.3.3 + model wording → canonical entry with title/description', () => {
    const hit = lookupRegulation('411.3.3 — model wording');
    expect(hit).not.toBeNull();
    expect(hit.ref).toBe('411.3.3');
    expect(typeof hit.title).toBe('string');
    expect(hit.title.length).toBeGreaterThan(0);
    expect(typeof hit.description).toBe('string');
  });

  test('MISS: 411.3.4 (schema example, absent from A2:2022 table) → null', () => {
    expect(lookupRegulation('411.3.4 — Additional protection')).toBeNull();
  });

  test('MISS: bare standard name → null', () => {
    expect(lookupRegulation('BS 7671 Part 6')).toBeNull();
  });
});

describe('PLAN-3 A′ — AFDD/SPD topic cross-check', () => {
  test.each(['443.4', '534.4.1'])('AFDD text rejects explicit SPD-family ref %s', (ref) => {
    expect(crossCheckObservationRegulation('AFDD protection is absent', ref)).toMatchObject({
      ok: false,
      code: 'regulation_topic_mismatch',
      ref,
      expectedFamilies: ['421.1.7'],
    });
  });

  test('SPD text rejects exact 421.1.7 but 421.1.201 remains a passthrough', () => {
    expect(crossCheckObservationRegulation('SPD enclosure is damaged', '421.1.7')).toMatchObject({
      ok: false,
      code: 'regulation_topic_mismatch',
    });
    expect(crossCheckObservationRegulation('SPD enclosure is damaged', '421.1.201')).toMatchObject({
      ok: true,
      ref: '421.1.201',
    });
  });

  test.each(['421.1.7', '443.4', null])(
    'dual AFDD + SPD text rejects-and-splits before citation handling (%s)',
    (ref) => {
      expect(
        crossCheckObservationRegulation('AFDD is absent and the SPD indicator has failed', ref)
      ).toMatchObject({
        ok: false,
        code: 'dual_topic_observation',
        topics: ['afdd', 'spd'],
      });
    }
  );

  test('a 534.x table MISS still rejects when the AFDD topic contradicts it', () => {
    expect(lookupRegulation('534.4.1')).toBeNull();
    expect(
      crossCheckObservationRegulation('Arc-fault detection is absent', '534.4.1')
    ).toMatchObject({
      ok: false,
      code: 'regulation_topic_mismatch',
      wellShaped: true,
    });
  });

  test('no-keyword text preserves current HIT/MISS behaviour', () => {
    expect(crossCheckObservationRegulation('Socket enclosure is cracked', '416.2')).toMatchObject({
      ok: true,
      ref: '416.2',
    });
  });

  test('every current RCD/bonding table HIT remains stamp-eligible', () => {
    const table = JSON.parse(fssync.readFileSync('config/bs7671-regulations.json', 'utf8'));
    const entries = table.regulations.filter((entry) =>
      /\bRCD\b|bonding/i.test(`${entry.title ?? ''} ${entry.description ?? ''}`)
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(
        crossCheckObservationRegulation(`${entry.title}. ${entry.description}`, entry.ref)
      ).toMatchObject({ ok: true, ref: entry.ref });
      expect(lookupRegulation(entry.ref)?.ref).toBe(entry.ref);
    }
  });
});
