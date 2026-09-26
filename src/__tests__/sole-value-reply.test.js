/**
 * PLAN-W1 M2 — the shared sole-value grammar. Pins the plan's accept and reject
 * vectors and every audit example. A reply matches only when the WHOLE reply is
 * one value; everything else is null, which each caller routes to its handoff.
 */

import {
  matchSoleValueReply,
  SOLE_VALUE_GRAMMARS as G,
  unitFamilyOf,
  fieldUnitFamily,
  notApplicableDeviceOf,
  fieldDevice,
} from '../extraction/sole-value-reply.js';
import { NUMERIC_READING_FIELDS } from '../extraction/value-enum-validator.js';

const value = (reply, grammar, options) => matchSoleValueReply(reply, grammar, options)?.value;

describe('reading grammar', () => {
  test.each(['0.47', '.43', "it's 0.47 ohms", "No, it's 0.85", 'yeah 0.47.'])(
    '%s → a value',
    (r) => {
      expect(value(r, G.reading, { contextField: 'measured_zs_ohm' })).toMatch(/^\.?\d/);
    }
  );

  test('".43" captures the leading-dot token (the caller normalises it)', () => {
    expect(value('.43', G.reading)).toBe('.43');
  });

  test('asked-field label lead-in', () => {
    expect(value('Zs is 0.47', G.reading, { contextField: 'measured_zs_ohm' })).toBe('0.47');
    expect(value('R1 plus R2 is 0.35', G.reading, { contextField: 'r1_r2_ohm' })).toBe('0.35');
    expect(value('Zs is 0.47', G.reading, { contextField: 'r1_r2_ohm' })).toBeUndefined();
    // The RCD slot alias canonicalises to the same field as the table's entry.
    expect(value('trip time 25 ms', G.reading, { contextField: 'rcd_trip_time' })).toBe('25');
  });

  test.each([
    ['LIM', 'LIM'],
    ["it's a limitation", 'limitation'],
    ['open circuit', 'open circuit'],
  ])('%s → token %s', (r, token) => {
    expect(value(r, G.reading)).toBe(token);
  });

  test('"25 milliseconds" → value 25 with a millisecond unit', () => {
    const m = matchSoleValueReply('25 milliseconds', G.reading);
    expect(m).toEqual({ value: '25', unit: 'milliseconds' });
    expect(unitFamilyOf(m.unit)).toBe('millisecond');
  });

  test.each([
    '0.47, not 0.7',
    '0.7 no 0.47',
    "It's not LIM, it's 0.4",
    "I'll have to open it up",
    'Give me 2 seconds',
    'the old one',
    '0.47 for circuit 5',
    '0.47 I think',
    'it came out at 0.47',
    '2.5 mm',
  ])('%s → null', (r) => {
    expect(matchSoleValueReply(r, G.reading, { contextField: 'r1_r2_ohm' })).toBeNull();
  });
});

