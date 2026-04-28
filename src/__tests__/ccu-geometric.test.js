/**
 * Unit tests for src/extraction/ccu-geometric.js — Phase B.
 *
 * Anthropic SDK is mocked at module level. Tests cover:
 *   - Stage 1 median correctness across 3 samples
 *   - Stage 1 lowConfidence SD threshold (5% of image width, 0-1000 scale)
 *   - Stage 2 geometricCount = round(rail_width / (main_switch_width/2))
 *   - Stage 2 disagreement flag (|geo - vlm| >= 1)
 *   - extractCcuGeometric combined shape
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
let getRailGeometry;
let getModuleCount;
let extractCcuGeometric;
let cropSlot;
let classifySlots;
let prepareModernGeometry;
let classifyModernSlots;

beforeAll(async () => {
  const mod = await import('../extraction/ccu-geometric.js');
  getRailGeometry = mod.getRailGeometry;
  getModuleCount = mod.getModuleCount;
  extractCcuGeometric = mod.extractCcuGeometric;
  cropSlot = mod.cropSlot;
  classifySlots = mod.classifySlots;
  prepareModernGeometry = mod.prepareModernGeometry;
  classifyModernSlots = mod.classifyModernSlots;
});

// Build a tiny in-memory JPEG buffer of known dimensions for metadata calls.
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
// getRailGeometry
// ---------------------------------------------------------------------------

describe('getRailGeometry', () => {
  test('computes per-coordinate median across 3 samples', async () => {
    const buf = await makeFakeJpeg(1200, 800);

    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 410, rail_bottom: 610, rail_left: 110, rail_right: 910 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 420, rail_bottom: 620, rail_left: 120, rail_right: 920 })
      );

    const result = await getRailGeometry(buf);

    expect(result.rails).toHaveLength(3);
    expect(result.medianRails).toEqual({
      rail_top: 410,
      rail_bottom: 610,
      rail_left: 110,
      rail_right: 910,
    });
    expect(result.imageWidth).toBe(1200);
    expect(result.imageHeight).toBe(800);
    expect(result.usage.inputTokens).toBe(300);
    expect(result.usage.outputTokens).toBe(120);
  });

  test('lowConfidence=false when per-coordinate SD is well under 5% of image width', async () => {
    const buf = await makeFakeJpeg();

    // Very tight clustering — SD on 0-1000 scale is ~4 → 0.4% of image width.
    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 404, rail_bottom: 604, rail_left: 104, rail_right: 904 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 398, rail_bottom: 598, rail_left: 98, rail_right: 898 })
      );

    const result = await getRailGeometry(buf);
    expect(result.lowConfidence).toBe(false);
    for (const v of Object.values(result.sdPct)) {
      expect(v).toBeLessThan(5);
    }
  });

  test('lowConfidence=true when any coordinate SD exceeds 5% of image width', async () => {
    const buf = await makeFakeJpeg();

    // rail_left wildly disagrees (10, 500, 990) → SD ~= 400 on 0-1000 → 40% of image width.
    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 10, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 405, rail_bottom: 605, rail_left: 500, rail_right: 905 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 395, rail_bottom: 595, rail_left: 990, rail_right: 895 })
      );

    const result = await getRailGeometry(buf);
    expect(result.lowConfidence).toBe(true);
    expect(result.sdPct.rail_left).toBeGreaterThan(5);
  });

  test('throws when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const buf = await makeFakeJpeg();
    await expect(getRailGeometry(buf)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  test('throws when VLM omits required rail_* fields', async () => {
    const buf = await makeFakeJpeg();
    mockCreate
      .mockResolvedValueOnce(fakeVlmResponse({ rail_top: 400, rail_bottom: 600 }))
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      );
    await expect(getRailGeometry(buf)).rejects.toThrow(/rail_\*/);
  });

  test('parses JSON wrapped in ```json fences', async () => {
    const buf = await makeFakeJpeg();
    mockCreate
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: 'Here is the result:\n```json\n{"rail_top":400,"rail_bottom":600,"rail_left":100,"rail_right":900}\n```',
          },
        ],
        usage: { input_tokens: 50, output_tokens: 20 },
      })
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      );
    const result = await getRailGeometry(buf);
    expect(result.medianRails.rail_top).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// getModuleCount
// ---------------------------------------------------------------------------

