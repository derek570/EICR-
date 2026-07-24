/**
 * Unit tests for the backend dictation-transcript normaliser (P6).
 *
 * Covers both v1 rules + their boundary/negative cases + idempotency. There is
 * NO unit-garble rule (dropped in refine round 3 as speculative — units are
 * already aliased by parseBareMegaohmsWithUnit).
 */

import { describe, test, expect } from '@jest/globals';
import { normalise, NORMALISE_RULE_IDS } from '../extraction/transcript-normalise.js';

describe('transcript-normalise — rule 1: context-gated "Z s" → "Zs"', () => {
  test('collapses the observed reading-shaped clause (id 89)', () => {
    const r = normalise('Z s on the heating was 0.67');
    expect(r.text).toBe('Zs on the heating was 0.67');
    expect(r.rules_hit).toEqual([NORMALISE_RULE_IDS.ZS_FIELD_TOKEN]);
  });

  test('collapses "Zed s" spelled form in a reading clause', () => {
    expect(normalise('Zed s for the cooker is 0.4').text).toBe('Zs for the cooker is 0.4');
    expect(normalise('zed s reads 1.2').text).toBe('Zs reads 1.2');
  });

  test('collapses with a sentinel value (not just a number)', () => {
    expect(normalise('Z s on the shower was LIM').text).toBe('Zs on the shower was LIM');
  });

  test('lower/upper/mixed casing of the token all collapse', () => {
    expect(normalise('z s on the lights was 0.3').text).toBe('Zs on the lights was 0.3');
    expect(normalise('Z S on the lights was 0.3').text).toBe('Zs on the lights was 0.3');
    expect(normalise('z S on the lights was 0.3').text).toBe('Zs on the lights was 0.3');
  });

  test('already-canonical "Zs" is left untouched (no space to re-trigger)', () => {
    const r = normalise('Zs on the heating was 0.67');
    expect(r.text).toBe('Zs on the heating was 0.67');
    expect(r.rules_hit).toEqual([]);
  });

  // ── Negative cases — genuine two-letter dictation MUST NOT collapse ──
  test('customer name "Z S Electrical" is NOT collapsed (no connector+value)', () => {
    const r = normalise('customer name Z S Electrical');
    expect(r.text).toBe('customer name Z S Electrical');
    expect(r.rules_hit).toEqual([]);
  });

  test('designation "Z S 1" is NOT collapsed (adjacent value, no connector)', () => {
    const r = normalise('designation Z S 1');
    expect(r.text).toBe('designation Z S 1');
    expect(r.rules_hit).toEqual([]);
  });

  test('designation "Z S for circuit 1" is NOT collapsed (scope noun before the value, not a value-connector)', () => {
    // The value "1" is introduced by the scope noun "circuit", NOT by a
    // value-connector (was/is/reads/…), so the reading gate does not fire.
    const r = normalise('designation Z S for circuit 1');
    expect(r.text).toBe('designation Z S for circuit 1');
    expect(r.rules_hit).toEqual([]);
  });

  test('"customer name Z S Electrical for unit 1" is NOT collapsed', () => {
    const r = normalise('customer name Z S Electrical for unit 1');
    expect(r.text).toBe('customer name Z S Electrical for unit 1');
    expect(r.rules_hit).toEqual([]);
  });

  test('an ADDRESS token is NOT collapsed ("at"/"of" are address prepositions, not value-connectors)', () => {
    // "at 1"/"of 10" is an address ("Z S at 1 High Street"), not a reading —
    // "at"/"of" are only scope-prepositions (form B), which need a trailing
    // value-connector, so a bare address never collapses.
    for (const input of [
      'The customer is Z S at 1 High Street',
      'Z S of 10 High Street',
      'client Z S at 5 Mill Lane',
    ]) {
      const r = normalise(input);
      expect(r.text).toBe(input);
      expect(r.rules_hit).toEqual([]);
    }
    // But a scoped reading using at/of as the scope-prep + a trailing connector
    // still collapses.
    expect(normalise('Z s at the cooker was 0.67').text).toBe('Zs at the cooker was 0.67');
  });

  test('a name/address does NOT bridge to a LATER comma-separated field', () => {
    // The scope gap excludes commas, so "…at 1 High Street, supply is 230" can't
    // reach the later "is 230" to satisfy form B — the name stays intact.
    const input = 'Customer name Z S at 1 High Street, supply is 230 volts';
    expect(normalise(input).text).toBe(input);
    expect(normalise(input).rules_hit).toEqual([]);
  });

  test('a name token is NOT collapsed even when a LATER reading shares the comma-joined clause', () => {
    // "Electrical" (a name word) immediately follows the token, so it is neither
    // a value-connector nor a scope-preposition — the later "Ze was 0.67"
    // (belonging to Ze) must not drag the name "Z S" into "Zs".
    const r = normalise('Customer name Z S Electrical, Ze was 0.67');
    expect(r.text).toBe('Customer name Z S Electrical, Ze was 0.67');
    expect(r.rules_hit).toEqual([]);
  });

  test('a value introduced by a value-connector after a scope phrase DOES collapse', () => {
    // "Z s for circuit 3 was 0.67" — the scope "for circuit 3" sits in the gap;
    // the value 0.67 is introduced by "was".
    expect(normalise('Z s for circuit 3 was 0.67').text).toBe('Zs for circuit 3 was 0.67');
  });

  test('a realistic reading scope (within the 60-char bound) collapses', () => {
    const input = 'Z s for the downstairs ring final circuit was 0.67';
    expect(normalise(input).text).toBe('Zs for the downstairs ring final circuit was 0.67');
  });

  test('a pathologically long name-shaped clause is NOT collapsed (bound favours name-safety)', () => {
    // >60-char gap between the scope-prep and the trailing "was 1" — the bound
    // stops the later reading grammar from dragging the name token into "Zs".
    const input =
      'Designation Z S for the long-standing metropolitan installation classification and records category was 1';
    expect(normalise(input).text).toBe(input);
    expect(normalise(input).rules_hit).toEqual([]);
  });

  test('the dropped connectors ("measuring"/"equalled") do NOT false-positive', () => {
    expect(normalise('Z S Electrical measuring 10 metres').text).toBe(
      'Z S Electrical measuring 10 metres'
    );
    expect(normalise('designation Z S equalled 1 in the old schedule').text).toBe(
      'designation Z S equalled 1 in the old schedule'
    );
  });

  test('designation with a preceding "is" is still NOT collapsed (connector before, not after)', () => {
    // "is" sits BEFORE the token; the rule requires a connector AFTER the token.
    expect(normalise('the designation is Z S 1').text).toBe('the designation is Z S 1');
  });

  test('spelled postcode text is NOT collapsed', () => {
    // No "z s" token followed by connector+value.
    expect(normalise('postcode S W 1 A one A A').text).toBe('postcode S W 1 A one A A');
  });

  test('does not bridge across a sentence boundary', () => {
    // Token in clause 1, value in clause 2 — the "." delimiter blocks the gate.
    const r = normalise('customer name Z S. The reading was 0.67');
    expect(r.text).toBe('customer name Z S. The reading was 0.67');
    expect(r.rules_hit).toEqual([]);
  });

  test('does not bridge across a NEWLINE or CR (structural + sentinel spacing is horizontal-only)', () => {
    // "Z S" on one line, "was 0.67" on the next — a newline/CR is a clause
    // boundary, so the name token is left untouched. Sentinel-internal spacing
    // ("off scale") is horizontal too, so it cannot bridge a line break either.
    expect(normalise('customer name Z S\nwas 0.67').text).toBe('customer name Z S\nwas 0.67');
    expect(normalise('Z S\nis 0.2').rules_hit).toEqual([]);
    expect(normalise('customer name Z S on account\rwas 0.67').rules_hit).toEqual([]);
    expect(normalise('customer name Z S is off\nscale').rules_hit).toEqual([]);
  });

  test('horizontal-space sentinel values DO collapse ("off scale", "out of range", "> 5")', () => {
    expect(normalise('Z s on the shower was off scale').text).toBe(
      'Zs on the shower was off scale'
    );
    expect(normalise('Z s was out of range').text).toBe('Zs was out of range');
    expect(normalise('Z s is > 5').text).toBe('Zs is > 5');
  });

  test('an optional comma/colon may sit between the token and the lead-in', () => {
    expect(normalise('Z s, on the heating was 0.67').text).toBe('Zs, on the heating was 0.67');
    expect(normalise('Z s: is 0.2').text).toBe('Zs: is 0.2');
  });

  test('does not match "z s" inside larger words', () => {
    // No word-boundary z<space>s pattern here.
    expect(normalise('the fuses on circuit 3 was 0.4').text).toBe('the fuses on circuit 3 was 0.4');
  });
});

