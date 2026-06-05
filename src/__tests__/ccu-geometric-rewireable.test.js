/**
 * Unit tests for src/extraction/ccu-geometric-rewireable.js — Stream 1.
 *
 * Anthropic SDK is mocked at module level (matches ccu-geometric.test.js style).
 * Tests cover:
 *   - Stage 1 per-coordinate median + main_switch_side majority vote (5 samples)
 *   - Stage 1 lowConfidence SD threshold (5% of 0-1000 scale)
 *   - Stage 2 slot centre computation given panel bounds + carrier count
 *   - Stage 2 main_switch_offset → mainSwitchSlotIndex
 *   - Stage 2 sanity-check retry: in-range → single call, out-of-range → retry,
 *     retry value wins (decision logged)
 *   - Stage 3 batches 4 crops per message
 *   - Stage 3 body-colour → rating fill-in (white=5, blue=15, yellow=20, red=30, green=45)
 *   - Stage 3 matches VLM responses by slot_index even when returned out of order
 *   - Stage 3 soft-fail returns Stage 1/2 output
 *   - extractCcuRewireable combined shape + schemaVersion
 *   - Throws on missing ANTHROPIC_API_KEY
 */

import { jest } from '@jest/globals';
import sharp from 'sharp';

const mockCreate = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

// Imported lazily AFTER the mock is registered.
let getPanelGeometry;
let getCarrierCount;
let extractCcuRewireable;
let cropCarrierSlot;
let classifyCarriers;
let BODY_COLOUR_TO_AMPS;
let prepareRewireableGeometry;
let classifyRewireableSlots;

beforeAll(async () => {
  const mod = await import('../extraction/ccu-geometric-rewireable.js');
  getPanelGeometry = mod.getPanelGeometry;
  getCarrierCount = mod.getCarrierCount;
  extractCcuRewireable = mod.extractCcuRewireable;
  cropCarrierSlot = mod.cropCarrierSlot;
  classifyCarriers = mod.classifyCarriers;
  BODY_COLOUR_TO_AMPS = mod.BODY_COLOUR_TO_AMPS;
  prepareRewireableGeometry = mod.prepareRewireableGeometry;
  classifyRewireableSlots = mod.classifyRewireableSlots;
});

async function makeFakeJpeg(width = 1000, height = 600) {
  return await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 180, g: 180, b: 180 },
    },
  })
    .jpeg()
    .toBuffer();
}

function fakeVlmResponse(obj, { inputTokens = 100, outputTokens = 40 } = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key-fixture';
});

// ---------------------------------------------------------------------------
// getPanelGeometry
// ---------------------------------------------------------------------------

describe('getPanelGeometry', () => {
  test('computes per-coordinate median across 5 samples + majority-votes main_switch_side', async () => {
    const buf = await makeFakeJpeg(1200, 800);

    // 5 samples — odd-count median is the middle sorted value per coordinate.
    // panel_top sorted: 300,305,310,315,320 → median 310
    // panel_bottom sorted: 600,605,610,615,620 → median 610
    // panel_left sorted: 100,105,110,115,120 → median 110
    // panel_right sorted: 900,905,910,915,920 → median 910
    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 100,
          panel_right: 900,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 305,
          panel_bottom: 605,
          panel_left: 105,
          panel_right: 905,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 310,
          panel_bottom: 610,
          panel_left: 110,
          panel_right: 910,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 315,
          panel_bottom: 615,
          panel_left: 115,
          panel_right: 915,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 320,
          panel_bottom: 620,
          panel_left: 120,
          panel_right: 920,
          main_switch_side: 'none',
        })
      );

    const result = await getPanelGeometry(buf);

    expect(result.panels).toHaveLength(5);
    expect(result.medianPanel).toEqual({
      panel_top: 310,
      panel_bottom: 610,
      panel_left: 110,
      panel_right: 910,
    });
    // 4 × "right" vs 1 × "none" → "right"
    expect(result.mainSwitchSide).toBe('right');
    expect(result.imageWidth).toBe(1200);
    expect(result.imageHeight).toBe(800);
    expect(result.usage.inputTokens).toBe(500);
    expect(result.usage.outputTokens).toBe(200);
  });

  test('lowConfidence=false when per-coordinate SD is under 5% of 0-1000 scale', async () => {
    const buf = await makeFakeJpeg();

    // 5 samples, very tight clustering (SD ~3-4 on 0-1000 → < 1%).
    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 100,
          panel_right: 900,
          main_switch_side: 'none',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 304,
          panel_bottom: 604,
          panel_left: 104,
          panel_right: 904,
          main_switch_side: 'none',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 298,
          panel_bottom: 598,
          panel_left: 98,
          panel_right: 898,
          main_switch_side: 'none',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 302,
          panel_bottom: 602,
          panel_left: 102,
          panel_right: 902,
          main_switch_side: 'none',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 301,
          panel_bottom: 601,
          panel_left: 101,
          panel_right: 901,
          main_switch_side: 'none',
        })
      );

    const result = await getPanelGeometry(buf);
    expect(result.lowConfidence).toBe(false);
    for (const v of Object.values(result.sdPct)) {
      expect(v).toBeLessThan(5);
    }
  });

  test('lowConfidence=true when any coordinate SD exceeds 5% of 0-1000 scale', async () => {
    const buf = await makeFakeJpeg();

    // panel_left wildly disagrees across 5 samples (10, 500, 990, 50, 800)
    // → SD well above 5% of 1000.
    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 10,
          panel_right: 900,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 305,
          panel_bottom: 605,
          panel_left: 500,
          panel_right: 905,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 295,
          panel_bottom: 595,
          panel_left: 990,
          panel_right: 895,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 50,
          panel_right: 900,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 800,
          panel_right: 900,
          main_switch_side: 'right',
        })
      );

    const result = await getPanelGeometry(buf);
    expect(result.lowConfidence).toBe(true);
    expect(result.sdPct.panel_left).toBeGreaterThan(5);
  });

  test('coerces unexpected main_switch_side values to "none"', async () => {
    const buf = await makeFakeJpeg();
    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 100,
          panel_right: 900,
          main_switch_side: 'middle', // invalid
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 100,
          panel_right: 900,
          // omitted
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 100,
          panel_right: 900,
          main_switch_side: 'none',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 100,
          panel_right: 900,
          main_switch_side: 'upwards', // invalid
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 100,
          panel_right: 900,
          main_switch_side: 'none',
        })
      );

    const result = await getPanelGeometry(buf);
    expect(result.mainSwitchSide).toBe('none');
    expect(result.panels.every((p) => p.main_switch_side === 'none')).toBe(true);
  });

  test('throws when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const buf = await makeFakeJpeg();
    await expect(getPanelGeometry(buf)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  test('throws when VLM omits required panel_* fields', async () => {
    const buf = await makeFakeJpeg();
    mockCreate.mockResolvedValueOnce(fakeVlmResponse({ panel_top: 300, panel_bottom: 600 }));
    // 4 additional successful responses — Stage 1 awaits Promise.all(5), so even
    // if one sample throws, the other 4 resolvers still need mock responses
    // available or they hang / throw a different error. Keep the failure mode
    // unambiguous by making every other sample well-formed.
    for (let i = 0; i < 4; i++) {
      mockCreate.mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 100,
          panel_right: 900,
          main_switch_side: 'none',
        })
      );
    }
    await expect(getPanelGeometry(buf)).rejects.toThrow(/panel_\*/);
  });
});