describe('getModuleCount', () => {
  const medianRails = {
    rail_top: 400,
    rail_bottom: 600,
    rail_left: 100,
    rail_right: 900,
  };

  test('right-side main switch clamps rail_right to exclude its bbox', async () => {
    const buf = await makeFakeJpeg();

    // rail = [100, 900], main switch centred at 820 width 80 → msLeft=780.
    // effectiveRailRight = 780 → width 680, moduleWidth=40 → count=17.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 820,
        main_switch_width: 80,
        module_count_direct: 17,
      })
    );

    const result = await getModuleCount(buf, medianRails);
    expect(result.mainSwitchSide).toBe('right');
    expect(result.geometricCount).toBe(17);
    expect(result.vlmCount).toBe(17);
    expect(result.disagreement).toBe(false);
    expect(result.truncatedFromDisagreement).toBe(false);
    expect(result.slotCentersX).toHaveLength(17);
    // Right-side clamp: tile from the left end of the rail.
    expect(result.slotCentersX[0]).toBeCloseTo(120);
    // Last slot still leaves a gap before the main switch (msLeft=780,
    // last centre = 100 + 40 * 16.5 = 760 → centre+moduleWidth/2 = 780).
    expect(result.slotCentersX.at(-1)).toBeCloseTo(760);
    expect(result.moduleWidth).toBe(40);
  });

  test('left-side main switch clamps rail_left to exclude its bbox', async () => {
    const buf = await makeFakeJpeg();

    // rail = [100, 900], main switch at left: centreX=180, width=80 → msRight=220.
    // effectiveRailLeft=220 → width=680, moduleWidth=40 → count=17.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 180,
        main_switch_width: 80,
        module_count_direct: 17,
      })
    );

    const result = await getModuleCount(buf, medianRails);
    expect(result.mainSwitchSide).toBe('left');
    expect(result.geometricCount).toBe(17);
    expect(result.slotCentersX).toHaveLength(17);
    // Left-side clamp: first module sits just to the right of the main switch.
    // Tiling runs right-to-left then reversed, so slotCentersX[0] is the
    // leftmost module centre = effectiveLeft + moduleWidth*0.5 = 240.
    expect(result.slotCentersX[0]).toBeCloseTo(240);
    expect(result.slotCentersX.at(-1)).toBeCloseTo(880);
  });

  test('no clamp when main switch centre falls outside rail bbox', async () => {
    const buf = await makeFakeJpeg();

    // rail_width = 800; main switch is on a SEPARATE segment (centre past rail_right).
    // Clamp is a no-op: full width used.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 960,
        main_switch_width: 80,
        module_count_direct: 20,
      })
    );

    const result = await getModuleCount(buf, medianRails);
    expect(result.mainSwitchSide).toBeNull();
    expect(result.geometricCount).toBe(20);
    expect(result.slotCentersX).toHaveLength(20);
    expect(result.slotCentersX[0]).toBeCloseTo(120);
    expect(result.slotCentersX.at(-1)).toBeCloseTo(880);
  });

  test('disagreement=true when |geometric - vlm| >= 1 (single-module drift kept)', async () => {
    const buf = await makeFakeJpeg();
    // Right-side MS at 820/80 → clamp to 780, width 680, moduleWidth 40 → count 17.
    // VLM insists 18 — within the 1-module fencepost tolerance, kept as-is.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 820,
        main_switch_width: 80,
        module_count_direct: 18,
      })
    );

    const result = await getModuleCount(buf, medianRails);
    expect(result.geometricCount).toBe(17);
    expect(result.vlmCount).toBe(18);
    expect(result.disagreement).toBe(true);
    expect(result.truncatedFromDisagreement).toBe(false);
  });

  test('truncates geometric → VLM when |geo − vlm| ≥ 2 post-clamp', async () => {
    const buf = await makeFakeJpeg();
    // Right-side MS: post-clamp geometric count = 17 but VLM insists 12.
    // Clamp did its job on the main-switch end; remaining 5-module gap means
    // rail_left estimate is off. Truncate geometric down to VLM's 12 and
    // flag truncatedFromDisagreement.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 820,
        main_switch_width: 80,
        module_count_direct: 12,
      })
    );

    const result = await getModuleCount(buf, medianRails);
    expect(result.vlmCount).toBe(12);
    expect(result.geometricCount).toBe(12);
    expect(result.slotCentersX).toHaveLength(12);
    expect(result.truncatedFromDisagreement).toBe(true);
    // With mainSwitchSide='right', tiling runs from the left, so the 12
    // slots span the FAR-FROM-main-switch end: centres [120, 160, …, 560].
    expect(result.slotCentersX[0]).toBeCloseTo(120);
    expect(result.slotCentersX.at(-1)).toBeCloseTo(560);
  });

  test('rounds non-integer geometric counts', async () => {
    const buf = await makeFakeJpeg();
    // Right-side MS at 870/60 → msLeft=840; effectiveWidth=740; moduleWidth=30
    // → 740/30 = 24.666 → floor()=24 (prevents phantom slot overlapping the
    // main switch bbox). VLM agrees.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 870,
        main_switch_width: 60,
        module_count_direct: 24,
      })
    );

    const result = await getModuleCount(buf, medianRails);
    expect(result.geometricCount).toBe(24);
    expect(result.disagreement).toBe(false);
    expect(result.truncatedFromDisagreement).toBe(false);
  });

  test('throws when main_switch_width is invalid', async () => {
    const buf = await makeFakeJpeg();
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 140,
        main_switch_width: 0,
        module_count_direct: 20,
      })
    );
    await expect(getModuleCount(buf, medianRails)).rejects.toThrow(/main_switch_width/);
  });

  test('throws when medianRails has non-numeric rail_left/rail_right', async () => {
    const buf = await makeFakeJpeg();
    await expect(getModuleCount(buf, { rail_left: null, rail_right: 900 })).rejects.toThrow(
      /rail_left/
    );
  });

  test('throws when rail_right <= rail_left', async () => {
    const buf = await makeFakeJpeg();
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 140,
        main_switch_width: 80,
        module_count_direct: 20,
      })
    );
    await expect(
      getModuleCount(buf, { rail_top: 0, rail_bottom: 1, rail_left: 900, rail_right: 100 })
    ).rejects.toThrow(/rail_right/);
  });
});