describe('transcript-normalise — rule 2: "a hundred" → "100"', () => {
  test('digit-ises the observed IR reply (id 80A)', () => {
    const r = normalise('A hundred MΩ');
    expect(r.text).toBe('100 MΩ');
    expect(r.rules_hit).toEqual([NORMALISE_RULE_IDS.A_HUNDRED]);
  });

  test('fires mid-sentence and with a trailing unit word', () => {
    expect(normalise('the IR for the cooker is a hundred megaohms').text).toBe(
      'the IR for the cooker is 100 megaohms'
    );
    expect(normalise('a hundred ohms').text).toBe('100 ohms');
    expect(normalise('a hundred.').text).toBe('100.');
  });

  test('is case-insensitive', () => {
    expect(normalise('A HUNDRED').text).toBe('100');
  });

  // ── Compound guard — a compound must NOT be corrupted into "100 and ..." ──
  test('leaves compound / decimal / multi-digit continuations UNTOUCHED (no "100 …" corruption)', () => {
    // Every one of these, if the head were rewritten, would let the IR parser
    // misread the value (150 / 100.5 / 10050) as 100. All left untouched.
    for (const input of [
      'a hundred and fifty megaohms',
      'a hundred and one',
      'a hundred and zero',
      'a hundred and a half',
      'a hundred point five',
      'a hundred-and-fifty',
      'a hundred, and fifty',
      'a hundred fifty',
      'a hundred 50 megaohms',
      'a hundred-50 megaohms',
      'a hundred point oh five',
      'a hundred point nought five',
      'a hundred and half',
      'a hundred quarter',
      'a hundred a quarter',
    ]) {
      const r = normalise(input);
      expect(r.text).toBe(input);
      expect(r.rules_hit).toEqual([]);
    }
  });

  test('a sentence-level "and" (not "and <number>") still digit-ises the standalone 100', () => {
    // Multi-fact dictation — "and polarity is pass" is a NEW fact, not a compound
    // number, so the standalone reading is digit-ised.
    const r = normalise('L to N is a hundred, and polarity is pass');
    expect(r.text).toBe('L to N is 100, and polarity is pass');
    expect(r.rules_hit).toEqual([NORMALISE_RULE_IDS.A_HUNDRED]);
  });

  test('does not fire inside a larger word', () => {
    // No "\ba hundred\b" boundary match.
    expect(normalise('bahundred').text).toBe('bahundred');
  });
});