// ---------------------------------------------------------------------------
// getCarrierCount
// ---------------------------------------------------------------------------

describe('getCarrierCount', () => {
  const medianPanel = {
    panel_top: 300,
    panel_bottom: 600,
    panel_left: 100,
    panel_right: 900,
  };
  // imageWidth = 500 chosen so panelWidthPx = (800/1000)*500 = 400
  // → expectedMin = floor(400/90) = 4, expectedMax = ceil(400/30) = 14
  // — allows 6/7/8 carrier counts below to run in single-pass (no retry fired)
  // while keeping the retry tests later in this suite free to choose extreme
  // counts that fall OUTSIDE [4,14].
  const imageDims = { imageWidth: 500, imageHeight: 600 };

  test('computes equal-pitch slot centre X coords across the panel', async () => {
    const buf = await makeFakeJpeg();
    // 8 carriers over a 0-1000 panel width of 800 → pitch = 100 norm
    // On a 500px-wide image: pitchPx = (100/1000)*500 = 50
    // First centre norm = panel_left(100) + 100*0.5 = 150 → 150/1000 * 500 = 75px
    // Last centre norm  = panel_left(100) + 100*7.5 = 850 → 850/1000 * 500 = 425px
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({ carrier_count: 8, main_switch_offset: 'none' })
    );
    const result = await getCarrierCount(buf, medianPanel, imageDims);

    expect(result.carrierCount).toBe(8);
    expect(result.slotCentersX).toHaveLength(8);
    expect(result.slotCentersX[0]).toBe(75);
    expect(result.slotCentersX[7]).toBe(425);
    expect(result.carrierPitchPx).toBeCloseTo(50);
    expect(result.mainSwitchOffset).toBe('none');
    expect(result.mainSwitchSlotIndex).toBeNull();
    // In-range count → no retry fires.
    expect(result.retry).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('main_switch_offset="right-edge" sets mainSwitchSlotIndex to last slot', async () => {
    const buf = await makeFakeJpeg();
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({ carrier_count: 7, main_switch_offset: 'right-edge' })
    );
    const result = await getCarrierCount(buf, medianPanel, imageDims);
    expect(result.carrierCount).toBe(7);
    expect(result.mainSwitchOffset).toBe('right-edge');
    expect(result.mainSwitchSlotIndex).toBe(6);
  });

  test('main_switch_offset="left-edge" sets mainSwitchSlotIndex to 0', async () => {
    const buf = await makeFakeJpeg();
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({ carrier_count: 6, main_switch_offset: 'left-edge' })
    );
    const result = await getCarrierCount(buf, medianPanel, imageDims);
    expect(result.mainSwitchSlotIndex).toBe(0);
  });

  test('throws when carrier_count is non-positive', async () => {
    const buf = await makeFakeJpeg();
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({ carrier_count: 0, main_switch_offset: 'none' })
    );
    await expect(getCarrierCount(buf, medianPanel, imageDims)).rejects.toThrow(/carrier_count/);
  });

  test('throws when panel_right <= panel_left', async () => {
    const buf = await makeFakeJpeg();
    await expect(
      getCarrierCount(
        buf,
        { panel_top: 300, panel_bottom: 600, panel_left: 900, panel_right: 100 },
        imageDims
      )
    ).rejects.toThrow(/panel_right/);
  });

  test('throws when imageDims.imageWidth is missing', async () => {
    const buf = await makeFakeJpeg();
    await expect(getCarrierCount(buf, medianPanel, { imageWidth: 0 })).rejects.toThrow(
      /imageWidth/
    );
  });

  // -------------------------------------------------------------------------
  // Sanity-check retry — Stage 2 improvement: if first VLM carrier_count falls
  // outside the panel-width-derived expected range [floor(W/90), ceil(W/30)],
  // a SECOND VLM call is made with a strengthened recount prompt. Retry value
  // wins (decision logged via console.log).
  // -------------------------------------------------------------------------
  describe('sanity-check retry', () => {
    // Quiet the branch-decision logger during these tests so Jest output stays
    // focused on assertions.
    let logSpy;
    beforeEach(() => {
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
      logSpy.mockRestore();
    });

    test('first count in expected range → single VLM call, retry=null', async () => {
      const buf = await makeFakeJpeg();
      // imageWidth=500, panelWidthPx=400 → range [4, 14]. 8 is in range.
      mockCreate.mockResolvedValueOnce(
        fakeVlmResponse({ carrier_count: 8, main_switch_offset: 'none' })
      );

      const result = await getCarrierCount(buf, medianPanel, imageDims);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(result.retry).toBeNull();
      expect(result.carrierCount).toBe(8);
    });

    test('first count out of range (too low) → retry fires, second count wins', async () => {
      const buf = await makeFakeJpeg();
      // imageWidth=500, panelWidthPx=400 → range [4, 14]. 2 is BELOW the min.
      mockCreate
        .mockResolvedValueOnce(fakeVlmResponse({ carrier_count: 2, main_switch_offset: 'none' }))
        // Retry: a more plausible answer within the expected range.
        .mockResolvedValueOnce(fakeVlmResponse({ carrier_count: 6, main_switch_offset: 'none' }));

      const result = await getCarrierCount(buf, medianPanel, imageDims);

      expect(mockCreate).toHaveBeenCalledTimes(2);
      // Retry wins.
      expect(result.carrierCount).toBe(6);
      expect(result.retry).toMatchObject({
        fired: true,
        firstCount: 2,
        secondCount: 6,
        expectedMin: 4,
        expectedMax: 14,
        panelWidthPx: 400,
        secondInRange: true,
      });
      // Branch decision logged.
      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/retry fired.*first=2.*second=6/));
      // Usage summed across both calls (2 × 100 input, 2 × 40 output from fakeVlmResponse defaults).
      expect(result.usage.inputTokens).toBe(200);
      expect(result.usage.outputTokens).toBe(80);
    });

    test('first count out of range (too high) → retry fires, second count wins', async () => {
      const buf = await makeFakeJpeg();
      // 30 is ABOVE expectedMax (14).
      mockCreate
        .mockResolvedValueOnce(fakeVlmResponse({ carrier_count: 30, main_switch_offset: 'none' }))
        .mockResolvedValueOnce(fakeVlmResponse({ carrier_count: 10, main_switch_offset: 'none' }));

      const result = await getCarrierCount(buf, medianPanel, imageDims);

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(result.carrierCount).toBe(10);
      expect(result.retry.fired).toBe(true);
      expect(result.retry.firstCount).toBe(30);
      expect(result.retry.secondCount).toBe(10);
      expect(result.retry.secondInRange).toBe(true);
    });

    test('both counts disagree + retry still out-of-range → retry value still wins, flagged secondInRange=false', async () => {
      const buf = await makeFakeJpeg();
      // First call: 30 (too high). Retry: 2 (too low). Retry wins because it
      // had the benefit of the strengthened recount prompt; secondInRange
      // marks the result as still suspect so callers can escalate.
      mockCreate
        .mockResolvedValueOnce(fakeVlmResponse({ carrier_count: 30, main_switch_offset: 'none' }))
        .mockResolvedValueOnce(fakeVlmResponse({ carrier_count: 2, main_switch_offset: 'none' }));

      const result = await getCarrierCount(buf, medianPanel, imageDims);

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(result.carrierCount).toBe(2);
      expect(result.retry).toMatchObject({
        fired: true,
        firstCount: 30,
        secondCount: 2,
        secondInRange: false,
      });
    });

    test('retry call receives a strengthened prompt mentioning the first count + expected range', async () => {
      const buf = await makeFakeJpeg();
      mockCreate
        .mockResolvedValueOnce(fakeVlmResponse({ carrier_count: 25, main_switch_offset: 'none' }))
        .mockResolvedValueOnce(fakeVlmResponse({ carrier_count: 8, main_switch_offset: 'none' }));

      await getCarrierCount(buf, medianPanel, imageDims);

      const firstCallPrompt = mockCreate.mock.calls[0][0].messages[0].content.find(
        (b) => b.type === 'text'
      ).text;
      const secondCallPrompt = mockCreate.mock.calls[1][0].messages[0].content.find(
        (b) => b.type === 'text'
      ).text;

      // First call has the baseline prompt — no recount language.
      expect(firstCallPrompt).not.toMatch(/RECOUNT/);
      // Retry call must flag the previous-count context and the expected range.
      expect(secondCallPrompt).toMatch(/RECOUNT/);
      expect(secondCallPrompt).toContain('25');
      expect(secondCallPrompt).toMatch(/between 4 and 14/);
    });

    test('in-range branch logs "single-pass" decision', async () => {
      const buf = await makeFakeJpeg();
      mockCreate.mockResolvedValueOnce(
        fakeVlmResponse({ carrier_count: 7, main_switch_offset: 'none' })
      );

      await getCarrierCount(buf, medianPanel, imageDims);

      expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/single-pass.*count=7.*\[4,14\]/));
    });
  });
});

