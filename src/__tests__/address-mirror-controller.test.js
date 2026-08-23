import { jest } from '@jest/globals';

import {
  ADDRESS_MIRROR_DIRECT_QUESTION_TYPE,
  createAddressMirrorController,
  parseAddressMirrorAnswer,
  parseDirectAddressMirrorCommand,
} from '../extraction/address-mirror-controller.js';
import {
  createPerTurnWrites,
  encodeBoardReadingKey,
  recordBoardReadingWrite,
} from '../extraction/stage6-per-turn-writes.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';

function sessionWith(site = {}, client = {}) {
  return {
    sessionId: 'synthetic-address-mirror',
    stateSnapshot: {
      circuits: {
        0: {
          address: site.address,
          postcode: site.postcode,
          town: site.town,
          county: site.county,
          client_address: client.address,
          client_postcode: client.postcode,
          client_town: client.town,
          client_county: client.county,
        },
      },
    },
  };
}

function sourceTurnWrites(values, derivedFields = new Set()) {
  const writes = createPerTurnWrites();
  for (const [field, value] of Object.entries(values)) {
    recordBoardReadingWrite(writes, encodeBoardReadingKey(field), {
      value,
      confidence: 1,
      source_turn_id: 'turn-source',
      ...(derivedFields.has(field) ? { derived: true } : {}),
    });
  }
  return writes;
}

