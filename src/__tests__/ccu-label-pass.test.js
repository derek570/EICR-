/**
 * Unit tests for src/extraction/ccu-label-pass.js (Stage 4 per-slot label reader).
 *
 * Mirrors src/__tests__/ccu-geometric.test.js style — Jest ESM + jest.fn() mocks
 * passed directly to helpers via opts.anthropicClient. Real image buffer from
 * /tmp/ccu-today/wylex-rewireable.jpg is NOT used here; cropping is covered by
 * small synthetic JPEG buffers produced by sharp directly.
 */

import { jest } from '@jest/globals';
import sharp from 'sharp';
import {
  normaliseLabel,
  cropSlotLabelZone,
  readSlotLabels,
  extractSlotLabels,
  LABEL_MAP,
} from '../extraction/ccu-label-pass.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeJpeg(width = 1000, height = 600) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function makeGeom(overrides = {}) {
  return {
    slotCentersX: [100, 300, 500, 700, 900],
    slotPitchPx: 200,
    panelTopNorm: 400,
    panelBottomNorm: 600,
    imageWidth: 1000,
    imageHeight: 1000,
    ...overrides,
  };
}

function mockAnthropic(responses) {
  // responses can be a single response or an array of responses consumed in order.
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const client = {
    messages: {
      create: jest.fn().mockImplementation(() => {
        if (queue.length === 0) {
          throw new Error('mockAnthropic: no more queued responses');
        }
        return queue.shift();
      }),
    },
  };
  return client;
}

