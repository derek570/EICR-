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
  uploadBytes: jest.fn().mockResolvedValue(true),
  uploadText: jest.fn().mockResolvedValue(true),
  downloadText: jest.fn().mockResolvedValue(''),
  isUsingS3: jest.fn().mockReturnValue(false),
  getSignedUrl: jest.fn().mockResolvedValue('https://example.com/signed'),
  getJsonObject: jest.fn().mockResolvedValue(null),
  listObjects: jest.fn().mockResolvedValue([]),
}));

// Mock queue.js so the new idempotency middleware (wired into /analyze-ccu)
// doesn't pull in BullMQ + IORedis + their transitive deps during these
// route-merger tests. Returning isRedisAvailable=false makes the middleware
// a no-op, which is what we want here — these tests cover Stage 3/4 + merger
// behaviour, not idempotency.
jest.unstable_mockModule('../queue.js', () => ({
  getConnection: jest.fn().mockReturnValue({
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn().mockResolvedValue(1),
  }),
  isRedisAvailable: jest.fn().mockReturnValue(false),
  enqueueJob: jest.fn().mockResolvedValue(undefined),
  startWorker: jest.fn().mockResolvedValue(undefined),
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
  requireAuth: jest.fn((req, _res, next) => {
    req.user = { id: 'user-1', email: 'test@example.com' };
    next();
  }),
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
// Mocks include both the thin-wrapper orchestrators (back-compat) AND the
// prepare/classify split functions used by the route handler's parallel flow.
jest.unstable_mockModule('../extraction/ccu-geometric.js', () => ({
  extractCcuGeometric: jest.fn().mockResolvedValue({ slots: [], stage3Error: null }),
  prepareModernGeometry: jest.fn().mockResolvedValue({
    slotCentersX: [],
    moduleWidth: 0,
    medianRails: { rail_top: 0, rail_bottom: 0, rail_left: 0, rail_right: 0 },
    imageWidth: 1000,
    imageHeight: 1000,
    usage: { inputTokens: 0, outputTokens: 0 },
    timings: { stage1Ms: 0, stage2Ms: 0 },
    stageOutputs: { stage1: {}, stage2: {} },
  }),
  classifyModernSlots: jest.fn().mockResolvedValue({
    slots: [],
    stage3Error: null,
    timings: { stage3Ms: 0 },
    usage: { inputTokens: 0, outputTokens: 0 },
    stageOutputs: { stage3: {} },
  }),
}));

jest.unstable_mockModule('../extraction/ccu-geometric-rewireable.js', () => ({
  extractCcuRewireable: jest.fn().mockResolvedValue({ slots: [], stage3Error: null }),
  prepareRewireableGeometry: jest.fn().mockResolvedValue({
    slotCentersX: [],
    carrierPitchPx: 0,
    medianPanel: { panel_top: 0, panel_bottom: 0, panel_left: 0, panel_right: 0 },
    panelBounds: { top: 0, bottom: 0, left: 0, right: 0 },
    imageWidth: 1000,
    imageHeight: 1000,
    usage: { inputTokens: 0, outputTokens: 0 },
    timings: { stage1Ms: 0, stage2Ms: 0 },
    stageOutputs: { stage1: {}, stage2: {} },
  }),
  classifyRewireableSlots: jest.fn().mockResolvedValue({
    slots: [],
    stage3Error: null,
    lowConfidence: false,
    timings: { stage3Ms: 0 },
    usage: { inputTokens: 0, outputTokens: 0 },
    stageOutputs: { stage3: {} },
  }),
}));

// Mock the Stage 4 label pass — the parallel-dispatch test below spies on
// classifyModernSlots + extractSlotLabels to prove they're dispatched via
// Promise.all (both start before either resolves).
const mockExtractSlotLabels = jest.fn().mockResolvedValue({
  labels: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  batchCount: 0,
  skippedSlotIndices: [],
  timings: { cropMs: 0, vlmMs: 0, totalMs: 0 },
});

jest.unstable_mockModule('../extraction/ccu-label-pass.js', () => ({
  extractSlotLabels: mockExtractSlotLabels,
}));

// Mock the Anthropic SDK — the parallel-dispatch test drives the full route
// handler via supertest, so we need a stub that responds to both the
// classifier prompt (~200-token JSON reply) and the single-shot prompt (full
// ~4KB JSON reply) without any real network calls.
const mockAnthropicMessagesCreate = jest.fn();
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockAnthropicMessagesCreate },
  })),
}));

// ---------------------------------------------------------------------------
// Module import — lazy, after mocks are registered.
// ---------------------------------------------------------------------------

let classifyBoardTechnology;
let slotsToCircuits;
let buildCircuitFromSlot;
let assembleGeometricResult;
let classifyModernSlotsMock;
let prepareModernGeometryMock;