describe('address mirror controller', () => {
  test('uses bounded answer and whole-command grammars', () => {
    expect(parseAddressMirrorAnswer('Yeah.')).toBe('yes');
    expect(parseAddressMirrorAnswer('keep the addresses separate')).toBe('no');
    expect(parseAddressMirrorAnswer('yes and change circuit three')).toBeNull();
    expect(parseDirectAddressMirrorCommand('Same address for the client.')).toEqual({
      sourceFamily: 'site',
      targetFamily: 'client',
    });
    expect(
      parseDirectAddressMirrorCommand('I mentioned the same address for the client earlier')
    ).toBeNull();
  });

  test('does not burn the ask when the same-turn source is incomplete', async () => {
    const store = { claim: jest.fn() };
    const controller = createAddressMirrorController({
      userId: 'owner-1',
      jobId: 'job-1',
      session: sessionWith({ address: '14 High Street' }),
      store,
    });
    const out = await controller.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the client?' },
      askId: 'ask-1',
      perTurnWrites: sourceTurnWrites({ address: '14 High Street' }),
    });
    expect(out).toEqual({ ok: false, reason: 'source_incomplete' });
    expect(store.claim).not.toHaveBeenCalled();
  });

  test('later postcode write selects a complete same-family snapshot in live and off modes', async () => {
    const makeStore = () => ({
      claim: jest.fn(async (_user, _job, intent) => ({ claimed: true, intent })),
    });
    const liveStore = makeStore();
    const live = createAddressMirrorController({
      userId: 'owner-split-live',
      jobId: 'job-split-live',
      session: sessionWith({ address: '2 Test Road', postcode: 'TE1 1ST' }),
      store: liveStore,
    });
    expect(
      await live.claimLiveAsk({
        input: { purpose: 'address_mirror', question: 'Use it for the client?' },
        askId: 'ask-split-live',
        perTurnWrites: sourceTurnWrites({ postcode: 'TE1 1ST' }),
      })
    ).toMatchObject({ ok: true });

    const offStore = makeStore();
    const off = createAddressMirrorController({
      userId: 'owner-split-off',
      jobId: 'job-split-off',
      session: sessionWith({ address: '2 Test Road', postcode: 'TE1 1ST' }),
      store: offStore,
    });
    expect(
      await off.claimLegacyQuestion(
        {
          type: 'address_mirror',
          purpose: 'address_mirror',
          field: 'client_address',
          id: 'ask-split-off',
          question: 'Use it for the client?',
        },
        sourceTurnWrites({ postcode: 'TE1 1ST' })
      )
    ).toBe(true);
    expect(liveStore.claim).toHaveBeenCalledTimes(1);
    expect(offStore.claim).toHaveBeenCalledTimes(1);

    const clientStore = makeStore();
    const clientFirst = createAddressMirrorController({
      userId: 'owner-split-client',
      jobId: 'job-split-client',
      session: sessionWith({}, { address: '9 Client Road', postcode: 'CR1 1AA' }),
      store: clientStore,
    });
    expect(
      await clientFirst.claimLiveAsk({
        input: { purpose: 'address_mirror', question: 'Use it for the site?' },
        askId: 'ask-split-client',
        perTurnWrites: sourceTurnWrites({ client_postcode: 'CR1 1AA' }),
      })
    ).toMatchObject({ ok: true });
  });

  test('legacy claim stamps its server ask id onto the outbound question', async () => {
    const store = {
      claim: jest.fn(async (_user, _job, intent) => ({ claimed: true, intent })),
    };
    const controller = createAddressMirrorController({
      userId: 'owner-legacy-id',
      jobId: 'job-legacy-id',
      session: sessionWith({ address: '2 Test Road', postcode: 'TE1 1ST' }),
      store,
    });
    const question = {
      type: 'address_mirror',
      purpose: 'address_mirror',
      field: 'client_address',
      question: 'Use it for the client?',
    };

    await expect(
      controller.claimLegacyQuestion(
        question,
        sourceTurnWrites({ address: '2 Test Road', postcode: 'TE1 1ST' })
      )
    ).resolves.toBe(true);

    expect(question).toMatchObject({
      tool_call_id: expect.stringMatching(/^legacy-address-mirror-/),
      expected_answer_shape: 'yes_no',
    });
    expect(store.claim.mock.calls[0][2].askId).toBe(question.tool_call_id);
  });

  test.each([
    ['type-only', { type: 'address_mirror' }],
    ['purpose-only', { purpose: 'address_mirror' }],
    ['mismatched type', { type: 'unclear', purpose: 'address_mirror' }],
  ])('legacy claim fails closed for a %s model marker', async (_label, marker) => {
    const store = {
      claim: jest.fn(async (_user, _job, intent) => ({ claimed: true, intent })),
    };
    const controller = createAddressMirrorController({
      userId: 'owner-marker-mismatch',
      jobId: 'job-marker-mismatch',
      session: sessionWith({ address: '2 Test Road', postcode: 'TE1 1ST' }),
      store,
    });

    await expect(
      controller.claimLegacyQuestion(
        {
          field: 'client_address',
          question: 'Use it for the client?',
          ...marker,
        },
        sourceTurnWrites({ address: '2 Test Road', postcode: 'TE1 1ST' })
      )
    ).resolves.toBe(false);
    expect(store.claim).not.toHaveBeenCalled();
  });

  test('claims once then applies a silent derived site-to-client copy', async () => {
    let row = null;
    const store = {
      claim: jest.fn(async (_user, _job, intent) => {
        row = {
          ...intent,
          ask_id: intent.askId,
          source_family: intent.sourceFamily,
          source_snapshot: intent.sourceSnapshot,
          source_writes: intent.sourceWrites,
          resolution_token: intent.resolutionToken,
          status: 'pending',
        };
        return { claimed: true, intent: row };
      }),
      load: jest.fn(async () => row),
      resolve: jest.fn(async (_user, _job, status) => ({ ...row, status })),
    };
    const session = sessionWith({
      address: '14 High Street',
      postcode: 'SW1A 1AA',
      town: 'London',
    });
    const turnWrites = sourceTurnWrites({
      address: '14 High Street',
      postcode: 'SW1A 1AA',
      town: 'London',
    });
    const controller = createAddressMirrorController({
      userId: 'owner-1',
      jobId: 'job-1',
      session,
      store,
    });

    expect(
      await controller.claimLiveAsk({
        input: { purpose: 'address_mirror', question: 'Use it for the client?' },
        askId: 'ask-1',
        perTurnWrites: turnWrites,
      })
    ).toMatchObject({ ok: true });

    const resolved = await controller.resolveLiveAnswer({
      input: { purpose: 'address_mirror' },
      outcome: { answered: true, user_text: 'yes' },
      askId: 'ask-1',
      perTurnWrites: turnWrites,
    });
    expect(resolved).toMatchObject({ handled: true, outcome: 'yes' });
    expect(session.stateSnapshot.circuits[0]).toMatchObject({
      client_address: '14 High Street',
      client_postcode: 'SW1A 1AA',
      client_town: 'London',
    });

    const result = bundleToolCallsIntoResult(turnWrites, null, {
      confirmationsEnabled: true,
    });
    const mirrorReadings = result.extracted_board_readings.filter((r) =>
      r.field.startsWith('client_')
    );
    expect(mirrorReadings).toHaveLength(3);
    const stagedMirrorValues = [...turnWrites.boardReadings.values()].filter(
      (value) => value.derived === true
    );
    expect(stagedMirrorValues).toHaveLength(3);
    expect(result.confirmations.some((c) => c.field.startsWith('client_'))).toBe(false);
    expect(result.confirmations.map((c) => c.field)).toEqual(
      expect.arrayContaining(['address', 'postcode', 'town'])
    );
    expect(result.spoken_response).toBeUndefined();
  });

  test('negative answer persists without target writes', async () => {
    const session = sessionWith({ address: '14 High Street', postcode: 'SW1A 1AA' });
    const turnWrites = sourceTurnWrites({ address: '14 High Street', postcode: 'SW1A 1AA' });
    const controller = createAddressMirrorController({ session });
    await controller.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the client?' },
      askId: 'ask-local',
      perTurnWrites: turnWrites,
    });
    const out = await controller.resolveLiveAnswer({
      input: { purpose: 'address_mirror' },
      outcome: { answered: true, user_text: 'different' },
      askId: 'ask-local',
      perTurnWrites: turnWrites,
    });
    expect(out.outcome).toBe('no');
    expect(session.stateSnapshot.circuits[0].client_address).toBeUndefined();
    expect(turnWrites.answer.stagedText).toBeNull();
  });

  test('uses one acknowledgement only when no dictated source read-back survives', async () => {
    const session = sessionWith({ address: '14 High Street', postcode: 'SW1A 1AA' });
    const controller = createAddressMirrorController({ session });
    await controller.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the client?' },
      askId: 'ask-local-ack',
      perTurnWrites: sourceTurnWrites({ address: '14 High Street', postcode: 'SW1A 1AA' }),
    });
    const answerWrites = createPerTurnWrites();
    const out = await controller.resolveLiveAnswer({
      input: { purpose: 'address_mirror' },
      outcome: { answered: true, user_text: 'yes' },
      askId: 'ask-local-ack',
      perTurnWrites: answerWrites,
    });
    expect(out.outcome).toBe('yes');
    expect(answerWrites.answer.stagedText).toMatch(/same address for the client/i);
    expect(
      bundleToolCallsIntoResult(answerWrites, null, { confirmationsEnabled: true }).confirmations
    ).toBeUndefined();
  });

  test('rehydration replays missing dictated source with stable tokens before silent copy', async () => {
    let row = null;
    const store = {
      claim: jest.fn(async (_user, _job, intent) => {
        row = {
          ...intent,
          ask_id: intent.askId,
          source_family: intent.sourceFamily,
          source_snapshot: intent.sourceSnapshot,
          source_writes: intent.sourceWrites,
          resolution_token: intent.resolutionToken,
          status: 'pending',
        };
        return { claimed: true, intent: row };
      }),
      load: jest.fn(async () => row),
      resolve: jest.fn(async (_user, _job, status) => {
        row = { ...row, status };
        return row;
      }),
      markDelivered: jest.fn(async () => {
        row = { ...row, delivered_at: '2026-08-01T12:00:00.000Z' };
        return row;
      }),
    };
    const original = sessionWith({
      address: '14 High Street',
      postcode: 'SW1A 1AA',
      town: 'London',
      county: 'Greater London',
    });
    const first = createAddressMirrorController({
      userId: 'owner-replay',
      jobId: 'job-replay',
      session: original,
      store,
    });
    await first.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the client?' },
      askId: 'ask-replay',
      perTurnWrites: sourceTurnWrites(
        {
          address: '14 High Street',
          postcode: 'SW1A 1AA',
          town: 'London',
          county: 'Greater London',
        },
        new Set(['town', 'county'])
      ),
    });

    const restarted = sessionWith();
    const recovered = createAddressMirrorController({
      userId: 'owner-replay',
      jobId: 'job-replay',
      session: restarted,
      store,
    });
    await recovered.rehydrate();
    const writes = createPerTurnWrites();
    const out = await recovered.resolveRecoveredAnswer({
      context: null,
      text: 'yes',
      askId: 'ask-replay',
      perTurnWrites: writes,
    });
    expect(out).toMatchObject({ handled: true, outcome: 'yes', replayedSource: 4 });
    const result = bundleToolCallsIntoResult(writes, null, {
      confirmationsEnabled: true,
      turnId: 'new-process-turn',
    });
    expect(result.turn_id).toBe('new-process-turn');
    expect(result.confirmations.map((c) => c.field)).toEqual(['address', 'postcode']);
    expect(result.confirmations.find((c) => c.field === 'postcode')?.dedupe_token).toBe(
      `secfield_postcode_global_${row.resolution_token}_ord1`
    );
    expect(result.confirmations.some((c) => c.field.startsWith('client_'))).toBe(false);
    expect(result.spoken_response).toBeUndefined();
    expect(restarted.stateSnapshot.circuits[0]).toMatchObject({
      address: '14 High Street',
      postcode: 'SW1A 1AA',
      town: 'London',
      county: 'Greater London',
      client_address: '14 High Street',
      client_postcode: 'SW1A 1AA',
      client_town: 'London',
      client_county: 'Greater London',
    });
    await recovered.markDelivered(out.delivery);
    expect(await recovered.recoverUndelivered(createPerTurnWrites())).toEqual({
      handled: false,
    });
  });

  test('terminal CAS remains replayable after a crash before staging', async () => {
    let row = null;
    let crashAfterCas = true;
    const store = {
      claim: jest.fn(async (_user, _job, intent) => {
        row = {
          ...intent,
          ask_id: intent.askId,
          source_family: intent.sourceFamily,
          source_snapshot: intent.sourceSnapshot,
          source_version_hash: intent.sourceVersionHash,
          source_writes: intent.sourceWrites,
          resolution_token: intent.resolutionToken,
          status: 'pending',
        };
        return { claimed: true, intent: row };
      }),
      load: jest.fn(async () => row),
      loadDirect: jest.fn(async () => null),
      resolve: jest.fn(async (_user, _job, status) => {
        row = { ...row, status };
        if (crashAfterCas) {
          crashAfterCas = false;
          throw new Error('simulated_process_crash_after_cas');
        }
        return row;
      }),
    };
    const original = sessionWith({ address: '14 High Street', postcode: 'SW1A 1AA' });
    const first = createAddressMirrorController({
      userId: 'owner-crash',
      jobId: 'job-crash',
      session: original,
      store,
    });
    await first.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the client?' },
      askId: 'ask-crash',
      perTurnWrites: sourceTurnWrites({ address: '14 High Street', postcode: 'SW1A 1AA' }),
    });
    await expect(
      first.resolveLiveAnswer({
        input: { purpose: 'address_mirror' },
        outcome: { answered: true, user_text: 'yes' },
        askId: 'ask-crash',
        perTurnWrites: createPerTurnWrites(),
      })
    ).rejects.toThrow('simulated_process_crash_after_cas');
    expect(row.status).toBe('resolved_yes');

    const restarted = sessionWith();
    const recovered = createAddressMirrorController({
      userId: 'owner-crash',
      jobId: 'job-crash',
      session: restarted,
      store,
    });
    await recovered.rehydrate();
    const writes = createPerTurnWrites();
    const out = await recovered.recoverUndelivered(writes);
    expect(out).toMatchObject({ handled: true, outcome: 'yes', replayedSource: 2 });
    expect(restarted.stateSnapshot.circuits[0]).toMatchObject({
      address: '14 High Street',
      postcode: 'SW1A 1AA',
      client_address: '14 High Street',
      client_postcode: 'SW1A 1AA',
    });
  });

  test('target conflict recovery still restores and reads back owed source writes', async () => {
    let row = null;
    const store = {
      claim: jest.fn(async (_user, _job, intent) => {
        row = {
          ...intent,
          ask_id: intent.askId,
          source_family: intent.sourceFamily,
          source_snapshot: intent.sourceSnapshot,
          source_version_hash: intent.sourceVersionHash,
          source_writes: intent.sourceWrites,
          resolution_token: intent.resolutionToken,
          status: 'pending',
        };
        return { claimed: true, intent: row };
      }),
      load: jest.fn(async () => row),
      resolve: jest.fn(async (_user, _job, status, _token, terminalOutcome) => {
        row = { ...row, status, terminal_outcome: terminalOutcome };
        return row;
      }),
    };
    const original = sessionWith({ address: '14 High Street', postcode: 'SW1A 1AA' });
    const first = createAddressMirrorController({
      userId: 'owner-target-conflict-replay',
      jobId: 'job-target-conflict-replay',
      session: original,
      store,
    });
    await first.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the client?' },
      askId: 'ask-target-conflict-replay',
      perTurnWrites: sourceTurnWrites({ address: '14 High Street', postcode: 'SW1A 1AA' }),
    });

    const restarted = sessionWith({}, { address: '9 Other Road' });
    const recovered = createAddressMirrorController({
      userId: 'owner-target-conflict-replay',
      jobId: 'job-target-conflict-replay',
      session: restarted,
      store,
    });
    await recovered.rehydrate();
    const writes = createPerTurnWrites();

    const out = await recovered.resolveRecoveredAnswer({
      context: { purpose: 'address_mirror' },
      text: 'yes',
      askId: 'ask-target-conflict-replay',
      perTurnWrites: writes,
    });

    expect(out).toMatchObject({ handled: true, outcome: 'conflict', replayedSource: 2 });
    const result = bundleToolCallsIntoResult(writes, null, {
      confirmationsEnabled: true,
      turnId: 'target-conflict-replay-turn',
    });
    expect(result.confirmations.map((confirmation) => confirmation.field)).toEqual([
      'address',
      'postcode',
    ]);
    expect(restarted.stateSnapshot.circuits[0]).toMatchObject({
      address: '14 High Street',
      postcode: 'SW1A 1AA',
      client_address: '9 Other Road',
    });
    expect(restarted.stateSnapshot.circuits[0].client_postcode).toBeUndefined();
  });

  test('captured-null to current-value drift emits one conflict and clears the stale ask', async () => {
    const session = sessionWith({ address: '14 High Street', postcode: 'SW1A 1AA' });
    const controller = createAddressMirrorController({ session });
    await controller.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the client?' },
      askId: 'ask-drift',
      perTurnWrites: sourceTurnWrites({ address: '14 High Street', postcode: 'SW1A 1AA' }),
    });
    session.stateSnapshot.circuits[0].town = 'London';
    const writes = createPerTurnWrites();
    const out = await controller.resolveRecoveredAnswer({
      context: { type: 'address_mirror' },
      text: 'yes',
      perTurnWrites: writes,
    });
    expect(out).toMatchObject({
      handled: true,
      outcome: 'conflict',
      clearAskId: 'ask-drift',
    });
    expect(writes.answer.stagedText).toMatch(/address changed/i);
    expect(session.stateSnapshot.circuits[0].client_address).toBeUndefined();
  });

  test('legacy claim requires one same-turn family agreeing with the question direction', async () => {
    const store = {
      claim: jest.fn(async (_user, _job, intent) => ({ claimed: true, intent })),
    };
    const controller = createAddressMirrorController({
      userId: 'owner-legacy',
      jobId: 'job-legacy',
      session: sessionWith({ address: '2 Test Road', postcode: 'TE1 1ST' }),
      store,
    });
    const question = {
      type: 'address_mirror',
      purpose: 'address_mirror',
      field: 'client_address',
      id: 'legacy-ask',
      question: 'Use the same address for the client?',
    };
    expect(await controller.claimLegacyQuestion(question, createPerTurnWrites())).toBe(false);
    expect(
      await controller.claimLegacyQuestion(
        { ...question, field: 'address' },
        sourceTurnWrites({ address: '2 Test Road', postcode: 'TE1 1ST' })
      )
    ).toBe(false);
    expect(
      await controller.claimLegacyQuestion(
        question,
        sourceTurnWrites({
          address: '2 Test Road',
          postcode: 'TE1 1ST',
          client_address: '9 Other Road',
        })
      )
    ).toBe(false);
    expect(
      await controller.claimLegacyQuestion(
        question,
        sourceTurnWrites({ address: '2 Test Road', postcode: 'TE1 1ST' })
      )
    ).toBe(true);
    expect(question.tool_call_id).toBe('legacy-ask');
    expect(question.expected_answer_shape).toBe('yes_no');
    expect(store.claim).toHaveBeenCalledTimes(1);
  });

  test('explicit command copies a complete source and rejects prose substrings', async () => {
    const session = sessionWith({ address: '2 Test Road', postcode: 'TE1 1ST' });
    const controller = createAddressMirrorController({ session });
    const writes = createPerTurnWrites();
    const copied = await controller.applyDirectCommand(
      'use the installation address for the customer',
      writes,
      'utt-1'
    );
    expect(copied).toMatchObject({ handled: true, outcome: 'copied' });
    expect(session.stateSnapshot.circuits[0].client_address).toBe('2 Test Road');
    expect(
      await controller.applyDirectCommand(
        'we discussed the same address for the client yesterday',
        createPerTurnWrites()
      )
    ).toEqual({ handled: false });
  });

  test('direct conflict asks once and replaces only after an explicit yes', async () => {
    const session = sessionWith(
      { address: '2 Test Road', postcode: 'TE1 1ST' },
      { address: '9 Other Road', postcode: 'OT1 1HR' }
    );
    const controller = createAddressMirrorController({ session });
    const first = await controller.applyDirectCommand(
      'use the installation address for the customer',
      createPerTurnWrites(),
      'utt-conflict'
    );
    expect(first).toMatchObject({ handled: true, outcome: 'conflict' });
    expect(first.question).toMatch(/already different/i);
    expect(session.stateSnapshot.circuits[0].client_address).toBe('9 Other Road');

    const writes = createPerTurnWrites();
    const resolved = await controller.resolveDirectClarification({
      context: {
        type: ADDRESS_MIRROR_DIRECT_QUESTION_TYPE,
        tool_call_id: first.questionId,
      },
      text: 'yes',
      perTurnWrites: writes,
    });
    expect(resolved).toMatchObject({ handled: true, outcome: 'copied' });
    expect(session.stateSnapshot.circuits[0]).toMatchObject({
      client_address: '2 Test Road',
      client_postcode: 'TE1 1ST',
    });
    expect([...writes.boardReadings.values()].every((entry) => entry.derived === true)).toBe(true);
  });

  test('incomplete direct command resumes after authoritative source writes', async () => {
    const session = sessionWith();
    const controller = createAddressMirrorController({ session });
    const first = await controller.applyDirectCommand(
      'use the installation address for the customer',
      createPerTurnWrites(),
      'utt-incomplete'
    );
    expect(first).toMatchObject({ handled: true, outcome: 'source_incomplete' });
    session.stateSnapshot.circuits[0].address = '2 Test Road';
    session.stateSnapshot.circuits[0].postcode = 'TE1 1ST';
    const writes = sourceTurnWrites({ address: '2 Test Road', postcode: 'TE1 1ST' });
    const completed = await controller.finalizeDirectAfterWrites({
      successfulFields: new Set(['address', 'postcode']),
      perTurnWrites: writes,
    });
    expect(completed).toMatchObject({
      handled: true,
      outcome: 'copied',
      clearAskId: first.questionId,
    });
    expect(session.stateSnapshot.circuits[0]).toMatchObject({
      client_address: '2 Test Road',
      client_postcode: 'TE1 1ST',
    });
    expect(
      [...writes.boardReadings.values()].filter((entry) => entry.derived === true)
    ).toHaveLength(2);
    expect(writes.answer.stagedText).toMatch(/use the site address for the client/i);
  });

  test('incomplete direct completion trusts only a source confirmation that will be audible', async () => {
    const session = sessionWith();
    const controller = createAddressMirrorController({ session });
    await controller.applyDirectCommand(
      'use the installation address for the customer',
      createPerTurnWrites(),
      'utt-audibility'
    );
    session.stateSnapshot.circuits[0].address = '2 Test Road';
    session.stateSnapshot.circuits[0].postcode = 'TE1 1ST';
    const writes = sourceTurnWrites({ address: '2 Test Road', postcode: 'TE1 1ST' });

    const completed = await controller.finalizeDirectAfterWrites({
      successfulFields: new Set(['address', 'postcode']),
      perTurnWrites: writes,
      sourceAudible: true,
    });

    expect(completed).toMatchObject({ handled: true, outcome: 'copied' });
    expect(writes.answer.stagedText).toBeNull();
  });

  test('direct conflict survives controller restart and resolves once', async () => {
    let directRow = null;
    const store = {
      load: jest.fn(async () => null),
      loadDirect: jest.fn(async () => directRow),
      claimDirect: jest.fn(async (_user, _job, intent) => {
        directRow = {
          status: 'pending',
          clarification_kind: intent.clarificationKind,
          source_family: intent.sourceFamily,
          target_family: intent.targetFamily,
          operation_token: intent.operationToken,
          question_id: intent.questionId,
          source_snapshot: intent.sourceSnapshot,
          source_writes: intent.sourceWrites,
        };
        return { claimed: true, intent: directRow };
      }),
      resolveDirect: jest.fn(async (_user, _job, _token, status, terminalOutcome) => {
        directRow = { ...directRow, status, terminal_outcome: terminalOutcome };
        return directRow;
      }),
    };
    const session = sessionWith(
      { address: '2 Test Road', postcode: 'TE1 1ST' },
      { address: '9 Other Road', postcode: 'OT1 1HR' }
    );
    const first = createAddressMirrorController({
      userId: 'owner-direct',
      jobId: 'job-direct',
      session,
      store,
    });
    expect(
      await first.applyDirectCommand(
        'use the installation address for the customer',
        createPerTurnWrites(),
        'utt-direct-restart'
      )
    ).toMatchObject({ outcome: 'conflict' });

    const restarted = createAddressMirrorController({
      userId: 'owner-direct',
      jobId: 'job-direct',
      session,
      store,
    });
    await restarted.rehydrate();
    const writes = createPerTurnWrites();
    const out = await restarted.resolveDirectClarification({
      context: {
        type: ADDRESS_MIRROR_DIRECT_QUESTION_TYPE,
        tool_call_id: directRow.question_id,
      },
      text: 'yes',
      perTurnWrites: writes,
    });
    expect(out).toMatchObject({ handled: true, outcome: 'copied' });
    expect(directRow.status).toBe('resolved_yes');
    expect(session.stateSnapshot.circuits[0].client_address).toBe('2 Test Road');
  });

  test('delivered direct operation token consumes a duplicate without writes or speech', async () => {
    const session = sessionWith({ address: '2 Test Road', postcode: 'TE1 1ST' });
    const controller = createAddressMirrorController({ session });
    const firstWrites = createPerTurnWrites();
    const first = await controller.applyDirectCommand(
      'use the installation address for the customer',
      firstWrites,
      'stable-utterance-token'
    );
    expect(first).toMatchObject({ handled: true, outcome: 'copied' });
    await controller.markDelivered(first.delivery);

    const duplicateWrites = createPerTurnWrites();
    const duplicate = await controller.applyDirectCommand(
      'use the installation address for the customer',
      duplicateWrites,
      'stable-utterance-token'
    );
    expect(duplicate).toEqual({ handled: true, outcome: 'duplicate', changed: [] });
    expect(duplicateWrites.boardReadings.size).toBe(0);
    expect(duplicateWrites.answer.stagedText).toBeNull();
  });

  test('direct terminal outbox replays after a crash without another command frame', async () => {
    let directRow = null;
    let crashAfterCas = true;
    const store = {
      load: jest.fn(async () => null),
      loadDirect: jest.fn(async () => directRow),
      claimDirect: jest.fn(async (_user, _job, intent) => {
        directRow = normaliseDirectFixture(intent);
        return { claimed: true, intent: directRow };
      }),
      resolveDirect: jest.fn(async (_user, _job, _token, status, terminalOutcome) => {
        directRow = {
          ...directRow,
          status,
          terminal_outcome: terminalOutcome,
          delivered_at: null,
        };
        if (crashAfterCas) {
          crashAfterCas = false;
          throw new Error('simulated_direct_crash_after_cas');
        }
        return directRow;
      }),
    };
    function normaliseDirectFixture(intent) {
      return {
        status: 'pending',
        clarification_kind: intent.clarificationKind,
        source_family: intent.sourceFamily,
        target_family: intent.targetFamily,
        operation_token: intent.operationToken,
        question_id: intent.questionId,
        source_snapshot: intent.sourceSnapshot,
        source_writes: intent.sourceWrites,
        delivered_at: null,
      };
    }

    const firstSession = sessionWith({ address: '2 Test Road', postcode: 'TE1 1ST' });
    const first = createAddressMirrorController({
      userId: 'owner-direct-crash',
      jobId: 'job-direct-crash',
      session: firstSession,
      store,
    });
    await expect(
      first.applyDirectCommand(
        'use the installation address for the customer',
        createPerTurnWrites(),
        'direct-crash-token'
      )
    ).rejects.toThrow('simulated_direct_crash_after_cas');
    expect(directRow.status).toBe('resolved_yes');

    const restartedSession = sessionWith({ address: '2 Test Road', postcode: 'TE1 1ST' });
    const restarted = createAddressMirrorController({
      userId: 'owner-direct-crash',
      jobId: 'job-direct-crash',
      session: restartedSession,
      store,
    });
    await restarted.rehydrate();
    const writes = createPerTurnWrites();
    const recovered = await restarted.recoverUndelivered(writes);
    expect(recovered).toMatchObject({ handled: true, outcome: 'copied' });
    expect(restartedSession.stateSnapshot.circuits[0]).toMatchObject({
      client_address: '2 Test Road',
      client_postcode: 'TE1 1ST',
    });
  });

  test('direct recovery keeps snapshot-only locality derived and silent', async () => {
    let row = {
      status: 'resolved_yes',
      clarification_kind: 'incomplete',
      source_family: 'site',
      target_family: 'client',
      operation_token: 'direct-derived-recovery',
      question_id: 'address-mirror-direct-derived-recovery',
      source_snapshot: {
        address: '2 Test Road',
        postcode: 'TE1 1ST',
        town: 'Test Town',
        county: 'Testshire',
      },
      source_writes: [
        {
          field: 'address',
          value: '2 Test Road',
          confidence: 1,
          source_turn_id: 'turn-address',
        },
        {
          field: 'postcode',
          value: 'TE1 1ST',
          confidence: 1,
          source_turn_id: 'turn-postcode',
        },
      ],
      terminal_outcome: {
        outcome: 'copied',
        replacement: false,
        target_snapshot: {},
      },
      delivered_at: null,
    };
    const store = {
      load: jest.fn(async () => null),
      loadRecoverableDirect: jest.fn(async () => [row]),
      claimDirectDelivery: jest.fn(async (_user, _job, _token, claimToken) => {
        row = { ...row, delivery_claim_token: claimToken };
        return row;
      }),
    };
    const session = sessionWith();
    const controller = createAddressMirrorController({
      userId: 'owner-direct-derived-recovery',
      jobId: 'job-direct-derived-recovery',
      session,
      store,
    });
    await controller.rehydrate();
    const writes = createPerTurnWrites();

    const recovered = await controller.recoverUndelivered(writes);

    expect(recovered).toMatchObject({
      handled: true,
      outcome: 'copied',
      replayedSource: 4,
    });
    const result = bundleToolCallsIntoResult(writes, null, {
      confirmationsEnabled: true,
      turnId: 'direct-derived-recovery-turn',
    });
    expect(result.confirmations.map((confirmation) => confirmation.field)).toEqual([
      'address',
      'postcode',
    ]);
    expect(result.spoken_response).toBeUndefined();
    expect(session.stateSnapshot.circuits[0]).toMatchObject({
      address: '2 Test Road',
      postcode: 'TE1 1ST',
      town: 'Test Town',
      county: 'Testshire',
      client_address: '2 Test Road',
      client_postcode: 'TE1 1ST',
      client_town: 'Test Town',
      client_county: 'Testshire',
    });
  });

  test('direct recovery preflights source drift before staging an earlier missing field', async () => {
    let row = {
      status: 'resolved_yes',
      clarification_kind: 'incomplete',
      source_family: 'site',
      target_family: 'client',
      operation_token: 'direct-source-drift-preflight',
      question_id: 'address-mirror-direct-source-drift-preflight',
      source_snapshot: { address: '2 Test Road', postcode: 'TE1 1ST' },
      source_writes: [
        { field: 'address', value: '2 Test Road', source_turn_id: 'turn-address' },
        { field: 'postcode', value: 'TE1 1ST', source_turn_id: 'turn-postcode' },
      ],
      terminal_outcome: {
        outcome: 'copied',
        replacement: false,
        target_snapshot: {},
      },
      delivered_at: null,
    };
    const store = {
      load: jest.fn(async () => null),
      loadRecoverableDirect: jest.fn(async () => [row]),
      claimDirectDelivery: jest.fn(async (_user, _job, _token, claimToken) => {
        row = { ...row, delivery_claim_token: claimToken };
        return row;
      }),
      conflictDirect: jest.fn(async (_user, _job, _token, terminalOutcome) => {
        row = { ...row, status: 'conflict', terminal_outcome: terminalOutcome };
        return row;
      }),
    };
    const session = sessionWith({ postcode: 'NW1 2AB' });
    const controller = createAddressMirrorController({
      userId: 'owner-direct-source-drift-preflight',
      jobId: 'job-direct-source-drift-preflight',
      session,
      store,
    });
    await controller.rehydrate();
    const writes = createPerTurnWrites();

    const recovered = await controller.recoverUndelivered(writes);

    expect(recovered).toMatchObject({ handled: true, outcome: 'conflict', changed: [] });
    expect(session.stateSnapshot.circuits[0].address).toBeUndefined();
    expect(session.stateSnapshot.circuits[0].postcode).toBe('NW1 2AB');
    expect(writes.boardReadings.size).toBe(0);
  });

  test('stale direct clarification id cannot resolve a newer opposite-direction ask', async () => {
    const session = sessionWith(
      { address: '2 Test Road', postcode: 'TE1 1ST' },
      { address: '9 Other Road', postcode: 'OT1 1HR' }
    );
    const controller = createAddressMirrorController({ session });
    const older = await controller.applyDirectCommand(
      'use the installation address for the customer',
      createPerTurnWrites(),
      'older-operation'
    );
    const olderNoWrites = createPerTurnWrites();
    const olderNo = await controller.resolveDirectClarification({
      context: {
        type: ADDRESS_MIRROR_DIRECT_QUESTION_TYPE,
        tool_call_id: older.questionId,
      },
      text: 'no',
      perTurnWrites: olderNoWrites,
    });
    await controller.markDelivered(olderNo.delivery);

    const newer = await controller.applyDirectCommand(
      'use the client address for the site',
      createPerTurnWrites(),
      'newer-operation'
    );
    const staleWrites = createPerTurnWrites();
    const stale = await controller.resolveDirectClarification({
      context: {
        type: ADDRESS_MIRROR_DIRECT_QUESTION_TYPE,
        tool_call_id: older.questionId,
        question: older.question,
      },
      text: 'yes',
      perTurnWrites: staleWrites,
    });
    expect(stale).toEqual({ handled: false, reason: 'stale_direct_question' });
    expect(staleWrites.boardReadings.size).toBe(0);
    expect(session.stateSnapshot.circuits[0]).toMatchObject({
      address: '2 Test Road',
      postcode: 'TE1 1ST',
      client_address: '9 Other Road',
      client_postcode: 'OT1 1HR',
    });
    expect(newer.questionId).not.toBe(older.questionId);
  });

  test('recovery requires exact server-owned purpose, type, or ask id', async () => {
    const session = sessionWith({ address: '2 Test Road', postcode: 'TE1 1ST' });
    const writes = sourceTurnWrites({ address: '2 Test Road', postcode: 'TE1 1ST' });
    const controller = createAddressMirrorController({ session });
    await controller.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for client?' },
      askId: 'ask-recover',
      perTurnWrites: writes,
    });
    expect(
      await controller.resolveRecoveredAnswer({
        context: { field: 'client_address' },
        text: 'yes',
        perTurnWrites: writes,
      })
    ).toEqual({ handled: false });
    expect(
      await controller.resolveRecoveredAnswer({
        context: { type: 'address_mirror' },
        text: 'yes',
        perTurnWrites: writes,
      })
    ).toMatchObject({ handled: true, outcome: 'yes' });
  });

  test('explicit stale recovery id fails closed even when purpose matches', async () => {
    const session = sessionWith({ address: '2 Test Road', postcode: 'TE1 1ST' });
    const writes = sourceTurnWrites({ address: '2 Test Road', postcode: 'TE1 1ST' });
    const controller = createAddressMirrorController({ session });
    await controller.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for client?' },
      askId: 'ask-current',
      perTurnWrites: writes,
    });

    const out = await controller.resolveRecoveredAnswer({
      context: { purpose: 'address_mirror' },
      text: 'yes',
      askId: 'ask-stale',
      perTurnWrites: writes,
    });

    expect(out).toEqual({ handled: false, reason: 'stale_address_mirror_ask_id' });
    expect(session.stateSnapshot.circuits[0].client_address).toBeUndefined();
  });

  test('terminal recovery duplicate returns its stale ask id for client clearing', async () => {
    const session = sessionWith({ address: '2 Test Road', postcode: 'TE1 1ST' });
    const writes = sourceTurnWrites({ address: '2 Test Road', postcode: 'TE1 1ST' });
    const controller = createAddressMirrorController({ session });
    await controller.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for client?' },
      askId: 'ask-delivered-terminal',
      perTurnWrites: writes,
    });
    await controller.resolveRecoveredAnswer({
      context: { purpose: 'address_mirror' },
      text: 'no',
      askId: 'ask-delivered-terminal',
      perTurnWrites: writes,
    });

    const duplicate = await controller.resolveRecoveredAnswer({
      context: { purpose: 'address_mirror' },
      text: 'no',
      askId: 'ask-delivered-terminal',
      perTurnWrites: createPerTurnWrites(),
    });

    expect(duplicate).toMatchObject({
      handled: true,
      outcome: 'duplicate',
      clearAskId: 'ask-delivered-terminal',
    });
  });

  test('two controllers sharing one CAS produce only one terminal ledger', async () => {
    let row = {
      status: 'pending',
      ask_id: 'ask-concurrent',
      source_family: 'site',
      source_snapshot: { address: '2 Test Road', postcode: 'TE1 1ST' },
      source_version_hash: null,
      source_writes: [],
      resolution_token: 'resolution-concurrent',
      delivered_at: null,
    };
    const store = {
      load: jest.fn(async () => row),
      loadRecoverableDirect: jest.fn(async () => []),
      resolve: jest.fn(async (_user, _job, status, _token, terminalOutcome) => {
        if (row.status !== 'pending') return { won: false, row };
        row = { ...row, status, terminal_outcome: terminalOutcome };
        return { won: true, row };
      }),
      claimDelivery: jest.fn(async (_user, _job, _token, claimToken) => {
        if (row.delivery_claim_token) return null;
        row = { ...row, delivery_claim_token: claimToken };
        return row;
      }),
    };
    const session = sessionWith({ address: '2 Test Road', postcode: 'TE1 1ST' });
    const a = createAddressMirrorController({
      userId: 'owner-concurrent',
      jobId: 'job-concurrent',
      session,
      store,
    });
    const b = createAddressMirrorController({
      userId: 'owner-concurrent',
      jobId: 'job-concurrent',
      session,
      store,
    });
    await Promise.all([a.rehydrate(), b.rehydrate()]);
    const writesA = createPerTurnWrites();
    const writesB = createPerTurnWrites();
    const outcomes = await Promise.all([
      a.resolveRecoveredAnswer({
        context: { purpose: 'address_mirror' },
        text: 'yes',
        askId: 'ask-concurrent',
        perTurnWrites: writesA,
      }),
      b.resolveRecoveredAnswer({
        context: { purpose: 'address_mirror' },
        text: 'yes',
        askId: 'ask-concurrent',
        perTurnWrites: writesB,
      }),
    ]);

    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(['duplicate', 'yes']);
    expect(outcomes.find((outcome) => outcome.outcome === 'duplicate')).toMatchObject({
      clearAskId: 'ask-concurrent',
    });
    const emittedLedgers = [writesA, writesB].filter(
      (writes) => writes.boardReadings.size > 0 || writes.answer.stagedText
    );
    expect(emittedLedgers).toHaveLength(1);
    expect(row.status).toBe('resolved_yes');
  });

  test('direct outbox recovery persists target drift and never overwrites it', async () => {
    let row = {
      status: 'resolved_yes',
      clarification_kind: 'direct',
      source_family: 'site',
      target_family: 'client',
      operation_token: 'direct-target-drift',
      question_id: 'address-mirror-direct-target-drift',
      source_snapshot: { address: '2 Test Road', postcode: 'TE1 1ST' },
      source_writes: [
        { field: 'address', value: '2 Test Road', source_turn_id: 'turn-address' },
        { field: 'postcode', value: 'TE1 1ST', source_turn_id: 'turn-postcode' },
      ],
      terminal_outcome: {
        outcome: 'copied',
        replacement: false,
        target_snapshot: {},
      },
      delivered_at: null,
    };
    const store = {
      load: jest.fn(async () => null),
      loadRecoverableDirect: jest.fn(async () => [row]),
      claimDirectDelivery: jest.fn(async (_user, _job, _token, claimToken) => {
        row = { ...row, delivery_claim_token: claimToken };
        return row;
      }),
      conflictDirect: jest.fn(async (_user, _job, _token, terminalOutcome) => {
        row = { ...row, status: 'conflict', terminal_outcome: terminalOutcome };
        return row;
      }),
    };
    const session = sessionWith(
      { address: '2 Test Road', postcode: 'TE1 1ST' },
      { address: '9 New Road', postcode: 'NW1 1AA' }
    );
    const controller = createAddressMirrorController({
      userId: 'owner-target-drift',
      jobId: 'job-target-drift',
      session,
      store,
    });
    await controller.rehydrate();
    const writes = createPerTurnWrites();
    const recovered = await controller.recoverUndelivered(writes);

    expect(recovered).toMatchObject({ handled: true, outcome: 'conflict', changed: [] });
    expect(row).toMatchObject({
      status: 'conflict',
      terminal_outcome: { outcome: 'conflict', reason: 'target_drift' },
    });
    expect(session.stateSnapshot.circuits[0]).toMatchObject({
      client_address: '9 New Road',
      client_postcode: 'NW1 1AA',
    });
    expect([...writes.boardReadings.values()].filter((write) => write.derived)).toHaveLength(0);

    const restartedSession = sessionWith({}, { address: '9 New Road', postcode: 'NW1 1AA' });
    const restarted = createAddressMirrorController({
      userId: 'owner-target-drift',
      jobId: 'job-target-drift',
      session: restartedSession,
      store,
    });
    await restarted.rehydrate();
    const replayWrites = createPerTurnWrites();
    const replayed = await restarted.recoverUndelivered(replayWrites);
    expect(replayed).toMatchObject({
      handled: true,
      outcome: 'conflict',
      replayedSource: 2,
    });
    const replayResult = bundleToolCallsIntoResult(replayWrites, null, {
      confirmationsEnabled: true,
      turnId: 'direct-target-conflict-retry',
    });
    expect(replayResult.confirmations.map((confirmation) => confirmation.field)).toEqual([
      'address',
      'postcode',
    ]);
    expect(restartedSession.stateSnapshot.circuits[0]).toMatchObject({
      address: '2 Test Road',
      postcode: 'TE1 1ST',
      client_address: '9 New Road',
      client_postcode: 'NW1 1AA',
    });
  });
});

