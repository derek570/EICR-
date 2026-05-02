/**
 * Unit tests for lookupMissingRcdTypes — the gpt-5-search-api fallback that
 * fills (and as of 2026-05-02, verifies) RCD types after Stage 3 of the
 * per-slot CCU pipeline.
 *
 * Two triggers are exercised:
 *
 * 1. `missing` — original behaviour. Stage 3 returned null rcdWaveformType
 *    on at least one RCD-protected circuit. Search fills the nulls.
 *
 * 2. `uniform_low_conf` — secondary verification trigger added after the
 *    2026-05-02 Crabtree field case. Stage 3 returned the SAME waveform
 *    value on every RCD-bearing slot but with mediocre average confidence.
 *    Symptom of the VLM defaulting (e.g. to "AC") rather than honouring
 *    the prompt's "null if unclear" rule. Search verifies against the
 *    datasheet and OVERRIDES the suspect uniform value if different.
 *
 * The function only depends on `analysis`, `openai`, `logger`, `userId` —
 * no module-level mocks needed; we pass plain stub objects.
 */

import { jest } from '@jest/globals';

// Heavy deps imported transitively by extraction.js — neutralise so the
// import itself doesn't try to talk to S3/Redis/DB.
jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: jest.fn(),
  uploadFile: jest.fn(),
  uploadBytes: jest.fn(),
  uploadText: jest.fn(),
  downloadText: jest.fn(),
  isUsingS3: jest.fn().mockReturnValue(false),
  getSignedUrl: jest.fn(),
  getJsonObject: jest.fn(),
  listObjects: jest.fn().mockResolvedValue([]),
}));

jest.unstable_mockModule('../queue.js', () => ({
  getConnection: jest.fn().mockReturnValue({
    set: jest.fn(),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn(),
  }),
  isRedisAvailable: jest.fn().mockReturnValue(false),
  enqueueJob: jest.fn(),
  startWorker: jest.fn(),
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('../auth.js', () => ({
  requireAuth: jest.fn((req, _res, next) => {
    req.user = { id: 'user-1', email: 't@e.co' };
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

const { lookupMissingRcdTypes, RCD_WAVEFORM_VERIFY_CONFIDENCE_THRESHOLD } =
  await import('../routes/extraction.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeOpenAi(content) {
  return {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content } }],
          usage: { completion_tokens: 50 },
        }),
      },
    },
  };
}

function rcboCircuit(num, opts = {}) {
  return {
    circuit_number: num,
    label: opts.label ?? `Circuit ${num}`,
    ocpd_type: 'B',
    ocpd_rating_a: '32',
    ocpd_bs_en: 'BS EN 61009-1',
    ocpd_breaking_capacity_ka: '6',
    is_rcbo: true,
    rcd_protected: true,
    rcd_type: opts.rcd_type === undefined ? 'AC' : opts.rcd_type,
    rcd_rating_ma: '30',
    rcd_bs_en: '61009',
  };
}

function rcboSlot(opts = {}) {
  return {
    classification: 'rcbo',
    manufacturer: opts.manufacturer ?? 'Crabtree',
    model: null,
    ratingAmps: 32,
    rating_text: 'B32',
    poles: 2,
    tripCurve: 'B',
    sensitivity: 30,
    rcdWaveformType: opts.rcdWaveformType ?? 'AC',
    bsEn: 'BS EN 61009-1',
    confidence: opts.confidence ?? 0.75,
    label: opts.label ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lookupMissingRcdTypes — primary `missing` trigger', () => {
  test('fills null rcd_type from search response and preserves existing types', async () => {
    const analysis = {
      board_manufacturer: 'Hager',
      board_model: 'VML106',
      circuits: [
        rcboCircuit(1, { rcd_type: null }),
        rcboCircuit(2, { rcd_type: 'A' }), // already known — must not be overwritten
        rcboCircuit(3, { rcd_type: null }),
      ],
      slots: [
        rcboSlot({ rcdWaveformType: null, confidence: 0.4 }),
        rcboSlot({ rcdWaveformType: 'A', confidence: 0.92 }),
        rcboSlot({ rcdWaveformType: null, confidence: 0.5 }),
      ],
    };
    const openai = makeOpenAi('{"rcd_type": "A", "source": "Hager VML106 datasheet"}');
    const logger = makeLogger();

    const out = await lookupMissingRcdTypes(analysis, openai, logger, 'user-1');

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(out.circuits[0].rcd_type).toBe('A'); // filled
    expect(out.circuits[1].rcd_type).toBe('A'); // preserved (was already A)
    expect(out.circuits[2].rcd_type).toBe('A'); // filled

    const startLog = logger.info.mock.calls.find(
      ([msg]) => msg === 'RCD type web search lookup starting'
    );
    expect(startLog?.[1]).toMatchObject({ trigger: 'missing' });
  });

  test('skips when no manufacturer is known', async () => {
    const analysis = {
      board_manufacturer: null,
      circuits: [rcboCircuit(1, { rcd_type: null })],
      slots: [rcboSlot({ rcdWaveformType: null })],
    };
    const openai = makeOpenAi('{"rcd_type":"A"}');
    const logger = makeLogger();

    await lookupMissingRcdTypes(analysis, openai, logger, 'user-1');

    expect(openai.chat.completions.create).not.toHaveBeenCalled();
    expect(
      logger.info.mock.calls.find(([msg]) => msg === 'RCD type lookup skipped — no manufacturer')
    ).toBeTruthy();
  });

  test('non-fatal when search throws', async () => {
    const analysis = {
      board_manufacturer: 'Hager',
      circuits: [rcboCircuit(1, { rcd_type: null })],
      slots: [rcboSlot({ rcdWaveformType: null })],
    };
    const openai = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(new Error('rate limited')),
        },
      },
    };
    const logger = makeLogger();

    const out = await lookupMissingRcdTypes(analysis, openai, logger, 'user-1');

    expect(out.circuits[0].rcd_type).toBeNull();
    const warnLog = logger.warn.mock.calls.find(
      ([msg]) => msg === 'RCD type web search failed (non-fatal)'
    );
    expect(warnLog?.[1]).toMatchObject({ error: 'rate limited' });
  });
});