// ---------------------------------------------------------------------------
// cropCarrierSlot
// ---------------------------------------------------------------------------

describe('cropCarrierSlot', () => {
  const baseGeom = {
    slotCentersX: [150, 250, 350, 450, 550, 650],
    carrierPitchPx: 100,
    panelTopNorm: 300,
    panelBottomNorm: 600,
    imageWidth: 1000,
    imageHeight: 800,
  };

  test('returns a buffer and a pixel bbox for a middle slot', async () => {
    const buf = await makeFakeJpeg(1000, 800);
    const result = await cropCarrierSlot(buf, 2, baseGeom);

    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.length).toBeGreaterThan(100);
    // halfWidthPx = carrierPitchPx (100)
    // centerXPx = 350 → leftPx = 250 → x=250
    expect(result.bbox.x).toBe(250);
    expect(result.bbox.w).toBeGreaterThan(0);
    expect(result.bbox.h).toBeGreaterThan(0);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBeGreaterThan(0);
  });

  test('clamps bbox to image bounds on the left edge', async () => {
    const buf = await makeFakeJpeg(1000, 800);
    const geom = { ...baseGeom, slotCentersX: [50, 150, 250], carrierPitchPx: 100 };
    const result = await cropCarrierSlot(buf, 0, geom);
    // leftPx = 50 - 100 = -50 → clamped to 0
    expect(result.bbox.x).toBe(0);
    expect(result.bbox.w).toBeGreaterThan(0);
  });

  test('clamps bbox to image bounds on the right edge', async () => {
    const buf = await makeFakeJpeg(1000, 800);
    const geom = { ...baseGeom, slotCentersX: [850, 950], carrierPitchPx: 100 };
    const result = await cropCarrierSlot(buf, 1, geom);
    // rightPx = 950 + 100 = 1050 → clamped to 1000
    expect(result.bbox.x + result.bbox.w).toBeLessThanOrEqual(1000);
  });

  test('throws on out-of-range slotIndex', async () => {
    const buf = await makeFakeJpeg();
    await expect(cropCarrierSlot(buf, 10, baseGeom)).rejects.toThrow(/out of range/);
    await expect(cropCarrierSlot(buf, -1, baseGeom)).rejects.toThrow(/out of range/);
  });

  test('throws on missing or invalid geometry fields', async () => {
    const buf = await makeFakeJpeg();
    await expect(cropCarrierSlot(buf, 0, { ...baseGeom, slotCentersX: [] })).rejects.toThrow(
      /non-empty/
    );
    await expect(cropCarrierSlot(buf, 0, { ...baseGeom, carrierPitchPx: 0 })).rejects.toThrow(
      /carrierPitchPx/
    );
    await expect(
      cropCarrierSlot(buf, 0, { ...baseGeom, panelTopNorm: 600, panelBottomNorm: 300 })
    ).rejects.toThrow(/panelTopNorm|panelBottomNorm/);
  });
});