// ---------------------------------------------------------------------------
// getModuleCount — tighten-and-chunk mode (CCU_STAGE2_GROUPS=true)
// ---------------------------------------------------------------------------
//
// New 2026-04-28 path (Derek's design): the VLM has ONE job — return a
// single rectangle that tightly encloses every device on the rail (RCD,
// MCBs, blanks, main switch). Backend then chunks the bbox geometrically
// using the UK MCB body-height standard (82.5mm) and DIN module pitch
// (17.5mm). No grouping decision, no module count from the VLM, no per-
// device list. Stage 3 classifies each tiled slot, and slotsToCircuits
// handles main_switch / blank / rcd classifications as before.
//
// Test math: with image 1000×1000 and bbox top=100/bottom=265 (height=165
// normalised = 165 px), pixels_per_mm = 165/82.5 = 2.0, module_width_px =
// 17.5*2 = 35. With bbox left=100/right=520 (width=420 px), module_count
// = round(420/35) = 12. moduleWidth in 0-1000 norm = 420/12 = 35.

describe('getModuleCount — tighten-and-chunk mode', () => {
  const medianRails = {
    rail_top: 100,
    rail_bottom: 900,
    rail_left: 0,
    rail_right: 1000,
  };
  const dims1k = { imageWidth: 1000, imageHeight: 1000 };

  beforeEach(() => {
    process.env.CCU_STAGE2_GROUPS = 'true';
  });

  afterEach(() => {
    delete process.env.CCU_STAGE2_GROUPS;
  });

  test('basic 12-module bbox → 12 slots tiled evenly across the bbox', async () => {
    const buf = await makeFakeJpeg(1000, 1000);
    // bbox 100→520 wide × 100→265 tall. height_px=165 → px/mm=2 →
    // module_px=35. width_px=420 → count=round(420/35)=12.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        rail_bbox: { left: 100, right: 520, top: 100, bottom: 265 },
        main_switch_center_x: 500,
        main_switch_width: 70,
      })
    );

    const result = await getModuleCount(buf, medianRails, dims1k);
    expect(result.geometricCount).toBe(12);
    expect(result.vlmCount).toBe(12);
    expect(result.disagreement).toBe(false);
    expect(result.moduleWidth).toBeCloseTo(35);
    expect(result.effectiveRailLeft).toBe(100);
    expect(result.effectiveRailRight).toBe(520);
    expect(result.populatedAreaStartX).toBe(100);
    expect(result.populatedAreaEndX).toBe(520);
    expect(result.slotCentersX).toHaveLength(12);
    expect(result.slotCentersX[0]).toBeCloseTo(117.5); // 100 + 35/2
    expect(result.slotCentersX.at(-1)).toBeCloseTo(502.5); // 520 - 35/2
    expect(result.railBbox).toEqual({ left: 100, right: 520, top: 100, bottom: 265 });
  });

  test('mainSwitchSide: main switch right of bbox midpoint → "right"', async () => {
    const buf = await makeFakeJpeg(1000, 1000);
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        rail_bbox: { left: 100, right: 520, top: 100, bottom: 265 },
        main_switch_center_x: 480, // > midpoint(310)
        main_switch_width: 70,
      })
    );
    const result = await getModuleCount(buf, medianRails, dims1k);
    expect(result.mainSwitchSide).toBe('right');
  });

  test('mainSwitchSide: main switch left of bbox midpoint → "left"', async () => {
    const buf = await makeFakeJpeg(1000, 1000);
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        rail_bbox: { left: 100, right: 520, top: 100, bottom: 265 },
        main_switch_center_x: 140, // < midpoint(310)
        main_switch_width: 70,
      })
    );
    const result = await getModuleCount(buf, medianRails, dims1k);
    expect(result.mainSwitchSide).toBe('left');
  });

  test('inline-mains board (no main switch) → mainSwitchSide null', async () => {
    const buf = await makeFakeJpeg(1000, 1000);
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        rail_bbox: { left: 100, right: 520, top: 100, bottom: 265 },
        main_switch_center_x: null,
        main_switch_width: null,
      })
    );
    const result = await getModuleCount(buf, medianRails, dims1k);
    expect(result.mainSwitchSide).toBeNull();
    expect(result.mainSwitchCenterX).toBeNull();
    expect(result.mainSwitchWidth).toBeNull();
    expect(result.geometricCount).toBe(12);
  });

  test('split-load board: gaps between groups appear as blank slots in the tiling', async () => {
    // Tighten-and-chunk doesn't try to detect gaps — they just exist as
    // module positions inside the single bbox. Stage 3 classifies them
    // as `blank` and slotsToCircuits emits Spare entries. So the test
    // here is just that a wide bbox with the matching module count
    // tiles enough slots to cover the gap.
    const buf = await makeFakeJpeg(1000, 1000);
    // bbox 100→520 → 12 slots. Imagine 4 MCBs + 3 blanks + 5 MCBs.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        rail_bbox: { left: 100, right: 520, top: 100, bottom: 265 },
        main_switch_center_x: 500,
        main_switch_width: 70,
      })
    );
    const result = await getModuleCount(buf, medianRails, dims1k);
    expect(result.slotCentersX).toHaveLength(12); // covers the entire span
  });

  test('lowConfidence flagged when main_switch_width disagrees with height calibration by >10%', async () => {
    const buf = await makeFakeJpeg(1000, 1000);
    // Height-based: module_width_px = 35. main_switch_width = 80 →
    // module from MS = 40. Disagreement = round(|40-35|/40 * 100) = 12.5
    // → 13% → lowConfidence.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        rail_bbox: { left: 100, right: 520, top: 100, bottom: 265 },
        main_switch_center_x: 500,
        main_switch_width: 80,
      })
    );
    const result = await getModuleCount(buf, medianRails, dims1k);
    expect(result.lowConfidence).toBe(true);
    expect(result.pitchCrossCheck).not.toBeNull();
    expect(result.pitchCrossCheck.disagreementPct).toBeGreaterThan(10);
  });

  test('lowConfidence NOT flagged when calibrations agree within 10%', async () => {
    const buf = await makeFakeJpeg(1000, 1000);
    // Height-based: module_width_px = 35. main_switch_width = 70 →
    // module from MS = 35. Disagreement = 0 → lowConfidence=false.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        rail_bbox: { left: 100, right: 520, top: 100, bottom: 265 },
        main_switch_center_x: 500,
        main_switch_width: 70,
      })
    );
    const result = await getModuleCount(buf, medianRails, dims1k);
    expect(result.lowConfidence).toBe(false);
    expect(result.pitchCrossCheck.disagreementPct).toBeLessThanOrEqual(10);
  });

  test('throws when rail_bbox is missing', async () => {
    const buf = await makeFakeJpeg(1000, 1000);
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 500,
        main_switch_width: 70,
      })
    );
    await expect(getModuleCount(buf, medianRails, dims1k)).rejects.toThrow(/missing rail_bbox/);
  });

  test('throws when rail_bbox right <= left', async () => {
    const buf = await makeFakeJpeg(1000, 1000);
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        rail_bbox: { left: 500, right: 100, top: 100, bottom: 265 },
        main_switch_center_x: null,
        main_switch_width: null,
      })
    );
    await expect(getModuleCount(buf, medianRails, dims1k)).rejects.toThrow(/right.*must be > left/);
  });

  test('throws when rail_bbox bottom <= top', async () => {
    const buf = await makeFakeJpeg(1000, 1000);
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        rail_bbox: { left: 100, right: 520, top: 265, bottom: 100 },
        main_switch_center_x: null,
        main_switch_width: null,
      })
    );
    await expect(getModuleCount(buf, medianRails, dims1k)).rejects.toThrow(/bottom.*must be > top/);
  });

  test('throws when imageDimensions are missing', async () => {
    const buf = await makeFakeJpeg(1000, 1000);
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        rail_bbox: { left: 100, right: 520, top: 100, bottom: 265 },
        main_switch_center_x: null,
        main_switch_width: null,
      })
    );
    await expect(getModuleCount(buf, medianRails)).rejects.toThrow(
      /imageDimensions must include positive imageWidth and imageHeight/
    );
  });

  test('default OFF — populated_area path runs when CCU_STAGE2_GROUPS unset', async () => {
    delete process.env.CCU_STAGE2_GROUPS;
    const buf = await makeFakeJpeg();
    // Legacy populated_area schema — should be parsed by the old path.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 820,
        main_switch_width: 80,
        module_count_direct: 17,
      })
    );

    const result = await getModuleCount(buf, medianRails);
    // Legacy path doesn't set railBbox — that's the fingerprint of which path ran.
    expect(result.railBbox).toBeUndefined();
    expect(result.geometricCount).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// extractCcuGeometric (orchestrator)
