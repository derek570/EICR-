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

const {
  lookupMissingRcdTypes,
  RCD_WAVEFORM_VERIFY_CONFIDENCE_THRESHOLD,
  RCD_OUTLIER_CLUSTER_FLOOR,
  detectRcdWaveformOutliers,
  flagRcdWaveformOutliers,
} = await import('../routes/extraction.js');

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

// ---------------------------------------------------------------------------
// detectRcdWaveformOutliers (pure function)
// ---------------------------------------------------------------------------

/** Same-manufacturer slot with explicit slotIndex — for outlier-detection tests. */
function rcboOutlierSlot(slotIndex, opts = {}) {
  return {
    slotIndex,
    classification: 'rcbo',
    manufacturer: opts.manufacturer ?? 'Elucian',
    model: null,
    ratingAmps: opts.ratingAmps ?? 20,
    ratingText: opts.ratingText ?? 'B20A',
    poles: 1,
    tripCurve: 'B',
    sensitivity: 30,
    rcdWaveformType: opts.rcdWaveformType ?? 'A',
    bsEn: 'BS EN 61009-1',
    confidence: opts.confidence ?? 0.93,
    label: opts.label ?? null,
  };
}

describe('detectRcdWaveformOutliers', () => {
  test('11-RCBO board with 10×A + 1×AC, all same manufacturer → returns the single outlier', () => {
    // 2026-05-04 Elucian CU1SPD275 repro shape.
    const slots = [];
    for (let i = 0; i < 10; i++) slots.push(rcboOutlierSlot(i, { rcdWaveformType: 'A' }));
    slots.push(
      rcboOutlierSlot(3, {
        rcdWaveformType: 'AC',
        label: 'Bathroom Underfloor Heating',
        confidence: 0.95,
      })
    );

    const out = detectRcdWaveformOutliers(slots);

    expect(out).toHaveLength(1);
    expect(out[0].slotValue).toBe('AC');
    expect(out[0].majorityValue).toBe('A');
    expect(out[0].majorityCount).toBe(10);
    expect(out[0].manufacturer).toBe('Elucian');
    expect(out[0].slotIndex).toBe(3);
    expect(out[0].slotLabel).toBe('Bathroom Underfloor Heating');
  });

  test('different-manufacturer outlier (legitimate retrofit) → NOT flagged', () => {
    // Inspector swapped one bad RCBO out for a Wylex AC retained from
    // stock. Older device genuinely has Type AC; the rest of the board
    // is a uniform Elucian Type A. Must NOT flag — that's what the
    // user means by "old device in the middle of the pack".
    const slots = [];
    for (let i = 0; i < 10; i++)
      slots.push(rcboOutlierSlot(i, { manufacturer: 'Elucian', rcdWaveformType: 'A' }));
    slots.push(
      rcboOutlierSlot(5, {
        manufacturer: 'Wylex',
        rcdWaveformType: 'AC',
        confidence: 0.95,
      })
    );

    expect(detectRcdWaveformOutliers(slots)).toEqual([]);
  });

  test('cluster floor: 4 same-manufacturer + 1 outlier → no outliers (below RCD_OUTLIER_CLUSTER_FLOOR=5)', () => {
    expect(RCD_OUTLIER_CLUSTER_FLOOR).toBe(5);
    const slots = [];
    for (let i = 0; i < 4; i++) slots.push(rcboOutlierSlot(i, { rcdWaveformType: 'A' }));
    slots.push(rcboOutlierSlot(4, { rcdWaveformType: 'AC' }));

    expect(detectRcdWaveformOutliers(slots)).toEqual([]);
  });

  test('low-confidence outlier (< 0.85) is filtered before clustering — no outliers returned', () => {
    // Below the 0.85 confidence floor, the outlier read isn't credible
    // enough to trust as a contradicting signal. The "uniform_low_conf"
    // path in lookupMissingRcdTypes handles fleet-wide low-confidence
    // cases; this detector is for the specific case where reads are
    // confident but disagree.
    const slots = [];
    for (let i = 0; i < 10; i++) slots.push(rcboOutlierSlot(i, { rcdWaveformType: 'A' }));
    slots.push(rcboOutlierSlot(10, { rcdWaveformType: 'AC', confidence: 0.6 }));

    expect(detectRcdWaveformOutliers(slots)).toEqual([]);
  });

  test('low-confidence cluster slots are filtered (cluster shrinks below floor)', () => {
    // 5 confident Type-A reads + 5 low-confidence Type-A reads + 1
    // confident Type-AC. After confidence filter, cluster is 5; the
    // outlier brings total eligible to 6, cluster majority 5 ≥ floor.
    const slots = [];
    for (let i = 0; i < 5; i++) slots.push(rcboOutlierSlot(i, { rcdWaveformType: 'A' }));
    for (let i = 5; i < 10; i++)
      slots.push(rcboOutlierSlot(i, { rcdWaveformType: 'A', confidence: 0.5 }));
    slots.push(rcboOutlierSlot(10, { rcdWaveformType: 'AC' }));

    const out = detectRcdWaveformOutliers(slots);
    expect(out).toHaveLength(1);
    expect(out[0].majorityCount).toBe(5);
  });

  test('unanimous high-confidence cluster → no outliers', () => {
    const slots = [];
    for (let i = 0; i < 11; i++) slots.push(rcboOutlierSlot(i, { rcdWaveformType: 'A' }));

    expect(detectRcdWaveformOutliers(slots)).toEqual([]);
  });

  test('two-outlier case: 9×A + 2×AC same manufacturer → both returned', () => {
    const slots = [];
    for (let i = 0; i < 9; i++) slots.push(rcboOutlierSlot(i, { rcdWaveformType: 'A' }));
    slots.push(rcboOutlierSlot(9, { rcdWaveformType: 'AC' }));
    slots.push(rcboOutlierSlot(10, { rcdWaveformType: 'AC' }));

    const out = detectRcdWaveformOutliers(slots);
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.majorityValue === 'A')).toBe(true);
    expect(out.every((o) => o.majorityCount === 9)).toBe(true);
  });

  test('manufacturer comparison is case- and whitespace-insensitive', () => {
    const slots = [];
    slots.push(rcboOutlierSlot(0, { manufacturer: 'Elucian', rcdWaveformType: 'A' }));
    slots.push(rcboOutlierSlot(1, { manufacturer: 'elucian', rcdWaveformType: 'A' }));
    slots.push(rcboOutlierSlot(2, { manufacturer: ' Elucian ', rcdWaveformType: 'A' }));
    slots.push(rcboOutlierSlot(3, { manufacturer: 'ELUCIAN', rcdWaveformType: 'A' }));
    slots.push(rcboOutlierSlot(4, { manufacturer: 'Elucian', rcdWaveformType: 'A' }));
    slots.push(rcboOutlierSlot(5, { manufacturer: 'Elucian', rcdWaveformType: 'AC' }));

    const out = detectRcdWaveformOutliers(slots);
    expect(out).toHaveLength(1);
    expect(out[0].majorityCount).toBe(5);
  });

  test('handles empty/invalid input gracefully', () => {
    expect(detectRcdWaveformOutliers([])).toEqual([]);
    expect(detectRcdWaveformOutliers(null)).toEqual([]);
    expect(detectRcdWaveformOutliers(undefined)).toEqual([]);
  });

  test('non-RCBO/RCD slots (mcb, blank, main_switch, spd) are ignored', () => {
    const slots = [];
    for (let i = 0; i < 10; i++) slots.push(rcboOutlierSlot(i, { rcdWaveformType: 'A' }));
    // An MCB whose rcdWaveformType is somehow set to AC must NOT be
    // counted as an outlier (MCBs don't have RCD function).
    slots.push({
      slotIndex: 10,
      classification: 'mcb',
      manufacturer: 'Elucian',
      rcdWaveformType: 'AC',
      confidence: 0.95,
      ratingText: 'B32A',
    });

    expect(detectRcdWaveformOutliers(slots)).toEqual([]);
  });

  test('slot without manufacturer string is excluded from clustering', () => {
    const slots = [];
    for (let i = 0; i < 10; i++) slots.push(rcboOutlierSlot(i, { rcdWaveformType: 'A' }));
    slots.push({
      slotIndex: 10,
      classification: 'rcbo',
      manufacturer: null,
      rcdWaveformType: 'AC',
      confidence: 0.95,
    });

    expect(detectRcdWaveformOutliers(slots)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// flagRcdWaveformOutliers (lookup + flag, never auto-correct)
// ---------------------------------------------------------------------------

/** Build an analysis fixture matching the 2026-05-04 Elucian shape. */
function makeOutlierAnalysis(opts = {}) {
  const slots = [];
  const circuits = [];
  for (let i = 0; i < 10; i++) {
    slots.push(rcboOutlierSlot(i, { rcdWaveformType: 'A' }));
    circuits.push({
      circuit_number: i + 1,
      slot_index: i,
      label: `Circuit ${i + 1}`,
      ocpd_type: 'B',
      ocpd_rating_a: '20',
      ocpd_bs_en: 'BS EN 61009-1',
      is_rcbo: true,
      rcd_protected: true,
      rcd_type: 'A',
      rcd_rating_ma: '30',
      rcd_bs_en: '61009',
    });
  }
  slots.push(
    rcboOutlierSlot(10, {
      rcdWaveformType: 'AC',
      label: 'Bathroom Underfloor Heating',
      confidence: 0.95,
    })
  );
  circuits.push({
    circuit_number: 11,
    slot_index: 10,
    label: 'Bathroom Underfloor Heating',
    ocpd_type: 'B',
    ocpd_rating_a: '20',
    ocpd_bs_en: 'BS EN 61009-1',
    is_rcbo: true,
    rcd_protected: true,
    rcd_type: 'AC',
    rcd_rating_ma: '30',
    rcd_bs_en: '61009',
  });

  return {
    board_manufacturer: 'Elucian',
    board_model: 'CU1SPD275',
    slots,
    circuits,
    questionsForInspector: opts.preExistingQuestions ?? [],
  };
}

describe('flagRcdWaveformOutliers', () => {
  test('datasheet says applies_to=all → flag outlier WITHOUT rewriting rcd_type', async () => {
    const analysis = makeOutlierAnalysis();
    const openai = makeOpenAi(
      '{"type": "A", "applies_to": "all", "source": "Elucian CU1SPD275 product datasheet"}'
    );
    const logger = makeLogger();

    const out = await flagRcdWaveformOutliers(analysis, openai, logger, 'user-1');

    const flagged = out.circuits.find((c) => c.label === 'Bathroom Underfloor Heating');
    // CRITICAL INVARIANT: rcd_type is NEVER auto-corrected, even when the
    // datasheet says applies_to=all and Stage 3 was almost certainly wrong.
    // The inspector has the final say; we surface uncertainty, we don't
    // overwrite it.
    expect(flagged.rcd_type).toBe('AC');
    expect(flagged.low_confidence).toBe(true);
    expect(flagged.rcd_type_outlier).toBe(true);
    expect(flagged.rcd_type_majority_value).toBe('A');
    expect(flagged.rcd_type_datasheet).toBe('A');

    // Other 10 circuits untouched.
    for (let i = 0; i < 10; i++) {
      expect(out.circuits[i].rcd_type).toBe('A');
      expect(out.circuits[i].rcd_type_outlier).toBeUndefined();
      expect(out.circuits[i].low_confidence).toBeUndefined();
    }

    // Question added to inspector queue, mentioning the datasheet steer.
    expect(out.questionsForInspector).toHaveLength(1);
    expect(out.questionsForInspector[0]).toContain('Bathroom Underfloor Heating');
    expect(out.questionsForInspector[0]).toContain('Type AC');
    expect(out.questionsForInspector[0]).toContain('Type A');
    expect(out.questionsForInspector[0]).toMatch(/datasheet/i);
  });

  test('datasheet says applies_to=outlier → flag with "may be correct, please verify" message', async () => {
    const analysis = makeOutlierAnalysis();
    const openai = makeOpenAi(
      '{"type": "AC", "applies_to": "outlier", "source": "Elucian legacy spec"}'
    );
    const logger = makeLogger();

    const out = await flagRcdWaveformOutliers(analysis, openai, logger, 'user-1');

    const flagged = out.circuits.find((c) => c.label === 'Bathroom Underfloor Heating');
    expect(flagged.rcd_type).toBe('AC'); // still untouched
    expect(flagged.rcd_type_outlier).toBe(true);
    expect(flagged.rcd_type_datasheet).toBe('AC');

    // Question text differentiates this case — datasheet supports the outlier.
    expect(out.questionsForInspector[0]).toMatch(/may be correct/i);
    expect(out.questionsForInspector[0]).toContain('Type AC');
  });

  test('inconclusive lookup (type=null) → flag with generic verification prompt', async () => {
    const analysis = makeOutlierAnalysis();
    const openai = makeOpenAi('{"type": null, "applies_to": "unknown", "source": "not found"}');
    const logger = makeLogger();

    const out = await flagRcdWaveformOutliers(analysis, openai, logger, 'user-1');

    const flagged = out.circuits.find((c) => c.label === 'Bathroom Underfloor Heating');
    expect(flagged.rcd_type).toBe('AC');
    expect(flagged.rcd_type_outlier).toBe(true);
    expect(flagged.rcd_type_majority_value).toBe('A');
    expect(flagged.rcd_type_datasheet).toBeNull();
    expect(out.questionsForInspector[0]).toMatch(/double-check/i);
    expect(out.questionsForInspector[0]).not.toMatch(/datasheet/i);
  });

  test('lookup throws → flagging still happens with no datasheet steer (non-fatal)', async () => {
    const analysis = makeOutlierAnalysis();
    const openai = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(new Error('search timeout')),
        },
      },
    };
    const logger = makeLogger();

    const out = await flagRcdWaveformOutliers(analysis, openai, logger, 'user-1');

    const flagged = out.circuits.find((c) => c.label === 'Bathroom Underfloor Heating');
    expect(flagged.rcd_type).toBe('AC'); // never auto-corrected
    expect(flagged.rcd_type_outlier).toBe(true);
    expect(flagged.rcd_type_datasheet).toBeNull();
    expect(out.questionsForInspector).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'RCD waveform outlier lookup failed (non-fatal)',
      expect.objectContaining({ manufacturer: 'Elucian' })
    );
  });

  test('no outliers → no lookup call, no flags, no questions', async () => {
    const analysis = makeOutlierAnalysis();
    // Make slot 10 agree with the rest — no outlier any more.
    analysis.slots[10].rcdWaveformType = 'A';
    analysis.circuits[10].rcd_type = 'A';
    const openai = makeOpenAi('{"type": "A", "applies_to": "all"}');
    const logger = makeLogger();

    const out = await flagRcdWaveformOutliers(analysis, openai, logger, 'user-1');

    expect(openai.chat.completions.create).not.toHaveBeenCalled();
    expect(out.questionsForInspector).toEqual([]);
    for (const c of out.circuits) {
      expect(c.rcd_type_outlier).toBeUndefined();
    }
  });

  test('multiple outliers from same manufacturer → ONE batched lookup call', async () => {
    const analysis = makeOutlierAnalysis();
    // Add a second outlier — slot 9 changes from A to AC, circuit 10 to match.
    analysis.slots[9].rcdWaveformType = 'AC';
    analysis.circuits[9].rcd_type = 'AC';
    analysis.circuits[9].label = 'Garage Sockets';
    const openai = makeOpenAi('{"type": "A", "applies_to": "all"}');
    const logger = makeLogger();

    const out = await flagRcdWaveformOutliers(analysis, openai, logger, 'user-1');

    // Single batched search call, regardless of outlier count.
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);

    const flagged1 = out.circuits.find((c) => c.label === 'Bathroom Underfloor Heating');
    const flagged2 = out.circuits.find((c) => c.label === 'Garage Sockets');
    expect(flagged1.rcd_type_outlier).toBe(true);
    expect(flagged2.rcd_type_outlier).toBe(true);
    expect(out.questionsForInspector).toHaveLength(2);
  });

  test('preserves pre-existing questionsForInspector (appends, does not overwrite)', async () => {
    const analysis = makeOutlierAnalysis({
      preExistingQuestions: ['Is the main switch a 100A isolator?'],
    });
    const openai = makeOpenAi('{"type": "A", "applies_to": "all"}');
    const logger = makeLogger();

    const out = await flagRcdWaveformOutliers(analysis, openai, logger, 'user-1');

    expect(out.questionsForInspector).toHaveLength(2);
    expect(out.questionsForInspector[0]).toBe('Is the main switch a 100A isolator?');
    expect(out.questionsForInspector[1]).toContain('Bathroom Underfloor Heating');
  });

  test('initialises questionsForInspector when missing', async () => {
    const analysis = makeOutlierAnalysis();
    delete analysis.questionsForInspector;
    const openai = makeOpenAi('{"type": "A", "applies_to": "all"}');
    const logger = makeLogger();

    const out = await flagRcdWaveformOutliers(analysis, openai, logger, 'user-1');

    expect(Array.isArray(out.questionsForInspector)).toBe(true);
    expect(out.questionsForInspector).toHaveLength(1);
  });

  test('maps outlier slot to circuit by slot_index, not by RCD-row position', async () => {
    // Defensive against a circuit table that includes RCD own-rows
    // (is_rcd_device:true with no circuit_number) interleaved with
    // regular circuits. The lookup-by-slot-index must find the
    // RCBO circuit, NOT an RCD own-row that happened to land at the
    // same array position.
    const analysis = makeOutlierAnalysis();
    // Splice an RCD own-row in between — slot_index doesn't matter for
    // own-rows in this fixture, just confirming the find() filter
    // (!c.is_rcd_device) skips them.
    analysis.circuits.splice(5, 0, {
      circuit_number: null,
      slot_index: 99,
      label: 'RCD',
      is_rcd_device: true,
      rcd_type: 'A',
    });

    const openai = makeOpenAi('{"type": "A", "applies_to": "all"}');
    const logger = makeLogger();
    const out = await flagRcdWaveformOutliers(analysis, openai, logger, 'user-1');

    const rcdRow = out.circuits.find((c) => c.is_rcd_device);
    expect(rcdRow.rcd_type_outlier).toBeUndefined();

    const flagged = out.circuits.find((c) => c.label === 'Bathroom Underfloor Heating');
    expect(flagged.rcd_type_outlier).toBe(true);
  });
});
