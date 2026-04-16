/**
 * CCU Geometric Extraction (Phase B)
 *
 * Two-stage VLM pipeline for Consumer Control Unit photo analysis:
 *   Stage 1 (getRailGeometry): Rail bbox on 0-1000 grid, median of 3 samples with SD check.
 *   Stage 2 (getModuleCount): Main switch pixel width → module pitch → rail-width-based count,
 *                             plus a direct VLM count for disagreement detection.
 *
 * Throws on missing ANTHROPIC_API_KEY or VLM failure. No fallbacks here — the caller decides.
 *
 * See: docs/plans/2026-04-16-ccu-geometric-extraction-design.md §2.1, §2.2, §5
 */

import sharp from 'sharp';

const CCU_GEOMETRIC_MODEL = (process.env.CCU_GEOMETRIC_MODEL || 'claude-sonnet-4-6').trim();
const CCU_GEOMETRIC_MAX_TOKENS = 1024;
const CCU_GEOMETRIC_TIMEOUT_MS = Number(process.env.CCU_GEOMETRIC_TIMEOUT_MS || 60_000);

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const RAIL_PROMPTS = [
  // Variation 1 — straightforward
  `Look at this consumer unit (fuseboard) photo. Identify the DIN rail — the metal rail that the circuit breakers clip onto.
Return the bounding box of the DIN rail only (NOT the whole enclosure, NOT the cover, NOT the labels — only the rail itself where modules clip on).
Coordinates are normalised 0-1000, with (0,0) at top-left of the image.
Return ONLY JSON: {"rail_top": number, "rail_bottom": number, "rail_left": number, "rail_right": number}`,

  // Variation 2 — emphasise module alignment
  `Examine this electrical consumer unit photograph. Find the horizontal row of breakers and isolators.
They all clip onto a DIN rail — locate that rail's outer edges.
- rail_top: vertical coordinate of the rail's upper edge
- rail_bottom: vertical coordinate of the rail's lower edge
- rail_left: horizontal coordinate of the leftmost point of the rail occupied by modules
- rail_right: horizontal coordinate of the rightmost point of the rail occupied by modules
All four values are on a 0 to 1000 scale (top-left origin).
Respond with JSON only: {"rail_top":..., "rail_bottom":..., "rail_left":..., "rail_right":...}`,

  // Variation 3 — emphasise precision
  `This is a UK consumer unit. Identify the DIN rail region — the strip where MCBs, RCBOs, the main switch, SPD etc. are mounted.
Return the tightest bounding box around that rail region (do not include the enclosure, cover, stickers, or wiring above/below).
Normalise to 0-1000 (top-left origin). Output strictly:
{"rail_top": <int>, "rail_bottom": <int>, "rail_left": <int>, "rail_right": <int>}`,
];

