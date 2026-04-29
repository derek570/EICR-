/**
 * Tests for src/extraction/insulation-resistance-script.js — the
 * server-driven micro-conversation that captures L-L and L-E IR readings
 * and prompts for the test voltage when missing. Mirrors
 * ring-continuity-script.test.js conventions.
 */

import {
  IR_SCRIPT_HARD_TIMEOUT_MS,
  detectEntry,
  detectCancel,
  detectTopicSwitch,
  parseValue,
  parseVoltage,
  extractNamedFieldValues,
  processInsulationResistanceTurn,
  __testing__,
} from '../extraction/insulation-resistance-script.js';
import { IR_FIELDS } from '../extraction/insulation-resistance-timeout.js';

const SESSION_ID = 'sess-ir-test';

class MockWS {
  constructor() {
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
}

function buildSession(circuits = {}) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: { circuits },
  };
}

// ---------------------------------------------------------------------------
// Entry detection
// ---------------------------------------------------------------------------

describe('detectEntry', () => {
  test('"insulation resistance for circuit 3" → matched, ref=3', () => {
    expect(detectEntry('insulation resistance for circuit 3.')).toEqual({
      matched: true,
      circuit_ref: 3,
    });
  });

  test('"insulation resistance" alone → matched, ref=null', () => {
    expect(detectEntry('insulation resistance.')).toEqual({
      matched: true,
      circuit_ref: null,
    });
  });

  test('"IR for circuit 5" → matched, ref=5 (terse)', () => {
    expect(detectEntry('IR for circuit 5.')).toEqual({ matched: true, circuit_ref: 5 });
  });

  test('"I R on circuit 12" → matched, ref=12 (terse with space)', () => {
    expect(detectEntry('I R on circuit 12.')).toEqual({ matched: true, circuit_ref: 12 });
  });

  test('Garbled "insulation resistence" still matches', () => {
    expect(detectEntry('insulation resistence for circuit 4').matched).toBe(true);
  });

  test('"ring continuity for circuit 3" → does NOT match (different family)', () => {
    expect(detectEntry('ring continuity for circuit 3.')).toEqual({
      matched: false,
      circuit_ref: null,
    });
  });

  test('"insulation tape" → does NOT match (no "resistance" word)', () => {
    expect(detectEntry('I need some insulation tape')).toEqual({
      matched: false,
      circuit_ref: null,
    });
  });

  test('Bare "IR" without "circuit N" → does NOT match (needs trailer)', () => {
    expect(detectEntry('IR done.')).toEqual({ matched: false, circuit_ref: null });
  });
});

// ---------------------------------------------------------------------------
// Cancel + topic switch
// ---------------------------------------------------------------------------

describe('detectCancel', () => {
  test.each([['cancel'], ['stop'], ['skip this'], ['scrap that'], ['never mind'], ['abort']])(
    '"%s" cancels',
    (text) => expect(detectCancel(text)).toBe(true)
  );

  test('"live to live 200" does NOT cancel (it is a value)', () => {
    expect(detectCancel('live to live 200')).toBe(false);
  });
});