// ---------------------------------------------------------------------------
// classifyCarriers
// ---------------------------------------------------------------------------

describe('classifyCarriers', () => {
  async function makeSlotCrops(n, widthPx = 100) {
    const crops = [];
    for (let i = 0; i < n; i++) {
      const buffer = await sharp({
        create: {
          width: widthPx,
          height: 200,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .jpeg()
        .toBuffer();
      crops.push({
        slotIndex: i,
        buffer,
        bbox: { x: i * widthPx, y: 300, w: widthPx, h: 300 },
      });
    }
    return crops;
  }

  test('batches 4 crops per Anthropic message (batchSize = 4)', async () => {
    const buf = await makeFakeJpeg();
    const slotCrops = await makeSlotCrops(4);

    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse([
        {
          slot_index: 0,
          classification: 'rewireable',
          bodyColour: 'red',
          ratingAmps: null,
          bsEn: 'BS 3036',
          confidence: 0.9,
        },
        {
          slot_index: 1,
          classification: 'rewireable',
          bodyColour: 'blue',
          ratingAmps: null,
          bsEn: 'BS 3036',
          confidence: 0.85,
        },
        {
          slot_index: 2,
          classification: 'rewireable',
          bodyColour: 'white',
          ratingAmps: null,
          bsEn: 'BS 3036',
          confidence: 0.8,
        },
        {
          slot_index: 3,
          classification: 'blank',
          bodyColour: null,
          ratingAmps: null,
          bsEn: null,
          confidence: 0.95,
        },
      ])
    );

    const result = await classifyCarriers(buf, slotCrops);

    expect(result.batchCount).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    const content = callArgs.messages[0].content;
    const imageBlocks = content.filter((b) => b.type === 'image');
    const textBlocks = content.filter((b) => b.type === 'text');
    expect(imageBlocks).toHaveLength(4);
    expect(textBlocks).toHaveLength(1);

    expect(result.slots).toHaveLength(4);
    expect(result.slots[0].classification).toBe('rewireable');
    expect(result.slots[3].classification).toBe('blank');
    for (const s of result.slots) {
      expect(s.crop.bbox).toBeDefined();
      expect(typeof s.crop.base64).toBe('string');
    }
  });

  test('splits > BATCH_SIZE crops into multiple messages', async () => {
    const buf = await makeFakeJpeg();
    const slotCrops = await makeSlotCrops(6); // 4 + 2

    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse([
          { slot_index: 0, classification: 'rewireable', bodyColour: 'red', confidence: 0.9 },
          { slot_index: 1, classification: 'rewireable', bodyColour: 'blue', confidence: 0.9 },
          { slot_index: 2, classification: 'rewireable', bodyColour: 'white', confidence: 0.9 },
          { slot_index: 3, classification: 'rewireable', bodyColour: 'red', confidence: 0.9 },
        ])
      )
      .mockResolvedValueOnce(
        fakeVlmResponse([
          { slot_index: 4, classification: 'rewireable', bodyColour: 'red', confidence: 0.9 },
          { slot_index: 5, classification: 'blank', bodyColour: null, confidence: 0.95 },
        ])
      );

    const result = await classifyCarriers(buf, slotCrops);

    expect(result.batchCount).toBe(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(
      mockCreate.mock.calls[0][0].messages[0].content.filter((b) => b.type === 'image')
    ).toHaveLength(4);
    expect(
      mockCreate.mock.calls[1][0].messages[0].content.filter((b) => b.type === 'image')
    ).toHaveLength(2);

    expect(result.slots).toHaveLength(6);
    expect(result.slots[5].classification).toBe('blank');
  });

  test('fills ratingAmps from bodyColour when VLM omits rating (white=5A, blue=15A, yellow=20A, red=30A, green=45A)', async () => {
    const buf = await makeFakeJpeg();
    // 5 slots → 2 batches (4 + 1) at BATCH_SIZE = 4
    const slotCrops = await makeSlotCrops(5);

    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse([
          { slot_index: 0, classification: 'rewireable', bodyColour: 'white', confidence: 0.9 },
          { slot_index: 1, classification: 'rewireable', bodyColour: 'blue', confidence: 0.9 },
          { slot_index: 2, classification: 'rewireable', bodyColour: 'yellow', confidence: 0.9 },
          { slot_index: 3, classification: 'rewireable', bodyColour: 'red', confidence: 0.9 },
        ])
      )
      .mockResolvedValueOnce(
        fakeVlmResponse([
          { slot_index: 4, classification: 'rewireable', bodyColour: 'green', confidence: 0.9 },
        ])
      );

    const result = await classifyCarriers(buf, slotCrops);

    expect(result.slots[0].ratingAmps).toBe(5);
    expect(result.slots[1].ratingAmps).toBe(15);
    expect(result.slots[2].ratingAmps).toBe(20);
    expect(result.slots[3].ratingAmps).toBe(30);
    expect(result.slots[4].ratingAmps).toBe(45);
  });

  test('does NOT overwrite VLM-returned ratingAmps with colour-derived value', async () => {
    const buf = await makeFakeJpeg();
    const slotCrops = await makeSlotCrops(1);

    // Cartridge with explicitly stamped rating — VLM returns 32, which is not a
    // BS 3036 colour-code value. We must keep the VLM value, not coerce to a
    // colour-derived rating.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse([
        {
          slot_index: 0,
          classification: 'cartridge',
          bodyColour: 'red',
          ratingAmps: 32,
          bsEn: 'BS 1361',
          confidence: 0.9,
        },
      ])
    );

    const result = await classifyCarriers(buf, slotCrops);
    expect(result.slots[0].ratingAmps).toBe(32);
    expect(result.slots[0].classification).toBe('cartridge');
    expect(result.slots[0].bsEn).toBe('BS 1361');
  });

  test('matches VLM responses by slot_index even when returned out of order', async () => {
    const buf = await makeFakeJpeg();
    const slotCrops = await makeSlotCrops(4);

    // Reverse response order
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse([
        { slot_index: 3, classification: 'blank', bodyColour: null, confidence: 0.9 },
        { slot_index: 2, classification: 'rewireable', bodyColour: 'red', confidence: 0.9 },
        { slot_index: 1, classification: 'rewireable', bodyColour: 'blue', confidence: 0.9 },
        { slot_index: 0, classification: 'rewireable', bodyColour: 'white', confidence: 0.9 },
      ])
    );

    const result = await classifyCarriers(buf, slotCrops);

    expect(result.slots[0].classification).toBe('rewireable');
    expect(result.slots[0].bodyColour).toBe('white');
    expect(result.slots[0].ratingAmps).toBe(5);

    expect(result.slots[1].bodyColour).toBe('blue');
    expect(result.slots[1].ratingAmps).toBe(15);

    expect(result.slots[2].bodyColour).toBe('red');
    expect(result.slots[2].ratingAmps).toBe(30);

    expect(result.slots[3].classification).toBe('blank');
    expect(result.slots[3].bodyColour).toBeNull();
    expect(result.slots[3].ratingAmps).toBeNull();
  });

  test('parses fenced ```json array response', async () => {
    const buf = await makeFakeJpeg();
    const slotCrops = await makeSlotCrops(2);

    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: 'Sure!\n```json\n[{"slot_index":0,"classification":"rewireable","bodyColour":"red","confidence":0.9},{"slot_index":1,"classification":"blank","bodyColour":null,"confidence":0.9}]\n```',
        },
      ],
      usage: { input_tokens: 50, output_tokens: 20 },
    });

    const result = await classifyCarriers(buf, slotCrops);
    expect(result.slots).toHaveLength(2);
    expect(result.slots[0].classification).toBe('rewireable');
    expect(result.slots[0].ratingAmps).toBe(30);
    expect(result.slots[1].classification).toBe('blank');
  });

  test('throws when VLM returns non-array JSON', async () => {
    const buf = await makeFakeJpeg();
    const slotCrops = await makeSlotCrops(2);

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"not":"an array"}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await expect(classifyCarriers(buf, slotCrops)).rejects.toThrow(/classifyCarriers/);
  });

  test('returns empty result when slotCrops is empty (no VLM calls)', async () => {
    const buf = await makeFakeJpeg();
    const result = await classifyCarriers(buf, []);
    expect(result.slots).toEqual([]);
    expect(result.batchCount).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('fills in defaults when VLM omits optional fields', async () => {
    const buf = await makeFakeJpeg();
    const slotCrops = await makeSlotCrops(1);

    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse([{ slot_index: 0, classification: 'rewireable' }])
    );

    const result = await classifyCarriers(buf, slotCrops);
    expect(result.slots[0].classification).toBe('rewireable');
    expect(result.slots[0].bodyColour).toBeNull();
    expect(result.slots[0].ratingAmps).toBeNull();
    expect(result.slots[0].bsEn).toBeNull();
    expect(result.slots[0].confidence).toBe(0);
  });

  test('exports BODY_COLOUR_TO_AMPS mapping with BS 3036 codes', () => {
    expect(BODY_COLOUR_TO_AMPS).toEqual({
      white: 5,
      blue: 15,
      yellow: 20,
      red: 30,
      green: 45,
    });
  });
});

