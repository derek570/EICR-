/**
 * Unit tests for the three route-handler helpers wired into /api/analyze-ccu
 * (ccu-per-slot-primary sprint, 2026-04-22).
 *
 * Helpers are now named exports from src/routes/extraction.js:
 *   - classifyBoardTechnology(base64, anthropic, model)
 *   - slotsToCircuits({ slots, mainSwitchSide, singleShotCircuits, minSlotConfidence })
 *   - buildCircuitFromSlot(slot, circuit_number, upstreamRcd)
 *
 * No VLM calls are made for slotsToCircuits / buildCircuitFromSlot — they are
 * pure functions that transform hand-crafted slot objects. classifyBoardTechnology
 * tests use a jest.fn() fake passed directly to the helper (no sdk module mock needed).
 *
 * Style follows src/__tests__/ccu-geometric.test.js.
 */

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mock heavy deps that import.meta.dirname (storage.js) or DB before importing
// the router module. These mocks must be registered before the lazy import.
// ---------------------------------------------------------------------------

jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: jest.fn().mockResolvedValue(true),
  uploadFile: jest.fn().mockResolvedValue(true),
  getSignedUrl: jest.fn().mockResolvedValue('https://example.com/signed'),
  getJsonObject: jest.fn().mockResolvedValue(null),
  listObjects: jest.fn().mockResolvedValue([]),
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../auth.js', () => ({
  requireAuth: jest.fn((_req, _res, next) => next()),
  generateToken: jest.fn(),
  verifyToken: jest.fn(),
}));

jest.unstable_mockModule('../sonnet_extract.js', () => ({
  sonnetExtractFromAudio: jest.fn(),
}));

jest.unstable_mockModule('../state/recording-sessions.js', () => ({
  getActiveSession: jest.fn().mockReturnValue(null),
}));

jest.unstable_mockModule('../db.js', () => ({
  getUserById: jest.fn(),
  getUserByEmail: jest.fn(),
  updateLastLogin: jest.fn(),
  logAction: jest.fn(),
}));

// Mock the geometric pipeline modules (they do their own Anthropic calls
// that we don't want to exercise here).
jest.unstable_mockModule('../extraction/ccu-geometric.js', () => ({
  extractCcuGeometric: jest.fn().mockResolvedValue({ slots: [], stage3Error: null }),
}));

jest.unstable_mockModule('../extraction/ccu-geometric-rewireable.js', () => ({
  extractCcuRewireable: jest.fn().mockResolvedValue({ slots: [], stage3Error: null }),
}));

// ---------------------------------------------------------------------------
// Module import — lazy, after mocks are registered.
// ---------------------------------------------------------------------------

let classifyBoardTechnology;
let slotsToCircuits;
let buildCircuitFromSlot;