// ---------------------------------------------------------------------------

describe('extractCcuGeometric', () => {
  // Helper: build a Stage 3 VLM response array for N slots.
  const stage3Response = (slotIndices) =>
    fakeVlmResponse(
      slotIndices.map((i) => ({
        slot_index: i,
        classification: i === 0 ? 'main_switch' : 'mcb',
        manufacturer: 'Hager',
        model: null,
        ratingAmps: 32,
        poles: i === 0 ? 2 : 1,
        confidence: 0.9,
      }))
    );

  test('returns combined stage1 + stage2 + stage3 result with stageOutputs', async () => {
    const buf = await makeFakeJpeg();

    // 3 rail samples, then 1 module-count sample, then N/BATCH Stage 3 batches.
    // Count = 4 → 1 batch of 4.
    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 410, rail_bottom: 610, rail_left: 110, rail_right: 910 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 420, rail_bottom: 620, rail_left: 120, rail_right: 920 })
      )
      // main_switch_width=400 on 0-1000 → moduleWidth=200 → count=round(800/200)=4
      .mockResolvedValueOnce(
        fakeVlmResponse({
          main_switch_center_x: 1000, // outside rail bbox — no clamp
          main_switch_width: 400,
          module_count_direct: 4,
        })
      )
      .mockResolvedValueOnce(stage3Response([0, 1, 2, 3]));

    const result = await extractCcuGeometric(buf);

    expect(result.schemaVersion).toBe('ccu-geometric-v1');
    expect(result.medianRails).toEqual({
      rail_top: 410,
      rail_bottom: 610,
      rail_left: 110,
      rail_right: 910,
    });
    expect(result.moduleCount).toBe(4);
    expect(result.vlmCount).toBe(4);
    expect(result.disagreement).toBe(false);
    expect(result.lowConfidence).toBe(false);
    expect(result.slotCentersX).toHaveLength(4);
    expect(result.stageOutputs.stage1.rails).toHaveLength(3);
    expect(result.stageOutputs.stage2.geometricCount).toBe(4);
    expect(result.stageOutputs.stage3.batchCount).toBe(1);
    expect(result.stageOutputs.stage3.batchSize).toBe(4);
    expect(result.stage3Error).toBeNull();
    expect(result.slots).toHaveLength(4);
    expect(result.slots[0].classification).toBe('main_switch');
    expect(result.slots[1].classification).toBe('mcb');
    expect(result.slots[0].crop.bbox).toEqual(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })
    );
    expect(typeof result.slots[0].crop.base64).toBe('string');
    expect(result.slots[0].crop.base64.length).toBeGreaterThan(10);
    expect(result.timings.stage3Ms).toBeGreaterThanOrEqual(0);
  });

  test('propagates stage 1 errors without running stage 2 or stage 3', async () => {
    const buf = await makeFakeJpeg();
    mockCreate.mockRejectedValueOnce(new Error('VLM boom'));
    // If stage 1 throws we should not reach stage 2.
    await expect(extractCcuGeometric(buf)).rejects.toThrow(/VLM boom/);
  });

  test('soft-fails on Stage 3 error: slots=null, stage3Error set, stage1/2 preserved', async () => {
    const buf = await makeFakeJpeg();

    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 410, rail_bottom: 610, rail_left: 110, rail_right: 910 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 420, rail_bottom: 620, rail_left: 120, rail_right: 920 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          main_switch_center_x: 1000, // outside rail bbox — no clamp
          main_switch_width: 400,
          module_count_direct: 4,
        })
      )
      // Stage 3 batch returns non-array garbage to trigger soft-fail.
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'not valid json at all' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

    const result = await extractCcuGeometric(buf);

    // Stage 1/2 output preserved.
    expect(result.moduleCount).toBe(4);
    expect(result.vlmCount).toBe(4);
    expect(result.slotCentersX).toHaveLength(4);
    // Stage 3 soft-failed.
    expect(result.slots).toBeNull();
    expect(result.stage3Error).toEqual(expect.stringMatching(/classifySlots/));
  });
});