// ---------------------------------------------------------------------------
// extractCcuRewireable (orchestrator)
// ---------------------------------------------------------------------------

describe('extractCcuRewireable', () => {
  // Helper: Stage 3 VLM response for N carrier slots.
  const stage3Response = (slotIndices) =>
    fakeVlmResponse(
      slotIndices.map((i) => ({
        slot_index: i,
        classification: 'rewireable',
        bodyColour: i % 2 === 0 ? 'red' : 'white',
        ratingAmps: null,
        bsEn: 'BS 3036',
        confidence: 0.85,
      }))
    );

  test('returns combined stage1 + stage2 + stage3 result with stageOutputs + ccu-rewireable-v1 schema', async () => {
    // 250px-wide image so panelWidthPx = (800/1000)*250 = 200 →
    // expectedMin=floor(200/90)=2, expectedMax=ceil(200/30)=7. carrier_count=4
    // sits in range, so no Stage 2 retry fires and the VLM call count is the
    // "pure" 5 (stage1) + 1 (stage2) + 1 (stage3) = 7 we assert on.
    const buf = await makeFakeJpeg(250, 600);

    mockCreate
      // Stage 1 — 5 panel samples (bumped from 3 for reliability)
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 100,
          panel_right: 900,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 305,
          panel_bottom: 605,
          panel_left: 105,
          panel_right: 905,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 310,
          panel_bottom: 610,
          panel_left: 110,
          panel_right: 910,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 315,
          panel_bottom: 615,
          panel_left: 115,
          panel_right: 915,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 320,
          panel_bottom: 620,
          panel_left: 120,
          panel_right: 920,
          main_switch_side: 'right',
        })
      )
      // Stage 2 — carrier count (in range, no retry)
      .mockResolvedValueOnce(fakeVlmResponse({ carrier_count: 4, main_switch_offset: 'none' }))
      // Stage 3 — 1 batch of 4
      .mockResolvedValueOnce(stage3Response([0, 1, 2, 3]));

    const result = await extractCcuRewireable(buf);

    expect(result.schemaVersion).toBe('ccu-rewireable-v1');
    expect(result.panelBounds).toEqual({
      top: 310,
      bottom: 610,
      left: 110,
      right: 910,
    });
    expect(result.carrierCount).toBe(4);
    expect(result.mainSwitchSide).toBe('right');
    expect(result.mainSwitchOffset).toBe('none');
    expect(result.mainSwitchSlotIndex).toBeNull();
    expect(result.slotCentersX).toHaveLength(4);
    expect(result.carrierPitch).toBeGreaterThan(0);
    expect(result.lowConfidence).toBe(false);
    expect(result.stage3Error).toBeNull();

    expect(result.slots).toHaveLength(4);
    expect(result.slots[0].classification).toBe('rewireable');
    expect(result.slots[0].bodyColour).toBe('red');
    expect(result.slots[0].ratingAmps).toBe(30); // colour-derived
    expect(result.slots[1].bodyColour).toBe('white');
    expect(result.slots[1].ratingAmps).toBe(5);
    expect(typeof result.slots[0].crop.base64).toBe('string');

    expect(result.stageOutputs.stage1.panels).toHaveLength(5);
    expect(result.stageOutputs.stage2.carrierCount).toBe(4);
    expect(result.stageOutputs.stage3.batchCount).toBe(1);
    expect(result.stageOutputs.stage3.batchSize).toBe(4);
    expect(result.timings.stage3Ms).toBeGreaterThanOrEqual(0);

    // Usage summed across all VLM calls. 5 stage1 + 1 stage2 + 1 stage3 = 7 calls.
    expect(result.usage.inputTokens).toBe(7 * 100);
    expect(result.usage.outputTokens).toBe(7 * 40);
  });

  test('propagates Stage 1 errors without running Stage 2 or Stage 3', async () => {
    const buf = await makeFakeJpeg();
    mockCreate.mockRejectedValueOnce(new Error('VLM boom'));
    await expect(extractCcuRewireable(buf)).rejects.toThrow(/VLM boom/);
  });

  test('soft-fails on Stage 3 error: slots=null, stage3Error set, Stage 1/2 preserved', async () => {
    // Narrow 250px image keeps carrier_count=4 inside the expected-count range
    // so the Stage 2 retry path doesn't fire (which would consume an extra mock).
    const buf = await makeFakeJpeg(250, 600);

    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 100,
          panel_right: 900,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 305,
          panel_bottom: 605,
          panel_left: 105,
          panel_right: 905,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 310,
          panel_bottom: 610,
          panel_left: 110,
          panel_right: 910,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 315,
          panel_bottom: 615,
          panel_left: 115,
          panel_right: 915,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 320,
          panel_bottom: 620,
          panel_left: 120,
          panel_right: 920,
          main_switch_side: 'right',
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ carrier_count: 4, main_switch_offset: 'right-edge' })
      )
      // Stage 3 returns garbage → soft-fail.
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'this is not json at all' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

    const result = await extractCcuRewireable(buf);

    // Stages 1 and 2 preserved
    expect(result.carrierCount).toBe(4);
    expect(result.slotCentersX).toHaveLength(4);
    expect(result.mainSwitchOffset).toBe('right-edge');
    expect(result.mainSwitchSlotIndex).toBe(3);
    expect(result.mainSwitchSide).toBe('right');

    // Stage 3 soft-failed
    expect(result.slots).toBeNull();
    expect(result.stage3Error).toEqual(expect.stringMatching(/classifyCarriers/));
  });

  test('flags lowConfidence=true when any Stage 3 slot has confidence < 0.6', async () => {
    // Narrow 250px image keeps carrier_count=3 within the expected-count
    // window (range [2,7] at panelWidthPx=200) — avoids retry path.
    const buf = await makeFakeJpeg(250, 600);

    // 5 identical Stage 1 samples.
    for (let i = 0; i < 5; i++) {
      mockCreate.mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 100,
          panel_right: 900,
          main_switch_side: 'none',
        })
      );
    }
    mockCreate
      .mockResolvedValueOnce(fakeVlmResponse({ carrier_count: 3, main_switch_offset: 'none' }))
      // One slot has confidence 0.4 — should trigger lowConfidence
      .mockResolvedValueOnce(
        fakeVlmResponse([
          { slot_index: 0, classification: 'rewireable', bodyColour: 'red', confidence: 0.9 },
          { slot_index: 1, classification: 'rewireable', bodyColour: 'blue', confidence: 0.4 },
          { slot_index: 2, classification: 'rewireable', bodyColour: 'white', confidence: 0.9 },
        ])
      );

    const result = await extractCcuRewireable(buf);
    expect(result.lowConfidence).toBe(true);
    expect(result.slots).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// prepareRewireableGeometry + classifyRewireableSlots (Stage 3 / Stage 4 split)