// ---------------------------------------------------------------------------
// PLAN-A 2026-08-23 (feedback id 126) — relaxed completeness (address + one of
// postcode/town/county) and the fail-closed hybrid-address guard.
// ---------------------------------------------------------------------------
describe('address mirror completeness relaxation (id 126)', () => {
  const claimStore = () => ({
    claim: jest.fn(async (_user, _job, intent) => ({ claimed: true, intent })),
  });

  describe.each([
    ['site', {}, 'client_'],
    ['client', {}, ''],
  ])('%s-source family', (family) => {
    const prefix = family === 'client' ? 'client_' : '';
    const snapshotFor = (components) =>
      family === 'site' ? sessionWith(components, {}) : sessionWith({}, components);

    test.each([
      ['address + postcode', { address: '2 Test Road', postcode: 'TE1 1ST' }, true, null],
      // The evidence-session shape (17821FFA): street + county, no postcode.
      ['address + county', { address: '137 Large Lane', county: 'Essex' }, true, null],
      ['address + town', { address: '1 High Street', town: 'Bristol' }, true, null],
      ['address alone', { address: '137 Large Lane' }, false, 'source_incomplete'],
      ['county alone', { county: 'Essex' }, false, 'source_incomplete'],
      ['empty', {}, false, 'source_family_ambiguous'],
    ])('live claim with %s', async (_label, components, ok, reason) => {
      const store = claimStore();
      const controller = createAddressMirrorController({
        userId: `owner-relax-${family}`,
        jobId: `job-relax-${family}`,
        session: snapshotFor(components),
        store,
      });
      const writeValues = {};
      for (const [key, value] of Object.entries(components)) writeValues[`${prefix}${key}`] = value;
      const out = await controller.claimLiveAsk({
        input: { purpose: 'address_mirror', question: 'Use it for the other family?' },
        askId: `ask-relax-${family}`,
        perTurnWrites: sourceTurnWrites(writeValues),
      });
      if (ok) {
        expect(out).toMatchObject({ ok: true });
        expect(store.claim).toHaveBeenCalledTimes(1);
      } else {
        expect(out).toEqual({ ok: false, reason });
        expect(store.claim).not.toHaveBeenCalled();
      }
    });
  });

  test('legacy claim accepts the address+county evidence-session shape', async () => {
    const store = claimStore();
    const controller = createAddressMirrorController({
      userId: 'owner-legacy-relax',
      jobId: 'job-legacy-relax',
      session: sessionWith({ address: '137 Large Lane', county: 'Essex' }),
      store,
    });
    await expect(
      controller.claimLegacyQuestion(
        {
          type: 'address_mirror',
          purpose: 'address_mirror',
          field: 'client_address',
          id: 'ask-legacy-relax',
          question: 'Use it for the client?',
        },
        sourceTurnWrites({ county: 'Essex' })
      )
    ).resolves.toBe(true);
    expect(store.claim).toHaveBeenCalledTimes(1);
  });

  test('a target complete under the relaxed rule (address+town) suppresses the ask', async () => {
    const store = claimStore();
    const controller = createAddressMirrorController({
      userId: 'owner-target-complete',
      jobId: 'job-target-complete',
      session: sessionWith(
        { address: '2 Test Road', postcode: 'TE1 1ST' },
        { address: '9 Client Road', town: 'Bristol' }
      ),
      store,
    });
    const out = await controller.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the client?' },
      askId: 'ask-target-complete',
      perTurnWrites: sourceTurnWrites({ address: '2 Test Road', postcode: 'TE1 1ST' }),
    });
    expect(out).toEqual({ ok: false, reason: 'target_already_complete' });
    expect(store.claim).not.toHaveBeenCalled();
  });

  test('answer-time yes on an address+county source completes the copy (the :619 revalidation regression)', async () => {
    // The keystone shared-predicate property: a relaxed ask gate followed by
    // a strict answer-time revalidation would fire the ask and then refuse
    // the copy with source_incomplete. All call sites move together.
    const session = sessionWith({ address: '137 Large Lane', county: 'Essex' });
    const turnWrites = sourceTurnWrites({ address: '137 Large Lane', county: 'Essex' });
    const controller = createAddressMirrorController({ session });
    expect(
      await controller.claimLiveAsk({
        input: { purpose: 'address_mirror', question: 'Use it for the client?' },
        askId: 'ask-revalidate',
        perTurnWrites: turnWrites,
      })
    ).toMatchObject({ ok: true });
    const resolved = await controller.resolveLiveAnswer({
      input: { purpose: 'address_mirror' },
      outcome: { answered: true, user_text: 'yes' },
      askId: 'ask-revalidate',
      perTurnWrites: turnWrites,
    });
    expect(resolved).toMatchObject({ handled: true, outcome: 'yes' });
    expect(session.stateSnapshot.circuits[0]).toMatchObject({
      client_address: '137 Large Lane',
      client_county: 'Essex',
    });
    expect(session.stateSnapshot.circuits[0].client_postcode).toBeUndefined();
  });

  test('explicit direct command with address+county copies without demanding a postcode', async () => {
    const session = sessionWith({ address: '137 Large Lane', county: 'Essex' });
    const controller = createAddressMirrorController({ session });
    const copied = await controller.applyDirectCommand(
      'use the installation address for the customer',
      createPerTurnWrites(),
      'utt-direct-relax'
    );
    expect(copied).toMatchObject({ handled: true, outcome: 'copied' });
    expect(session.stateSnapshot.circuits[0]).toMatchObject({
      client_address: '137 Large Lane',
      client_county: 'Essex',
    });
  });

  test('direct clarification asks for the missing corroborator, not the address again, at emission AND durable replay', async () => {
    // A static "What is the address?" would solicit the component the
    // inspector already gave and loop forever on the address-alone shape.
    const session = sessionWith({ address: '137 Large Lane' });
    const controller = createAddressMirrorController({ session });
    const first = await controller.applyDirectCommand(
      'use the installation address for the customer',
      createPerTurnWrites(),
      'utt-corroborator'
    );
    expect(first).toMatchObject({ handled: true, outcome: 'source_incomplete' });
    expect(first.question).toBe('What is the site postcode, town, or county?');

    // Durable replay derives from the intent's PERSISTED source_snapshot —
    // byte-identical even after the live snapshot mutates.
    session.stateSnapshot.circuits[0].address = '999 Mutated After Ask';
    const replay = await controller.currentDirectQuestion();
    expect(replay.question).toBe(first.question);
  });

  test('direct clarification with no address asks for address plus a corroborator', async () => {
    const session = sessionWith();
    const controller = createAddressMirrorController({ session });
    const first = await controller.applyDirectCommand(
      'use the installation address for the customer',
      createPerTurnWrites(),
      'utt-no-address'
    );
    expect(first).toMatchObject({ handled: true, outcome: 'source_incomplete' });
    expect(first.question).toBe('What is the site address, including a town, county, or postcode?');
    const replay = await controller.currentDirectQuestion();
    expect(replay.question).toBe(first.question);
  });
});

