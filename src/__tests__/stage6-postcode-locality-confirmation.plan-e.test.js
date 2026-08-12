/**
 * PLAN-E (feedback id 125) — E4: fold the audible locality (town/county)
 * into the EXISTING postcode confirmation, on BOTH egress seams. Speaks the
 * EFFECTIVE post-apply snapshot values, never the raw lookup output (an
 * E1-seeded/preserved value must speak as stored). One utterance,
 * exactly-once — never a second confirmation object — and the postcode
 * operation's dedupe_token (field/scope/turnId/ordinal) must stay unchanged
 * despite the longer text.
 */

import { jest } from '@jest/globals';

import { dispatchRecordBoardReading } from '../extraction/stage6-dispatchers-board.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { foldLocalityIntoLegacyConfirmations } from '../extraction/eicr-extraction-session.js';

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(seededCircuits0 = {}) {
  return {
    sessionId: 'plan-e-locality',
    stateSnapshot: {
      circuits: { 0: { ...seededCircuits0 } },
      boards: [{ id: 'main', board_type: 'main', circuits: [] }],
      currentBoardId: 'main',
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
  };
}

async function writePostcode({
  perTurnWrites,
  session,
  field = 'postcode',
  value = 'RG6 3EY',
  callId = 'postcode-write',
  turnId = 'turn-1',
  postcodeLookupResult,
}) {
  const result = await dispatchRecordBoardReading(
    {
      tool_call_id: callId,
      name: 'record_board_reading',
      input: { field, value, confidence: 1, source_turn_id: turnId },
    },
    { session, logger: makeLogger(), turnId, perTurnWrites, round: 0, postcodeLookupResult }
  );
  expect(result.is_error).toBe(false);
}

function bundleWithSnapshot(perTurnWrites, session, turnId = 'turn-1') {
  return bundleToolCallsIntoResult(
    perTurnWrites,
    { questions: [] },
    { confirmationsEnabled: true, turnId, stateSnapshot: session.stateSnapshot }
  );
}

function postcodeConfirmation(bundled, field = 'postcode') {
  return bundled.confirmations.find((entry) => entry.field === field);
}

describe('PLAN-E E4 — live production bundler path', () => {
  test('derived fill: the lookup writes an empty town, and it is spoken appended to the postcode confirmation', async () => {
    const writes = createPerTurnWrites();
    const session = makeSession();
    await writePostcode({
      perTurnWrites: writes,
      session,
      postcodeLookupResult: { valid: true, postcode: 'RG6 3EY', town: 'Earley', county: '' },
    });
    const bundled = bundleWithSnapshot(writes, session);
    const conf = postcodeConfirmation(bundled);
    expect(conf.text.endsWith(', Earley')).toBe(true);
  });

  test('preserved pre-existing locality: an E1-seeded town survives the lookup and speaks AS STORED, not the lookup value', async () => {
    const writes = createPerTurnWrites();
    // Snapshot already carries the E1-seeded "Lower Earley" (non-empty ⇒
    // shouldOverride is false ⇒ the applier preserves it).
    const session = makeSession({ town: 'Lower Earley' });
    await writePostcode({
      perTurnWrites: writes,
      session,
      postcodeLookupResult: { valid: true, postcode: 'RG6 3EY', town: 'Earley', county: '' },
    });
    const bundled = bundleWithSnapshot(writes, session);
    const conf = postcodeConfirmation(bundled);
    expect(conf.text.endsWith(', Lower Earley')).toBe(true);
    expect(conf.text.includes('Earley,')).toBe(false);
  });

  test('drift replacement: a stored UK_REGION_DRIFT county is replaced and the NEW value speaks', async () => {
    const writes = createPerTurnWrites();
    const session = makeSession({ county: 'South East' });
    await writePostcode({
      perTurnWrites: writes,
      session,
      postcodeLookupResult: {
        valid: true,
        postcode: 'RG6 3EY',
        town: 'Earley',
        county: 'Berkshire',
      },
    });
    const bundled = bundleWithSnapshot(writes, session);
    const conf = postcodeConfirmation(bundled);
    expect(conf.text.endsWith(', Earley, Berkshire')).toBe(true);
  });

  test('both locality fields blank: the confirmation stays postcode-only (no trailing comma clause)', async () => {
    const writes = createPerTurnWrites();
    const session = makeSession();
    await writePostcode({
      perTurnWrites: writes,
      session,
      postcodeLookupResult: { valid: false, reason: 'no_match' },
    });
    const bundled = bundleWithSnapshot(writes, session);
    const conf = postcodeConfirmation(bundled);
    expect(conf.text.includes(',')).toBe(false);
  });

  test('client-postcode variant reads the CLIENT locality family, not site', async () => {
    const writes = createPerTurnWrites();
    const session = makeSession({ client_town: 'Reading', town: 'Wrong Site Town' });
    await writePostcode({
      perTurnWrites: writes,
      session,
      field: 'client_postcode',
      value: 'RG1 5QA',
    });
    const bundled = bundleWithSnapshot(writes, session);
    const conf = postcodeConfirmation(bundled, 'client_postcode');
    expect(conf.text.endsWith(', Reading')).toBe(true);
  });

  test('EXACTLY ONCE: only one confirmation object carries the postcode text, never a second locality confirmation', async () => {
    const writes = createPerTurnWrites();
    const session = makeSession({ town: 'Lower Earley', county: 'Berkshire' });
    await writePostcode({ perTurnWrites: writes, session });
    const bundled = bundleWithSnapshot(writes, session);
    const postcodeEntries = bundled.confirmations.filter((c) => c.field === 'postcode');
    expect(postcodeEntries).toHaveLength(1);
    // The derived town/county writes remain designed-silent (excluded from
    // confirmation candidacy) even though they informed the tail text.
    expect(bundled.confirmations.some((c) => c.field === 'town' || c.field === 'county')).toBe(
      false
    );
  });

  test('DEDUPE IDENTITY UNCHANGED: dedupe_token is identical whether or not a locality tail is appended', async () => {
    const withTail = createPerTurnWrites();
    const sessionWithTail = makeSession({ town: 'Lower Earley' });
    await writePostcode({ perTurnWrites: withTail, session: sessionWithTail });
    const bundledWithTail = bundleWithSnapshot(withTail, sessionWithTail);

    const withoutTail = createPerTurnWrites();
    const sessionWithoutTail = makeSession();
    await writePostcode({ perTurnWrites: withoutTail, session: sessionWithoutTail });
    const bundledWithoutTail = bundleWithSnapshot(withoutTail, sessionWithoutTail);

    expect(postcodeConfirmation(bundledWithTail).text).not.toBe(
      postcodeConfirmation(bundledWithoutTail).text
    );
    expect(postcodeConfirmation(bundledWithTail).dedupe_token).toBe(
      postcodeConfirmation(bundledWithoutTail).dedupe_token
    );
    expect(postcodeConfirmation(bundledWithTail).dedupe_token).toBe(
      'secfield_postcode_global_turn-1_ord0'
    );
  });

  test('no stateSnapshot option passed (older/test call sites): confirmation is unchanged, no throw', async () => {
    const writes = createPerTurnWrites();
    const session = makeSession({ town: 'Lower Earley' });
    await writePostcode({ perTurnWrites: writes, session });
    const bundled = bundleToolCallsIntoResult(
      writes,
      { questions: [] },
      { confirmationsEnabled: true, turnId: 'turn-1' } // no stateSnapshot
    );
    const conf = postcodeConfirmation(bundled);
    expect(conf.text.includes(',')).toBe(false);
  });
});

describe('PLAN-E E4 — legacy JSON-prose path (foldLocalityIntoLegacyConfirmations)', () => {
  function snapshot(circuits0) {
    return { circuits: { 0: circuits0 } };
  }

  test('appends the effective locality to an existing postcode confirmation', () => {
    const confirmations = [{ field: 'postcode', text: 'postcode RG6 3EY', circuit: 0 }];
    foldLocalityIntoLegacyConfirmations(
      confirmations,
      snapshot({ town: 'Lower Earley', county: 'Berkshire' })
    );
    expect(confirmations[0].text).toBe('postcode RG6 3EY, Lower Earley, Berkshire');
  });

  test('also updates expanded_text when present, leaves it absent when not', () => {
    const withExpanded = [
      { field: 'postcode', text: 'postcode RG6 3EY', expanded_text: 'postcode R G 6 3 E Y' },
    ];
    foldLocalityIntoLegacyConfirmations(withExpanded, snapshot({ town: 'Earley' }));
    expect(withExpanded[0].expanded_text).toBe('postcode R G 6 3 E Y, Earley');

    const withoutExpanded = [{ field: 'postcode', text: 'postcode RG6 3EY' }];
    foldLocalityIntoLegacyConfirmations(withoutExpanded, snapshot({ town: 'Earley' }));
    expect('expanded_text' in withoutExpanded[0]).toBe(false);
  });

  test('client_postcode reads the client family', () => {
    const confirmations = [{ field: 'client_postcode', text: 'customer postcode RG1 5QA' }];
    foldLocalityIntoLegacyConfirmations(
      confirmations,
      snapshot({ town: 'Wrong', client_town: 'Reading' })
    );
    expect(confirmations[0].text).toBe('customer postcode RG1 5QA, Reading');
  });

  test('both fields blank leaves the text unchanged', () => {
    const confirmations = [{ field: 'postcode', text: 'postcode RG6 3EY' }];
    foldLocalityIntoLegacyConfirmations(confirmations, snapshot({}));
    expect(confirmations[0].text).toBe('postcode RG6 3EY');
  });

  test('non-postcode confirmations are left untouched', () => {
    const confirmations = [{ field: 'measured_zs_ohm', text: 'Zs 0.35', circuit: 4 }];
    foldLocalityIntoLegacyConfirmations(confirmations, snapshot({ town: 'Earley' }));
    expect(confirmations[0].text).toBe('Zs 0.35');
  });

  test('an empty/absent confirmations array is a no-op, never throws', () => {
    expect(() =>
      foldLocalityIntoLegacyConfirmations([], snapshot({ town: 'Earley' }))
    ).not.toThrow();
    expect(() =>
      foldLocalityIntoLegacyConfirmations(undefined, snapshot({ town: 'Earley' }))
    ).not.toThrow();
  });
});

describe('PLAN-E E4 — spoken-string hygiene', () => {
  test('the expanded postcode confirmation text is distinct from adjacent apology/notice phrasing', () => {
    const confirmations = [{ field: 'postcode', text: 'postcode RG6 3EY' }];
    foldLocalityIntoLegacyConfirmations(confirmations, {
      circuits: { 0: { town: 'Earley', county: 'Berkshire' } },
    });
    const text = confirmations[0].text;
    // Representative existing notice-family fragments this must never equal
    // or be mistaken for (each is a DISTINCT spoken sentence elsewhere).
    const otherFamilies = [
      "SERVER POSTCODE LOOKUP: no locality match. This is enrichment only; still interpret and record the inspector's postcode in the address family they named.",
      'postcode RG6 3EY',
    ];
    for (const other of otherFamilies) {
      expect(text).not.toBe(other);
    }
    expect(text).toBe('postcode RG6 3EY, Earley, Berkshire');
  });
});
