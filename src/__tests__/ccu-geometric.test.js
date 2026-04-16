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

beforeAll(async () => {
  const mod = await import('../extraction/ccu-geometric.js');
  getRailGeometry = mod.getRailGeometry;
  getModuleCount = mod.getModuleCount;
  extractCcuGeometric = mod.extractCcuGeometric;
  cropSlot = mod.cropSlot;
  classifySlots = mod.classifySlots;
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

  test('geometricCount = round(rail_width / (main_switch_width/2))', async () => {
    const buf = await makeFakeJpeg();

    // rail_width = 800; main_switch_width=80 → module_width=40 → count=20
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 140,
        main_switch_width: 80,
        module_count_direct: 20,
      })
    );

    const result = await getModuleCount(buf, medianRails);
    expect(result.geometricCount).toBe(20);
    expect(result.vlmCount).toBe(20);
    expect(result.disagreement).toBe(false);
    expect(result.slotCentersX).toHaveLength(20);
    // First slot centre: rail_left + moduleWidth*0.5 = 100 + 20 = 120
    expect(result.slotCentersX[0]).toBeCloseTo(120);
    // Last slot centre: rail_left + moduleWidth*(count - 0.5) = 100 + 40*19.5 = 880
    expect(result.slotCentersX[19]).toBeCloseTo(880);
    expect(result.moduleWidth).toBe(40);
  });

  test('disagreement=true when |geometric - vlm| >= 1', async () => {
    const buf = await makeFakeJpeg();
    // Geometric = 20 but VLM insists it's 18.
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 140,
        main_switch_width: 80,
        module_count_direct: 18,
      })
    );

    const result = await getModuleCount(buf, medianRails);
    expect(result.geometricCount).toBe(20);
    expect(result.vlmCount).toBe(18);
    expect(result.disagreement).toBe(true);
  });

  test('rounds non-integer geometric counts', async () => {
    const buf = await makeFakeJpeg();
    // rail_width = 800; main_switch_width=70 → module_width=35 → 800/35 = 22.857 → 23
    mockCreate.mockResolvedValueOnce(
      fakeVlmResponse({
        main_switch_center_x: 150,
        main_switch_width: 70,
        module_count_direct: 23,
      })
    );

    const result = await getModuleCount(buf, medianRails);
    expect(result.geometricCount).toBe(23);
    expect(result.disagreement).toBe(false);
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
          main_switch_center_x: 310,
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
          main_switch_center_x: 310,
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
    // moduleWidth=40 on 0-1000; halfWidthNorm = 40*0.5*1.2 = 24
    // centerX=200 → leftNorm=176 → xPx=round(176)=176
    expect(result.bbox.x).toBe(176);
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
    // leftNorm = 10 - 24 = -14 → clamped to 0 → xPx=0
    expect(result.bbox.x).toBe(0);
    expect(result.bbox.w).toBeGreaterThan(0);
  });

  test('clamps bbox to image bounds on the right edge', async () => {
    const buf = await makeFakeJpeg(1000, 800);
    // Slot at centre=990 (very right edge)
    const geom = { ...baseGeom, slotCentersX: [950, 970, 990], moduleWidth: 40 };
    const result = await cropSlot(buf, 2, geom);
    // rightNorm = 990+24 = 1014 → clamped to 1000 → rightPx=1000
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
    expect(result.slots[0].poles).toBe(1);
    expect(result.slots[0].confidence).toBe(0);
  });
});