beforeAll(async () => {
  const mod = await import('../routes/extraction.js');
  classifyBoardTechnology = mod.classifyBoardTechnology;
  slotsToCircuits = mod.slotsToCircuits;
  buildCircuitFromSlot = mod.buildCircuitFromSlot;
  assembleGeometricResult = mod.assembleGeometricResult;

  // Grab references to the mocked prepare/classify functions so the
  // parallel-dispatch test can override their implementations per-test.
  const modernMod = await import('../extraction/ccu-geometric.js');
  prepareModernGeometryMock = modernMod.prepareModernGeometry;
  classifyModernSlotsMock = modernMod.classifyModernSlots;
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
    expect(
      slotsToCircuits({ slots: [], mainSwitchSide: 'left', singleShotCircuits: [] })
    ).toBeNull();
  });

  test('1b. returns null for undefined slots', () => {
    expect(
      slotsToCircuits({ slots: undefined, mainSwitchSide: 'left', singleShotCircuits: [] })
    ).toBeNull();
  });

  test('2. modern board, main switch LEFT — 4 slots in physical order', () => {
    const slots = [
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.9 }),
      makeSlot({ classification: 'mcb', tripCurve: 'C', ratingAmps: 16, confidence: 0.9 }),
      makeSlot({
        classification: 'rcbo',
        tripCurve: 'B',
        ratingAmps: 32,
        sensitivity: 30,
        rcdWaveformType: 'A',
        confidence: 0.9,
      }),
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

  test('4. standalone RCD emits an own-row AND cascades rcd_* fields to subsequent MCBs', () => {
    const slots = [
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.9 }),
      makeSlot({
        classification: 'rcd',
        rcdWaveformType: 'AC',
        sensitivity: 30,
        ratingAmps: 80,
        bsEn: 'BS EN 61008-1',
        confidence: 0.9,
      }),
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 16, confidence: 0.9 }),
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 6, confidence: 0.9 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left', singleShotCircuits: [] });

    // 3 MCB rows + 1 RCD own-row = 4 entries total
    expect(circuits).toHaveLength(4);

    // MCB before the RCD (circuit 1) — NOT rcd_protected
    expect(circuits[0].circuit_number).toBe(1);
    expect(circuits[0].rcd_protected).toBe(false);
    expect(circuits[0].rcd_bs_en).toBeNull();
    expect(circuits[0].is_rcd_device).toBeUndefined();

    // RCD own-row — no circuit_number, BS EN 61008-1, 80A 30mA AC
    expect(circuits[1].is_rcd_device).toBe(true);
    expect(circuits[1].circuit_number).toBeNull();
    expect(circuits[1].ocpd_rating_a).toBe('80');
    expect(circuits[1].rcd_type).toBe('AC');
    expect(circuits[1].rcd_rating_ma).toBe('30');
    expect(circuits[1].rcd_bs_en).toBe('BS EN 61008-1');

    // MCBs after the RCD (circuits 2 and 3) — ARE rcd_protected
    expect(circuits[2].circuit_number).toBe(2);
    expect(circuits[2].rcd_protected).toBe(true);
    expect(circuits[2].rcd_type).toBe('AC');
    expect(circuits[2].rcd_rating_ma).toBe('30');
    expect(circuits[2].rcd_bs_en).toBe('61008');

    expect(circuits[3].circuit_number).toBe(3);
    expect(circuits[3].rcd_protected).toBe(true);
    expect(circuits[3].rcd_type).toBe('AC');
    expect(circuits[3].rcd_rating_ma).toBe('30');
    expect(circuits[3].rcd_bs_en).toBe('61008');
  });

  test('4b. two adjacent rcd slots (one 2-module physical device) collapse to ONE row', () => {
    // An RCD is always 2 modules wide on UK boards — Stage 3 classifies both
    // module-halves as "rcd". The merger must emit a single schedule row for
    // the pair, not two.
    const slots = [
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.9 }),
      // First rcd slot — strong face read (rating, bsEn).
      makeSlot({
        classification: 'rcd',
        rcdWaveformType: 'AC',
        sensitivity: 30,
        ratingAmps: 80,
        bsEn: 'BS EN 61008-1',
        confidence: 0.9,
      }),
      // Second rcd slot — weaker read, BUT carries rcdWaveformType which the
      // first slot missed. Gap-fill from here should win over the first
      // slot's null.
      makeSlot({
        classification: 'rcd',
        rcdWaveformType: null, // still null here
        sensitivity: null,
        ratingAmps: null,
        confidence: 0.8,
      }),
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 16, confidence: 0.9 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left' });

    // 2 MCBs + 1 collapsed RCD row = 3 entries
    expect(circuits).toHaveLength(3);
    // _rcdPairOpen must not leak to callers.
    expect(circuits[1]._rcdPairOpen).toBeUndefined();
    // Circuit numbers don't jump — RCD row is unnumbered.
    expect(circuits[0].circuit_number).toBe(1);
    expect(circuits[1].is_rcd_device).toBe(true);
    expect(circuits[1].circuit_number).toBeNull();
    expect(circuits[2].circuit_number).toBe(2);
    // The downstream MCB still gets the cascaded RCD protection.
    expect(circuits[2].rcd_protected).toBe(true);
    expect(circuits[2].rcd_type).toBe('AC');
  });

  test('4c. two rcd slots separated by a non-rcd slot emit TWO rcd rows', () => {
    // Paranoia case: two genuinely separate physical RCDs with an MCB between
    // them. Must NOT collapse — even though both are "rcd", they are
    // different devices.
    const slots = [
      makeSlot({
        classification: 'rcd',
        rcdWaveformType: 'AC',
        sensitivity: 30,
        ratingAmps: 63,
        confidence: 0.9,
      }),
      makeSlot({
        classification: 'rcd',
        rcdWaveformType: 'AC',
        sensitivity: 30,
        ratingAmps: 63,
        confidence: 0.9,
      }),
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.9 }),
      // A genuinely second RCD after an MCB — not part of the first pair.
      makeSlot({
        classification: 'rcd',
        rcdWaveformType: 'A',
        sensitivity: 30,
        ratingAmps: 80,
        confidence: 0.9,
      }),
      makeSlot({
        classification: 'rcd',
        rcdWaveformType: 'A',
        sensitivity: 30,
        ratingAmps: 80,
        confidence: 0.9,
      }),
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 16, confidence: 0.9 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left' });

    // 2 RCDs + 2 MCBs = 4 rows (each RCD is a 2-module dedupe → 1 row each).
    expect(circuits).toHaveLength(4);
    expect(circuits[0].is_rcd_device).toBe(true);
    expect(circuits[0].rcd_type).toBe('AC');
    expect(circuits[1].circuit_number).toBe(1);
    expect(circuits[1].rcd_type).toBe('AC');
    expect(circuits[2].is_rcd_device).toBe(true);
    expect(circuits[2].rcd_type).toBe('A'); // different RCD, different waveform
    expect(circuits[3].circuit_number).toBe(2);
    expect(circuits[3].rcd_type).toBe('A');
  });

  test('4d. cascade BREAKS at blank slots — MCBs after a run of spares are not RCD-protected', () => {
    // 38 Dickens Close topology (2026-04-28): RCD at left, 2 MCBs, then 3
    // spares (blanks), then 2 more MCBs, then main switch. The MCBs BEFORE
    // the spares inherit RCD protection; MCBs AFTER the spares do NOT.
    // Pre-pass cascade computation breaks at the first blank.
    const slots = [
      // First module of 2-module RCD
      makeSlot({
        classification: 'rcd',
        rcdWaveformType: 'AC',
        sensitivity: 30,
        ratingAmps: 80,
        confidence: 0.9,
      }),
      // Second module of same RCD (collapsed by dedupe)
      makeSlot({ classification: 'rcd', confidence: 0.85 }),
      // 2 MCBs — should inherit RCD cascade
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.9 }),
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.9 }),
      // 3 spares — cascade breaks here
      makeSlot({ classification: 'blank', content: 'blank', confidence: 0.95 }),
      makeSlot({ classification: 'blank', content: 'blank', confidence: 0.95 }),
      makeSlot({ classification: 'blank', content: 'blank', confidence: 0.95 }),
      // 2 MCBs after spares — should NOT have RCD cascade
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 6, confidence: 0.9 }),
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 6, confidence: 0.9 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'right' });
    // 1 RCD row + 4 MCBs + 3 Spares = 8 entries (RCD row is unnumbered).
    expect(circuits).toHaveLength(8);

    // Identify RCD row + numbered MCBs / spares
    const rcdRow = circuits.find((c) => c.is_rcd_device);
    expect(rcdRow).toBeDefined();
    expect(rcdRow.rcd_type).toBe('AC');

    const mcbs = circuits.filter((c) => c.circuit_number != null && c.label !== 'Spare');
    expect(mcbs).toHaveLength(4);

    // Right-handed scan: circuits 1-2 are the RIGHT-side MCBs (after spares,
    // unprotected). Circuits 3-4 are the LEFT-side MCBs (RCD-protected).
    // Find by ratingAmps — right-side MCBs are 6A, left-side are 32A.
    const protectedMcbs = mcbs.filter((c) => c.ocpd_rating_a === '32');
    const unprotectedMcbs = mcbs.filter((c) => c.ocpd_rating_a === '6');
    expect(protectedMcbs).toHaveLength(2);
    expect(unprotectedMcbs).toHaveLength(2);

    for (const c of protectedMcbs) {
      expect(c.rcd_protected).toBe(true);
      expect(c.rcd_type).toBe('AC');
      expect(c.rcd_rating_ma).toBe('30');
    }
    for (const c of unprotectedMcbs) {
      expect(c.rcd_protected).toBe(false);
      expect(c.rcd_type).toBeNull();
    }
  });

  test('4e. cascade BREAKS at main_switch slot too', () => {
    // Defensive: a main_switch in the middle of slot order (rare — usually
    // at the end) also breaks cascade. MCBs after a main_switch do not
    // inherit RCD protection from before it.
    const slots = [
      makeSlot({
        classification: 'rcd',
        rcdWaveformType: 'A',
        sensitivity: 30,
        confidence: 0.9,
      }),
      makeSlot({ classification: 'rcd', confidence: 0.85 }),
      makeSlot({ classification: 'mcb', tripCurve: 'C', ratingAmps: 16, confidence: 0.9 }),
      makeSlot({ classification: 'main_switch', poles: 2, confidence: 0.9 }),
      makeSlot({ classification: 'mcb', tripCurve: 'C', ratingAmps: 32, confidence: 0.9 }),
    ];
    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left' });
    // 1 RCD row + 2 MCBs (main_switch skipped entirely)
    expect(circuits).toHaveLength(3);
    const protectedMcb = circuits.find((c) => c.ocpd_rating_a === '16');
    const unprotectedMcb = circuits.find((c) => c.ocpd_rating_a === '32');
    expect(protectedMcb.rcd_protected).toBe(true);
    expect(unprotectedMcb.rcd_protected).toBe(false);
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
      makeSlot({
        classification: 'rewireable',
        tripCurve: null,
        ratingAmps: 30,
        bsEn: null,
        confidence: 0.9,
      }),
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
      makeSlot({
        classification: 'cartridge',
        tripCurve: null,
        ratingAmps: 30,
        bsEn: null,
        confidence: 0.9,
      }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left', singleShotCircuits: [] });

    expect(circuits).toHaveLength(1);
    expect(circuits[0].ocpd_type).toBe('HRC');
    expect(circuits[0].ocpd_bs_en).toBe('BS 1361');
  });

  test('9. low-confidence slot emits slot-derived fields + low_confidence=true (no single-shot fallback)', () => {
    // ARCHITECTURE NOTE: Single-shot fallback was removed on 2026-04-22 per
    // Derek's architectural guidance: single-shot is inherently unreliable on
    // whole-board classification, so overwriting a low-confidence slot reading
    // with a single-shot value replaces uncertainty with equal-or-worse
    // uncertainty. The new behaviour: emit the slot's own reading and set
    // low_confidence so UI surfaces it to the inspector.
    const slots = [
      makeSlot({
        classification: 'mcb',
        tripCurve: 'B',
        ratingAmps: 32,
        confidence: 0.5,
        label: 'Lights',
      }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left' });

    expect(circuits).toHaveLength(1);
    expect(circuits[0].circuit_number).toBe(1);
    // Device fields still come from the slot's own reading — just marked
    // uncertain.
    expect(circuits[0].ocpd_type).toBe('B');
    expect(circuits[0].ocpd_rating_a).toBe('32');
    expect(circuits[0].label).toBe('Lights');
    expect(circuits[0].low_confidence).toBe(true);
  });

  test('10. low-confidence slot with no Stage-4 label → null label + low_confidence=true', () => {
    const slots = [
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.5 }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left' });

    expect(circuits).toHaveLength(1);
    expect(circuits[0].circuit_number).toBe(1);
    expect(circuits[0].label).toBeNull();
    // Slot's own reading is preserved, not nulled — UI flags via low_confidence.
    expect(circuits[0].ocpd_type).toBe('B');
    expect(circuits[0].ocpd_rating_a).toBe('32');
    expect(circuits[0].low_confidence).toBe(true);
  });

  test('11. label comes from slot.label (Stage 4 per-slot pass); blank or null slot label emits null', () => {
    // Stage 4 attaches label onto slot.label before the merger runs.
    const slots = [
      makeSlot({
        classification: 'mcb',
        tripCurve: 'B',
        ratingAmps: 32,
        confidence: 0.9,
        label: null,
      }),
      makeSlot({
        classification: 'mcb',
        tripCurve: 'B',
        ratingAmps: 16,
        confidence: 0.9,
        label: 'Kitchen',
      }),
      makeSlot({
        classification: 'mcb',
        tripCurve: 'B',
        ratingAmps: 16,
        confidence: 0.9,
        label: '   ', // empty/whitespace-only → null
      }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left' });

    expect(circuits[0].label).toBeNull();
    expect(circuits[1].label).toBe('Kitchen');
    expect(circuits[2].label).toBeNull();
  });

  test('11b. blank-label semantics: empty labels on MCBs stay null; empty labels on blank slots become "Spare"', () => {
    // Locks in Derek's 2026-04-23 rule:
    //   - MCB/RCBO slot + no readable label → circuit emits label=null
    //     (don't invent "Spare" for a device-occupied slot; inspector may
    //     not have labelled it yet)
    //   - Blank slot + no readable label → circuit emits "Spare"
    //   - Blank slot + handwritten label (e.g. "Future Cooker") → keep it
    const slots = [
      // MCB with no label — stays null, must NOT default to "Spare".
      makeSlot({
        classification: 'mcb',
        tripCurve: 'B',
        ratingAmps: 32,
        confidence: 0.9,
        label: null,
      }),
      // Blank slot with no label — "Spare".
      makeSlot({ classification: 'blank', confidence: 0.95, label: null }),
      // Blank slot with a handwritten label — kept.
      makeSlot({ classification: 'blank', confidence: 0.95, label: 'Future Heating' }),
    ];

    const circuits = slotsToCircuits({ slots, mainSwitchSide: 'left' });

    expect(circuits).toHaveLength(3);
    expect(circuits[0].label).toBeNull(); // MCB + no label → null
    expect(circuits[1].label).toBe('Spare'); // blank + no label → Spare
    expect(circuits[2].label).toBe('Future Heating'); // blank + label → kept
  });

  test('12. minSlotConfidence parameter: default 0.7 marks conf=0.6 as low_confidence; 0.5 accepts it', () => {
    const slots = [
      makeSlot({ classification: 'mcb', tripCurve: 'B', ratingAmps: 32, confidence: 0.6 }),
    ];

    // Default threshold 0.7 → slot is below threshold, marked low_confidence.
    const withDefault = slotsToCircuits({ slots, mainSwitchSide: 'left' });
    expect(withDefault[0].ocpd_type).toBe('B'); // slot data preserved
    expect(withDefault[0].low_confidence).toBe(true);

    // Lowered threshold 0.5 → slot is accepted as confident; low_confidence flag
    // is not set (undefined when the branch is skipped).
    const withLow = slotsToCircuits({
      slots,
      mainSwitchSide: 'left',
      minSlotConfidence: 0.5,
    });
    expect(withLow[0].ocpd_type).toBe('B');
    expect(withLow[0].ocpd_rating_a).toBe('32');
    expect(withLow[0].low_confidence).toBeUndefined();
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
    const result = await classifyBoardTechnology(
      'base64data==',
      fakeAnthropic,
      'claude-sonnet-4-6'
    );

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

  test('19. extracts board_manufacturer + board_model from classifier response', async () => {
    // 2026-04-29: classifier extended to take over single-shot's role for
    // board metadata. Verify it parses + returns the new fields.
    const fakeResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            board_technology: 'modern',
            main_switch_position: 'right',
            board_manufacturer: 'Wylex',
            board_model: 'NHRS12SL',
            main_switch_rating: '100',
            spd_present: false,
            confidence: 0.9,
          }),
        },
      ],
      usage: { input_tokens: 130, output_tokens: 50 },
    };

    const fakeAnthropic = makeFakeAnthropic(fakeResponse);
    const result = await classifyBoardTechnology(
      'base64data==',
      fakeAnthropic,
      'claude-sonnet-4-6'
    );

    expect(result.boardManufacturer).toBe('Wylex');
    expect(result.boardModel).toBe('NHRS12SL');
    expect(result.mainSwitchRating).toBe('100');
    expect(result.spdPresent).toBe(false);
  });

  test('20. normalises main_switch_rating to digits ("100A" → "100", "80 amp" → "80")', async () => {
    const fakeResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            board_technology: 'modern',
            main_switch_position: 'left',
            board_manufacturer: 'Hager',
            board_model: 'VML112',
            main_switch_rating: '100A AC22A', // VLMs often append units / category
            spd_present: true,
            confidence: 0.85,
          }),
        },
      ],
      usage: { input_tokens: 120, output_tokens: 40 },
    };

    const fakeAnthropic = makeFakeAnthropic(fakeResponse);
    const result = await classifyBoardTechnology(
      'base64data==',
      fakeAnthropic,
      'claude-sonnet-4-6'
    );

    expect(result.mainSwitchRating).toBe('100');
    expect(result.spdPresent).toBe(true);
  });

  test('21. handles missing/null board metadata gracefully (returns nulls, not undefined)', async () => {
    // VLM may legitimately not see manufacturer/model on a covered or
    // damaged board. Classifier must return null (not omit the fields)
    // so downstream code uses analysis.board_manufacturer === null
    // checks rather than === undefined.
    const fakeResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            board_technology: 'modern',
            main_switch_position: 'left',
            board_manufacturer: null,
            board_model: null,
            main_switch_rating: null,
            spd_present: false,
            confidence: 0.7,
          }),
        },
      ],
      usage: { input_tokens: 100, output_tokens: 30 },
    };

    const fakeAnthropic = makeFakeAnthropic(fakeResponse);
    const result = await classifyBoardTechnology(
      'base64data==',
      fakeAnthropic,
      'claude-sonnet-4-6'
    );

    expect(result.boardManufacturer).toBeNull();
    expect(result.boardModel).toBeNull();
    expect(result.mainSwitchRating).toBeNull();
    expect(result.spdPresent).toBe(false);
  });

  test('22a. board-model override: Wylex NHRS12SL labelled "mixed" is forced to modern (2026-05-01 prod repro)', async () => {
    // Reproduces the 2026-05-01 prod incident: VLM returned the precise
    // model code AND a wrong technology bucket.  The route handler must
    // trust the model identification.
    const fakeResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            board_technology: 'mixed',
            main_switch_position: 'right',
            board_manufacturer: 'Wylex',
            board_model: 'NHRS12SL',
            main_switch_rating: '100',
            spd_present: false,
            confidence: 0.92,
          }),
        },
      ],
      usage: { input_tokens: 130, output_tokens: 50 },
    };

    const fakeAnthropic = makeFakeAnthropic(fakeResponse);
    const result = await classifyBoardTechnology(
      'base64data==',
      fakeAnthropic,
      'claude-sonnet-4-6'
    );

    expect(result.boardTechnology).toBe('modern');
    expect(result.technologyOverride).not.toBeNull();
    expect(result.technologyOverride.fromVlm).toBe('mixed');
    expect(result.technologyOverride.toTechnology).toBe('modern');
    expect(result.technologyOverride.appliedBy).toBe('model-prefix-match');
    expect(result.technologyOverride.series).toMatch(/Wylex NH/);
  });

  test('22b. board-model override: VLM-issued "modern" passes through unchanged (no override)', async () => {
    // The override is one-way — a correctly-labelled modern board must
    // not have technologyOverride populated; downstream telemetry uses
    // null to mean "VLM agreed with itself".
    const fakeResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            board_technology: 'modern',
            main_switch_position: 'left',
            board_manufacturer: 'Hager',
            board_model: 'VML112',
            main_switch_rating: '100',
            spd_present: false,
            confidence: 0.9,
          }),
        },
      ],
      usage: { input_tokens: 120, output_tokens: 40 },
    };

    const fakeAnthropic = makeFakeAnthropic(fakeResponse);
    const result = await classifyBoardTechnology(
      'base64data==',
      fakeAnthropic,
      'claude-sonnet-4-6'
    );

    expect(result.boardTechnology).toBe('modern');
    expect(result.technologyOverride).toBeNull();
  });

  test('22c. board-model override: genuine rewireable model is NOT forced to modern', async () => {
    // Conservative-by-design: the registry should never override a real
    // rewireable board.  An unknown / non-modern model leaves the VLM's
    // technology label intact.
    const fakeResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            board_technology: 'rewireable_fuse',
            main_switch_position: 'right',
            board_manufacturer: 'Wylex',
            board_model: 'S5', // genuine pull-out fuse carrier board
            main_switch_rating: '60',
            spd_present: false,
            confidence: 0.88,
          }),
        },
      ],
      usage: { input_tokens: 110, output_tokens: 40 },
    };

    const fakeAnthropic = makeFakeAnthropic(fakeResponse);
    const result = await classifyBoardTechnology(
      'base64data==',
      fakeAnthropic,
      'claude-sonnet-4-6'
    );

    expect(result.boardTechnology).toBe('rewireable_fuse');
    expect(result.technologyOverride).toBeNull();
  });

  test('22. spd_present coerces non-boolean truthy to false (only `true` boolean counts)', async () => {
    // Strict boolean coercion — protects against the VLM returning the
    // string "false" or 0/1, which would silently pass through as a
    // truthy value in JS without the === true check.
    const fakeResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            board_technology: 'modern',
            main_switch_position: 'left',
            spd_present: 'false', // string, not boolean
            confidence: 0.8,
          }),
        },
      ],
      usage: { input_tokens: 100, output_tokens: 30 },
    };

    const fakeAnthropic = makeFakeAnthropic(fakeResponse);
    const result = await classifyBoardTechnology(
      'base64data==',
      fakeAnthropic,
      'claude-sonnet-4-6'
    );

    expect(result.spdPresent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assembleGeometricResult — reassembles prepared + classified into the old
// orchestrator's return shape so the rest of the route handler is unchanged.
// ---------------------------------------------------------------------------

describe('assembleGeometricResult', () => {
  test('returns null when perSlotState is null or missing prepared', () => {
    expect(assembleGeometricResult(null)).toBeNull();
    expect(assembleGeometricResult(undefined)).toBeNull();
    expect(assembleGeometricResult({ classified: {} })).toBeNull();
  });

  test('assembles modern-pipeline shape with ccu-geometric-v1 schemaVersion', () => {
    const prepared = {
      medianRails: { rail_top: 100, rail_bottom: 200, rail_left: 50, rail_right: 950 },
      moduleCount: 10,
      vlmCount: 10,
      disagreement: false,
      lowConfidence: false,
      slotCentersX: [100, 200, 300, 400, 500, 600, 700, 800, 900, 950],
      moduleWidth: 90,
      mainSwitchCenterX: 150,
      mainSwitchWidth: 180,
      imageWidth: 2000,
      imageHeight: 1500,
      stageOutputs: { stage1: { rails: [] }, stage2: {} },
      timings: { stage1Ms: 5000, stage2Ms: 3000 },
      usage: { inputTokens: 500, outputTokens: 100 },
    };
    const classified = {
      slots: [{ slotIndex: 0, classification: 'main_switch' }],
      stage3Error: null,
      timings: { stage3Ms: 15000 },
      usage: { inputTokens: 2000, outputTokens: 300 },
      stageOutputs: { stage3: { slots: [], error: null } },
    };

    const result = assembleGeometricResult({
      prepared,
      classified,
      isRewireablePipeline: false,
    });

    expect(result.schemaVersion).toBe('ccu-geometric-v1');
    expect(result.medianRails).toEqual(prepared.medianRails);
    expect(result.moduleCount).toBe(10);
    expect(result.slots).toEqual(classified.slots);
    expect(result.stage3Error).toBeNull();
    expect(result.timings.stage1Ms).toBe(5000);
    expect(result.timings.stage3Ms).toBe(15000);
    expect(result.timings.totalMs).toBe(23000);
    expect(result.usage.inputTokens).toBe(2500);
    expect(result.usage.outputTokens).toBe(400);
    expect(result.stageOutputs.stage3).toEqual(classified.stageOutputs.stage3);
  });

  test('assembles rewireable-pipeline shape with ccu-rewireable-v1 schemaVersion', () => {
    const prepared = {
      panelBounds: { top: 300, bottom: 600, left: 100, right: 900 },
      carrierCount: 6,
      slotCentersX: [150, 250, 350, 450, 550, 650],
      carrierPitchPx: 120,
      mainSwitchSide: 'right',
      mainSwitchOffset: 'right-edge',
      mainSwitchSlotIndex: 5,
      imageWidth: 2000,
      imageHeight: 1500,
      stageOutputs: {
        stage1: { lowConfidence: false, panels: [] },
        stage2: {},
      },
      timings: { stage1Ms: 4000, stage2Ms: 2000 },
      usage: { inputTokens: 400, outputTokens: 80 },
    };
    const classified = {
      slots: [{ slotIndex: 0, classification: 'rewireable' }],
      stage3Error: null,
      lowConfidence: false,
      timings: { stage3Ms: 10000 },
      usage: { inputTokens: 1500, outputTokens: 250 },
      stageOutputs: { stage3: { slots: [], error: null } },
    };

    const result = assembleGeometricResult({
      prepared,
      classified,
      isRewireablePipeline: true,
    });

    expect(result.schemaVersion).toBe('ccu-rewireable-v1');
    expect(result.panelBounds).toEqual(prepared.panelBounds);
    expect(result.carrierCount).toBe(6);
    expect(result.mainSwitchSlotIndex).toBe(5);
    expect(result.slots).toEqual(classified.slots);
    expect(result.lowConfidence).toBe(false);
    expect(result.timings.totalMs).toBe(16000);
    expect(result.usage.inputTokens).toBe(1900);
  });

  test('rewireable lowConfidence is combined from stage1 SD flag + stage3 floor', () => {
    const prepared = {
      panelBounds: { top: 0, bottom: 1, left: 0, right: 1 },
      carrierCount: 1,
      slotCentersX: [0],
      carrierPitchPx: 1,
      mainSwitchSide: 'none',
      mainSwitchOffset: 'none',
      mainSwitchSlotIndex: null,
      imageWidth: 100,
      imageHeight: 100,
      stageOutputs: {
        stage1: { lowConfidence: true, panels: [] }, // Stage 1 SD flag set
        stage2: {},
      },
      timings: { stage1Ms: 0, stage2Ms: 0 },
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    const classifiedGood = {
      slots: [],
      stage3Error: null,
      lowConfidence: false,
      timings: { stage3Ms: 0 },
      usage: { inputTokens: 0, outputTokens: 0 },
      stageOutputs: { stage3: {} },
    };
    const resultStage1Only = assembleGeometricResult({
      prepared,
      classified: classifiedGood,
      isRewireablePipeline: true,
    });
    expect(resultStage1Only.lowConfidence).toBe(true);
  });

  test('handles null classified (Stage 3 bailed) gracefully', () => {
    const prepared = {
      medianRails: { rail_top: 0, rail_bottom: 0, rail_left: 0, rail_right: 0 },
      moduleCount: 0,
      vlmCount: 0,
      disagreement: false,
      lowConfidence: false,
      slotCentersX: [],
      moduleWidth: 0,
      mainSwitchCenterX: null,
      mainSwitchWidth: 0,
      imageWidth: 100,
      imageHeight: 100,
      stageOutputs: { stage1: {}, stage2: {} },
      timings: { stage1Ms: 1000, stage2Ms: 500 },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const result = assembleGeometricResult({
      prepared,
      classified: null,
      isRewireablePipeline: false,
    });
    expect(result.schemaVersion).toBe('ccu-geometric-v1');
    expect(result.slots).toBeNull();
    expect(result.stage3Error).toMatch(/null/);
  });
});

// ---------------------------------------------------------------------------
// Parallel-dispatch integration test — drives the full /api/analyze-ccu route
// via supertest and asserts Stage 3 (classifyModernSlots) + Stage 4
// (extractSlotLabels) are dispatched IN PARALLEL via Promise.all, not
// sequentially. Captures the order of "started" vs "resolved" events: both
// must START before either RESOLVES, which is only possible if Promise.all
// (or equivalent concurrent dispatch) was used.
// ---------------------------------------------------------------------------

describe('analyze-ccu route — Stage 3 || Stage 4 parallel dispatch', () => {
  let app;
  let supertest;
  let jwt;
  const events = [];

  beforeAll(async () => {
    process.env.JWT_SECRET = 'dev-secret-change-in-production';
    process.env.ANTHROPIC_API_KEY = 'sk-test';

    const { default: express } = await import('express');
    const st = await import('supertest');
    supertest = st.default;
    jwt = (await import('jsonwebtoken')).default;

    const { default: extractionRouter } = await import('../routes/extraction.js');
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api', extractionRouter);
  });

  beforeEach(() => {
    events.length = 0;

    // Build a prepared-geometry fixture with 2 slots so label pass actually
    // has something to crop (ccu-label-pass requires slotCentersX with at least
    // one entry to schedule a VLM call — zero entries short-circuits to empty).
    prepareModernGeometryMock.mockResolvedValue({
      medianRails: { rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 },
      moduleCount: 2,
      vlmCount: 2,
      disagreement: false,
      lowConfidence: false,
      slotCentersX: [250, 750], // 0-1000 normalised
      moduleWidth: 400,
      mainSwitchCenterX: 250,
      mainSwitchWidth: 200,
      imageWidth: 1000,
      imageHeight: 800,
      stageOutputs: { stage1: { rails: [], lowConfidence: false }, stage2: {} },
      timings: { stage1Ms: 100, stage2Ms: 100 },
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    // Reset anthropic + mocks back to default no-delay responses before each test.
    mockAnthropicMessagesCreate.mockReset();
  });

  test('dispatches classifyModernSlots + extractSlotLabels concurrently (Promise.all)', async () => {
    // Each mock records when it started, waits briefly, then resolves. If
    // they're dispatched concurrently via Promise.all both will record
    // 'start' before either records 'resolve'. We use a short real setTimeout
    // rather than Jest fake timers because supertest drives the event loop
    // normally and we want to observe real scheduling order.
    classifyModernSlotsMock.mockImplementation(async () => {
      events.push({ name: 'classify-start', t: Date.now() });
      await new Promise((r) => setTimeout(r, 50));
      events.push({ name: 'classify-resolve', t: Date.now() });
      return {
        slots: [
          { slotIndex: 0, classification: 'mcb', ratingAmps: 32, confidence: 0.9 },
          { slotIndex: 1, classification: 'mcb', ratingAmps: 16, confidence: 0.9 },
        ],
        stage3Error: null,
        timings: { stage3Ms: 50 },
        usage: { inputTokens: 1000, outputTokens: 200 },
        stageOutputs: { stage3: { slots: [], error: null, batchCount: 1, batchSize: 4 } },
      };
    });

    mockExtractSlotLabels.mockImplementation(async () => {
      events.push({ name: 'label-start', t: Date.now() });
      await new Promise((r) => setTimeout(r, 50));
      events.push({ name: 'label-resolve', t: Date.now() });
      return {
        labels: [
          { slotIndex: 0, label: 'Lights', rawLabel: 'Lts', confidence: 0.9 },
          { slotIndex: 1, label: 'Sockets', rawLabel: 'Skt', confidence: 0.9 },
        ],
        usage: { inputTokens: 500, outputTokens: 100 },
        batchCount: 1,
        skippedSlotIndices: [],
        timings: { cropMs: 10, vlmMs: 30, totalMs: 40 },
      };
    });

    // Anthropic mock: handle (a) classifier call (board_technology JSON) and
    // (b) single-shot call (full analysis JSON). Classifier returns fast;
    // single-shot returns fast too — the parallelism we're verifying is
    // between Stage 3 (classifyModernSlots) and Stage 4 (extractSlotLabels).
    mockAnthropicMessagesCreate.mockImplementation(async (args) => {
      const userText = args.messages?.[0]?.content?.find((b) => b.type === 'text')?.text || '';
      if (userText.includes('board_technology')) {
        // Classifier prompt.
        return {
          content: [
            {
              type: 'text',
              text: '{"board_technology":"modern","main_switch_position":"left","confidence":0.9}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
          stop_reason: 'end_turn',
        };
      }
      // Single-shot full-board prompt — return an almost-empty but valid
      // analysis object. We only care about the parallel dispatch; single-
      // shot circuits[] will be overwritten by the merger.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              board_manufacturer: 'Hager',
              board_model: null,
              board_technology: 'modern',
              main_switch_rating: '100',
              main_switch_position: 'left',
              main_switch_bs_en: null,
              main_switch_type: 'Isolator',
              main_switch_poles: 'DP',
              main_switch_current: '100',
              main_switch_voltage: '230',
              spd_present: false,
              circuits: [],
              confidence: { overall: 0.9, image_quality: 'clear', uncertain_fields: [] },
              questionsForInspector: [],
            }),
          },
        ],
        usage: { input_tokens: 2000, output_tokens: 500 },
        stop_reason: 'end_turn',
      };
    });

    const token = jwt.sign({ userId: 'user-1', email: 'u@x' }, process.env.JWT_SECRET, {
      expiresIn: '24h',
    });

    // Minimal 1x1 JPEG buffer as the uploaded photo.
    const sharp = (await import('sharp')).default;
    const fakeJpeg = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .jpeg()
      .toBuffer();

    const res = await supertest(app)
      .post('/api/analyze-ccu')
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', fakeJpeg, 'test.jpg');

    expect(res.status).toBe(200);

    // Assertion: both classify AND label must have START'd before either
    // RESOLVED. If the route had run them sequentially, label-start would
    // only appear after classify-resolve.
    const classifyStartIdx = events.findIndex((e) => e.name === 'classify-start');
    const classifyResolveIdx = events.findIndex((e) => e.name === 'classify-resolve');
    const labelStartIdx = events.findIndex((e) => e.name === 'label-start');
    const labelResolveIdx = events.findIndex((e) => e.name === 'label-resolve');

    expect(classifyStartIdx).toBeGreaterThanOrEqual(0);
    expect(labelStartIdx).toBeGreaterThanOrEqual(0);
    // Both started before either resolved — this is the parallelism invariant.
    expect(classifyStartIdx).toBeLessThan(classifyResolveIdx);
    expect(labelStartIdx).toBeLessThan(classifyResolveIdx);
    expect(classifyStartIdx).toBeLessThan(labelResolveIdx);
    expect(labelStartIdx).toBeLessThan(labelResolveIdx);
  });

  // Removed 2026-04-29: single-shot was retired. The "Codex P2 invariant"
  // (single-shot started in parallel with the classifier) no longer applies
  // because there is no single-shot to overlap with. The classifier is now
  // awaited up front before Stage 2/3/4 dispatch — see analyze-ccu route
  // handler in src/routes/extraction.js.
});