// ---------------------------------------------------------------------------

describe('prepareRewireableGeometry', () => {
  test('returns Stage 1 + Stage 2 output shape (no Stage 3)', async () => {
    // 250px-wide image keeps carrier_count=4 inside the expected-range
    // window [2,7] so no Stage 2 retry fires (5 + 1 = 6 VLM calls total).
    const buf = await makeFakeJpeg(250, 600);

    for (let i = 0; i < 5; i++) {
      mockCreate.mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300 + i,
          panel_bottom: 600 + i,
          panel_left: 100 + i,
          panel_right: 900 + i,
          main_switch_side: 'right',
        })
      );
    }
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({ carrier_count: 4, main_switch_offset: 'right-edge' })
    );

    const prepared = await prepareRewireableGeometry(buf);

    expect(prepared.carrierCount).toBe(4);
    expect(prepared.slotCentersX).toHaveLength(4);
    expect(prepared.carrierPitchPx).toBeGreaterThan(0);
    expect(prepared.mainSwitchSide).toBe('right');
    expect(prepared.mainSwitchOffset).toBe('right-edge');
    expect(prepared.mainSwitchSlotIndex).toBe(3);
    expect(prepared.panelBounds).toEqual({
      top: 302,
      bottom: 602,
      left: 102,
      right: 902,
    });
    expect(prepared.stageOutputs.stage1).toBeDefined();
    expect(prepared.stageOutputs.stage2).toBeDefined();
    expect(prepared.stageOutputs.stage3).toBeUndefined();
    // 5 Stage 1 + 1 Stage 2 = 6 VLM calls total (no Stage 3).
    expect(mockCreate).toHaveBeenCalledTimes(6);
  });

  test('propagates Stage 1 failures (no Stage 2)', async () => {
    const buf = await makeFakeJpeg();
    mockCreate.mockRejectedValueOnce(new Error('VLM boom'));
    await expect(prepareRewireableGeometry(buf)).rejects.toThrow(/VLM boom/);
  });
});