// ---------------------------------------------------------------------------
// cropSlot (Phase C)
// ---------------------------------------------------------------------------

describe('cropSlot', () => {
  const baseGeom = {
    slotCentersX: [120, 160, 200, 240, 280],
    moduleWidth: 40,
    railTop: 400,
    railBottom: 600,
    imageWidth: 1000,
    imageHeight: 800,
  };

  test('returns a buffer and a pixel bbox for a middle slot', async () => {
    const buf = await makeFakeJpeg(1000, 800);
    const result = await cropSlot(buf, 2, baseGeom);

    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.length).toBeGreaterThan(100);
    // moduleWidth=40 on 0-1000; halfWidthNorm = 40*0.5*2.2 = 44
    // centerX=200 → leftNorm=156 → xPx=round(156)=156
    expect(result.bbox.x).toBe(156);
    expect(result.bbox.w).toBeGreaterThan(0);
    expect(result.bbox.h).toBeGreaterThan(0);
    // Image metadata check — cropped JPEG should actually be readable.
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  });

  test('clamps bbox to image bounds on the left edge', async () => {
    const buf = await makeFakeJpeg(1000, 800);
    // Slot 0 is at centre=10 (very left edge)
    const geom = { ...baseGeom, slotCentersX: [10, 50, 90], moduleWidth: 40 };
    const result = await cropSlot(buf, 0, geom);
    // leftNorm = 10 - 44 = -34 → clamped to 0 → xPx=0
    expect(result.bbox.x).toBe(0);
    expect(result.bbox.w).toBeGreaterThan(0);
  });

  test('clamps bbox to image bounds on the right edge', async () => {
    const buf = await makeFakeJpeg(1000, 800);
    // Slot at centre=990 (very right edge)
    const geom = { ...baseGeom, slotCentersX: [950, 970, 990], moduleWidth: 40 };
    const result = await cropSlot(buf, 2, geom);
    // rightNorm = 990+44 = 1034 → clamped to 1000 → rightPx=1000
    expect(result.bbox.x + result.bbox.w).toBeLessThanOrEqual(1000);
  });

  test('handles a single-slot board without error', async () => {
    const buf = await makeFakeJpeg(1000, 800);
    const geom = { ...baseGeom, slotCentersX: [500], moduleWidth: 400 };
    const result = await cropSlot(buf, 0, geom);
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.bbox.w).toBeGreaterThan(0);
  });

  test('throws on out-of-range slotIndex', async () => {
    const buf = await makeFakeJpeg();
    await expect(cropSlot(buf, 10, baseGeom)).rejects.toThrow(/out of range/);
    await expect(cropSlot(buf, -1, baseGeom)).rejects.toThrow(/out of range/);
  });

  test('throws on missing or invalid geometry fields', async () => {
    const buf = await makeFakeJpeg();
    await expect(cropSlot(buf, 0, { ...baseGeom, slotCentersX: [] })).rejects.toThrow(/non-empty/);
    await expect(cropSlot(buf, 0, { ...baseGeom, moduleWidth: 0 })).rejects.toThrow(/moduleWidth/);
    await expect(cropSlot(buf, 0, { ...baseGeom, railTop: 600, railBottom: 400 })).rejects.toThrow(
      /railTop/
    );
  });
});

// ---------------------------------------------------------------------------
// classifySlots (Phase C)
// ---------------------------------------------------------------------------