describe('lookupMissingRcdTypes — secondary `uniform_low_conf` trigger', () => {
  test('overrides uniform Stage-3 read when avg confidence < threshold and search returns different type', async () => {
    // Reproduces the 2026-05-02 Crabtree field case: 11 RCBOs, all read
    // "AC" at avg conf 0.79, true type per datasheet is "A".
    const slots = [];
    const circuits = [];
    for (let i = 0; i < 11; i++) {
      slots.push(rcboSlot({ rcdWaveformType: 'AC', confidence: 0.79 }));
      circuits.push(rcboCircuit(i + 1, { rcd_type: 'AC' }));
    }
    const analysis = { board_manufacturer: 'Crabtree', board_model: '', circuits, slots };
    const openai = makeOpenAi(
      '{"rcd_type": "A", "source": "Crabtree Starbreaker SB6000 datasheet"}'
    );
    const logger = makeLogger();

    const out = await lookupMissingRcdTypes(analysis, openai, logger, 'user-1');

    expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
    out.circuits.forEach((c) => expect(c.rcd_type).toBe('A'));

    const startLog = logger.info.mock.calls.find(
      ([msg]) => msg === 'RCD type web search lookup starting'
    );
    expect(startLog?.[1]).toMatchObject({
      trigger: 'uniform_low_conf',
      stage3UniformValue: 'AC',
    });
    expect(startLog?.[1].stage3AvgConfidence).toBeCloseTo(0.79, 2);

    const foundLog = logger.info.mock.calls.find(
      ([msg]) => msg === 'RCD type web search found type'
    );
    expect(foundLog?.[1]).toMatchObject({
      trigger: 'uniform_low_conf',
      rcdType: 'A',
      filled: 0,
      overridden: 11,
      previousValue: 'AC',
    });

    // Search prompt must mention what Stage 3 read so the search has a
    // concrete claim to verify rather than asking blank.
    const sentPrompt = openai.chat.completions.create.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).toMatch(/Type AC/);
    expect(sentPrompt).toMatch(/low confidence/i);
  });

  test('preserves uniform Stage-3 read when search confirms the same type', async () => {
    const slots = [
      rcboSlot({ rcdWaveformType: 'AC', confidence: 0.79 }),
      rcboSlot({ rcdWaveformType: 'AC', confidence: 0.8 }),
      rcboSlot({ rcdWaveformType: 'AC', confidence: 0.78 }),
    ];
    const circuits = [
      rcboCircuit(1, { rcd_type: 'AC' }),
      rcboCircuit(2, { rcd_type: 'AC' }),
      rcboCircuit(3, { rcd_type: 'AC' }),
    ];
    const analysis = { board_manufacturer: 'OldMfr', circuits, slots };
    const openai = makeOpenAi('{"rcd_type": "AC", "source": "datasheet"}');
    const logger = makeLogger();

    await lookupMissingRcdTypes(analysis, openai, logger, 'user-1');

    analysis.circuits.forEach((c) => expect(c.rcd_type).toBe('AC'));
    const foundLog = logger.info.mock.calls.find(
      ([msg]) => msg === 'RCD type web search found type'
    );
    expect(foundLog?.[1]).toMatchObject({
      trigger: 'uniform_low_conf',
      filled: 0,
      overridden: 0,
    });
  });

  test('does NOT trigger when avg confidence is above threshold', async () => {
    // Same uniform value but high confidence — no verification needed.
    const slots = [
      rcboSlot({ rcdWaveformType: 'AC', confidence: 0.95 }),
      rcboSlot({ rcdWaveformType: 'AC', confidence: 0.9 }),
      rcboSlot({ rcdWaveformType: 'AC', confidence: 0.92 }),
    ];
    const circuits = [
      rcboCircuit(1, { rcd_type: 'AC' }),
      rcboCircuit(2, { rcd_type: 'AC' }),
      rcboCircuit(3, { rcd_type: 'AC' }),
    ];
    const analysis = { board_manufacturer: 'Crabtree', circuits, slots };
    const openai = makeOpenAi('{"rcd_type":"A"}');
    const logger = makeLogger();

    await lookupMissingRcdTypes(analysis, openai, logger, 'user-1');

    expect(openai.chat.completions.create).not.toHaveBeenCalled();
    expect(
      logger.info.mock.calls.find(
        ([msg]) => msg === 'RCD type lookup skipped — all RCD-protected circuits already have types'
      )
    ).toBeTruthy();
  });

  test('does NOT trigger when reads disagree (mixed types means VLM is reading, not defaulting)', async () => {
    const slots = [
      rcboSlot({ rcdWaveformType: 'AC', confidence: 0.7 }),
      rcboSlot({ rcdWaveformType: 'A', confidence: 0.7 }),
      rcboSlot({ rcdWaveformType: 'AC', confidence: 0.7 }),
    ];
    const circuits = [
      rcboCircuit(1, { rcd_type: 'AC' }),
      rcboCircuit(2, { rcd_type: 'A' }),
      rcboCircuit(3, { rcd_type: 'AC' }),
    ];
    const analysis = { board_manufacturer: 'Crabtree', circuits, slots };
    const openai = makeOpenAi('{"rcd_type":"A"}');
    const logger = makeLogger();

    await lookupMissingRcdTypes(analysis, openai, logger, 'user-1');

    // Stage 3 produced varied reads — not the "fleet defaulted" signature,
    // so no verification fires and types are preserved.
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
    expect(analysis.circuits.map((c) => c.rcd_type)).toEqual(['AC', 'A', 'AC']);
  });

  test('does NOT trigger with only one RCD-bearing slot (uniformity is meaningless)', async () => {
    const slots = [rcboSlot({ rcdWaveformType: 'AC', confidence: 0.6 })];
    const circuits = [rcboCircuit(1, { rcd_type: 'AC' })];
    const analysis = { board_manufacturer: 'Crabtree', circuits, slots };
    const openai = makeOpenAi('{"rcd_type":"A"}');
    const logger = makeLogger();

    await lookupMissingRcdTypes(analysis, openai, logger, 'user-1');

    expect(openai.chat.completions.create).not.toHaveBeenCalled();
    expect(analysis.circuits[0].rcd_type).toBe('AC');
  });

  test('threshold constant matches expected value (regression guard)', () => {
    // Picked from the 2026-05-02 Crabtree case where avg conf was 0.79.
    // Lowering this would re-introduce that field bug; raising it past
    // ~0.9 would fire spuriously on healthy boards. Lock the value.
    expect(RCD_WAVEFORM_VERIFY_CONFIDENCE_THRESHOLD).toBe(0.85);
  });
});