describe('classifyRewireableSlots', () => {
  async function buildPreparedGeometry({ mainSwitchOffset = 'none' } = {}) {
    const buf = await makeFakeJpeg(250, 600);
    for (let i = 0; i < 5; i++) {
      mockCreate.mockResolvedValueOnce(
        fakeVlmResponse({
          panel_top: 300,
          panel_bottom: 600,
          panel_left: 100,
          panel_right: 900,
          main_switch_side: 'none',
        })
      );
    }
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({ carrier_count: 4, main_switch_offset: mainSwitchOffset })
    );
    const prepared = await prepareRewireableGeometry(buf);
    return { buf, prepared };
  }

  test('returns Stage 3 output given prepared geometry', async () => {
    const { buf, prepared } = await buildPreparedGeometry();

    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse([
        { slot_index: 0, classification: 'rewireable', bodyColour: 'red', confidence: 0.9 },
        { slot_index: 1, classification: 'rewireable', bodyColour: 'blue', confidence: 0.85 },
        { slot_index: 2, classification: 'rewireable', bodyColour: 'white', confidence: 0.85 },
        { slot_index: 3, classification: 'blank', confidence: 0.95 },
      ])
    );

    const classified = await classifyRewireableSlots(buf, prepared);

    expect(classified.slots).toHaveLength(4);
    expect(classified.slots[0].bodyColour).toBe('red');
    expect(classified.slots[0].ratingAmps).toBe(30);
    expect(classified.slots[1].ratingAmps).toBe(15);
    expect(classified.slots[2].ratingAmps).toBe(5);
    expect(classified.slots[3].classification).toBe('blank');
    expect(classified.stage3Error).toBeNull();
    expect(classified.lowConfidence).toBe(false);
    expect(classified.timings.stage3Ms).toBeGreaterThanOrEqual(0);
    expect(classified.stageOutputs.stage3.batchCount).toBe(1);
  });

  test('force-tags main-switch slot when mainSwitchSlotIndex set', async () => {
    const { buf, prepared } = await buildPreparedGeometry({
      mainSwitchOffset: 'right-edge',
    });

    expect(prepared.mainSwitchSlotIndex).toBe(3);

    // VLM returns blank at the main-switch slot — classifyRewireableSlots must
    // override it to 'main_switch' so the merger correctly skips it.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse([
        { slot_index: 0, classification: 'rewireable', bodyColour: 'red', confidence: 0.9 },
        { slot_index: 1, classification: 'rewireable', bodyColour: 'blue', confidence: 0.85 },
        { slot_index: 2, classification: 'rewireable', bodyColour: 'white', confidence: 0.85 },
        { slot_index: 3, classification: 'blank', confidence: 0.95 },
      ])
    );

    const classified = await classifyRewireableSlots(buf, prepared);
    expect(classified.slots[3].classification).toBe('main_switch');
    expect(classified.slots[3].ratingAmps).toBeNull();
  });

  test('soft-fails when Stage 3 VLM returns garbage', async () => {
    const { buf, prepared } = await buildPreparedGeometry();

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'definitely not json' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const classified = await classifyRewireableSlots(buf, prepared);
    expect(classified.slots).toBeNull();
    expect(classified.stage3Error).toEqual(expect.stringMatching(/classifyCarriers/));
  });

  test('raises lowConfidence=true when any slot scores below STAGE3_LOW_CONF_THRESHOLD', async () => {
    const { buf, prepared } = await buildPreparedGeometry();

    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse([
        { slot_index: 0, classification: 'rewireable', bodyColour: 'red', confidence: 0.9 },
        { slot_index: 1, classification: 'rewireable', bodyColour: 'blue', confidence: 0.4 }, // below 0.6
        { slot_index: 2, classification: 'rewireable', bodyColour: 'white', confidence: 0.9 },
        { slot_index: 3, classification: 'blank', confidence: 0.95 },
      ])
    );

    const classified = await classifyRewireableSlots(buf, prepared);
    expect(classified.lowConfidence).toBe(true);
  });

  test('throws when preparedGeom is invalid', async () => {
    const buf = await makeFakeJpeg();
    await expect(classifyRewireableSlots(buf, null)).rejects.toThrow(/slotCentersX/);
    await expect(classifyRewireableSlots(buf, {})).rejects.toThrow(/slotCentersX/);
  });
});
