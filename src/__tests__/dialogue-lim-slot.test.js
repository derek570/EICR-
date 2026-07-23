/**
 * P3 (2026-07-23, feedback id 86) — dialogue-slot LIM ingestion.
 *
 * The five numeric dialogue-slot parsers must recognise the four canonical LIM
 * forms and return "LIM" (so a LIM answer writes instead of re-asking forever),
 * and the shared dialogue-slot normaliser must accept LIM / reject near-matches,
 * alternate sentinels, out-of-range, and off-ladder values on seeded
 * pending_writes.
 */
import { parseLimSlot } from '../extraction/dialogue-engine/parsers/lim-slot.js';
import { parseAmps } from '../extraction/dialogue-engine/parsers/amps.js';
import { parseKa } from '../extraction/dialogue-engine/parsers/ka.js';
import { parseMa } from '../extraction/dialogue-engine/parsers/ma.js';
import { parseMs } from '../extraction/dialogue-engine/parsers/ms.js';
import { parseVoltage } from '../extraction/dialogue-engine/parsers/voltage.js';
import { parseOhms } from '../extraction/dialogue-engine/parsers/ohms.js';
import { normaliseDialogueSlotWrite } from '../extraction/dialogue-engine/helpers/dialogue-slot-normalise.js';
import { ocpdSchema } from '../extraction/dialogue-engine/schemas/ocpd.js';

const NUMERIC_PARSERS = [
  ['parseAmps', parseAmps],
  ['parseKa', parseKa],
  ['parseMa', parseMa],
  ['parseMs', parseMs],
  ['parseVoltage', parseVoltage],
  ['parseOhms', parseOhms],
];

describe('parseLimSlot — four-form matcher', () => {
  test.each(['LIM', 'lim', 'limb', 'limp', 'limitation'])('"%s" → LIM', (v) => {
    expect(parseLimSlot(v)).toBe('LIM');
  });
  test.each(['limit', 'limited', 'lynn', 'lym', 'climbing', '32'])('near/other "%s" → null', (v) => {
    expect(parseLimSlot(v)).toBeNull();
  });
});

describe('numeric slot parsers accept the four LIM forms', () => {
  for (const [name, parser] of NUMERIC_PARSERS) {
    test.each(['LIM', 'limb', 'limp', 'limitation'])(`${name}("%s") → LIM`, (v) => {
      expect(parser(v)).toBe('LIM');
    });
    test.each(['limited', 'lynn', 'lym'])(`${name} near-match "%s" not LIM`, (v) => {
      expect(parser(v)).not.toBe('LIM');
    });
  }
});

describe('numeric slot parsers still parse their numerics (no regression)', () => {
  test('amps 32 / ka 6 / ma 30 / ms 25 / voltage 500 / ohms 0.43', () => {
    expect(parseAmps('32 amps')).toBe('32');
    expect(parseKa('6 kA')).toBe('6');
    expect(parseMa('30 mA')).toBe('30');
    expect(parseMs('25 ms')).toBe('25');
    expect(parseVoltage('500')).toBe('500');
    expect(parseOhms('0.43')).toBe('0.43');
  });
});

describe('normaliseDialogueSlotWrite — seeded pending_writes gate', () => {
  test('accepts a LIM garble → canonical LIM on a numeric reading field', () => {
    expect(normaliseDialogueSlotWrite(ocpdSchema, 'ocpd_rating_a', 'limitation')).toEqual({
      ok: true,
      value: 'LIM',
    });
  });

  test('rejects a near-match on a numeric reading field', () => {
    expect(normaliseDialogueSlotWrite(ocpdSchema, 'ocpd_rating_a', 'limited').ok).toBe(false);
  });

  test('rejects an out-of-range numeric on a ranged field', () => {
    expect(normaliseDialogueSlotWrite(ocpdSchema, 'ocpd_rating_a', '9999').ok).toBe(false);
    expect(normaliseDialogueSlotWrite(ocpdSchema, 'ocpd_rating_a', '32').ok).toBe(true);
  });

  test('honours the OCPD-kA allowedValues ladder, but accepts LIM', () => {
    // 66 kA is off-ladder → rejected.
    expect(normaliseDialogueSlotWrite(ocpdSchema, 'ocpd_breaking_capacity_ka', '66').ok).toBe(false);
    expect(normaliseDialogueSlotWrite(ocpdSchema, 'ocpd_breaking_capacity_ka', '6').ok).toBe(true);
    expect(normaliseDialogueSlotWrite(ocpdSchema, 'ocpd_breaking_capacity_ka', 'limitation')).toEqual(
      { ok: true, value: 'LIM' }
    );
  });

  test('rcd_trip_time alias validates against canonical rcd_time_ms bounds', () => {
    expect(normaliseDialogueSlotWrite(ocpdSchema, 'rcd_trip_time', 'LIM')).toEqual({
      ok: true,
      value: 'LIM',
    });
    expect(normaliseDialogueSlotWrite(ocpdSchema, 'rcd_trip_time', '5000').ok).toBe(false);
  });

  test('non-numeric-reading field passes through unchanged (bs_en/Y-N seed behaviour)', () => {
    expect(normaliseDialogueSlotWrite(ocpdSchema, 'ocpd_type', 'B')).toEqual({ ok: true, value: 'B' });
  });
});