describe('detectTopicSwitch', () => {
  test('"Zs is 0.62" → topic switch', () => {
    expect(detectTopicSwitch('Zs is 0.62')).toBe(true);
  });

  test('"ring continuity for circuit 4" → topic switch', () => {
    expect(detectTopicSwitch('ring continuity for circuit 4')).toBe(true);
  });

  test('"polarity confirmed" → topic switch', () => {
    expect(detectTopicSwitch('polarity confirmed')).toBe(true);
  });

  test('"lives are 0.43" → topic switch (the user moved to ring)', () => {
    expect(detectTopicSwitch('lives are 0.43')).toBe(true);
  });

  test('"live to live 200" → NOT a topic switch (it is an IR value)', () => {
    expect(detectTopicSwitch('live to live 200')).toBe(false);
  });

  test('"live to earth greater than 999" → NOT a topic switch', () => {
    expect(detectTopicSwitch('live to earth greater than 999')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseValue — bare numerics, ">N" forms, saturation sentinels
// ---------------------------------------------------------------------------

describe('parseValue', () => {
  test('bare integer "200" → "200"', () => {
    expect(parseValue('200')).toBe('200');
  });

  test('bare decimal "0.43" → "0.43"', () => {
    expect(parseValue('0.43')).toBe('0.43');
  });

  test('".43" normalises leading zero → "0.43"', () => {
    expect(parseValue('.43')).toBe('0.43');
  });

  test('"greater than 200" → ">200"', () => {
    expect(parseValue('greater than 200')).toBe('>200');
  });

  test('"greater than 999" → ">999"', () => {
    expect(parseValue('greater than 999')).toBe('>999');
  });

  test('"greater than 500" (per user request — any value) → ">500"', () => {
    expect(parseValue('greater than 500')).toBe('>500');
  });

  test('"more than 200" → ">200"', () => {
    expect(parseValue('more than 200')).toBe('>200');
  });

  test('"over 999" → ">999"', () => {
    expect(parseValue('over 999')).toBe('>999');
  });

  test('"above 200" → ">200"', () => {
    expect(parseValue('above 200')).toBe('>200');
  });

  test('">200" canonical form preserved', () => {
    expect(parseValue('>200')).toBe('>200');
  });

  test('"> 200" with space → ">200" (whitespace tolerated)', () => {
    expect(parseValue('> 200')).toBe('>200');
  });

  test('"greater than .5" normalises to ">0.5"', () => {
    expect(parseValue('greater than .5')).toBe('>0.5');
  });

  test('"infinite" → ">999" (saturation sentinel)', () => {
    expect(parseValue('infinite')).toBe('>999');
  });

  test('"infinity" → ">999"', () => {
    expect(parseValue('infinity')).toBe('>999');
  });

  test('"off scale" → ">999"', () => {
    expect(parseValue('off scale')).toBe('>999');
  });

  test('"out of range" → ">999"', () => {
    expect(parseValue('out of range')).toBe('>999');
  });

  test('"OL" / "O L" → ">999" (meter shorthand)', () => {
    expect(parseValue('OL')).toBe('>999');
    expect(parseValue('O L')).toBe('>999');
  });

  test('"maxed out" → ">999"', () => {
    expect(parseValue('maxed out')).toBe('>999');
  });

  test('"hello world" → null (no value)', () => {
    expect(parseValue('hello world')).toBeNull();
  });

  test('non-string → null', () => {
    expect(parseValue(null)).toBeNull();
    expect(parseValue(undefined)).toBeNull();
    expect(parseValue(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseVoltage
// ---------------------------------------------------------------------------

describe('parseVoltage', () => {
  test('"500" → "500"', () => {
    expect(parseVoltage('500')).toBe('500');
  });

  test('"the test voltage was 250" → "250"', () => {
    expect(parseVoltage('the test voltage was 250')).toBe('250');
  });

  test('"1000" → "1000"', () => {
    expect(parseVoltage('1000')).toBe('1000');
  });

  test('"5" → null (out of range — too low to be a voltage)', () => {
    expect(parseVoltage('5')).toBeNull();
  });

  test('"3000" → null (out of range — above 2500 sanity cap)', () => {
    expect(parseVoltage('3000')).toBeNull();
  });

  test('"hello" → null', () => {
    expect(parseVoltage('hello')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractNamedFieldValues
// ---------------------------------------------------------------------------

describe('extractNamedFieldValues', () => {
  test('"live to live 200" → ir_live_live_mohm 200', () => {
    expect(extractNamedFieldValues('live to live 200')).toEqual([
      { field: 'ir_live_live_mohm', value: '200' },
    ]);
  });

  test('"live to earth greater than 999" → ir_live_earth_mohm >999', () => {
    expect(extractNamedFieldValues('live to earth greater than 999')).toEqual([
      { field: 'ir_live_earth_mohm', value: '>999' },
    ]);
  });

  test('"live to live 200, live to earth >999" → both fields', () => {
    expect(extractNamedFieldValues('live to live 200, live to earth >999')).toEqual([
      { field: 'ir_live_live_mohm', value: '200' },
      { field: 'ir_live_earth_mohm', value: '>999' },
    ]);
  });

  test('"L to L 200" shorthand → ir_live_live_mohm 200', () => {
    expect(extractNamedFieldValues('L to L 200')).toEqual([
      { field: 'ir_live_live_mohm', value: '200' },
    ]);
  });

  test('"L to E 50" shorthand → ir_live_earth_mohm 50', () => {
    expect(extractNamedFieldValues('L to E 50')).toEqual([
      { field: 'ir_live_earth_mohm', value: '50' },
    ]);
  });

  test('"line to line 250" → ir_live_live_mohm 250', () => {
    expect(extractNamedFieldValues('line to line 250')).toEqual([
      { field: 'ir_live_live_mohm', value: '250' },
    ]);
  });

  test('"ring continuity lives 0.43" → no match (ring vocabulary, not IR)', () => {
    // The IR script's vocabulary is intentionally narrower than ring's.
    // Bare "lives" maps to ring R1 in ring mode; in IR mode it's a topic
    // switch. The named-field extractor here does NOT pick "lives" up
    // as L-L — that would let ring values cross into the IR script.
    expect(extractNamedFieldValues('lives 0.43')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// processInsulationResistanceTurn — entry + flow
// ---------------------------------------------------------------------------

describe('processInsulationResistanceTurn — inactive (no entry)', () => {
  test('non-entry transcript returns handled=false', () => {
    const ws = new MockWS();
    const session = buildSession();
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'circuit 1 is upstairs sockets',
    });
    expect(out).toEqual({ handled: false });
    expect(ws.sent).toEqual([]);
    expect(session.insulationResistanceScript).toBeUndefined();
  });
});

describe('processInsulationResistanceTurn — entry without readings', () => {
  test('"insulation resistance for circuit 3" → asks LL first', () => {
    const ws = new MockWS();
    const session = buildSession();
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 3.',
      now: 100,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      type: 'ask_user_started',
      question: "What's the live-to-live?",
      context_field: 'ir_live_live_mohm',
      context_circuit: 3,
    });
    expect(session.insulationResistanceScript.active).toBe(true);
    expect(session.insulationResistanceScript.circuit_ref).toBe(3);
  });

  test('after LL is captured, asks LE next', () => {
    const ws = new MockWS();
    const session = buildSession();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 3.',
      now: 100,
    });
    ws.sent = []; // clear entry ask

    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '200',
      now: 200,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    // First sent message is the extraction write for LL.
    expect(ws.sent[0]).toMatchObject({
      type: 'extraction',
      result: {
        readings: [
          {
            field: 'ir_live_live_mohm',
            circuit: 3,
            value: '200',
            source: 'ir_script',
          },
        ],
      },
    });
    // Second is the LE prompt.
    expect(ws.sent[1]).toMatchObject({
      type: 'ask_user_started',
      question: "What's the live-to-earth?",
      context_field: 'ir_live_earth_mohm',
      context_circuit: 3,
    });
  });
});

describe('processInsulationResistanceTurn — entry with one reading volunteered', () => {
  test('"insulation resistance for circuit 3 live to live 200" → records LL, asks LE', () => {
    const ws = new MockWS();
    const session = buildSession();
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 3 live to live 200.',
      now: 100,
    });
    expect(out.handled).toBe(true);
    expect(session.insulationResistanceScript.values.ir_live_live_mohm).toBe('200');
    // Wire: extraction (LL=200) followed by ask (LE).
    const extractionMsg = ws.sent.find((m) => m.type === 'extraction');
    expect(extractionMsg.result.readings[0]).toMatchObject({
      field: 'ir_live_live_mohm',
      circuit: 3,
      value: '200',
    });
    const askMsg = ws.sent.find((m) => m.type === 'ask_user_started' && m.context_field);
    expect(askMsg.context_field).toBe('ir_live_earth_mohm');
  });

  test('"insulation resistance for circuit 3 live to earth >999" → records LE, asks LL', () => {
    const ws = new MockWS();
    const session = buildSession();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 3 live to earth greater than 999.',
      now: 100,
    });
    expect(session.insulationResistanceScript.values.ir_live_earth_mohm).toBe('>999');
    const askMsg = ws.sent.find((m) => m.type === 'ask_user_started' && m.context_field);
    expect(askMsg.context_field).toBe('ir_live_live_mohm');
  });
});

describe('processInsulationResistanceTurn — entry with both readings volunteered', () => {
  test('"insulation resistance for circuit 3 LL 200 LE >999" → both written, voltage prompt (no default set)', () => {
    const ws = new MockWS();
    const session = buildSession();
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText:
        'insulation resistance for circuit 3 live to live 200 live to earth greater than 999.',
      now: 100,
    });
    expect(out.handled).toBe(true);
    expect(session.insulationResistanceScript.values).toMatchObject({
      ir_live_live_mohm: '200',
      ir_live_earth_mohm: '>999',
    });
    // Voltage prompt should fire because circuit has no ir_test_voltage_v set.
    const askMsg = ws.sent.find(
      (m) => m.type === 'ask_user_started' && m.context_field === 'ir_test_voltage_v'
    );
    expect(askMsg).toBeDefined();
    expect(askMsg.question).toBe('What was the test voltage?');
  });

  test('voltage already populated on snapshot → script completes WITHOUT voltage ask', () => {
    const ws = new MockWS();
    const session = buildSession({
      3: { circuit_ref: 3, ir_test_voltage_v: '500' },
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText:
        'insulation resistance for circuit 3 live to live 200 live to earth greater than 999.',
      now: 100,
    });
    // No voltage ask; instead a "Got it. ..." completion info message.
    const voltageAsk = ws.sent.find(
      (m) => m.type === 'ask_user_started' && m.context_field === 'ir_test_voltage_v'
    );
    expect(voltageAsk).toBeUndefined();
    const doneMsg = ws.sent.find(
      (m) => m.type === 'ask_user_started' && m.expected_answer_shape === 'none'
    );
    expect(doneMsg.question).toMatch(/got it/i);
    expect(session.insulationResistanceScript).toBeNull(); // cleared on completion
  });
});

describe('processInsulationResistanceTurn — voltage phase', () => {
  test('voltage reply parses and finishes the script', () => {
    const ws = new MockWS();
    const session = buildSession();
    // Enter, fill both readings → voltage prompt fires
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText:
        'insulation resistance for circuit 3 live to live 200 live to earth greater than 999.',
      now: 100,
    });
    expect(session.insulationResistanceScript.phase).toBe('voltage');
    ws.sent = [];

    // User: "500"
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '500',
      now: 200,
    });
    // Wire: extraction (voltage=500) + completion announcement.
    const extractionMsg = ws.sent.find((m) => m.type === 'extraction');
    expect(extractionMsg.result.readings[0]).toMatchObject({
      field: 'ir_test_voltage_v',
      circuit: 3,
      value: '500',
    });
    const doneMsg = ws.sent.find(
      (m) => m.type === 'ask_user_started' && m.expected_answer_shape === 'none'
    );
    expect(doneMsg.question).toMatch(/got it.*L-L 200.*L-E >999.*voltage 500/i);
    expect(session.insulationResistanceScript).toBeNull();
  });

  test('"the test voltage was 250" → captures 250', () => {
    const ws = new MockWS();
    const session = buildSession();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance circuit 3 LL 200 LE 999.',
      now: 100,
    });
    ws.sent = [];
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'the test voltage was 250.',
      now: 200,
    });
    const extractionMsg = ws.sent.find((m) => m.type === 'extraction');
    expect(extractionMsg.result.readings[0]).toMatchObject({
      field: 'ir_test_voltage_v',
      value: '250',
    });
  });
});

describe('processInsulationResistanceTurn — bare-value fallback (script asked LL)', () => {
  test('after "What\'s the live-to-live?", reply "200" lands on LL', () => {
    const ws = new MockWS();
    const session = buildSession();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 4.',
      now: 100,
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: '200.',
      now: 200,
    });
    expect(session.insulationResistanceScript.values.ir_live_live_mohm).toBe('200');
  });

  test('bare "greater than 200" reply lands as ">200" on the next missing field', () => {
    const ws = new MockWS();
    const session = buildSession();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 4 live to live 200.',
      now: 100,
    });
    // Next missing is LE.
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'greater than 200.',
      now: 200,
    });
    expect(session.insulationResistanceScript.values.ir_live_earth_mohm).toBe('>200');
  });
});