describe('lookupMissingRcdTypes — questionsForInspector pruning', () => {
  test('prunes RCD-related questions once all rcd_types resolved', async () => {
    const analysis = {
      board_manufacturer: 'Hager',
      circuits: [rcboCircuit(1, { rcd_type: null })],
      slots: [rcboSlot({ rcdWaveformType: null })],
      questionsForInspector: [
        'What RCD type is on circuit 1?',
        'Is the main switch a 100A isolator?',
      ],
    };
    const openai = makeOpenAi('{"rcd_type":"A","source":"datasheet"}');
    const logger = makeLogger();

    await lookupMissingRcdTypes(analysis, openai, logger, 'user-1');

    expect(analysis.questionsForInspector).toEqual(['Is the main switch a 100A isolator?']);
  });

  test('leaves questions intact if some rcd_types remain unresolved', async () => {
    const analysis = {
      board_manufacturer: 'Hager',
      circuits: [rcboCircuit(1, { rcd_type: null }), rcboCircuit(2, { rcd_type: null })],
      slots: [rcboSlot({ rcdWaveformType: null }), rcboSlot({ rcdWaveformType: null })],
      questionsForInspector: ['What RCD type for the kitchen circuit?'],
    };
    // Search returns invalid type — fills nothing.
    const openai = makeOpenAi('{"rcd_type": null, "source": "not found"}');
    const logger = makeLogger();

    await lookupMissingRcdTypes(analysis, openai, logger, 'user-1');

    expect(analysis.questionsForInspector).toEqual(['What RCD type for the kitchen circuit?']);
  });
});