describe('classifySlots', () => {
  // Create N fake crops (tiny valid JPEGs).
  async function makeSlotCrops(n, widthPx = 40) {
    const crops = [];
    for (let i = 0; i < n; i++) {
      const buffer = await sharp({
        create: {
          width: widthPx,
          height: 80,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .jpeg()
        .toBuffer();
      crops.push({
        slotIndex: i,
        buffer,
        bbox: { x: i * widthPx, y: 400, w: widthPx, h: 200 },
      });
    }
    return crops;
  }

  test('batches 4 crops per Anthropic message (batchSize = 4)', async () => {
    const buf = await makeFakeJpeg();
    const slotCrops = await makeSlotCrops(4);

    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse([
        { slot_index: 0, classification: 'main_switch', poles: 2, confidence: 0.9 },
        { slot_index: 1, classification: 'mcb', ratingAmps: 32, poles: 1, confidence: 0.85 },
        { slot_index: 2, classification: 'mcb', ratingAmps: 16, poles: 1, confidence: 0.8 },
        { slot_index: 3, classification: 'rcbo', ratingAmps: 32, poles: 1, confidence: 0.75 },
      ])
    );

    const result = await classifySlots(buf, slotCrops);

    expect(result.batchCount).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Inspect message content — should have 4 image blocks + 1 text block.
    const callArgs = mockCreate.mock.calls[0][0];
    const content = callArgs.messages[0].content;
    const imageBlocks = content.filter((b) => b.type === 'image');
    const textBlocks = content.filter((b) => b.type === 'text');
    expect(imageBlocks).toHaveLength(4);
    expect(textBlocks).toHaveLength(1);

    expect(result.slots).toHaveLength(4);
    expect(result.slots[0].classification).toBe('main_switch');
    expect(result.slots[3].classification).toBe('rcbo');
    // Every slot should include crop bbox and base64.
    for (const s of result.slots) {
      expect(s.crop.bbox).toBeDefined();
      expect(typeof s.crop.base64).toBe('string');
    }
  });

  test('splits > BATCH_SIZE crops into multiple messages', async () => {
    const buf = await makeFakeJpeg();
    const slotCrops = await makeSlotCrops(6); // batchSize=4 → 2 batches (4 + 2)

    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse([
          { slot_index: 0, classification: 'main_switch', poles: 2, confidence: 0.9 },
          { slot_index: 1, classification: 'mcb', ratingAmps: 32, poles: 1, confidence: 0.8 },
          { slot_index: 2, classification: 'mcb', ratingAmps: 16, poles: 1, confidence: 0.8 },
          { slot_index: 3, classification: 'mcb', ratingAmps: 6, poles: 1, confidence: 0.8 },
        ])
      )
      .mockResolvedValueOnce(
        fakeVlmResponse([
          { slot_index: 4, classification: 'rcbo', ratingAmps: 32, poles: 1, confidence: 0.85 },
          { slot_index: 5, classification: 'blank', poles: 1, confidence: 0.95 },
        ])
      );

    const result = await classifySlots(buf, slotCrops);

    expect(result.batchCount).toBe(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    // First batch should have 4 image blocks; second should have 2.
    expect(
      mockCreate.mock.calls[0][0].messages[0].content.filter((b) => b.type === 'image')
    ).toHaveLength(4);
    expect(
      mockCreate.mock.calls[1][0].messages[0].content.filter((b) => b.type === 'image')
    ).toHaveLength(2);

    expect(result.slots).toHaveLength(6);
    expect(result.slots[5].classification).toBe('blank');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  test('matches VLM responses by slot_index even when returned out of order', async () => {
    const buf = await makeFakeJpeg();
    const slotCrops = await makeSlotCrops(4);

    // Intentionally reverse the response order.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse([
        { slot_index: 3, classification: 'rcbo', poles: 1, confidence: 0.7 },
        { slot_index: 2, classification: 'mcb', poles: 1, confidence: 0.8 },
        { slot_index: 1, classification: 'mcb', poles: 1, confidence: 0.9 },
        { slot_index: 0, classification: 'main_switch', poles: 2, confidence: 0.95 },
      ])
    );

    const result = await classifySlots(buf, slotCrops);

    expect(result.slots[0].classification).toBe('main_switch');
    expect(result.slots[1].classification).toBe('mcb');
    expect(result.slots[2].classification).toBe('mcb');
    expect(result.slots[3].classification).toBe('rcbo');
  });

  test('parses fenced ```json array response', async () => {
    const buf = await makeFakeJpeg();
    const slotCrops = await makeSlotCrops(2);

    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: 'Sure!\n```json\n[{"slot_index":0,"classification":"mcb","poles":1,"confidence":0.9},{"slot_index":1,"classification":"blank","poles":1,"confidence":0.9}]\n```',
        },
      ],
      usage: { input_tokens: 50, output_tokens: 20 },
    });

    const result = await classifySlots(buf, slotCrops);
    expect(result.slots).toHaveLength(2);
    expect(result.slots[0].classification).toBe('mcb');
    expect(result.slots[1].classification).toBe('blank');
  });

  test('throws when VLM returns non-array JSON', async () => {
    const buf = await makeFakeJpeg();
    const slotCrops = await makeSlotCrops(2);

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"not":"an array"}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await expect(classifySlots(buf, slotCrops)).rejects.toThrow(/classifySlots/);
  });

  test('returns empty result when slotCrops is empty (no VLM calls)', async () => {
    const buf = await makeFakeJpeg();
    const result = await classifySlots(buf, []);
    expect(result.slots).toEqual([]);
    expect(result.batchCount).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('fills in defaults when VLM omits optional fields', async () => {
    const buf = await makeFakeJpeg();
    const slotCrops = await makeSlotCrops(1);

    mockCreate.mockResolvedValueOnce(fakeVlmResponse([{ slot_index: 0, classification: 'mcb' }]));

    const result = await classifySlots(buf, slotCrops);
    expect(result.slots[0].classification).toBe('mcb');
    expect(result.slots[0].manufacturer).toBeNull();
    expect(result.slots[0].model).toBeNull();
    expect(result.slots[0].ratingAmps).toBeNull();
    expect(result.slots[0].poles).toBeNull();
    expect(result.slots[0].tripCurve).toBeNull();
    expect(result.slots[0].sensitivity).toBeNull();
    expect(result.slots[0].rcdWaveformType).toBeNull();
    expect(result.slots[0].bsEn).toBeNull();
    expect(result.slots[0].confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// prepareModernGeometry + classifyModernSlots (Stage 3 / Stage 4 parallelism split)
// ---------------------------------------------------------------------------

describe('prepareModernGeometry', () => {
  test('returns Stage 1 + Stage 2 output shape (no Stage 3)', async () => {
    const buf = await makeFakeJpeg();

    // 3 rail samples + 1 module-count sample, then STOP — prepare must not
    // advance to Stage 3.
    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 410, rail_bottom: 610, rail_left: 110, rail_right: 910 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 420, rail_bottom: 620, rail_left: 120, rail_right: 920 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          main_switch_center_x: 1000, // outside rail bbox — no clamp
          main_switch_width: 400,
          module_count_direct: 4,
        })
      );

    const prepared = await prepareModernGeometry(buf);

    expect(prepared.medianRails).toEqual({
      rail_top: 410,
      rail_bottom: 610,
      rail_left: 110,
      rail_right: 910,
    });
    expect(prepared.moduleCount).toBe(4);
    expect(prepared.vlmCount).toBe(4);
    expect(prepared.disagreement).toBe(false);
    expect(prepared.slotCentersX).toHaveLength(4);
    expect(prepared.moduleWidth).toBe(200);
    expect(prepared.imageWidth).toBeGreaterThan(0);
    expect(prepared.stageOutputs.stage1).toBeDefined();
    expect(prepared.stageOutputs.stage2).toBeDefined();
    expect(prepared.stageOutputs.stage3).toBeUndefined();
    expect(prepared.timings.stage1Ms).toBeGreaterThanOrEqual(0);
    expect(prepared.timings.stage2Ms).toBeGreaterThanOrEqual(0);
    expect(prepared.usage.inputTokens).toBeGreaterThan(0);
    // Used exactly 4 VLM calls (no Stage 3 yet).
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });

  test('propagates Stage 1 failures (no Stage 2)', async () => {
    const buf = await makeFakeJpeg();
    mockCreate.mockRejectedValueOnce(new Error('VLM boom'));
    await expect(prepareModernGeometry(buf)).rejects.toThrow(/VLM boom/);
  });

  test('railRoiHint option: bypasses Stage 1 VLM entirely, uses ROI as medianRails', async () => {
    const buf = await makeFakeJpeg();
    // Only Stage 2 VLM call should fire — no rail-detection samples.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 1000,
        main_switch_width: 400,
        module_count_direct: 4,
      })
    );

    const prepared = await prepareModernGeometry(buf, {
      railRoiHint: { x: 0.05, y: 0.4, w: 0.9, h: 0.2 },
    });

    // medianRails converted from ROI: 0-1 → 0-1000 scale.
    expect(prepared.medianRails).toEqual({
      rail_top: 400,
      rail_bottom: 600,
      rail_left: 50,
      rail_right: 950,
    });
    expect(prepared.stage1Source).toBe('roi-hint');
    // Exactly ONE VLM call happened (Stage 2 module count), not 4 (Stage 1 × 3 + Stage 2).
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Stage 1 contribution to usage is zero.
    expect(prepared.stageOutputs.stage1.usage.inputTokens).toBe(0);
    expect(prepared.stageOutputs.stage1.usage.outputTokens).toBe(0);
    // Stage 1 never trips lowConfidence on ROI path (user framed it).
    expect(prepared.stageOutputs.stage1.lowConfidence).toBe(false);
  });

  test('railRoiHint accepts x_min/y_min/x_max/y_max form too', async () => {
    const buf = await makeFakeJpeg();
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 1000,
        main_switch_width: 400,
        module_count_direct: 4,
      })
    );

    const prepared = await prepareModernGeometry(buf, {
      railRoiHint: { x_min: 0.1, y_min: 0.3, x_max: 0.9, y_max: 0.7 },
    });

    expect(prepared.medianRails).toEqual({
      rail_top: 300,
      rail_bottom: 700,
      rail_left: 100,
      rail_right: 900,
    });
    expect(prepared.stage1Source).toBe('roi-hint');
  });

  test('railRoiHint clamps out-of-range values to [0, 1]', async () => {
    const buf = await makeFakeJpeg();
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 1000,
        main_switch_width: 400,
        module_count_direct: 4,
      })
    );

    const prepared = await prepareModernGeometry(buf, {
      railRoiHint: { x: -0.1, y: 0.4, w: 1.5, h: 0.2 }, // x<0 and x+w>1 both clamp
    });

    expect(prepared.medianRails.rail_left).toBe(0);
    expect(prepared.medianRails.rail_right).toBe(1000);
  });

  test('railRoiHint with collapsed/invalid area throws', async () => {
    const buf = await makeFakeJpeg();
    // Stage 1 ROI path throws BEFORE any Stage 2 VLM call, so no mock needed.
    await expect(
      prepareModernGeometry(buf, { railRoiHint: { x: 0.5, y: 0.5, w: 0, h: 0 } })
    ).rejects.toThrow(/zero area/);
  });

  test('no railRoiHint → behaves identically to before (Stage 1 × 3 + Stage 2 × 1)', async () => {
    const buf = await makeFakeJpeg();
    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          main_switch_center_x: 1000,
          main_switch_width: 400,
          module_count_direct: 4,
        })
      );

    const prepared = await prepareModernGeometry(buf);
    expect(prepared.stage1Source).toBe('vlm');
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });
});

