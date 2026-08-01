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

function sourceTurnWrites(values) {
  const writes = createPerTurnWrites();
  for (const [field, value] of Object.entries(values)) {
    recordBoardReadingWrite(writes, encodeBoardReadingKey(field), {
      value,
      confidence: 1,
      source_turn_id: 'turn-source',
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
    };
    const original = sessionWith({ address: '14 High Street', postcode: 'SW1A 1AA' });
    const first = createAddressMirrorController({
      userId: 'owner-replay',
      jobId: 'job-replay',
      session: original,
      store,
    });
    await first.claimLiveAsk({
      input: { purpose: 'address_mirror', question: 'Use it for the client?' },
      askId: 'ask-replay',
      perTurnWrites: sourceTurnWrites({ address: '14 High Street', postcode: 'SW1A 1AA' }),
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
    expect(out).toMatchObject({ handled: true, outcome: 'yes', replayedSource: 2 });
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
      client_address: '14 High Street',
      client_postcode: 'SW1A 1AA',
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
    const out = await recovered.resolveRecoveredAnswer({
      context: null,
      text: 'yes',
      askId: 'ask-crash',
      perTurnWrites: writes,
    });
    expect(out).toMatchObject({ handled: true, outcome: 'yes', replayedSource: 2 });
    expect(restarted.stateSnapshot.circuits[0]).toMatchObject({
      address: '14 High Street',
      postcode: 'SW1A 1AA',
      client_address: '14 High Street',
      client_postcode: 'SW1A 1AA',
    });
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
      context: { type: ADDRESS_MIRROR_DIRECT_QUESTION_TYPE },
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
    expect(completed).toMatchObject({ handled: true, outcome: 'copied' });
    expect(session.stateSnapshot.circuits[0]).toMatchObject({
      client_address: '2 Test Road',
      client_postcode: 'TE1 1ST',
    });
    expect(
      [...writes.boardReadings.values()].filter((entry) => entry.derived === true)
    ).toHaveLength(2);
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
        };
        return { claimed: true, intent: directRow };
      }),
      resolveDirect: jest.fn(async (_user, _job, _token, status) => {
        directRow = { ...directRow, status };
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
      context: { type: ADDRESS_MIRROR_DIRECT_QUESTION_TYPE },
      text: 'yes',
      perTurnWrites: writes,
    });
    expect(out).toMatchObject({ handled: true, outcome: 'copied' });
    expect(directRow.status).toBe('resolved_yes');
    expect(session.stateSnapshot.circuits[0].client_address).toBe('2 Test Road');
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
});