describe('transcript-normalise — combined + idempotency', () => {
  test('both rules can fire on one transcript (a_hundred runs first, enabling the Zs gate)', () => {
    // "was a hundred" — the Zs context gate needs a DIGIT value, so a_hundred
    // MUST run first ("a hundred" → "100") for "Z s" to then collapse. rules_hit
    // is reported in application order.
    const r = normalise('Z s on the cooker was a hundred');
    expect(r.text).toBe('Zs on the cooker was 100');
    expect(r.rules_hit).toEqual([
      NORMALISE_RULE_IDS.A_HUNDRED,
      NORMALISE_RULE_IDS.ZS_FIELD_TOKEN,
    ]);
  });

  test('idempotent — normalise(normalise(x)) === normalise(x) across every case', () => {
    const inputs = [
      'Z s on the heating was 0.67',
      'Zed s for the cooker is 0.4',
      'Z s on the shower was LIM',
      'A hundred MΩ',
      'Z s on the cooker was a hundred',
      'customer name Z S Electrical',
      'designation Z S 1',
      'designation Z S for circuit 1',
      'a hundred and fifty megaohms',
      'a hundred point five',
      '',
      'nothing to change here',
      // punctuation / case variants
      'z s ON THE lights WAS 0.3',
      'the IR is A Hundred.',
    ];
    for (const input of inputs) {
      const once = normalise(input);
      const twice = normalise(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.rules_hit).toEqual([]);
    }
  });

  test('non-string input is coerced safely, no rules hit', () => {
    expect(normalise(undefined)).toEqual({ text: '', rules_hit: [] });
    expect(normalise(null)).toEqual({ text: '', rules_hit: [] });
    expect(normalise(42)).toEqual({ text: '', rules_hit: [] });
    expect(normalise('')).toEqual({ text: '', rules_hit: [] });
  });

  test('no catastrophic backtracking on a long connector-dense no-value clause (ReDoS guard)', () => {
    // The Zs lookahead gap is bounded, so a long clause with many connectors and
    // no value completes in ~linear time rather than stalling the event loop.
    const evil = 'z s ' + 'was on for is are '.repeat(4000);
    const start = process.hrtime.bigint();
    const r = normalise(evil);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(r.rules_hit).toEqual([]); // no value → no collapse
    expect(elapsedMs).toBeLessThan(250);
  });
});