describe('classifyModernSlots', () => {
  async function buildPreparedGeometry() {
    const buf = await makeFakeJpeg();
    mockCreate
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 410, rail_bottom: 610, rail_left: 110, rail_right: 910 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 420, rail_bottom: 620, rail_left: 120, rail_right: 920 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          main_switch_center_x: 1000, // outside rail bbox — no clamp
          main_switch_width: 400,
          module_count_direct: 4,
        })
      );
    const prepared = await prepareModernGeometry(buf);
    return { buf, prepared };
  }

  test('returns Stage 3 output given prepared geometry', async () => {
    const { buf, prepared } = await buildPreparedGeometry();

    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse([
        { slot_index: 0, classification: 'main_switch', poles: 2, confidence: 0.9 },
        { slot_index: 1, classification: 'mcb', ratingAmps: 32, poles: 1, confidence: 0.85 },
        { slot_index: 2, classification: 'mcb', ratingAmps: 16, poles: 1, confidence: 0.8 },
        { slot_index: 3, classification: 'rcbo', ratingAmps: 32, poles: 1, confidence: 0.75 },
      ])
    );

    const classified = await classifyModernSlots(buf, prepared);

    expect(classified.slots).toHaveLength(4);
    expect(classified.slots[0].classification).toBe('main_switch');
    expect(classified.slots[3].classification).toBe('rcbo');
    expect(classified.stage3Error).toBeNull();
    expect(classified.timings.stage3Ms).toBeGreaterThanOrEqual(0);
    expect(classified.usage.inputTokens).toBeGreaterThan(0);
    expect(classified.stageOutputs.stage3.batchCount).toBe(1);
    expect(classified.stageOutputs.stage3.batchSize).toBe(4);
  });

  test('soft-fails when Stage 3 VLM returns garbage', async () => {
    const { buf, prepared } = await buildPreparedGeometry();

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not valid json' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const classified = await classifyModernSlots(buf, prepared);

    expect(classified.slots).toBeNull();
    expect(classified.stage3Error).toEqual(expect.stringMatching(/classifySlots/));
  });

  test('throws when preparedGeom is invalid', async () => {
    const buf = await makeFakeJpeg();
    await expect(classifyModernSlots(buf, null)).rejects.toThrow(/slotCentersX/);
    await expect(classifyModernSlots(buf, {})).rejects.toThrow(/slotCentersX/);
  });
});

