/**
 * PLAN-3 (feedback id 107) — durable observation severity re-code emitter.
 * Pins the two-frame order, frame-level suffix replay, Rule-6 ledger
 * composition, byte-distinct repeated speech, and active regulation fallback.
 */

import { jest } from '@jest/globals';

jest.unstable_mockModule('../storage.js', () => ({ uploadJson: jest.fn(async () => {}) }));
jest.unstable_mockModule('../logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  OBSERVATION_RECODE_EMISSION_CURSOR,
  _test_buildObservationUpdatePayload,
  _test_buildResultFrameLedger,
  emitObservationRecode,
} = await import('../extraction/sonnet-stream.js');

function update(overrides = {}) {
  return {
    type: 'observation_update',
    observation_id: 'obs-1',
    observation_text: 'AFDD protection is absent in the HMO',
    code: 'C2',
    regulation: '421.1.7',
    regulation_title: 'Protection against fire - Arc fault detection',
    regulation_description: 'AFDD provision',
    schedule_item: '5.22',
    rationale: 'test',
    source: 'test',
    ...overrides,
  };
}

function wsThatThrowsOn(callNumber = null) {
  const sent = [];
  let calls = 0;
  return {
    OPEN: 1,
    readyState: 1,
    sent,
    send(raw) {
      calls += 1;
      if (callNumber === calls) throw new Error(`send ${calls} failed`);
      sent.push(JSON.parse(raw));
    },
  };
}

function emit({ ws, state = {}, session = {}, previousCode = 'C1', payload = update() }) {
  return emitObservationRecode({
    ws,
    emissionState: state,
    update: payload,
    previousCode,
    turnId: 'turn-origin-1',
    session,
  });
}

describe('emitObservationRecode — exactly-once two-frame contract', () => {
  test('changed code emits observation_update then one field-nil extraction with the originating turn_id', () => {
    const ws = wsThatThrowsOn();
    const out = emit({ ws });
    expect(out).toMatchObject({ ok: true, recodeSpoken: true });
    expect(ws.sent.map((frame) => frame.type)).toEqual(['observation_update', 'extraction']);
    expect(ws.sent[1].result.turn_id).toBe('turn-origin-1');
    expect(ws.sent[1].result.confirmations).toEqual([
      expect.objectContaining({
        field: null,
        circuit: null,
        dedupe_token: 'obsrecode_turn-origin-1_obs-1_C1_C2',
        text: expect.stringMatching(/C1.*C2/),
      }),
    ]);
  });

  test('unchanged code emits only the data frame and stays silent', () => {
    const ws = wsThatThrowsOn();
    const out = emit({ ws, previousCode: 'C2' });
    expect(out).toMatchObject({ ok: true, recodeSpoken: false });
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0].type).toBe('observation_update');
  });

  test('failure before frame 1 replays both frames exactly once', () => {
    const state = {};
    const failed = wsThatThrowsOn(1);
    expect(emit({ ws: failed, state })).toMatchObject({
      ok: false,
      cursor: 0,
      frameKind: 'observation_update',
    });
    expect(state[OBSERVATION_RECODE_EMISSION_CURSOR]).toBe(0);
    const replay = wsThatThrowsOn();
    expect(emit({ ws: replay, state }).ok).toBe(true);
    expect(replay.sent.map((frame) => frame.type)).toEqual(['observation_update', 'extraction']);
  });

  test('failure between frames replays only the unsent confirmation suffix', () => {
    const state = {};
    const failed = wsThatThrowsOn(2);
    expect(emit({ ws: failed, state })).toMatchObject({
      ok: false,
      cursor: 1,
      frameKind: 'observation_recode_confirmation',
    });
    expect(failed.sent.map((frame) => frame.type)).toEqual(['observation_update']);
    const replay = wsThatThrowsOn();
    expect(emit({ ws: replay, state }).ok).toBe(true);
    expect(replay.sent.map((frame) => frame.type)).toEqual(['extraction']);
    expect(replay.sent[0].result.confirmations[0].dedupe_token).toBe(
      'obsrecode_turn-origin-1_obs-1_C1_C2'
    );
  });

  test('a completed emission is terminal and cannot double-send after completion', () => {
    const state = {};
    const first = wsThatThrowsOn();
    expect(emit({ ws: first, state }).ok).toBe(true);
    const duplicate = wsThatThrowsOn();
    expect(emit({ ws: duplicate, state })).toMatchObject({ ok: true, complete: true });
    expect(duplicate.sent).toEqual([]);
  });

  test('four repeated C1→C2 re-codes inside one session use byte-distinct lines', () => {
    const session = {};
    const texts = [];
    for (let i = 0; i < 4; i += 1) {
      const ws = wsThatThrowsOn();
      emit({ ws, state: {}, session });
      texts.push(ws.sent[1].result.confirmations[0].text);
    }
    expect(new Set(texts).size).toBe(4);
  });
});

describe('Rule-6 ledger and regulation preservation', () => {
  test('Rule-6 appends the same update+recode pair to the ordered extraction ledger', () => {
    const frames = _test_buildResultFrameLedger(
      {},
      {
        extracted_readings: [],
        observations: [],
        confirmations: [],
        turn_id: 'legacy-turn-7',
        observationUpdates: [
          {
            observation_id: 'obs-r6',
            observation_text: 'Damaged socket enclosure',
            previous_code: 'C3',
            code: 'C2',
            regulation: '416.2',
            source: 'rule_6_edit',
          },
        ],
      },
      {}
    ).map((frame) => ({ kind: frame.kind, body: JSON.parse(frame.json) }));

    expect(frames.map((frame) => frame.kind)).toEqual([
      'extraction',
      'observation_update',
      'observation_recode_confirmation',
    ]);
    expect(frames[2].body.result.turn_id).toBe('legacy-turn-7');
    expect(frames[2].body.result.confirmations[0].dedupe_token).toBe(
      'obsrecode_legacy-turn-7_obs-r6_C3_C2'
    );
    expect(JSON.stringify(frames)).not.toContain('previous_code');
  });

  test('rejected refined AFDD→SPD regulation actively preserves the original canonical ref and wording while accepting code', () => {
    const payload = _test_buildObservationUpdatePayload(
      {
        observation_id: 'obs-afdd',
        observation_text: 'AFDD protection is absent in an HMO',
        code: 'C3',
        regulation: '421.1.7',
      },
      {
        code: 'C2',
        regulation: '443.4',
        regulation_refinement_accepted: false,
        professional_text: 'AFDD protection is absent in the HMO.',
      }
    );
    expect(payload.code).toBe('C2');
    expect(payload.regulation).toBe('421.1.7');
    expect(payload.regulation_title).toMatch(/arc fault/i);
    expect(payload.regulation_description).toEqual(expect.any(String));
    expect(payload.regulation_description.length).toBeGreaterThan(0);
  });
});
