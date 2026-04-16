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

beforeAll(async () => {
  const mod = await import('../extraction/ccu-geometric.js');
  getRailGeometry = mod.getRailGeometry;
  getModuleCount = mod.getModuleCount;
  extractCcuGeometric = mod.extractCcuGeometric;
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
  test('returns combined stage1 + stage2 result with stageOutputs', async () => {
    const buf = await makeFakeJpeg();

    // 3 rail samples, then 1 module-count sample.
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
          main_switch_center_x: 160,
          main_switch_width: 80,
          module_count_direct: 20,
        })
      );

    const result = await extractCcuGeometric(buf);

    expect(result.schemaVersion).toBe('ccu-geometric-v1');
    expect(result.medianRails).toEqual({
      rail_top: 410,
      rail_bottom: 610,
      rail_left: 110,
      rail_right: 910,
    });
    expect(result.moduleCount).toBe(20);
    expect(result.vlmCount).toBe(20);
    expect(result.disagreement).toBe(false);
    expect(result.lowConfidence).toBe(false);
    expect(result.slotCentersX).toHaveLength(20);
    expect(result.stageOutputs.stage1.rails).toHaveLength(3);
    expect(result.stageOutputs.stage2.geometricCount).toBe(20);
    expect(result.usage.inputTokens).toBe(400);
    expect(result.usage.outputTokens).toBe(160);
    expect(result.timings.stage1Ms).toBeGreaterThanOrEqual(0);
    expect(result.timings.stage2Ms).toBeGreaterThanOrEqual(0);
  });

  test('propagates stage 1 errors without running stage 2', async () => {
    const buf = await makeFakeJpeg();
    mockCreate.mockRejectedValueOnce(new Error('VLM boom'));
    // If stage 1 throws we should not reach stage 2.
    await expect(extractCcuGeometric(buf)).rejects.toThrow(/VLM boom/);
  });
});