describe('prepare + classify → extractCcuGeometric equivalence', () => {
  // Lock behaviour of the split: calling prepare then classify must produce
  // the same observable slot outputs + geometry + schemaVersion as calling
  // the wrapper orchestrator. Guards against accidental drift between the
  // two paths.
  test('wrapper output equals prepare → classify composition for the same inputs', async () => {
    const buf = await makeFakeJpeg();

    // Deterministic response sequence — use identical samples across both runs.
    // We run the wrapper first (consumes 5 VLM calls), then prepare+classify.
    mockCreate
      // Wrapper run — 3 rail + 1 count + 1 stage3 batch
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          main_switch_center_x: 1000, // outside rail bbox — no clamp
          main_switch_width: 400,
          module_count_direct: 4,
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse([
          { slot_index: 0, classification: 'main_switch', poles: 2, confidence: 0.9 },
          { slot_index: 1, classification: 'mcb', ratingAmps: 32, poles: 1, confidence: 0.85 },
          { slot_index: 2, classification: 'mcb', ratingAmps: 16, poles: 1, confidence: 0.85 },
          { slot_index: 3, classification: 'blank', poles: 1, confidence: 0.95 },
        ])
      )
      // prepare+classify run — identical samples
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({ rail_top: 400, rail_bottom: 600, rail_left: 100, rail_right: 900 })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse({
          main_switch_center_x: 1000, // outside rail bbox — no clamp
          main_switch_width: 400,
          module_count_direct: 4,
        })
      )
      .mockResolvedValueOnce(
        fakeVlmResponse([
          { slot_index: 0, classification: 'main_switch', poles: 2, confidence: 0.9 },
          { slot_index: 1, classification: 'mcb', ratingAmps: 32, poles: 1, confidence: 0.85 },
          { slot_index: 2, classification: 'mcb', ratingAmps: 16, poles: 1, confidence: 0.85 },
          { slot_index: 3, classification: 'blank', poles: 1, confidence: 0.95 },
        ])
      );

    const wrapperResult = await extractCcuGeometric(buf);
    const prepared = await prepareModernGeometry(buf);
    const classified = await classifyModernSlots(buf, prepared);

    expect(wrapperResult.schemaVersion).toBe('ccu-geometric-v1');
    expect(wrapperResult.slots).toHaveLength(4);
    expect(classified.slots).toHaveLength(4);
    // Slot CLASSIFICATIONS must match — proves the split is behaviour-equivalent.
    for (let i = 0; i < 4; i++) {
      expect(classified.slots[i].classification).toBe(wrapperResult.slots[i].classification);
      expect(classified.slots[i].ratingAmps ?? null).toBe(
        wrapperResult.slots[i].ratingAmps ?? null
      );
    }
    expect(prepared.moduleCount).toBe(wrapperResult.moduleCount);
    expect(prepared.slotCentersX).toEqual(wrapperResult.slotCentersX);
  });
});