function textResponse(text, inputTokens = 120, outputTokens = 60) {
  return Promise.resolve({
    content: [{ type: 'text', text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
}

// ---------------------------------------------------------------------------
// normaliseLabel
// ---------------------------------------------------------------------------

describe('normaliseLabel', () => {
  test('returns null for null / empty / "null" string', () => {
    expect(normaliseLabel(null)).toBeNull();
    expect(normaliseLabel('')).toBeNull();
    expect(normaliseLabel('   ')).toBeNull();
    expect(normaliseLabel('null')).toBeNull();
    expect(normaliseLabel('NULL')).toBeNull();
  });

  test('maps known shorthand to canonical EICR labels', () => {
    expect(normaliseLabel('Imm')).toBe('Water Heater');
    expect(normaliseLabel('Immersion')).toBe('Water Heater');
    expect(normaliseLabel('Immersion Heater')).toBe('Water Heater');
    expect(normaliseLabel('Ckr')).toBe('Cooker');
    expect(normaliseLabel('Shwr')).toBe('Shower');
    expect(normaliseLabel('Smokes')).toBe('Smoke Alarm');
    expect(normaliseLabel('S/D')).toBe('Smoke Alarm');
    expect(normaliseLabel('F/F')).toBe('Fridge Freezer');
    expect(normaliseLabel('CH')).toBe('Central Heating');
    expect(normaliseLabel('UFH')).toBe('Underfloor Heating');
    expect(normaliseLabel('W/M')).toBe('Washing Machine');
    expect(normaliseLabel('T/D')).toBe('Tumble Dryer');
    expect(normaliseLabel('EV')).toBe('Electric Vehicle');
  });

  test('Skt prefix expansion preserves location', () => {
    expect(normaliseLabel('Skt kitchen')).toBe('Kitchen Sockets');
    expect(normaliseLabel('Skt Upstairs')).toBe('Upstairs Sockets');
    expect(normaliseLabel('Skts')).toBe('Sockets');
  });

  test('title-cases all-upper or all-lower input', () => {
    expect(normaliseLabel('KITCHEN SOCKETS')).toBe('Kitchen Sockets');
    expect(normaliseLabel('kitchen sockets')).toBe('Kitchen Sockets');
  });

  test('preserves mixed-case input exactly', () => {
    expect(normaliseLabel('Kitchen Sockets')).toBe('Kitchen Sockets');
    expect(normaliseLabel('FF in garage')).toBe('FF in garage');
  });

  test('LABEL_MAP export is iterable and non-empty', () => {
    expect(Array.isArray(LABEL_MAP)).toBe(true);
    expect(LABEL_MAP.length).toBeGreaterThan(10);
    expect(LABEL_MAP.every((e) => e.pattern instanceof RegExp)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cropSlotLabelZone
// ---------------------------------------------------------------------------

describe('cropSlotLabelZone', () => {
  test('returns a buffer + bbox for a middle slot', async () => {
    const img = await makeJpeg(1000, 1000);
    const { buffer, bbox } = await cropSlotLabelZone(img, 2, makeGeom());
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    expect(bbox.w).toBeGreaterThan(0);
    expect(bbox.h).toBeGreaterThan(0);
    // Slot 2 centre is 500; halfWidth = pitch * 0.6 = 120 → x: 380..620
    expect(bbox.x).toBe(380);
    expect(bbox.x + bbox.w).toBeLessThanOrEqual(1000);
  });

  test('vertical extent widens symmetrically to reach flap above OR below rail (±600%)', async () => {
    const geom = makeGeom({
      panelTopNorm: 400,
      panelBottomNorm: 600, // panel height 200 norm → 400px on a 2000-tall image
      imageHeight: 2000,
    });
    const bigImg = await makeJpeg(1000, 2000);
    const { bbox } = await cropSlotLabelZone(bigImg, 2, geom);
    // Panel in pixel coords: top=400*2000/1000=800, bottom=1200, height=400.
    // top = 800 - 6.0*400 = -1600 → clamp to 0.
    // bottom = 1200 + 6.0*400 = 3600 → clamp to 2000.
    expect(bbox.y).toBe(0);
    expect(bbox.y + bbox.h).toBe(2000);
  });

  test('clamps bbox to image bounds when slot near left edge', async () => {
    const img = await makeJpeg(1000, 1000);
    const geom = makeGeom({ slotCentersX: [50, 300, 500, 700, 900] });
    const { bbox } = await cropSlotLabelZone(img, 0, geom);
    // slot 0 centre is 50, half-width = pitch * 0.6 = 120 → x would be -70 → clamped to 0
    expect(bbox.x).toBe(0);
    expect(bbox.x + bbox.w).toBeLessThanOrEqual(1000);
  });

  test('clamps bbox vertically when panel top near image top', async () => {
    const img = await makeJpeg(1000, 1000);
    const geom = makeGeom({
      panelTopNorm: 100,
      panelBottomNorm: 300,
      imageHeight: 1000,
    });
    const { bbox } = await cropSlotLabelZone(img, 2, geom);
    // up = 100 - 6.0*200 = -1100 → clamped to 0
    expect(bbox.y).toBe(0);
    expect(bbox.y + bbox.h).toBeLessThanOrEqual(1000);
  });

  test('throws on invalid inputs', async () => {
    const img = await makeJpeg(1000, 1000);
    await expect(cropSlotLabelZone('not-a-buffer', 0, makeGeom())).rejects.toThrow(
      /imageBuffer must be a Buffer/
    );
    await expect(cropSlotLabelZone(img, 99, makeGeom())).rejects.toThrow(/slotIndex 99/);
    await expect(cropSlotLabelZone(img, 0, makeGeom({ slotCentersX: [] }))).rejects.toThrow(
      /slotCentersX must be a non-empty array/
    );
    await expect(cropSlotLabelZone(img, 0, makeGeom({ slotPitchPx: 0 }))).rejects.toThrow(
      /slotPitchPx must be a positive number/
    );
    await expect(
      cropSlotLabelZone(img, 0, makeGeom({ panelTopNorm: 500, panelBottomNorm: 400 }))
    ).rejects.toThrow(/panelTopNorm\/panelBottomNorm invalid/);
  });
});

// ---------------------------------------------------------------------------
// readSlotLabels
// ---------------------------------------------------------------------------

describe('readSlotLabels', () => {
  test('batches 4 crops per VLM message', async () => {
    const anthropic = mockAnthropic([
      textResponse(
        JSON.stringify([
          { slot_index: 0, label: 'Lights', confidence: 0.9 },
          { slot_index: 1, label: 'Sockets', confidence: 0.8 },
          { slot_index: 2, label: 'Cooker', confidence: 0.85 },
          { slot_index: 3, label: 'Shower', confidence: 0.9 },
        ])
      ),
      textResponse(
        JSON.stringify([
          { slot_index: 4, label: 'Immersion', confidence: 0.7 },
          { slot_index: 5, label: null, confidence: 0.2 },
        ])
      ),
    ]);

    const slotCrops = Array.from({ length: 6 }, (_, i) => ({
      slotIndex: i,
      buffer: Buffer.from([0xff, 0xd8, 0xff]), // minimal JPEG header bytes
      bbox: { x: 0, y: 0, w: 100, h: 100 },
    }));

    const { labels, batchCount, usage } = await readSlotLabels(slotCrops, {
      anthropicClient: anthropic,
      model: 'test-model',
    });

    expect(batchCount).toBe(2);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(2);
    expect(labels).toHaveLength(6);
    expect(labels[0].label).toBe('Lights');
    expect(labels[4].label).toBe('Water Heater'); // normalised from "Immersion"
    expect(labels[5].label).toBeNull();
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  test('normalises labels through normaliseLabel (Imm → Water Heater, Ckr → Cooker, Skt Kitchen → Kitchen Sockets)', async () => {
    const anthropic = mockAnthropic(
      textResponse(
        JSON.stringify([
          { slot_index: 0, label: 'Imm', confidence: 0.85 },
          { slot_index: 1, label: 'Ckr', confidence: 0.9 },
          { slot_index: 2, label: 'Skt Kitchen', confidence: 0.9 },
        ])
      )
    );

    const slotCrops = Array.from({ length: 3 }, (_, i) => ({
      slotIndex: i,
      buffer: Buffer.from([0xff]),
      bbox: { x: 0, y: 0, w: 100, h: 100 },
    }));

    const { labels } = await readSlotLabels(slotCrops, { anthropicClient: anthropic });

    expect(labels[0].label).toBe('Water Heater');
    expect(labels[0].rawLabel).toBe('Imm');
    expect(labels[1].label).toBe('Cooker');
    expect(labels[2].label).toBe('Kitchen Sockets');
  });

  test('matches VLM responses by slot_index even when returned out of order', async () => {
    const anthropic = mockAnthropic(
      textResponse(
        JSON.stringify([
          { slot_index: 2, label: 'Cooker', confidence: 0.9 },
          { slot_index: 0, label: 'Lights', confidence: 0.9 },
          { slot_index: 1, label: 'Sockets', confidence: 0.9 },
        ])
      )
    );

    const slotCrops = Array.from({ length: 3 }, (_, i) => ({
      slotIndex: i,
      buffer: Buffer.from([0xff]),
      bbox: { x: 0, y: 0, w: 100, h: 100 },
    }));

    const { labels } = await readSlotLabels(slotCrops, { anthropicClient: anthropic });

    // Output preserves input-order (slotIndex 0, 1, 2) but pulls each from the
    // out-of-order VLM reply by slot_index match.
    expect(labels[0].label).toBe('Lights');
    expect(labels[1].label).toBe('Sockets');
    expect(labels[2].label).toBe('Cooker');
  });

  test('parses fenced ```json array response', async () => {
    const anthropic = mockAnthropic(
      textResponse('```json\n[{"slot_index":0,"label":"Lights","confidence":0.9}]\n```')
    );

    const slotCrops = [
      { slotIndex: 0, buffer: Buffer.from([0xff]), bbox: { x: 0, y: 0, w: 10, h: 10 } },
    ];
    const { labels } = await readSlotLabels(slotCrops, { anthropicClient: anthropic });
    expect(labels[0].label).toBe('Lights');
  });

  test('throws when VLM returns non-array JSON', async () => {
    const anthropic = mockAnthropic(textResponse('{"not":"an array"}'));
    const slotCrops = [
      { slotIndex: 0, buffer: Buffer.from([0xff]), bbox: { x: 0, y: 0, w: 10, h: 10 } },
    ];
    await expect(readSlotLabels(slotCrops, { anthropicClient: anthropic })).rejects.toThrow(
      /failed to parse VLM array response/
    );
  });

  test('returns empty result when slotCrops is empty (no VLM calls)', async () => {
    const anthropic = mockAnthropic([]);
    const { labels, batchCount, usage } = await readSlotLabels([], {
      anthropicClient: anthropic,
    });
    expect(labels).toEqual([]);
    expect(batchCount).toBe(0);
    expect(usage.inputTokens).toBe(0);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  test('fills in nulls + confidence 0 when VLM omits items for some slots', async () => {
    const anthropic = mockAnthropic(
      textResponse(
        // Only returns 1 of 2 slots — other slot should get default null label
        JSON.stringify([{ slot_index: 0, label: 'Lights', confidence: 0.9 }])
      )
    );

    const slotCrops = [
      { slotIndex: 0, buffer: Buffer.from([0xff]), bbox: { x: 0, y: 0, w: 10, h: 10 } },
      { slotIndex: 1, buffer: Buffer.from([0xff]), bbox: { x: 10, y: 0, w: 10, h: 10 } },
    ];

    const { labels } = await readSlotLabels(slotCrops, { anthropicClient: anthropic });

    expect(labels).toHaveLength(2);
    expect(labels[0].label).toBe('Lights');
    // Slot 1 got VLM entry at position 1 (there is none) → falls back to null
    // — verifies the positional fallback yields a sensible empty entry, not a
    // crash. Actually the impl uses `|| arr[i]` which would pick position 1
    // (undefined), so label ends up null.
    expect(labels[1].label).toBeNull();
    expect(labels[1].confidence).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Confidence gating
  // ---------------------------------------------------------------------------

  test('confidence gating: label with confidence=0.9 passes through unchanged', async () => {
    const anthropic = mockAnthropic(
      textResponse(JSON.stringify([{ slot_index: 0, label: 'Sockets', confidence: 0.9 }]))
    );
    const slotCrops = [
      { slotIndex: 0, buffer: Buffer.from([0xff]), bbox: { x: 0, y: 0, w: 10, h: 10 } },
    ];
    const { labels } = await readSlotLabels(slotCrops, { anthropicClient: anthropic });
    expect(labels[0].label).toBe('Sockets');
    expect(labels[0].rawLabel).toBe('Sockets');
    expect(labels[0].confidence).toBe(0.9);
  });

  test('confidence gating: label with confidence=0.3 is nulled out but rawLabel is preserved', async () => {
    const anthropic = mockAnthropic(
      textResponse(JSON.stringify([{ slot_index: 0, label: 'Sockets', confidence: 0.3 }]))
    );
    const slotCrops = [
      { slotIndex: 0, buffer: Buffer.from([0xff]), bbox: { x: 0, y: 0, w: 10, h: 10 } },
    ];
    const { labels } = await readSlotLabels(slotCrops, { anthropicClient: anthropic });
    expect(labels[0].label).toBeNull();
    expect(labels[0].rawLabel).toBe('Sockets');
    expect(labels[0].confidence).toBe(0.3);
  });

  test('confidence gating: label at exactly the threshold (0.5) is kept (>= semantics)', async () => {
    const anthropic = mockAnthropic(
      textResponse(JSON.stringify([{ slot_index: 0, label: 'Lights', confidence: 0.5 }]))
    );
    const slotCrops = [
      { slotIndex: 0, buffer: Buffer.from([0xff]), bbox: { x: 0, y: 0, w: 10, h: 10 } },
    ];
    const { labels } = await readSlotLabels(slotCrops, { anthropicClient: anthropic });
    expect(labels[0].label).toBe('Lights');
    expect(labels[0].confidence).toBe(0.5);
  });

  test('confidence gating: opts.labelConfidenceMin=0.8 overrides default; 0.6-confidence label is nulled', async () => {
    const anthropic = mockAnthropic(
      textResponse(JSON.stringify([{ slot_index: 0, label: 'Cooker', confidence: 0.6 }]))
    );
    const slotCrops = [
      { slotIndex: 0, buffer: Buffer.from([0xff]), bbox: { x: 0, y: 0, w: 10, h: 10 } },
    ];
    const { labels } = await readSlotLabels(slotCrops, {
      anthropicClient: anthropic,
      labelConfidenceMin: 0.8,
    });
    expect(labels[0].label).toBeNull();
    expect(labels[0].rawLabel).toBe('Cooker');
    expect(labels[0].confidence).toBe(0.6);
  });

  test('confidence gating: process.env.CCU_LABEL_CONFIDENCE_MIN overrides default 0.5', async () => {
    // 0.65-confidence label: passes with default (0.5) but should be nulled with env threshold (0.7)
    const anthropic = mockAnthropic(
      textResponse(JSON.stringify([{ slot_index: 0, label: 'Shower', confidence: 0.65 }]))
    );
    const slotCrops = [
      { slotIndex: 0, buffer: Buffer.from([0xff]), bbox: { x: 0, y: 0, w: 10, h: 10 } },
    ];

    process.env.CCU_LABEL_CONFIDENCE_MIN = '0.7';
    let labels;
    try {
      ({ labels } = await readSlotLabels(slotCrops, { anthropicClient: anthropic }));
    } finally {
      delete process.env.CCU_LABEL_CONFIDENCE_MIN;
    }

    expect(labels[0].label).toBeNull();
    expect(labels[0].rawLabel).toBe('Shower');
    expect(labels[0].confidence).toBe(0.65);
  });
});

// ---------------------------------------------------------------------------
// extractSlotLabels (orchestrator)
// ---------------------------------------------------------------------------

describe('extractSlotLabels', () => {
  test('skips slots with classification main_switch / spd / blank', async () => {
    const img = await makeJpeg(1000, 1000);
    const anthropic = mockAnthropic(
      textResponse(
        JSON.stringify([
          { slot_index: 0, label: 'Lights', confidence: 0.9 },
          { slot_index: 2, label: 'Sockets', confidence: 0.9 },
        ])
      )
    );

    const result = await extractSlotLabels(
      img,
      {
        ...makeGeom({ slotCentersX: [100, 300, 500, 700] }),
        slotsForSkipHint: [
          { slotIndex: 0, classification: 'mcb' },
          { slotIndex: 1, classification: 'main_switch' },
          { slotIndex: 2, classification: 'rcbo' },
          { slotIndex: 3, classification: 'blank' },
        ],
      },
      { anthropicClient: anthropic }
    );

    expect(result.skippedSlotIndices).toEqual([1, 3]);
    expect(result.labels).toHaveLength(2); // only slots 0 and 2
    expect(result.labels[0].slotIndex).toBe(0);
    expect(result.labels[1].slotIndex).toBe(2);
  });

  test('returns empty labels array + timings when every slot is skipped', async () => {
    const img = await makeJpeg(1000, 1000);
    const anthropic = mockAnthropic([]);

    const result = await extractSlotLabels(
      img,
      {
        ...makeGeom({ slotCentersX: [100, 300] }),
        slotsForSkipHint: [
          { slotIndex: 0, classification: 'blank' },
          { slotIndex: 1, classification: 'main_switch' },
        ],
      },
      { anthropicClient: anthropic }
    );

    expect(result.labels).toEqual([]);
    expect(result.batchCount).toBe(0);
    expect(result.skippedSlotIndices).toEqual([0, 1]);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  test('reads every slot when no skip hints provided', async () => {
    const img = await makeJpeg(1000, 1000);
    const anthropic = mockAnthropic(
      textResponse(
        JSON.stringify([
          { slot_index: 0, label: 'A', confidence: 0.9 },
          { slot_index: 1, label: 'B', confidence: 0.9 },
          { slot_index: 2, label: 'C', confidence: 0.9 },
        ])
      )
    );

    const result = await extractSlotLabels(img, makeGeom({ slotCentersX: [100, 300, 500] }), {
      anthropicClient: anthropic,
    });

    expect(result.skippedSlotIndices).toEqual([]);
    expect(result.labels).toHaveLength(3);
  });

  test('propagates readSlotLabels errors (caller soft-fails)', async () => {
    const img = await makeJpeg(1000, 1000);
    const anthropic = mockAnthropic(textResponse('not json'));
    const geom = {
      ...makeGeom({ slotCentersX: [100, 300] }),
      slotsForSkipHint: [
        { slotIndex: 0, classification: 'mcb' },
        { slotIndex: 1, classification: 'mcb' },
      ],
    };
    await expect(extractSlotLabels(img, geom, { anthropicClient: anthropic })).rejects.toThrow(
      /failed to parse VLM array response/
    );
  });
});