describe('slot grammars', () => {
  test.each(['32', '32 amps', 'a 32', '32A'])('amps: %s → 32', (r) => {
    expect(value(r, G.amps)).toBe('32');
  });
  test.each(['give me 2 minutes', "it's a 32 amp breaker"])('amps: %s → null', (r) => {
    expect(matchSoleValueReply(r, G.amps)).toBeNull();
  });
  test('ohms: "the breaker\'s a B32" → null', () => {
    expect(matchSoleValueReply("the breaker's a B32", G.ohms)).toBeNull();
  });
  test('ohms: ".43" → .43', () => {
    expect(value('.43', G.ohms)).toBe('.43');
  });
  test.each([
    ['greater than 200', 'greater than 200'],
    ['>200', '>200'],
    ['OL', 'OL'],
    ['200 megs', '200'],
  ])('megaohms: %s → %s', (r, token) => {
    expect(value(r, G.megaohms)).toBe(token);
  });
  test.each(['hang on 2 secs', 'what is the max for this', 'the limb is fine'])(
    'megaohms: %s → null',
    (r) => {
      expect(matchSoleValueReply(r, G.megaohms)).toBeNull();
    }
  );
  test.each(['Type A', 'A', 'AC'])('rcdType: %s → a token', (r) => {
    expect(value(r, G.rcdType)).toBe(r);
  });
  test.each(['the main switch is type AC but this one is A', "it's a type B RCBO"])(
    'rcdType: %s → null',
    (r) => {
      expect(matchSoleValueReply(r, G.rcdType)).toBeNull();
    }
  );
  test.each(['61009', 'BS EN 61009'])('bsCode: %s → 61009', (r) => {
    expect(value(r, G.bsCode)).toBe('61009');
  });
  test.each(['not 61008, 61009', "there's no RCD on this one, it's a 61009"])(
    'bsCode: %s → null',
    (r) => {
      expect(matchSoleValueReply(r, G.bsCode)).toBeNull();
    }
  );
  test.each(['kA', '6 kA', '6'])('kiloamps: "%s"', (r) => {
    expect(value(r, G.kiloamps) ?? null).toBe(r === 'kA' ? null : '6');
  });
  test.each(['30', '30 mA', '30 milliamps'])('milliamps: %s → 30', (r) => {
    expect(value(r, G.milliamps)).toBe('30');
  });
});

describe('notApplicable grammar', () => {
  test.each([
    ['N/A', 'any'],
    ['none', 'any'],
    ['no RCD fitted', 'rcd'],
    ['no ocpd', 'ocpd'],
    ['no RCD', 'rcd'],
  ])('%s → token, device %s', (r, device) => {
    const m = matchSoleValueReply(r, G.notApplicable);
    expect(m).not.toBeNull();
    expect(notApplicableDeviceOf(m.value)).toBe(device);
  });
  test('"none of that 61008 stuff, it\'s 61009" → null', () => {
    expect(matchSoleValueReply("none of that 61008 stuff, it's 61009", G.notApplicable)).toBeNull();
  });
  test('field devices', () => {
    expect(fieldDevice('rcd_bs_en')).toBe('rcd');
    expect(fieldDevice('ocpd_type')).toBe('ocpd');
    expect(fieldDevice('spd_bs_en')).toBe('spd');
    expect(fieldDevice('afdd_button_confirmed')).toBeNull();
  });
});

describe('unit families (W1-2)', () => {
  test('every numeric reading field has a unit family', () => {
    for (const field of NUMERIC_READING_FIELDS) {
      expect([field, fieldUnitFamily(field)]).toEqual([field, expect.any(String)]);
    }
  });
  test('suffix precedence: _mohm before _ohm, _ma/_ka before _a', () => {
    expect(fieldUnitFamily('ir_live_earth_mohm')).toBe('megaohm');
    expect(fieldUnitFamily('ring_r1_ohm')).toBe('ohm');
    expect(fieldUnitFamily('rcd_operating_current_ma')).toBe('milliamp');
    expect(fieldUnitFamily('ocpd_breaking_capacity_ka')).toBe('kiloamp');
    expect(fieldUnitFamily('ocpd_rating_a')).toBe('amp');
    expect(fieldUnitFamily('rcd_trip_time')).toBe('millisecond');
    expect(fieldUnitFamily('live_csa_mm2')).toBeNull();
  });
  test.each([
    ['ohms', 'ohm'],
    ['Ω', 'ohm'],
    ['megs', 'megaohm'],
    ['meg ohms', 'megaohm'],
    ['milligrams', 'megaohm'],
    ['ms', 'millisecond'],
    ['milliseconds', 'millisecond'],
    ['amps', 'amp'],
    ['A', 'amp'],
    ['kA', 'kiloamp'],
    ['mA', 'milliamp'],
    ['volts', 'volt'],
  ])('%s → %s', (unit, family) => {
    expect(unitFamilyOf(unit)).toBe(family);
  });
});
