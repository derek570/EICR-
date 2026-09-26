/**
 * PLAN-W1 M4 (B-115, W1-10) — IR leg labels no longer match "I'll", "we'll"
 * or "it'll", and a reply naming BOTH legs picks neither.
 *
 * `\b` sits between an apostrophe and `l`, so the bare `l[\s.-]*l` label arm
 * matched contractions: "we'll, 200" wrote L-L = 200 at step 7, and the
 * bare-value router read "I'll check" as live-to-live. One pair of label
 * sources now feeds all four live sites.
 */

import { ALL_DIALOGUE_SCHEMAS } from '../extraction/dialogue-engine/index.js';
import { extractNamedFieldValues } from '../extraction/dialogue-engine/helpers/extraction.js';

const ir = ALL_DIALOGUE_SCHEMAS.find((s) => s.name === 'insulation_resistance');
const route = (text) => ir.disambiguateBareValue(text);

describe('router — disambiguateBareValue', () => {
  test.each(["I'll check", "we'll see", 'live to live or live to earth?'])(
    'red proof: "%s" → null',
    (text) => {
      expect(route(text)).toBeNull();
    }
  );

  test('red proof: "I\'ll check, live to earth" → L-E', () => {
    expect(route("I'll check, live to earth")).toEqual({ field: 'ir_live_earth_mohm' });
  });

  test.each([
    ['L-L', 'ir_live_live_mohm'],
    ['l l', 'ir_live_live_mohm'],
    ['live to earth', 'ir_live_earth_mohm'],
  ])('control: "%s" → %s', (text, field) => {
    expect(route(text)).toEqual({ field });
  });
});

describe('named extraction — the slot extractors share the guarded labels', () => {
  test.each(["we'll, 200", "I'll 200", "it'll 200"])('red proof: "%s" → no IR capture', (text) => {
    expect(extractNamedFieldValues(text, ir.slots)).toEqual([]);
  });

  test('control: "L-L 200" → L-L 200', () => {
    expect(extractNamedFieldValues('L-L 200', ir.slots)).toEqual([
      { field: 'ir_live_live_mohm', value: '200' },
    ]);
  });

  test('control: the compound entry still captures both legs', () => {
    expect(ir.compoundEntryExtractor('greater than 299 live to live and live to earth')).toEqual([
      { field: 'ir_live_live_mohm', value: '>299' },
      { field: 'ir_live_earth_mohm', value: '>299' },
    ]);
  });
});
