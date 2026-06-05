/**
 * reading-transcript-anchor.test.js — Bug 2 speech-anchor helper.
 *
 * Locks two contracts:
 *   1. Behavioural — the helper returns true when the transcript
 *      contains the field's normalised display label or a known
 *      spoken alias, and false on bare-value utterances.
 *   2. Coverage — every member of RECORDABLE_READING_FIELDS (the
 *      shared whitelist from src/extraction/recordable-reading-fields.js)
 *      must have at least one anchor (label OR alias). Under-coverage
 *      would pollute the warn-only dispatcher metric and skew the
 *      >5%/14-day promotion decision in Bug 2's resolved-questions
 *      block. Single source of truth: the test imports the canonical
 *      Set directly — no second exported "anchor required" set.
 */

import { hasReadingFieldAnchor, normaliseLabel } from '../extraction/reading-transcript-anchor.js';
import { RECORDABLE_READING_FIELDS } from '../extraction/recordable-reading-fields.js';

describe('hasReadingFieldAnchor — behaviour', () => {
  test('returns false on missing transcript (null / undefined / empty)', () => {
    expect(hasReadingFieldAnchor('measured_zs_ohm', null)).toBe(false);
    expect(hasReadingFieldAnchor('measured_zs_ohm', undefined)).toBe(false);
    expect(hasReadingFieldAnchor('measured_zs_ohm', '')).toBe(false);
  });

  test('returns false on missing field', () => {
    expect(hasReadingFieldAnchor('', 'Zs on circuit 3 is 0.18')).toBe(false);
    expect(hasReadingFieldAnchor(null, 'Zs on circuit 3 is 0.18')).toBe(false);
  });

  test('bare-value utterance does NOT anchor any reading field (Bug 2 repro)', () => {
    // The D7D01509 repro shape. No field cue in the words at all.
    expect(hasReadingFieldAnchor('r1_r2_ohm', 'upstairs sockets number 0.6')).toBe(false);
    expect(hasReadingFieldAnchor('measured_zs_ohm', 'upstairs sockets number 0.6')).toBe(false);
  });

  test('spoken alias anchors the canonical field', () => {
    expect(hasReadingFieldAnchor('r1_r2_ohm', 'R1 plus R2 on circuit 4 is 0.6')).toBe(true);
    expect(hasReadingFieldAnchor('measured_zs_ohm', 'Zs on circuit 4 is 0.6')).toBe(true);
    expect(hasReadingFieldAnchor('ze', 'Ze is 0.18')).toBe(true);
    expect(hasReadingFieldAnchor('polarity_confirmed', 'polarity correct')).toBe(true);
    expect(hasReadingFieldAnchor('number_of_points', 'number of points is 4')).toBe(true);
  });

  test('normalised label anchors the field (when alias would not)', () => {
    // R1+R2 (ohm) → r1+r2 — covered by alias too, but the label path
    // proves the parens / units stripping works.
    expect(hasReadingFieldAnchor('r1_r2_ohm', 'r1+r2 on circuit 4 is 0.6')).toBe(true);
    expect(hasReadingFieldAnchor('rcd_time_ms', 'RCD Time is 25 ms')).toBe(true);
  });

  test('wrong-field transcript correctly returns false (no anchor)', () => {
    // "Zs ..." anchors measured_zs_ohm; it does NOT anchor r1_r2_ohm.
    // Mirrors the dispatcher counter-test (the metric must NOT fire
    // when transcript anchors a DIFFERENT field — the WRITE is still
    // unanchored against the requested field, which is exactly what
    // Bug 2 wants to log).
    expect(hasReadingFieldAnchor('r1_r2_ohm', 'Zs on circuit 4 is 0.6')).toBe(false);
  });

  test('legacy wire aliases match too (zs, pfc, r1_plus_r2, rcd_trip_time)', () => {
    // The dispatcher receives canonical names but the regex layer
    // emits legacy aliases — the helper must handle both ends.
    expect(hasReadingFieldAnchor('zs', 'Zs on circuit 3 is 0.18')).toBe(true);
    expect(hasReadingFieldAnchor('pfc', 'PFC is 1.2 kA')).toBe(true);
    expect(hasReadingFieldAnchor('r1_plus_r2', 'R1 plus R2 is 0.42')).toBe(true);
    expect(hasReadingFieldAnchor('rcd_trip_time', 'RCD time was 25 ms')).toBe(true);
  });
});

describe('normaliseLabel — unit stripping', () => {
  test('strips parenthetical content', () => {
    expect(normaliseLabel('R1+R2 (ohm)')).toBe('r1+r2');
    expect(normaliseLabel('Measured Zs (ohm)')).toBe('measured zs');
    expect(normaliseLabel('IR L-L (Mohm)')).toBe('ir l-l');
  });

  test('strips trailing unit tokens left bare by mis-shaped labels', () => {
    // Defence-in-depth — if a future label is "RCD Time ms" (no
    // parens), still strip the trailing unit.
    expect(normaliseLabel('RCD Time ms')).toBe('rcd time');
    expect(normaliseLabel('Max Disconnect Time s')).toBe('max disconnect time');
  });

  test('idempotent / safe on empty + non-string', () => {
    expect(normaliseLabel('')).toBe('');
    expect(normaliseLabel(null)).toBe('');
    expect(normaliseLabel(undefined)).toBe('');
  });
});

describe('hasReadingFieldAnchor — coverage of RECORDABLE_READING_FIELDS', () => {
  // Single-source-of-truth: import the shared Set and iterate. No
  // second exported "anchor required" set. The plan's mandatory
  // coverage assertion: every member must have at least one anchor.
  // Silent under-coverage on a legitimate dictation would pollute the
  // warn-only metric and skew the >5%/14-day promotion decision.
  for (const field of RECORDABLE_READING_FIELDS) {
    test(`field "${field}" has at least one viable anchor`, () => {
      // Construct a synthetic transcript designed to anchor the field
      // via EITHER the normalised display label OR a known spoken
      // alias. The helper's positive return is the proof.
      const aliasProbe = `inspector dictates the ${field.replace(/_/g, ' ')} reading`;
      // The label probe leans on display-name normalisation. Build a
      // plausible utterance from the field name itself; if the field
      // has a label or alias the substring match should hit. If
      // neither anchors, the test fails LOUDLY with the field name.
      const labelProbe = `${field.replace(/_/g, ' ')}`.toLowerCase();
      // Try a generic family-name probe too — "zs", "ir", "rcd",
      // "polarity", "points", "ze", "pfc" — that overlap with the
      // hand-curated alias map. The point is: for EVERY recordable
      // field there should exist SOME natural utterance that anchors
      // it. We probe permissively here and fail only if NONE of the
      // synthetic probes anchor.
      const probes = [
        aliasProbe,
        labelProbe,
        // Field-name as a bare token; this catches `polarity_confirmed`,
        // `number_of_points`, etc. via alias substring matches.
        field.replace(/_/g, ' '),
        // Family-level keywords. These intentionally cast wide.
        'zs ze ir polarity points ring pfc pscc rcd time r1 r2 csa rating breaking',
      ];
      const anyAnchored = probes.some((t) => hasReadingFieldAnchor(field, t));
      if (!anyAnchored) {
        throw new Error(
          `RECORDABLE_READING_FIELDS member "${field}" has no anchor — add ` +
            `it to SPOKEN_ALIASES in reading-transcript-anchor.js OR ensure ` +
            `its display label in config/field_schema.json normalises to a ` +
            `substring of natural inspector speech.`
        );
      }
      expect(anyAnchored).toBe(true);
    });
  }
});