describe('hybrid-address guard (id 126 — fail-closed, zero new durable state)', () => {
  const HYBRID_TARGETS = [
    ['postcode-only', { postcode: 'HB1 1AA' }, ['postcode']],
    // Source is address+county, so the target's county is present-but-
    // different (the pre-existing CONFLICT class) while its town is absent
    // from the source (the new BLOCKED class). Blocked dominates — the
    // conflict question's "yes" would authorise the hybrid — and the spoken
    // blocker names only the genuinely missing source component.
    ['town/county-only', { town: 'Reading', county: 'Berkshire' }, ['town']],
    ['multi-component', { postcode: 'HB1 1AA', town: 'Reading' }, ['postcode', 'town']],
  ];

  test.each(HYBRID_TARGETS)(
    'convenience ask is suppressed for a %s target (no claim offered)',
    async (_label, targetComponents) => {
      const store = {
        claim: jest.fn(async (_user, _job, intent) => ({ claimed: true, intent })),
      };
      const controller = createAddressMirrorController({
        userId: 'owner-hybrid-conv',
        jobId: 'job-hybrid-conv',
        session: sessionWith({ address: '137 Large Lane', county: 'Essex' }, targetComponents),
        store,
      });
      const out = await controller.claimLiveAsk({
        input: { purpose: 'address_mirror', question: 'Use it for the client?' },
        askId: 'ask-hybrid-conv',
        perTurnWrites: sourceTurnWrites({ address: '137 Large Lane', county: 'Essex' }),
      });
      expect(out).toEqual({ ok: false, reason: 'source_missing_target_components' });
      expect(store.claim).not.toHaveBeenCalled();
    }
  );

  test.each(HYBRID_TARGETS)(
    'direct command against a %s target terminates with a spoken blocker naming every missing source component',
    async (_label, targetComponents, missingKeys) => {
      const session = sessionWith({ address: '137 Large Lane', county: 'Essex' }, targetComponents);
      const controller = createAddressMirrorController({ session });
      const writes = createPerTurnWrites();
      const out = await controller.applyDirectCommand(
        'use the installation address for the customer',
        writes,
        `utt-hybrid-${_label}`
      );
      expect(out).toMatchObject({ handled: true, outcome: 'blocked', changed: [] });
      expect(out.question).toBeUndefined();
      const list = missingKeys.join(' and ');
      expect(writes.answer.stagedText).toBe(
        `The client address already has a ${list} — dictate the site ${list} and ask me again.`
      );
      // NEVER a silent merge: the target keeps only what it had.
      for (const [key, value] of Object.entries(targetComponents)) {
        expect(session.stateSnapshot.circuits[0][`client_${key}`]).toBe(value);
      }
      expect(session.stateSnapshot.circuits[0].client_address).toBeUndefined();
    }
  );

  test('equal on all populated-both-sides keys with no target-only components → copy proceeds', async () => {
    const session = sessionWith(
      { address: '137 Large Lane', county: 'Essex' },
      { address: '137 Large Lane', county: 'Essex' }
    );
    const controller = createAddressMirrorController({ session });
    const out = await controller.applyDirectCommand(
      'use the installation address for the customer',
      createPerTurnWrites(),
      'utt-equal-populated'
    );
    expect(out).toMatchObject({ handled: true, outcome: 'copied' });
  });

  test('following the spoken instruction recovers: dictate the named source component, then a fresh direct command copies', async () => {
    const session = sessionWith(
      { address: '137 Large Lane', county: 'Essex' },
      { postcode: 'HB1 1AA' }
    );
    const controller = createAddressMirrorController({ session });
    const writes = createPerTurnWrites();
    const blocked = await controller.applyDirectCommand(
      'use the installation address for the customer',
      writes,
      'utt-recover-1'
    );
    expect(blocked).toMatchObject({ handled: true, outcome: 'blocked' });
    expect(writes.answer.stagedText).toBe(
      'The client address already has a postcode — dictate the site postcode and ask me again.'
    );
    // FOLLOW the instruction: dictate the site postcode…
    session.stateSnapshot.circuits[0].postcode = 'HB1 1AA';
    // …then ask again with a FRESH command.
    const retried = await controller.applyDirectCommand(
      'use the installation address for the customer',
      createPerTurnWrites(),
      'utt-recover-2'
    );
    expect(retried).toMatchObject({ handled: true, outcome: 'copied' });
    expect(session.stateSnapshot.circuits[0]).toMatchObject({
      client_address: '137 Large Lane',
      client_postcode: 'HB1 1AA',
      client_county: 'Essex',
    });
  });

  test('late race (a): target-only component added after the ask is claimed — yes yields the blocker terminal, consumes the one-shot, writes nothing', async () => {
    const session = sessionWith({ address: '137 Large Lane', county: 'Essex' });
    const turnWrites = sourceTurnWrites({ address: '137 Large Lane', county: 'Essex' });
    const controller = createAddressMirrorController({ session });
    expect(
      await controller.claimLiveAsk({
        input: { purpose: 'address_mirror', question: 'Use it for the client?' },
        askId: 'ask-late-race',
        perTurnWrites: turnWrites,
      })
    ).toMatchObject({ ok: true });

    // The late race: a client postcode lands between the claim and the "yes".
    session.stateSnapshot.circuits[0].client_postcode = 'HB1 1AA';

    const answerWrites = createPerTurnWrites();
    const resolved = await controller.resolveLiveAnswer({
      input: { purpose: 'address_mirror' },
      outcome: { answered: true, user_text: 'yes' },
      askId: 'ask-late-race',
      perTurnWrites: answerWrites,
    });
    expect(resolved).toMatchObject({
      handled: true,
      outcome: 'blocked',
      changed: [],
      clearAskId: 'ask-late-race',
    });
    // The convenience wording states the recovery route — a fresh DIRECT
    // command, because the one-shot is consumed.
    expect(answerWrites.answer.stagedText).toBe(
      'The client address already has a postcode, so I haven\'t copied the site address. Dictate the site postcode, then say "use the same address for the client".'
    );
    // ZERO derived target writes.
    expect([...answerWrites.boardReadings.values()]).toHaveLength(0);
    expect(session.stateSnapshot.circuits[0].client_address).toBeUndefined();
    // One-shot consumed: a second convenience claim is refused.
    const reclaim = await controller.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the client?' },
      askId: 'ask-late-race-2',
      perTurnWrites: sourceTurnWrites({ county: 'Essex' }),
    });
    expect(reclaim.ok).toBe(false);
    // Recovery is a fresh direct command after dictating the site postcode.
    session.stateSnapshot.circuits[0].postcode = 'HB1 1AA';
    const recovered = await controller.applyDirectCommand(
      'use the same address for the client',
      createPerTurnWrites(),
      'utt-late-race-recover'
    );
    expect(recovered).toMatchObject({ handled: true, outcome: 'copied' });
  });

  test('late race (b): a direct terminal recovered against a target that gained a source-absent component fails closed, never merges', async () => {
    let directRow = null;
    const store = {
      load: jest.fn(async () => null),
      loadDirect: jest.fn(async () => directRow),
      claimDirect: jest.fn(async (_user, _job, intent) => {
        directRow = {
          status: 'pending',
          clarification_kind: intent.clarificationKind,
          source_family: intent.sourceFamily,
          target_family: intent.targetFamily,
          operation_token: intent.operationToken,
          question_id: intent.questionId,
          source_snapshot: intent.sourceSnapshot,
          source_writes: intent.sourceWrites,
        };
        return { claimed: true, intent: directRow };
      }),
      resolveDirect: jest.fn(async (_user, _job, _token, status, terminalOutcome) => {
        directRow = { ...directRow, status, terminal_outcome: terminalOutcome };
        return directRow;
      }),
      conflictDirect: jest.fn(async (_user, _job, _token, terminalOutcome) => {
        directRow = { ...directRow, status: 'conflict', terminal_outcome: terminalOutcome };
        return directRow;
      }),
    };
    const session = sessionWith({ address: '137 Large Lane', county: 'Essex' });
    const controller = createAddressMirrorController({
      userId: 'owner-late-b',
      jobId: 'job-late-b',
      session,
      store,
    });
    // Authorise the copy while the target is empty… but simulate the crash
    // BEFORE materialisation: resolveDirect persisted the terminal, then the
    // process died, so nothing was staged into this turn's writes.
    await controller.applyDirectCommand(
      'use the installation address for the customer',
      createPerTurnWrites(),
      'utt-late-b'
    );
    expect(directRow.status).toBe('resolved_yes');

    // Restart: the target gained a postcode the source lacks before recovery.
    const restartedSession = sessionWith(
      { address: '137 Large Lane', county: 'Essex' },
      { postcode: 'HB1 1AA' }
    );
    const restarted = createAddressMirrorController({
      userId: 'owner-late-b',
      jobId: 'job-late-b',
      session: restartedSession,
      store,
    });
    await restarted.rehydrate();
    const replayWrites = createPerTurnWrites();
    const recovered = await restarted.recoverUndelivered(replayWrites);
    expect(recovered).toMatchObject({ handled: true, outcome: 'blocked', changed: [] });
    expect(replayWrites.answer.stagedText).toBe(
      'The client address already has a postcode — dictate the site postcode and ask me again.'
    );
    // NEVER a silent merge, and never the generic conflict question.
    expect(restartedSession.stateSnapshot.circuits[0].client_address).toBeUndefined();
    expect(restartedSession.stateSnapshot.circuits[0].client_postcode).toBe('HB1 1AA');
    expect(replayWrites.answer.stagedText).not.toMatch(/already different/i);
    // The blocker is persisted restart-stable (status within the CHECK set,
    // payload carries the ordered missing keys).
    expect(directRow.status).toBe('conflict');
    expect(directRow.terminal_outcome).toMatchObject({
      outcome: 'blocked',
      reason: 'source_missing_target_components',
      missing_source_keys: ['postcode'],
    });
  });

  test('blocked convenience terminal replays its exact persisted wording after restart', async () => {
    let row = null;
    const store = {
      claim: jest.fn(async (_user, _job, intent) => {
        row = {
          ...intent,
          ask_id: intent.askId,
          source_family: intent.sourceFamily,
          source_snapshot: intent.sourceSnapshot,
          source_writes: intent.sourceWrites,
          resolution_token: intent.resolutionToken,
          status: 'pending',
        };
        return { claimed: true, intent: row };
      }),
      load: jest.fn(async () => row),
      resolve: jest.fn(async (_user, _job, status, _token, terminalOutcome) => {
        row = { ...row, status, terminal_outcome: terminalOutcome };
        return { won: true, row };
      }),
    };
    const session = sessionWith({ address: '137 Large Lane', county: 'Essex' });
    const controller = createAddressMirrorController({
      userId: 'owner-blocked-replay',
      jobId: 'job-blocked-replay',
      session,
      store,
    });
    await controller.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the client?' },
      askId: 'ask-blocked-replay',
      perTurnWrites: sourceTurnWrites({ address: '137 Large Lane', county: 'Essex' }),
    });
    session.stateSnapshot.circuits[0].client_town = 'Reading';
    const liveWrites = createPerTurnWrites();
    const blocked = await controller.resolveLiveAnswer({
      input: { purpose: 'address_mirror' },
      outcome: { answered: true, user_text: 'yes' },
      askId: 'ask-blocked-replay',
      perTurnWrites: liveWrites,
    });
    expect(blocked).toMatchObject({ handled: true, outcome: 'blocked' });
    const spokenLive = liveWrites.answer.stagedText;
    expect(row.terminal_outcome).toMatchObject({
      outcome: 'blocked',
      reason: 'source_missing_target_components',
      missing_source_keys: ['town'],
    });

    // Restart with a MUTATED live snapshot (the organic recovery already
    // happened: the site town was dictated). The undelivered terminal must
    // still speak the exact persisted wording — never a re-derivation, and
    // never a generic drift conflict.
    const restartedSession = sessionWith(
      { address: '137 Large Lane', county: 'Essex', town: 'Reading' },
      { town: 'Reading' }
    );
    const restarted = createAddressMirrorController({
      userId: 'owner-blocked-replay',
      jobId: 'job-blocked-replay',
      session: restartedSession,
      store,
    });
    await restarted.rehydrate();
    const replayWrites = createPerTurnWrites();
    const replayed = await restarted.recoverUndelivered(replayWrites);
    expect(replayed).toMatchObject({ handled: true, outcome: 'blocked' });
    expect(replayWrites.answer.stagedText).toBe(spokenLive);
    expect(restartedSession.stateSnapshot.circuits[0].client_address).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Codex diff-review cycle 1 (id 126) — the mirror is directional BOTH ways:
// every hybrid-guard behaviour and the legacy claim pinned in the
// client→site direction too, plus the blocked-terminal shared-CAS race.
// ---------------------------------------------------------------------------
describe('hybrid-address guard — client→site direction (id 126)', () => {
  // Source = CLIENT family (address+county), target = SITE family.
  const clientSourceSession = (targetComponents = {}) =>
    sessionWith(targetComponents, { address: '9 Client Road', county: 'Essex' });

  test('legacy claim accepts a client-source address+county shape', async () => {
    const store = {
      claim: jest.fn(async (_user, _job, intent) => ({ claimed: true, intent })),
    };
    const controller = createAddressMirrorController({
      userId: 'owner-legacy-client',
      jobId: 'job-legacy-client',
      session: clientSourceSession(),
      store,
    });
    await expect(
      controller.claimLegacyQuestion(
        {
          type: 'address_mirror',
          purpose: 'address_mirror',
          field: 'address',
          id: 'ask-legacy-client',
          question: 'Use it for the site?',
        },
        sourceTurnWrites({ client_county: 'Essex' })
      )
    ).resolves.toBe(true);
    expect(store.claim.mock.calls[0][2].sourceFamily).toBe('client');
  });

  test('convenience ask is suppressed when the SITE target holds a component the client source lacks', async () => {
    const store = {
      claim: jest.fn(async (_user, _job, intent) => ({ claimed: true, intent })),
    };
    const controller = createAddressMirrorController({
      userId: 'owner-hybrid-cs',
      jobId: 'job-hybrid-cs',
      session: clientSourceSession({ postcode: 'HB1 1AA' }),
      store,
    });
    const out = await controller.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the site?' },
      askId: 'ask-hybrid-cs',
      perTurnWrites: sourceTurnWrites({ client_address: '9 Client Road', client_county: 'Essex' }),
    });
    expect(out).toEqual({ ok: false, reason: 'source_missing_target_components' });
    expect(store.claim).not.toHaveBeenCalled();
  });

  test('direct client→site command against a postcode-only site target terminates with the reversed-family blocker wording', async () => {
    const session = clientSourceSession({ postcode: 'HB1 1AA' });
    const controller = createAddressMirrorController({ session });
    const writes = createPerTurnWrites();
    const out = await controller.applyDirectCommand(
      'use the client address for the site',
      writes,
      'utt-hybrid-cs-direct'
    );
    expect(out).toMatchObject({ handled: true, outcome: 'blocked', changed: [] });
    expect(writes.answer.stagedText).toBe(
      'The site address already has a postcode — dictate the client postcode and ask me again.'
    );
    // Never a silent merge — the site keeps only its postcode.
    expect(session.stateSnapshot.circuits[0].address).toBeUndefined();
    expect(session.stateSnapshot.circuits[0].postcode).toBe('HB1 1AA');
    // Follow the instruction: dictate the client postcode, fresh command copies.
    session.stateSnapshot.circuits[0].client_postcode = 'HB1 1AA';
    const retried = await controller.applyDirectCommand(
      'use the client address for the site',
      createPerTurnWrites(),
      'utt-hybrid-cs-direct-2'
    );
    expect(retried).toMatchObject({ handled: true, outcome: 'copied' });
    expect(session.stateSnapshot.circuits[0]).toMatchObject({
      address: '9 Client Road',
      postcode: 'HB1 1AA',
      county: 'Essex',
    });
  });

  test('late race (a) client→site: a site component added after the claim blocks the yes with the reversed convenience wording', async () => {
    const session = clientSourceSession();
    const turnWrites = sourceTurnWrites({
      client_address: '9 Client Road',
      client_county: 'Essex',
    });
    const controller = createAddressMirrorController({ session });
    expect(
      await controller.claimLiveAsk({
        input: { purpose: 'address_mirror', question: 'Use it for the site?' },
        askId: 'ask-late-cs',
        perTurnWrites: turnWrites,
      })
    ).toMatchObject({ ok: true });
    session.stateSnapshot.circuits[0].town = 'Reading';
    const answerWrites = createPerTurnWrites();
    const resolved = await controller.resolveLiveAnswer({
      input: { purpose: 'address_mirror' },
      outcome: { answered: true, user_text: 'yes' },
      askId: 'ask-late-cs',
      perTurnWrites: answerWrites,
    });
    expect(resolved).toMatchObject({ handled: true, outcome: 'blocked', changed: [] });
    expect(answerWrites.answer.stagedText).toBe(
      'The site address already has a town, so I haven\'t copied the client address. Dictate the client town, then say "use the same address for the site".'
    );
    expect([...answerWrites.boardReadings.values()]).toHaveLength(0);
    expect(session.stateSnapshot.circuits[0].address).toBeUndefined();
  });
});