describe('processInsulationResistanceTurn — cancel + topic switch', () => {
  test('"cancel" mid-script clears state, sends cancel TTS', () => {
    const ws = new MockWS();
    const session = buildSession();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 3 live to live 200.',
      now: 100,
    });
    ws.sent = [];
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'cancel',
      now: 200,
    });
    expect(out).toEqual({ handled: true, fallthrough: false });
    const cancelMsg = ws.sent.find(
      (m) => m.type === 'ask_user_started' && m.expected_answer_shape === 'none'
    );
    expect(cancelMsg.question).toMatch(/cancelled.*1 of 2 saved/i);
    expect(session.insulationResistanceScript).toBeNull();
  });

  test('"Zs is 0.62" mid-script → topic switch, fallthrough=true', () => {
    const ws = new MockWS();
    const session = buildSession();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 3.',
      now: 100,
    });
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'Zs is 0.62',
      now: 200,
    });
    expect(out).toEqual({
      handled: true,
      fallthrough: true,
      transcriptText: 'Zs is 0.62',
    });
    expect(session.insulationResistanceScript).toBeNull();
  });

  test('"ring continuity for circuit 4" mid-IR → topic switch (LE/LL not stolen)', () => {
    const ws = new MockWS();
    const session = buildSession();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 3.',
      now: 100,
    });
    const out = processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'ring continuity for circuit 4',
      now: 200,
    });
    expect(out.fallthrough).toBe(true);
    expect(session.insulationResistanceScript).toBeNull();
  });
});