beforeAll(async () => {
  const mod = await import('../routes/extraction.js');
  classifyBoardTechnology = mod.classifyBoardTechnology;
  slotsToCircuits = mod.slotsToCircuits;
  buildCircuitFromSlot = mod.buildCircuitFromSlot;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal slot object with sane defaults. */
function makeSlot(overrides = {}) {
  return {
    classification: 'mcb',
    tripCurve: 'B',
    ratingAmps: 32,
    poles: 1,
    manufacturer: null,
    model: null,
    sensitivity: null,
    rcdWaveformType: null,
    bsEn: null,
    confidence: 0.9,
    ...overrides,
  };
}

/** Build a minimal single-shot circuit object. */
function makeSSCircuit(circuit_number, overrides = {}) {
  return {
    circuit_number,
    label: `Circuit ${circuit_number}`,
    ocpd_type: 'B',
    ocpd_rating_a: '32',
    ocpd_bs_en: '60898-1',
    ocpd_breaking_capacity_ka: '6',
    is_rcbo: false,
    rcd_protected: false,
    rcd_type: null,
    rcd_rating_ma: null,
    rcd_bs_en: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// slotsToCircuits
// ---------------------------------------------------------------------------

describe('slotsToCircuits', () => {
  test('1. returns null for empty slots array', () => {
    expect(slotsToCircuits({ slots: [], mainSwitchSide: 'left', singleShotCircuits: [] })).toBeNull();
  });

  test('1b. returns null for undefined slots', () => {
    expect(slotsToCircuits({ slots: undefined, mainSwitchSide: 'left', singleShotCircuits: [] })).toBeNull();
  });

  test('2. modern board, main switch LEFT — 4 slots in physical order', () => {
    const slots = [
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.9 }),
      makeSlot({ classification: 'mcb', tripCurve: 'C', ratingAmps: 16, confidence: 0.9 }),
      makeSlot({ classification: 'rcbo', tripCurve: 'B', ratingAmps: 32, sensitivity: 30, rcdWaveformType: 'A', confidence: 0.9 }),
      makeSlot({ classification: 'blank', confidence: 0.95 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left', singleShotCircuits: [] });

    expect(circuits).toHaveLength(4);
    expect(circuits[0].circuit_number).toBe(1);
    expect(circuits[1].circuit_number).toBe(2);
    expect(circuits[2].circuit_number).toBe(3);
    expect(circuits[3].circuit_number).toBe(4);

    // RCBO at slot index 2 → circuit 3
    expect(circuits[2].is_rcbo).toBe(true);
    expect(circuits[2].ocpd_bs_en).toBe('61009-1');

    // Blank at slot index 3 → circuit 4 "Spare"
    expect(circuits[3].label).toBe('Spare');
    expect(circuits[3].ocpd_type).toBeNull();
  });

  test('3. modern board, main switch RIGHT — circuits numbered in reverse physical order', () => {
    // Rightmost slot (index 3) is nearest the main switch → circuit 1
    const slots = [
      makeSlot({ classification: 'mcb', tripCurve: 'D', ratingAmps: 100, confidence: 0.9 }),
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 16, confidence: 0.9 }),
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 6, confidence: 0.9 }),
      makeSlot({ classification: 'mcb', tripCurve: 'C', ratingAmps: 32, confidence: 0.9 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'right', singleShotCircuits: [] });

    expect(circuits).toHaveLength(4);
    // slot[3] (C32) is processed first → circuit 1
    expect(circuits[0].circuit_number).toBe(1);
    expect(circuits[0].ocpd_type).toBe('C');
    expect(circuits[0].ocpd_rating_a).toBe('32');

    // slot[0] (D100) is processed last → circuit 4
    expect(circuits[3].circuit_number).toBe(4);
    expect(circuits[3].ocpd_type).toBe('D');
    expect(circuits[3].ocpd_rating_a).toBe('100');
  });

  test('4. standalone RCD cascades rcd_* fields to subsequent MCBs', () => {
    const slots = [
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.9 }),
      makeSlot({ classification: 'rcd', rcdWaveformType: 'AC', sensitivity: 30, confidence: 0.9 }),
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 16, confidence: 0.9 }),
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 6, confidence: 0.9 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left', singleShotCircuits: [] });

    // RCD slot itself is NOT a circuit — only 3 circuit rows
    expect(circuits).toHaveLength(3);

    // MCB before the RCD (circuit 1) — NOT rcd_protected
    expect(circuits[0].circuit_number).toBe(1);
    expect(circuits[0].rcd_protected).toBe(false);
    expect(circuits[0].rcd_bs_en).toBeNull();

    // MCBs after the RCD (circuits 2 and 3) — ARE rcd_protected
    expect(circuits[1].circuit_number).toBe(2);
    expect(circuits[1].rcd_protected).toBe(true);
    expect(circuits[1].rcd_type).toBe('AC');
    expect(circuits[1].rcd_rating_ma).toBe('30');
    expect(circuits[1].rcd_bs_en).toBe('61008');

    expect(circuits[2].circuit_number).toBe(3);
    expect(circuits[2].rcd_protected).toBe(true);
    expect(circuits[2].rcd_type).toBe('AC');
    expect(circuits[2].rcd_rating_ma).toBe('30');
    expect(circuits[2].rcd_bs_en).toBe('61008');
  });

  test('5. main_switch slot is skipped entirely', () => {
    const slots = [
      makeSlot({ classification: 'main_switch', poles: 2, confidence: 0.99 }),
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.9 }),
      makeSlot({ classification: 'mcb', tripCurve: 'C', ratingAmps: 16, confidence: 0.9 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left', singleShotCircuits: [] });

    expect(circuits).toHaveLength(2);
    expect(circuits[0].circuit_number).toBe(1);
    expect(circuits[0].ocpd_type).toBe('B');
  });

  test('6. spd slot is skipped entirely', () => {
    const slots = [
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.9 }),
      makeSlot({ classification: 'spd', confidence: 0.95 }),
      makeSlot({ classification: 'mcb', tripCurve: 'C', ratingAmps: 16, confidence: 0.9 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left', singleShotCircuits: [] });

    expect(circuits).toHaveLength(2);
    expect(circuits[0].circuit_number).toBe(1);
    expect(circuits[1].circuit_number).toBe(2);
  });

  test('7. rewireable slot → ocpd_type="Rew", ocpd_bs_en="BS 3036", ocpd_breaking_capacity_ka=null', () => {
    const slots = [
      makeSlot({ classification: 'rewireable', tripCurve: null, ratingAmps: 30, bsEn: null, confidence: 0.9 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left', singleShotCircuits: [] });

    expect(circuits).toHaveLength(1);
    expect(circuits[0].ocpd_type).toBe('Rew');
    expect(circuits[0].ocpd_bs_en).toBe('BS 3036');
    expect(circuits[0].ocpd_breaking_capacity_ka).toBeNull();
    expect(circuits[0].ocpd_rating_a).toBe('30');
  });

  test('8. cartridge slot → ocpd_type="HRC", ocpd_bs_en="BS 1361"', () => {
    const slots = [
      makeSlot({ classification: 'cartridge', tripCurve: null, ratingAmps: 30, bsEn: null, confidence: 0.9 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left', singleShotCircuits: [] });

    expect(circuits).toHaveLength(1);
    expect(circuits[0].ocpd_type).toBe('HRC');
    expect(circuits[0].ocpd_bs_en).toBe('BS 1361');
  });

  test('9. low-confidence slot falls back to singleShotCircuits for device fields', () => {
    const singleShotCircuits = [
      makeSSCircuit(1, { label: 'Cooker', ocpd_type: 'C', ocpd_rating_a: '40' }),
    ];
    const slots = [
      // confidence 0.5 < default threshold 0.7
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.5 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left', singleShotCircuits });

    expect(circuits).toHaveLength(1);
    // Should use single-shot data for device fields
    expect(circuits[0].ocpd_type).toBe('C');
    expect(circuits[0].ocpd_rating_a).toBe('40');
    expect(circuits[0].label).toBe('Cooker');
    expect(circuits[0].circuit_number).toBe(1);
  });

  test('10. low-confidence slot with NO single-shot fallback → empty circuit shell', () => {
    const slots = [
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.5 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left', singleShotCircuits: [] });

    expect(circuits).toHaveLength(1);
    expect(circuits[0].circuit_number).toBe(1);
    expect(circuits[0].label).toBeNull();
    expect(circuits[0].ocpd_type).toBeNull();
    expect(circuits[0].ocpd_rating_a).toBeNull();
    expect(circuits[0].ocpd_bs_en).toBeNull();
    expect(circuits[0].ocpd_breaking_capacity_ka).toBeNull();
    expect(circuits[0].is_rcbo).toBe(false);
    expect(circuits[0].rcd_protected).toBe(false);
    expect(circuits[0].rcd_type).toBeNull();
    expect(circuits[0].rcd_rating_ma).toBeNull();
    expect(circuits[0].rcd_bs_en).toBeNull();
  });

  test('11. label from single-shot; string "null" treated as missing and emits null', () => {
    const singleShotCircuits = [
      makeSSCircuit(1, { label: 'null' }), // string "null" → should be treated as missing
      makeSSCircuit(2, { label: 'Kitchen' }),
    ];
    const slots = [
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.9 }),
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 16, confidence: 0.9 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left', singleShotCircuits });

    // circuit 1: label="null" → should emit null label (not overwritten with "null")
    expect(circuits[0].label).toBeNull();
    // circuit 2: label="Kitchen" → should be preserved
    expect(circuits[1].label).toBe('Kitchen');
  });

  test('12. minSlotConfidence=0.5 accepts a slot with confidence 0.6 that default threshold would reject', () => {
    const singleShotCircuits = [
      makeSSCircuit(1, { label: 'Lights', ocpd_type: 'C', ocpd_rating_a: '6' }),
    ];
    const slots = [
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.6 }),
    ];

    // Default threshold 0.7 → this would fall back to single-shot
    const withDefault = slotsToCircuits({
      slots,
      mainSwitchSide: 'left',
      singleShotCircuits,
    });
    expect(withDefault[0].ocpd_type).toBe('C'); // fallback to single-shot

    // With lowered threshold 0.5 → slot is accepted, reads B/32 from slot
    const withLow = slotsToCircuits({
      slots,
      mainSwitchSide: 'left',
      singleShotCircuits,
      minSlotConfidence: 0.5,
    });
    expect(withLow[0].ocpd_type).toBe('B');
    expect(withLow[0].ocpd_rating_a).toBe('32');
  });
});

// ---------------------------------------------------------------------------
// buildCircuitFromSlot
// ---------------------------------------------------------------------------

describe('buildCircuitFromSlot', () => {
  test('13. MCB B32 → correct ocpd fields', () => {
    const slot = makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32 });
    const circuit = buildCircuitFromSlot(slot, 1, null);

    expect(circuit.circuit_number).toBe(1);
    expect(circuit.ocpd_type).toBe('B');
    expect(circuit.ocpd_rating_a).toBe('32');
    expect(circuit.ocpd_bs_en).toBe('60898-1');
    expect(circuit.ocpd_breaking_capacity_ka).toBe('6');
    expect(circuit.is_rcbo).toBe(false);
    expect(circuit.rcd_protected).toBe(false);
    expect(circuit.rcd_type).toBeNull();
    expect(circuit.rcd_rating_ma).toBeNull();
    expect(circuit.rcd_bs_en).toBeNull();
    expect(circuit.label).toBeNull();
  });

  test('14. RCBO C16 30mA Type A → full RCBO fields', () => {
    const slot = makeSlot({
      classification: 'rcbo',
      tripCurve: 'C',
      ratingAmps: 16,
      sensitivity: 30,
      rcdWaveformType: 'A',
    });
    const circuit = buildCircuitFromSlot(slot, 3, null);

    expect(circuit.is_rcbo).toBe(true);
    expect(circuit.rcd_protected).toBe(true);
    expect(circuit.rcd_type).toBe('A');
    expect(circuit.rcd_rating_ma).toBe('30');
    expect(circuit.rcd_bs_en).toBe('61009');
    // ocpd fields
    expect(circuit.ocpd_type).toBe('C');
    expect(circuit.ocpd_rating_a).toBe('16');
    expect(circuit.ocpd_bs_en).toBe('61009-1');
    expect(circuit.ocpd_breaking_capacity_ka).toBe('6');
  });

  test('15. MCB behind upstream RCD inherits rcd_* from upstreamRcd', () => {
    const slot = makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 16 });
    const upstreamRcd = { type: 'AC', sensitivity: '30' };
    const circuit = buildCircuitFromSlot(slot, 2, upstreamRcd);

    expect(circuit.is_rcbo).toBe(false);
    expect(circuit.rcd_protected).toBe(true);
    expect(circuit.rcd_type).toBe('AC');
    expect(circuit.rcd_rating_ma).toBe('30');
    expect(circuit.rcd_bs_en).toBe('61008');
  });

  test('16. Rewireable slot 30A → Rew fields, null kA', () => {
    const slot = makeSlot({
      classification: 'rewireable',
      tripCurve: null,
      ratingAmps: 30,
      bsEn: null,
    });
    const circuit = buildCircuitFromSlot(slot, 1, null);

    expect(circuit.ocpd_type).toBe('Rew');
    expect(circuit.ocpd_rating_a).toBe('30');
    expect(circuit.ocpd_bs_en).toBe('BS 3036');
    expect(circuit.ocpd_breaking_capacity_ka).toBeNull();
    expect(circuit.is_rcbo).toBe(false);
    expect(circuit.rcd_protected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyBoardTechnology
// ---------------------------------------------------------------------------

describe('classifyBoardTechnology', () => {
  /**
   * Build a fake Anthropic client whose messages.create returns `response`.
   * We pass this directly to the helper so no module-level mock is needed.
   */
  function makeFakeAnthropic(response) {
    return {
      messages: {
        create: jest.fn().mockResolvedValueOnce(response),
      },
    };
  }

  test('17. returns correctly-shaped result from bare JSON response', async () => {
    const fakeResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            board_technology: 'modern',
            main_switch_position: 'left',
            confidence: 0.9,
          }),
        },
      ],
      usage: { input_tokens: 120, output_tokens: 25 },
    };

    const fakeAnthropic = makeFakeAnthropic(fakeResponse);
    const result = await classifyBoardTechnology('base64data==', fakeAnthropic, 'claude-sonnet-4-6');

    expect(result.boardTechnology).toBe('modern');
    expect(result.mainSwitchPosition).toBe('left');
    expect(result.confidence).toBe(0.9);
    expect(result.usage.inputTokens).toBe(120);
    expect(result.usage.outputTokens).toBe(25);

    // Ensure exactly one call was made with the provided model
    expect(fakeAnthropic.messages.create).toHaveBeenCalledTimes(1);
    const callArgs = fakeAnthropic.messages.create.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-sonnet-4-6');
  });

  test('18. handles response wrapped in ```json ... ``` fence', async () => {
    const fakeResponse = {
      content: [
        {
          type: 'text',
          text: 'Sure, here you go:\n```json\n{"board_technology":"rewireable_fuse","main_switch_position":"right","confidence":0.85}\n```',
        },
      ],
      usage: { input_tokens: 150, output_tokens: 30 },
    };

    const fakeAnthropic = makeFakeAnthropic(fakeResponse);
    const result = await classifyBoardTechnology('base64data==', fakeAnthropic, 'claude-haiku-3-5');

    expect(result.boardTechnology).toBe('rewireable_fuse');
    expect(result.mainSwitchPosition).toBe('right');
    expect(result.confidence).toBe(0.85);
    expect(result.usage.inputTokens).toBe(150);
    expect(result.usage.outputTokens).toBe(30);
  });
});