const MODULE_COUNT_PROMPT = (
  rails
) => `This is a UK consumer unit. The DIN rail bounding box on a 0-1000 scale is:
- rail_top: ${rails.rail_top}
- rail_bottom: ${rails.rail_bottom}
- rail_left: ${rails.rail_left}
- rail_right: ${rails.rail_right}

Find the MAIN SWITCH on this board. It is typically the largest device on the rail — two modules wide (~36mm in reality). It has no test button and no sensitivity marking ("30mA" etc.). It is NOT an RCD.

Report:
1. The x-coordinate of the main switch's CENTRE on the 0-1000 scale (main_switch_center_x).
2. The TOTAL width of the main switch on the 0-1000 scale (main_switch_width).
3. A direct count of how many module positions fit on the rail between rail_left and rail_right (module_count_direct). A module is an 18mm-wide slot — a single MCB is 1 module, an RCBO or RCD or main switch is 2 modules, blanks count as 1 module each.

Respond with JSON only:
{"main_switch_center_x": <int>, "main_switch_width": <int>, "module_count_direct": <int>}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJson(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('VLM returned empty response');
  }
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else {
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }
  }
  return JSON.parse(jsonStr);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(variance);
}

async function getAnthropicClient() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  return new Anthropic({ apiKey: anthropicKey });
}

async function callVlm(anthropic, base64, prompt) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), CCU_GEOMETRIC_TIMEOUT_MS);
  let response;
  try {
    response = await anthropic.messages.create(
      {
        model: CCU_GEOMETRIC_MODEL,
        max_tokens: CCU_GEOMETRIC_MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      },
      { signal: abortController.signal }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const textBlocks = (response.content || []).filter((b) => b.type === 'text');
  const text = textBlocks.map((b) => b.text).join('');
  const usage = response.usage || {};
  return {
    text,
    parsed: extractJson(text),
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
  };
}

// ---------------------------------------------------------------------------
// Stage 1 — Rail geometry (median of 3)
// ---------------------------------------------------------------------------

/**
 * Stage 1: Extract DIN rail bounding box.
 *
 * Runs 3 VLM samples with wording variations, takes the median per-coordinate,
 * flags low confidence if per-coordinate SD > 5% of image width.
 *
 * @param {Buffer} imageBuffer  Raw JPEG bytes.
 * @returns {Promise<{rails: Array<object>, medianRails: object, sdPct: object, lowConfidence: boolean, usage: object}>}
 * @throws if ANTHROPIC_API_KEY missing or any VLM call fails.
 */
export async function getRailGeometry(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error('getRailGeometry: imageBuffer must be a Buffer');
  }

  const anthropic = await getAnthropicClient();
  const base64 = imageBuffer.toString('base64');

  // Image metadata (for SD-as-percentage).
  const meta = await sharp(imageBuffer).metadata();
  const imageWidth = meta.width || 1000;

  // Run 3 samples in parallel.
  const samples = await Promise.all(RAIL_PROMPTS.map((p) => callVlm(anthropic, base64, p)));

  const rails = samples.map((s) => {
    const { rail_top, rail_bottom, rail_left, rail_right } = s.parsed;
    if (
      typeof rail_top !== 'number' ||
      typeof rail_bottom !== 'number' ||
      typeof rail_left !== 'number' ||
      typeof rail_right !== 'number'
    ) {
      throw new Error('getRailGeometry: VLM response missing required rail_* numeric fields');
    }
    return { rail_top, rail_bottom, rail_left, rail_right };
  });

  const medianRails = {
    rail_top: median(rails.map((r) => r.rail_top)),
    rail_bottom: median(rails.map((r) => r.rail_bottom)),
    rail_left: median(rails.map((r) => r.rail_left)),
    rail_right: median(rails.map((r) => r.rail_right)),
  };

  // SD on 0-1000 normalised scale.
  const sd = {
    rail_top: standardDeviation(rails.map((r) => r.rail_top)),
    rail_bottom: standardDeviation(rails.map((r) => r.rail_bottom)),
    rail_left: standardDeviation(rails.map((r) => r.rail_left)),
    rail_right: standardDeviation(rails.map((r) => r.rail_right)),
  };

  // SD as % of image width. The VLM coords are 0-1000 so SD is already on that scale;
  // "percent of image width" is SD / 1000 * 100 regardless of actual pixel width, because
  // both numerator and denominator are in the same normalised space. We keep imageWidth
  // on the output for downstream pixel conversion.
  const sdPct = {
    rail_top: (sd.rail_top / 1000) * 100,
    rail_bottom: (sd.rail_bottom / 1000) * 100,
    rail_left: (sd.rail_left / 1000) * 100,
    rail_right: (sd.rail_right / 1000) * 100,
  };

  const SD_THRESHOLD_PCT = 5;
  const lowConfidence = Object.values(sdPct).some((v) => v > SD_THRESHOLD_PCT);

  const usage = samples.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + s.inputTokens,
      outputTokens: acc.outputTokens + s.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 }
  );

  return {
    rails,
    medianRails,
    sdPct,
    lowConfidence,
    imageWidth,
    imageHeight: meta.height || 0,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Stage 2 — Module count (geometric vs direct VLM)
// ---------------------------------------------------------------------------

/**
 * Stage 2: Derive module count from main switch pitch + directly from VLM.
 *
 * The main switch is always 2 modules wide on UK CCUs, so:
 *   module_width = main_switch_width / 2
 *   module_count = round(rail_width / module_width)
 * We also ask the VLM directly for a count, and flag disagreement if |geo - vlm| >= 1.
 *
 * @param {Buffer} imageBuffer
 * @param {{rail_top:number, rail_bottom:number, rail_left:number, rail_right:number}} medianRails
 * @returns {Promise<{geometricCount:number, vlmCount:number, slotCentersX:number[], disagreement:boolean, mainSwitchCenterX:number, mainSwitchWidth:number, usage:object}>}
 * @throws if ANTHROPIC_API_KEY missing or VLM call fails.
 */
export async function getModuleCount(imageBuffer, medianRails) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error('getModuleCount: imageBuffer must be a Buffer');
  }
  if (
    !medianRails ||
    typeof medianRails.rail_left !== 'number' ||
    typeof medianRails.rail_right !== 'number'
  ) {
    throw new Error('getModuleCount: medianRails must include numeric rail_left and rail_right');
  }

  const anthropic = await getAnthropicClient();
  const base64 = imageBuffer.toString('base64');

  const sample = await callVlm(anthropic, base64, MODULE_COUNT_PROMPT(medianRails));
  const { main_switch_center_x, main_switch_width, module_count_direct } = sample.parsed;

  if (typeof main_switch_width !== 'number' || main_switch_width <= 0) {
    throw new Error('getModuleCount: VLM returned invalid main_switch_width');
  }
  if (typeof module_count_direct !== 'number') {
    throw new Error('getModuleCount: VLM returned invalid module_count_direct');
  }

  const railWidth = medianRails.rail_right - medianRails.rail_left;
  if (railWidth <= 0) {
    throw new Error('getModuleCount: rail_right must be greater than rail_left');
  }

  const moduleWidth = main_switch_width / 2; // main switch is always 2 modules wide
  const geometricCount = Math.round(railWidth / moduleWidth);

  const slotCentersX = [];
  for (let i = 0; i < geometricCount; i++) {
    slotCentersX.push(medianRails.rail_left + moduleWidth * (i + 0.5));
  }

  const vlmCount = Math.round(module_count_direct);
  const disagreement = Math.abs(geometricCount - vlmCount) >= 1;

  return {
    geometricCount,
    vlmCount,
    slotCentersX,
    disagreement,
    mainSwitchCenterX: typeof main_switch_center_x === 'number' ? main_switch_center_x : null,
    mainSwitchWidth: main_switch_width,
    moduleWidth,
    usage: {
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full two-stage geometric extraction pipeline.
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<object>} Combined result with stage1, stage2 and top-level convenience fields.
 * @throws on any VLM failure or missing key (no fallback — caller decides).
 */
export async function extractCcuGeometric(imageBuffer) {
  const t0 = Date.now();
  const stage1 = await getRailGeometry(imageBuffer);
  const stage1Ms = Date.now() - t0;

  const t1 = Date.now();
  const stage2 = await getModuleCount(imageBuffer, stage1.medianRails);
  const stage2Ms = Date.now() - t1;

  const totalUsage = {
    inputTokens: stage1.usage.inputTokens + stage2.usage.inputTokens,
    outputTokens: stage1.usage.outputTokens + stage2.usage.outputTokens,
  };

  return {
    schemaVersion: 'ccu-geometric-v1',
    medianRails: stage1.medianRails,
    moduleCount: stage2.geometricCount,
    vlmCount: stage2.vlmCount,
    slotCentersX: stage2.slotCentersX,
    moduleWidth: stage2.moduleWidth,
    mainSwitchCenterX: stage2.mainSwitchCenterX,
    mainSwitchWidth: stage2.mainSwitchWidth,
    lowConfidence: stage1.lowConfidence,
    disagreement: stage2.disagreement,
    imageWidth: stage1.imageWidth,
    imageHeight: stage1.imageHeight,
    timings: { stage1Ms, stage2Ms, totalMs: stage1Ms + stage2Ms },
    usage: totalUsage,
    stageOutputs: {
      stage1: {
        rails: stage1.rails,
        medianRails: stage1.medianRails,
        sdPct: stage1.sdPct,
        lowConfidence: stage1.lowConfidence,
        usage: stage1.usage,
      },
      stage2: {
        geometricCount: stage2.geometricCount,
        vlmCount: stage2.vlmCount,
        slotCentersX: stage2.slotCentersX,
        mainSwitchCenterX: stage2.mainSwitchCenterX,
        mainSwitchWidth: stage2.mainSwitchWidth,
        moduleWidth: stage2.moduleWidth,
        disagreement: stage2.disagreement,
        usage: stage2.usage,
      },
    },
  };
}