describe('processInsulationResistanceTurn — different circuit entry mid-script', () => {
  test('"insulation resistance for circuit 5" while c3 active → switch', () => {
    const ws = new MockWS();
    const session = buildSession();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 3 live to live 200.',
      now: 100,
    });
    ws.sent = [];
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 5.',
      now: 200,
    });
    expect(session.insulationResistanceScript.circuit_ref).toBe(5);
    expect(session.insulationResistanceScript.values.ir_live_live_mohm).toBeUndefined();
  });
});

describe('processInsulationResistanceTurn — entry without circuit, designation match later', () => {
  test('"insulation resistance" → ask circuit, "circuit 3" answer resolves it', () => {
    const ws = new MockWS();
    const session = buildSession({
      3: { circuit_ref: 3, designation: 'kitchen sockets' },
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance.',
      now: 100,
    });
    expect(ws.sent[0].question).toMatch(/which circuit/i);
    ws.sent = [];

    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'kitchen sockets',
      now: 200,
    });
    expect(session.insulationResistanceScript.circuit_ref).toBe(3);
    // Once resolved, asks LL next.
    const askMsg = ws.sent.find((m) => m.type === 'ask_user_started' && m.context_field);
    expect(askMsg.context_field).toBe('ir_live_live_mohm');
  });
});