describe('blocked terminal shared-CAS race (id 126)', () => {
  test('two controllers recovering one blocked direct terminal produce exactly one spoken blocker', async () => {
    let row = {
      status: 'conflict',
      clarification_kind: 'direct',
      source_family: 'site',
      target_family: 'client',
      operation_token: 'direct-blocked-race',
      question_id: 'address-mirror-direct-blocked-race',
      source_snapshot: { address: '137 Large Lane', county: 'Essex' },
      source_writes: [],
      terminal_outcome: {
        outcome: 'blocked',
        reason: 'source_missing_target_components',
        missing_source_keys: ['postcode'],
        source_family: 'site',
        target_family: 'client',
      },
      delivered_at: null,
    };
    const store = {
      load: jest.fn(async () => null),
      loadRecoverableDirect: jest.fn(async () => [row]),
      claimDirectDelivery: jest.fn(async (_user, _job, _token, claimToken) => {
        if (row.delivery_claim_token) return null;
        row = { ...row, delivery_claim_token: claimToken };
        return row;
      }),
    };
    const makeSession = () =>
      sessionWith({ address: '137 Large Lane', county: 'Essex' }, { postcode: 'HB1 1AA' });
    const a = createAddressMirrorController({
      userId: 'owner-blocked-race',
      jobId: 'job-blocked-race',
      session: makeSession(),
      store,
    });
    const b = createAddressMirrorController({
      userId: 'owner-blocked-race',
      jobId: 'job-blocked-race',
      session: makeSession(),
      store,
    });
    await Promise.all([a.rehydrate(), b.rehydrate()]);
    const writesA = createPerTurnWrites();
    const writesB = createPerTurnWrites();
    const outcomes = await Promise.all([
      a.recoverUndelivered(writesA),
      b.recoverUndelivered(writesB),
    ]);
    const blocker =
      'The client address already has a postcode — dictate the site postcode and ask me again.';
    const spoken = [writesA, writesB].filter((writes) => writes.answer.stagedText === blocker);
    expect(spoken).toHaveLength(1);
    const winner = outcomes.find((outcome) => outcome.outcome === 'blocked');
    expect(winner).toMatchObject({ handled: true, changed: [] });
    const loser = outcomes.find((outcome) => outcome !== winner);
    expect(loser.handled === false || loser.outcome === 'duplicate').toBe(true);
  });
});