describe('processInsulationResistanceTurn — pre-existing partial fill on the snapshot', () => {
  test('LL already filled → script asks LE only', () => {
    const ws = new MockWS();
    const session = buildSession({
      3: { circuit_ref: 3, ir_live_live_mohm: '200' },
    });
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 3.',
      now: 100,
    });
    const askMsg = ws.sent.find((m) => m.type === 'ask_user_started' && m.context_field);
    expect(askMsg.context_field).toBe('ir_live_earth_mohm');
    // Pre-existing LL is seeded on the script state so the script knows
    // it's already filled.
    expect(session.insulationResistanceScript.values.ir_live_live_mohm).toBe('200');
  });
});

describe('processInsulationResistanceTurn — hard timeout', () => {
  test('after IR_SCRIPT_HARD_TIMEOUT_MS of silence, state clears and a new entry can fire', () => {
    const ws = new MockWS();
    const session = buildSession();
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 3.',
      now: 100,
    });
    expect(session.insulationResistanceScript.active).toBe(true);

    ws.sent = [];
    // Long silence then a fresh entry on a new circuit.
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: SESSION_ID,
      transcriptText: 'insulation resistance for circuit 7.',
      now: 100 + IR_SCRIPT_HARD_TIMEOUT_MS + 1,
    });
    expect(session.insulationResistanceScript.circuit_ref).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// IR_FIELDS contract — guard the order if a future refactor changes the
// canonical sequence.
// ---------------------------------------------------------------------------

describe('IR_FIELDS canonical order', () => {
  test('LL before LE', () => {
    expect(IR_FIELDS).toEqual(['ir_live_live_mohm', 'ir_live_earth_mohm']);
  });
});

// Exercise __testing__ exports to guarantee their stability for downstream
// consumers (mirrors the ring-continuity-script test suite contract).
describe('__testing__ exports are stable', () => {
  test('all expected helpers exposed', () => {
    expect(__testing__.parseValue).toBe(parseValue);
    expect(__testing__.parseVoltage).toBe(parseVoltage);
    expect(__testing__.extractNamedFieldValues).toBe(extractNamedFieldValues);
    expect(typeof __testing__.detectDifferentIrEntry).toBe('function');
    expect(typeof __testing__.findCircuitByDesignation).toBe('function');
    expect(__testing__.VOLTAGE_FIELD).toBe('ir_test_voltage_v');
  });
});
