/**
 * CCU Geometric Extraction — Rewireable Fuse Board variant
 *
 * Three-stage VLM pipeline for UK rewireable (bakelite) consumer units — BS 3036
 * pull-out fuse carriers on a flat panel. Parallels `ccu-geometric.js` which targets
 * modern DIN-rail boards; same outer return shape so the two pipelines are drop-in
 * comparable from the caller's perspective.
 *
 *   Stage 1 (getPanelGeometry): carrier-bank (panel) bbox on 0-1000 grid + main
 *                               switch side. Median of 5 samples with SD check.
 *   Stage 2 (getCarrierCount):  carrier count + main-switch-edge offset. Equal-pitch
 *                               slot centre X coords derived from panel bounds,
 *                               excluding the main-switch slot if it sits at a band edge.
 *                               Sanity-checks the VLM count against panel width
 *                               (expected pitch 30–90 px); on out-of-range counts
 *                               a retry call is made with a strengthened recount
 *                               prompt and the retry value wins.
 *   Stage 3 (classifyCarriers): per-slot crop-and-zoom classification, batched 4 crops
 *                               per VLM call. Body-colour → rating lookup applied
 *                               locally (Wylex white=5A, blue=15A, yellow=20A,
 *                               red=30A, green=45A) when VLM does not return a rating.
 *
 * Stages 1/2 throw on missing ANTHROPIC_API_KEY or VLM failure. Stage 3 is soft-fail:
 * any error is captured on `stage3Error` and `slots` is null, so Stage 1/2 output
 * is still returned so the caller can render geometry even with no classifications.
 *
 * See: .planning/ccu-per-slot-sprint.md (2026-04-22) — Stream 1 (rewireable pipeline).
 */

import sharp from 'sharp';

const CCU_REWIREABLE_MODEL = (
  process.env.CCU_REWIREABLE_MODEL ||
  process.env.CCU_GEOMETRIC_MODEL ||
  process.env.CCU_MODEL ||
  'claude-sonnet-4-6'
).trim();
const CCU_REWIREABLE_MAX_TOKENS = 1024;
// Stage 3 needs a bigger envelope — batched classification responses.
const CCU_REWIREABLE_STAGE3_MAX_TOKENS = 2048;
const CCU_REWIREABLE_TIMEOUT_MS = Number(process.env.CCU_GEOMETRIC_TIMEOUT_MS || 60_000);
// 4 crops/message matches the modern pipeline (best accuracy/cost tradeoff at ~18mm
// modules, and rewireable carriers are roughly the same visual scale). Keep identical
// for cost-comparison parity between the two pipelines.
const CCU_REWIREABLE_STAGE3_BATCH_SIZE = 4;

// Body colour → rated amps per BS 3036 / Wylex colour code. White=5A blue=15A
// yellow=20A red=30A green=45A. Used locally by Stage 3 when the VLM returns
// a colour but no rating (or a colour-vs-rating mismatch we want to normalise).
const BODY_COLOUR_TO_AMPS = Object.freeze({
  white: 5,
  blue: 15,
  yellow: 20,
  red: 30,
  green: 45,
});

// Stage 3 confidence floor — below this, we flag overall lowConfidence regardless
// of Stage 1 SD health. Chosen to match the modern pipeline's Stage-4 gap-fill
// threshold (0.7) but a notch lower because rewireable classification is a simpler
// classifier (3 classes + 5 colours) than MCB reading.
const STAGE3_LOW_CONF_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const PANEL_PROMPTS = [
  // Variation 1 — direct
  `Look at this UK rewireable (bakelite) consumer unit photo. Identify the CARRIER BANK — the row of pull-out fuse carriers on the face of the panel.
This is NOT a DIN rail. These are bakelite / metal / plastic pull-out carriers (BS 3036 style), typically with a red pull-tab at the top of each carrier body. Ignore the metal enclosure, labels, stickers, neutral bar and wiring — return only the rectangle containing the carriers themselves.
Also identify whether there is an adjacent MAIN SWITCH or SWITCH-FUSE that is NOT part of the carrier row. On many Wylex/MEM boards the main switch sits to the LEFT or RIGHT of the carriers; on others it is integrated into the carrier row (same pitch as the carriers).
Coordinates are normalised 0-1000, with (0,0) at top-left of the image.
Return ONLY JSON: {"panel_top": <int>, "panel_bottom": <int>, "panel_left": <int>, "panel_right": <int>, "main_switch_side": "left"|"right"|"none"}
"main_switch_side" = "none" means the main switch is integrated into the carrier row or is not visible.`,

  // Variation 2 — emphasise carrier alignment
  `Examine this UK rewireable fuse board photograph. Find the horizontal row of PULL-OUT FUSE CARRIERS — bakelite or plastic bodies with a red pull-tab, stacked side-by-side on a flat panel.
Locate the tight bounding box around that carrier row ONLY. Exclude the steel enclosure, the neutral bar below, the "main switch" (if separate), and any labels or cable glands.
- panel_top: vertical coordinate of the top edge of the carrier bodies
- panel_bottom: vertical coordinate of the bottom edge of the carrier bodies
- panel_left: horizontal coordinate of the leftmost carrier's outer edge
- panel_right: horizontal coordinate of the rightmost carrier's outer edge
Also report main_switch_side: "left" if a distinct main-switch isolator sits to the left of the carrier row, "right" if to the right, "none" if it is integrated into the row (same pitch) or not present.
All coordinates on a 0 to 1000 scale (top-left origin).
Respond with JSON only: {"panel_top":..., "panel_bottom":..., "panel_left":..., "panel_right":..., "main_switch_side":...}`,

  // Variation 3 — emphasise "not a DIN rail"
  `This is a UK rewireable consumer unit (BS 3036, typically Wylex/MEM/Crabtree/Bill). It has NO DIN rail — the fuse carriers clip into moulded sockets on a flat bakelite panel.
Identify the panel region occupied by the CARRIER BODIES (not a DIN rail). Return the tightest bounding box around just the carriers. Do not include the cover, the steel enclosure, the neutral bar or any label text.
Additionally classify the main switch location:
- "left" = there is a separate main-switch / switch-fuse / isolator positioned to the LEFT of the carrier row.
- "right" = positioned to the RIGHT of the carrier row.
- "none" = the main switch is integrated into the carrier row at the same pitch as the carriers, or it is not visible in the photo.
Normalise to 0-1000 (top-left origin). Output strictly:
{"panel_top": <int>, "panel_bottom": <int>, "panel_left": <int>, "panel_right": <int>, "main_switch_side": "left"|"right"|"none"}`,

  // Variation 4 — emphasise "inner rectangle where carriers sit"
  `You are inspecting a UK rewireable consumer unit. Find the INNER RECTANGLE within the enclosure where the pull-out fuse CARRIERS sit side-by-side.
Think of it as the "socket plate" region — the moulded bakelite or plastic panel with rows of cut-outs into which each carrier slots. Every carrier body (with its red pull-tab) sits inside this rectangle. Everything outside this rectangle — the metal case surround, the cover lip, the neutral / earth bar strips, the incoming cable glands, any printed labels — must be EXCLUDED from the box.
Then determine the position of the main switch relative to the carrier row:
- "left" if a discrete main switch / switch-fuse isolator sits OUTSIDE the carrier row to its left
- "right" if it sits OUTSIDE the carrier row to its right
- "none" if it shares the carrier row at the same pitch OR is not visible
Coordinates are normalised to 0-1000 (origin at top-left). Respond JSON only:
{"panel_top": <int>, "panel_bottom": <int>, "panel_left": <int>, "panel_right": <int>, "main_switch_side": "left"|"right"|"none"}`,

  // Variation 5 — emphasise "ignore the metal enclosure and labels"
  `Given this UK rewireable consumer-unit photograph, locate the bank of pull-out fuse carriers.
IGNORE EVERYTHING ELSE: the steel / metal outer enclosure, any screws, any printed stickers or labels (e.g. circuit schedules, manufacturer badges), the neutral bar, the earth bar, the incoming mains tails, any plastic cover flap. Do NOT include any of those in your bounding box.
Return only the tightest rectangle that hugs the fuse-carrier bodies themselves — from the top of the bodies (or the base of the red pull-tabs if flush) down to the bottom of the bodies, from the outer edge of the leftmost carrier to the outer edge of the rightmost carrier.
Also say where the MAIN SWITCH is:
- "left" = sits to the LEFT of the carriers as a separate unit
- "right" = sits to the RIGHT of the carriers as a separate unit
- "none" = integrated into the carrier row (same pitch) or not visible
All coordinates on 0-1000 scale, top-left origin. JSON only:
{"panel_top": <int>, "panel_bottom": <int>, "panel_left": <int>, "panel_right": <int>, "main_switch_side": "left"|"right"|"none"}`,
];

const CARRIER_COUNT_PROMPT = (
  panel,
  { retryContext = null } = {}
) => `This is a UK rewireable consumer unit. The carrier-bank bounding box on a 0-1000 scale is:
- panel_top: ${panel.panel_top}
- panel_bottom: ${panel.panel_bottom}
- panel_left: ${panel.panel_left}
- panel_right: ${panel.panel_right}

Count how many PULL-OUT FUSE CARRIERS are in this carrier row. Each carrier is a bakelite / plastic body with (usually) a red pull-tab at the top. They are equally spaced across the panel.

Also report whether one of the slots at the LEFT or RIGHT edge of the panel is occupied by a MAIN SWITCH / SWITCH-FUSE (rather than a fuse carrier). This matters because the main switch often shares the carrier pitch at one end of the row.
- "none" = every position in the panel bounding box is a fuse carrier.
- "left-edge" = the LEFTMOST position is the main switch, not a fuse carrier.
- "right-edge" = the RIGHTMOST position is the main switch, not a fuse carrier.

Return the TOTAL number of positions (carriers + any main switch at the edge) as carrier_count. A 6-way board with main switch at the right edge has carrier_count = 7 and main_switch_offset = "right-edge". A 6-way board with a separate main switch below or to the side of the carrier bank has carrier_count = 6 and main_switch_offset = "none".${
  retryContext
    ? `\n\nIMPORTANT RECOUNT: we previously estimated this board has ${retryContext.previousCount} positions, but that value is outside the expected range given the panel width. From the panel geometry we measured the expected number of slots is between ${retryContext.expectedMin} and ${retryContext.expectedMax} (based on a typical rewireable carrier pitch of 30–90 px on a ${retryContext.panelWidthPx}-px-wide panel). Please recount carefully — walk left-to-right across the panel band and count every distinct carrier or main-switch slot separated by a visible gap or join between mouldings. Do NOT just echo the previous count; look again at the image.`
    : ''
}

Respond with JSON only:
{"carrier_count": <int>, "main_switch_offset": "none"|"left-edge"|"right-edge"}`;

// Stage 3 — classify each carrier crop. The VLM must return one object per crop
// in the same order, echoing slot_index for alignment verification.
const CARRIER_CLASSIFY_PROMPT = (
  slotIndices
) => `You are looking at ${slotIndices.length} cropped image${slotIndices.length === 1 ? '' : 's'} from a UK rewireable consumer unit (bakelite fuse board). Each crop is centred on a single pull-out carrier position.

The slot indices, in order of the images you are seeing, are: [${slotIndices.join(', ')}].

For EACH crop, classify the carrier occupying that slot. Valid classifications:
- "rewireable"   — BS 3036 semi-enclosed pull-out fuse carrier. Bakelite / plastic body with fuse wire inside. Virtually all Wylex/MEM/Crabtree/Bill domestic carriers are rewireable.
- "cartridge"    — pull-out carrier containing a cylindrical HBC cartridge (BS 1361 domestic or BS 88-2 commercial). The carrier typically has a rating stamped on its face.
- "blank"        — empty socket with no carrier fitted, or a blank cover plate. No body colour.

For rewireable and cartridge carriers, read:
- bodyColour        — colour of the CARRIER BODY below the red pull-tab. One of "white", "blue", "yellow", "red", "green", "unknown". CRITICAL: EVERY Wylex carrier has a RED PULL-TAB at the top — that red pull-tab is NOT a rating indicator, it is the lift-handle. Look at the BODY of the carrier below the pull-tab. If the body itself appears the same red as the pull-tab, it IS a 30A red carrier — do not flag that as unusual on colour alone.
- ratingAmps        — if cartridge, read the printed rating directly from the cartridge face (5/15/20/30/45/60/80/100). If rewireable, you MAY leave ratingAmps null and we will derive it from bodyColour via the Wylex code: white=5A, blue=15A, yellow=20A, red=30A, green=45A.
- bsEn              — "BS 3036" for rewireable, "BS 1361" for cartridge domestic, "BS 88-2" for cartridge commercial. Null if not printed and you cannot determine from style.
- confidence        — your self-assessed 0.0-1.0 confidence in the classification.

COLOUR DISAMBIGUATION — READ THIS BEFORE YOU COMMIT TO A COLOUR:
These carriers are often 30+ years old, caked with dust, and photographed under tungsten / sodium / fluorescent site lighting that skews colour balance. Two pairs are especially easy to confuse — use these tie-breakers before answering.

- Blue (15A) vs red (30A):
  A faded or dirt-covered BLUE carrier body can photograph with a reddish / magenta cast under warm indoor lighting. If the body is a CLEAR PURE RED that matches the hue of the red pull-tab above it, say "red". If the body has ANY BLUE TINT AT ALL — even a dull, desaturated, grey-blue or slightly violet tint — say "blue". When in doubt between these two, default to "blue": blue is by far the more common rating on domestic rewireable boards (lighting-circuit 15A is historically the most-used carrier).

- White (5A) vs yellow (20A):
  White bakelite yellows with age — a 30-year-old "white" 5A carrier can look cream, ivory, or distinctly yellow-tinted. If the body LACKS any strong yellow / orange / mustard pigment relative to a true yellow (20A) carrier sitting nearby on the same board, say "white". A true yellow carrier will be a saturated, pigmented yellow — not a pale cream. When only one type is present and you cannot comparison-check, default to "white" unless the body is obviously saturated yellow.

REPEATING THE EARLIER WARNING so it stays front of mind: a carrier body that is legitimately the same RED as its pull-tab is a genuine 30A carrier — do NOT second-guess a clearly red body just because it matches the pull-tab hue. The pull-tab rule ("red tab is a handle, not a rating") only cautions against assuming a WHITE/BLUE/YELLOW/GREEN body is red because of the tab.

For blanks: bodyColour, ratingAmps, bsEn may be null. Still return confidence.

Return ONLY a JSON array, one object per crop, in the SAME ORDER as the images you received. Echo back slot_index to prove alignment:
[
  {"slot_index": <int>, "classification": "<string>", "bodyColour": <string|null>, "ratingAmps": <int|null>, "bsEn": <string|null>, "confidence": <float>},
  ...
]`;

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

/**
 * Majority-vote across a set of string labels. Ties broken by first-seen order.
 * @private
 */
function majority(values) {
  const counts = new Map();
  for (const v of values) {
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = values[0];
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

async function getAnthropicClient() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  return new Anthropic({ apiKey: anthropicKey });
}

async function callVlm(anthropic, base64, prompt, opts = {}) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), CCU_REWIREABLE_TIMEOUT_MS);
  let response;
  try {
    response = await anthropic.messages.create(
      {
        model: opts.model || CCU_REWIREABLE_MODEL,
        max_tokens: opts.maxTokens || CCU_REWIREABLE_MAX_TOKENS,
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

/**
 * Convert 0-1000 normalised coordinates to pixel coordinates, clamped to image bounds.
 * @private
 */
function normToPx(value, dimension) {
  const px = (value / 1000) * dimension;
  return Math.max(0, Math.min(dimension, Math.round(px)));
}

// ---------------------------------------------------------------------------
// Stage 1 — Panel geometry (median of 3)
// ---------------------------------------------------------------------------

/**
 * Stage 1: Extract carrier-bank panel bounding box + main switch side.
 *
 * Runs 5 VLM samples with wording variations (bumped from 3 after a field
 * test where three consecutive runs against the same Wylex photo returned
 * carrierCount values of 7, 7, 6 — the extra samples stabilise the median
 * panel bounds that Stage 2 divides by), takes the per-coordinate median,
 * majority-votes main_switch_side, and flags lowConfidence if any SD > 5% of
 * the normalised 0-1000 scale.
 *
 * @param {Buffer} imageBuffer  Raw JPEG bytes.
 * @returns {Promise<{panels: Array<object>, medianPanel: object, mainSwitchSide: 'left'|'right'|'none', sdPct: object, lowConfidence: boolean, usage: object, imageWidth: number, imageHeight: number}>}
 * @throws if ANTHROPIC_API_KEY missing or any VLM call fails.
 */
export async function getPanelGeometry(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error('getPanelGeometry: imageBuffer must be a Buffer');
  }

  const anthropic = await getAnthropicClient();
  const base64 = imageBuffer.toString('base64');

  const meta = await sharp(imageBuffer).metadata();
  const imageWidth = meta.width || 1000;
  const imageHeight = meta.height || 0;

  const samples = await Promise.all(PANEL_PROMPTS.map((p) => callVlm(anthropic, base64, p)));

  const panels = samples.map((s) => {
    const { panel_top, panel_bottom, panel_left, panel_right, main_switch_side } = s.parsed;
    if (
      typeof panel_top !== 'number' ||
      typeof panel_bottom !== 'number' ||
      typeof panel_left !== 'number' ||
      typeof panel_right !== 'number'
    ) {
      throw new Error('getPanelGeometry: VLM response missing required panel_* numeric fields');
    }
    const side =
      main_switch_side === 'left' || main_switch_side === 'right' || main_switch_side === 'none'
        ? main_switch_side
        : 'none';
    return { panel_top, panel_bottom, panel_left, panel_right, main_switch_side: side };
  });

  const medianPanel = {
    panel_top: median(panels.map((p) => p.panel_top)),
    panel_bottom: median(panels.map((p) => p.panel_bottom)),
    panel_left: median(panels.map((p) => p.panel_left)),
    panel_right: median(panels.map((p) => p.panel_right)),
  };

  const mainSwitchSide = majority(panels.map((p) => p.main_switch_side));

  const sd = {
    panel_top: standardDeviation(panels.map((p) => p.panel_top)),
    panel_bottom: standardDeviation(panels.map((p) => p.panel_bottom)),
    panel_left: standardDeviation(panels.map((p) => p.panel_left)),
    panel_right: standardDeviation(panels.map((p) => p.panel_right)),
  };

  // SD as % of normalised 0-1000 scale (same convention as modern pipeline).
  const sdPct = {
    panel_top: (sd.panel_top / 1000) * 100,
    panel_bottom: (sd.panel_bottom / 1000) * 100,
    panel_left: (sd.panel_left / 1000) * 100,
    panel_right: (sd.panel_right / 1000) * 100,
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
    panels,
    medianPanel,
    mainSwitchSide,
    sdPct,
    lowConfidence,
    imageWidth,
    imageHeight,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Stage 2 — Carrier count + slot centres
// ---------------------------------------------------------------------------

/**
 * Compute the expected min/max carrier count from the panel width + image dimensions.
 *
 * Wylex-family rewireable carriers sit on a ~18mm pitch across a ~400mm-wide board,
 * so on a 1000px-wide photo a carrier pitch of ~55px is typical. We allow a 30–90px
 * pitch range (≈ 3x tolerance either side) so that a photo taken close up or far
 * away still passes the sanity check. The resulting count window is:
 *
 *   expectedMin = floor(panelWidthPx / 90)   // fewest slots that fit at wide pitch
 *   expectedMax = ceil(panelWidthPx / 30)    // most slots that fit at tight pitch
 *
 * Any first-pass carrier_count outside this window triggers a Stage-2 retry.
 * @private
 */
function expectedCarrierCountRange(panelWidthPx) {
  return {
    expectedMin: Math.max(1, Math.floor(panelWidthPx / 90)),
    expectedMax: Math.max(1, Math.ceil(panelWidthPx / 30)),
  };
}

function parseCarrierCountSample(sample) {
  const { carrier_count, main_switch_offset } = sample.parsed;
  if (typeof carrier_count !== 'number' || carrier_count <= 0) {
    throw new Error('getCarrierCount: VLM returned invalid carrier_count');
  }
  const offset =
    main_switch_offset === 'left-edge' ||
    main_switch_offset === 'right-edge' ||
    main_switch_offset === 'none'
      ? main_switch_offset
      : 'none';
  return { carrierCount: Math.round(carrier_count), offset };
}

/**
 * Stage 2: Count carriers and compute equal-pitched slot centre X coordinates.
 *
 * Returns slotCentersX in PIXEL coordinate space (so downstream crop code does
 * not have to re-scale). Carrier pitch is also returned in pixels. If the
 * VLM's `main_switch_offset` says the main switch occupies the left or right
 * edge slot, the carrier_count still includes that slot (total positions in
 * the panel band), but we flag it via `mainSwitchSlotIndex` so the caller /
 * Stage 3 can classify that slot as a main switch rather than a carrier.
 *
 * Reliability: after the first VLM call we sanity-check `carrier_count` against
 * the panel width (expected pitch 30–90 px → derived min/max). If the count is
 * outside that window we make a SECOND call with a strengthened prompt asking
 * the VLM to recount. If both counts land in-range we keep the SECOND count
 * (two chances, latest wins) — if the second is still out-of-range we still
 * prefer it over the first, on the reasoning that the retry prompt gave the
 * VLM explicit expected-range context the first call didn't have. The decision
 * is logged so operators can spot recurring retry cases in production.
 *
 * @param {Buffer} imageBuffer
 * @param {{panel_top:number, panel_bottom:number, panel_left:number, panel_right:number}} medianPanel
 * @param {{imageWidth:number, imageHeight:number}} imageDims
 * @returns {Promise<{carrierCount:number, slotCentersX:number[], carrierPitchPx:number, mainSwitchOffset: 'none'|'left-edge'|'right-edge', mainSwitchSlotIndex: number|null, retry: object|null, usage: object}>}
 * @throws if ANTHROPIC_API_KEY missing or VLM call fails or inputs invalid.
 */
export async function getCarrierCount(imageBuffer, medianPanel, imageDims) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error('getCarrierCount: imageBuffer must be a Buffer');
  }
  if (
    !medianPanel ||
    typeof medianPanel.panel_left !== 'number' ||
    typeof medianPanel.panel_right !== 'number'
  ) {
    throw new Error('getCarrierCount: medianPanel must include numeric panel_left and panel_right');
  }
  if (medianPanel.panel_right <= medianPanel.panel_left) {
    throw new Error('getCarrierCount: panel_right must be greater than panel_left');
  }
  if (!imageDims || !Number.isFinite(imageDims.imageWidth) || imageDims.imageWidth <= 0) {
    throw new Error('getCarrierCount: imageDims.imageWidth must be a positive number');
  }

  const anthropic = await getAnthropicClient();
  const base64 = imageBuffer.toString('base64');

  const panelWidthNorm = medianPanel.panel_right - medianPanel.panel_left;
  const panelWidthPx = Math.round((panelWidthNorm / 1000) * imageDims.imageWidth);
  const { expectedMin, expectedMax } = expectedCarrierCountRange(panelWidthPx);

  // First pass.
  const firstSample = await callVlm(anthropic, base64, CARRIER_COUNT_PROMPT(medianPanel));
  const first = parseCarrierCountSample(firstSample);

  const usage = {
    inputTokens: firstSample.inputTokens,
    outputTokens: firstSample.outputTokens,
  };

  let chosenCount = first.carrierCount;
  let chosenOffset = first.offset;
  let retry = null;

  const inRange = (n) => n >= expectedMin && n <= expectedMax;

  if (!inRange(first.carrierCount)) {
    // Second pass — retry with strengthened prompt. If the retry itself throws we
    // propagate (same policy as the first call); we deliberately do NOT swallow a
    // retry failure because it would leave the operator blind to the VLM flakiness
    // the retry exists to catch.
    const secondSample = await callVlm(
      anthropic,
      base64,
      CARRIER_COUNT_PROMPT(medianPanel, {
        retryContext: {
          previousCount: first.carrierCount,
          expectedMin,
          expectedMax,
          panelWidthPx,
        },
      })
    );
    const second = parseCarrierCountSample(secondSample);

    usage.inputTokens += secondSample.inputTokens;
    usage.outputTokens += secondSample.outputTokens;

    // Retry wins — the retry prompt had explicit expected-range context that the
    // first call did not, so even if the second value is also out-of-range it is
    // the better-informed answer. Log the branch so prod ops can audit.
    chosenCount = second.carrierCount;
    chosenOffset = second.offset;
    retry = {
      fired: true,
      firstCount: first.carrierCount,
      secondCount: second.carrierCount,
      expectedMin,
      expectedMax,
      panelWidthPx,
      secondInRange: inRange(second.carrierCount),
    };
    // eslint-disable-next-line no-console
    console.log(
      `[ccu-rewireable] getCarrierCount: retry fired (first=${first.carrierCount} out of range [${expectedMin},${expectedMax}], second=${second.carrierCount}, panelWidthPx=${panelWidthPx})`
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[ccu-rewireable] getCarrierCount: single-pass (count=${first.carrierCount} in range [${expectedMin},${expectedMax}], panelWidthPx=${panelWidthPx})`
    );
  }

  const carrierCount = chosenCount;
  const offset = chosenOffset;

  const pitchNorm = panelWidthNorm / carrierCount;

  // Equal-pitch centre coordinates in 0-1000 normalised space, then converted
  // to pixel coordinates (same scheme as modern pipeline's slotCentersX — keeps
  // downstream crop math identical).
  const slotCentersX = [];
  for (let i = 0; i < carrierCount; i++) {
    const centerNorm = medianPanel.panel_left + pitchNorm * (i + 0.5);
    slotCentersX.push(normToPx(centerNorm, imageDims.imageWidth));
  }

  const carrierPitchPx = (pitchNorm / 1000) * imageDims.imageWidth;

  let mainSwitchSlotIndex = null;
  if (offset === 'left-edge') mainSwitchSlotIndex = 0;
  else if (offset === 'right-edge') mainSwitchSlotIndex = carrierCount - 1;

  return {
    carrierCount,
    slotCentersX,
    carrierPitchPx,
    pitchNorm,
    mainSwitchOffset: offset,
    mainSwitchSlotIndex,
    retry,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Stage 3 — Per-carrier crop + classify
// ---------------------------------------------------------------------------

/**
 * Crop a single carrier slot from the full image.
 *
 * Rewireable carriers are visually larger than DIN modules — the crop is
 * deliberately ~2× the pitch width (so a 20% bleed into each neighbour gives
 * the VLM colour context) and ~1.4× the panel height (so the red pull-tab and
 * the printed face below it are both visible).
 *
 * @param {Buffer} imageBuffer  Full CCU JPEG.
 * @param {number} slotIndex
 * @param {object} geom
 * @param {number[]} geom.slotCentersX   In PIXEL space (already converted in Stage 2).
 * @param {number}   geom.carrierPitchPx Pitch in pixel space.
 * @param {number}   geom.panelTopNorm   0-1000 panel top.
 * @param {number}   geom.panelBottomNorm 0-1000 panel bottom.
 * @param {number}   geom.imageWidth     Full image pixel width.
 * @param {number}   geom.imageHeight    Full image pixel height.
 * @returns {Promise<{buffer: Buffer, bbox: {x:number,y:number,w:number,h:number}}>}
 */
export async function cropCarrierSlot(imageBuffer, slotIndex, geom) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error('cropCarrierSlot: imageBuffer must be a Buffer');
  }
  const { slotCentersX, carrierPitchPx, panelTopNorm, panelBottomNorm, imageWidth, imageHeight } =
    geom || {};
  if (!Array.isArray(slotCentersX) || slotCentersX.length === 0) {
    throw new Error('cropCarrierSlot: geom.slotCentersX must be a non-empty array');
  }
  if (slotIndex < 0 || slotIndex >= slotCentersX.length) {
    throw new Error(
      `cropCarrierSlot: slotIndex ${slotIndex} out of range (0..${slotCentersX.length - 1})`
    );
  }
  if (!Number.isFinite(carrierPitchPx) || carrierPitchPx <= 0) {
    throw new Error('cropCarrierSlot: geom.carrierPitchPx must be a positive number');
  }
  if (
    !Number.isFinite(panelTopNorm) ||
    !Number.isFinite(panelBottomNorm) ||
    panelBottomNorm <= panelTopNorm
  ) {
    throw new Error('cropCarrierSlot: geom.panelTopNorm/panelBottomNorm invalid');
  }
  if (
    !Number.isFinite(imageWidth) ||
    imageWidth <= 0 ||
    !Number.isFinite(imageHeight) ||
    imageHeight <= 0
  ) {
    throw new Error('cropCarrierSlot: geom.imageWidth and imageHeight must be positive');
  }

  const centerXPx = slotCentersX[slotIndex];

  // Crop width ≈ 2× pitch so ~20% of each neighbour is visible for colour context
  // without swamping the target. Height = 1.4× panel height so the red pull-tab
  // (top ~20% of a carrier) AND the printed body/face below it are both in frame.
  const halfWidthPx = carrierPitchPx; // 2 × (pitch/2) = pitch
  const panelTopPx = normToPx(panelTopNorm, imageHeight);
  const panelBottomPx = normToPx(panelBottomNorm, imageHeight);
  const panelHeightPx = panelBottomPx - panelTopPx;
  const panelCenterYPx = (panelTopPx + panelBottomPx) / 2;
  const halfHeightPx = (panelHeightPx / 2) * 1.4;

  const leftPx = Math.max(0, Math.round(centerXPx - halfWidthPx));
  const rightPx = Math.min(imageWidth, Math.round(centerXPx + halfWidthPx));
  const topPx = Math.max(0, Math.round(panelCenterYPx - halfHeightPx));
  const bottomPx = Math.min(imageHeight, Math.round(panelCenterYPx + halfHeightPx));
  const wPx = Math.max(1, rightPx - leftPx);
  const hPx = Math.max(1, bottomPx - topPx);

  const buffer = await sharp(imageBuffer)
    .extract({ left: leftPx, top: topPx, width: wPx, height: hPx })
    // Upscale for VLM legibility. Bumped 1024→1536 after a field test where one
    // of three runs on a Wylex board misread a blue (15A) carrier as red (30A);
    // the extra resolution preserves colour detail on faded BS 3036 bodies where
    // the hue is already borderline under site lighting.
    .resize({ width: 1536, withoutEnlargement: false })
    .jpeg({ quality: 90 })
    .toBuffer();

  return {
    buffer,
    bbox: { x: leftPx, y: topPx, w: wPx, h: hPx },
  };
}

/**
 * Send a batch of carrier-slot crops to the VLM for classification.
 *
 * Mirrors classifySlots() in the modern pipeline: 4 crops per message, parse the
 * JSON array response, match VLM items to crops by echoed slot_index (falling
 * back to positional order if the VLM omits it), and body-colour-to-amps fill-in.
 *
 * @param {Buffer} _imageBuffer  Original full image (unused; kept for signature parity).
 * @param {Array<{slotIndex:number, buffer:Buffer, bbox:object}>} slotCrops
 * @param {{anthropicClient?: object, model?: string}} [opts]
 * @returns {Promise<{slots: Array<object>, usage: {inputTokens:number, outputTokens:number}, batchCount:number}>}
 */
export async function classifyCarriers(_imageBuffer, slotCrops, opts = {}) {
  if (!Array.isArray(slotCrops)) {
    throw new Error('classifyCarriers: slotCrops must be an array');
  }
  if (slotCrops.length === 0) {
    return { slots: [], usage: { inputTokens: 0, outputTokens: 0 }, batchCount: 0 };
  }

  const anthropic = opts.anthropicClient || (await getAnthropicClient());
  const model = opts.model || CCU_REWIREABLE_MODEL;

  const batches = [];
  for (let i = 0; i < slotCrops.length; i += CCU_REWIREABLE_STAGE3_BATCH_SIZE) {
    batches.push(slotCrops.slice(i, i + CCU_REWIREABLE_STAGE3_BATCH_SIZE));
  }

  const resultsBySlotIndex = new Map();
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (const batch of batches) {
    const slotIndices = batch.map((b) => b.slotIndex);
    const base64s = batch.map((b) => b.buffer.toString('base64'));

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), CCU_REWIREABLE_TIMEOUT_MS);
    let response;
    try {
      response = await anthropic.messages.create(
        {
          model,
          max_tokens: CCU_REWIREABLE_STAGE3_MAX_TOKENS,
          messages: [
            {
              role: 'user',
              content: [
                ...base64s.map((data) => ({
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/jpeg', data },
                })),
                { type: 'text', text: CARRIER_CLASSIFY_PROMPT(slotIndices) },
              ],
            },
          ],
        },
        { signal: abortController.signal }
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const text = (response.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    let arr;
    try {
      let jsonStr = text.trim();
      const fence = jsonStr.match(/```json\s*([\s\S]*?)```/);
      if (fence) jsonStr = fence[1].trim();
      const firstBracket = jsonStr.indexOf('[');
      const lastBracket = jsonStr.lastIndexOf(']');
      if (firstBracket !== -1 && lastBracket > firstBracket) {
        jsonStr = jsonStr.slice(firstBracket, lastBracket + 1);
      }
      arr = JSON.parse(jsonStr);
      if (!Array.isArray(arr)) throw new Error('not an array');
    } catch (err) {
      throw new Error(`classifyCarriers: failed to parse VLM array response: ${err.message}`);
    }

    const u = response.usage || {};
    usage.inputTokens += u.input_tokens || 0;
    usage.outputTokens += u.output_tokens || 0;

    for (let i = 0; i < batch.length; i++) {
      const crop = batch[i];
      const vlmItem = arr.find((x) => x && x.slot_index === crop.slotIndex) || arr[i] || {};

      const rawBodyColour =
        typeof vlmItem.bodyColour === 'string' ? vlmItem.bodyColour.toLowerCase() : null;
      const bodyColour =
        rawBodyColour && Object.prototype.hasOwnProperty.call(BODY_COLOUR_TO_AMPS, rawBodyColour)
          ? rawBodyColour
          : rawBodyColour === 'unknown'
            ? 'unknown'
            : rawBodyColour
              ? rawBodyColour
              : null;

      // If VLM returned a recognised body colour but no rating, derive rating from the
      // BS 3036 colour code. VLM-returned ratings win (the VLM may have read a printed
      // number on a cartridge face and we must not overwrite that with colour).
      let ratingAmps =
        typeof vlmItem.ratingAmps === 'number' ? vlmItem.ratingAmps : (vlmItem.ratingAmps ?? null);
      if (ratingAmps == null && bodyColour && BODY_COLOUR_TO_AMPS[bodyColour] != null) {
        ratingAmps = BODY_COLOUR_TO_AMPS[bodyColour];
      }

      resultsBySlotIndex.set(crop.slotIndex, {
        slotIndex: crop.slotIndex,
        bbox: crop.bbox,
        classification: vlmItem.classification || 'unknown',
        bodyColour,
        ratingAmps,
        bsEn: vlmItem.bsEn ?? null,
        confidence: typeof vlmItem.confidence === 'number' ? vlmItem.confidence : 0,
        crop: {
          bbox: crop.bbox,
          base64: crop.buffer.toString('base64'),
        },
      });
    }
  }

  // Preserve input order.
  const slots = slotCrops.map(
    (c) =>
      resultsBySlotIndex.get(c.slotIndex) || {
        slotIndex: c.slotIndex,
        bbox: c.bbox,
        classification: 'unknown',
        bodyColour: null,
        ratingAmps: null,
        bsEn: null,
        confidence: 0,
        crop: { bbox: c.bbox, base64: c.buffer.toString('base64') },
      }
  );

  return { slots, usage, batchCount: batches.length };
}

// ---------------------------------------------------------------------------
// Prepare / Classify split
// ---------------------------------------------------------------------------

/**
 * Prepare the rewireable pipeline geometry — runs Stage 1 (panel bbox) and
 * Stage 2 (carrier count + slot centres) sequentially. Exposed so the route
 * handler can dispatch Stage 3 (`classifyRewireableSlots`) and Stage 4
 * (`extractSlotLabels`) in parallel once geometry is available.
 *
 * Throws on VLM/key failure. Stage 3 soft-fail lives in the classifier half.
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<{
 *   medianPanel: object,
 *   panelBounds: {top:number,bottom:number,left:number,right:number},
 *   mainSwitchSide: 'left'|'right'|'none',
 *   lowConfidence: boolean,
 *   carrierCount: number,
 *   slotCentersX: number[],
 *   carrierPitchPx: number,
 *   mainSwitchOffset: 'none'|'left-edge'|'right-edge',
 *   mainSwitchSlotIndex: number|null,
 *   imageWidth: number,
 *   imageHeight: number,
 *   stageOutputs: { stage1: object, stage2: object },
 *   timings: { stage1Ms: number, stage2Ms: number },
 *   usage: { inputTokens: number, outputTokens: number }
 * }>}
 * @throws on any Stage 1 or Stage 2 VLM failure, or missing ANTHROPIC_API_KEY.
 */
export async function prepareRewireableGeometry(imageBuffer) {
  const t0 = Date.now();
  const stage1 = await getPanelGeometry(imageBuffer);
  const stage1Ms = Date.now() - t0;

  const t1 = Date.now();
  const stage2 = await getCarrierCount(imageBuffer, stage1.medianPanel, {
    imageWidth: stage1.imageWidth,
    imageHeight: stage1.imageHeight,
  });
  const stage2Ms = Date.now() - t1;

  const panelBounds = {
    top: stage1.medianPanel.panel_top,
    bottom: stage1.medianPanel.panel_bottom,
    left: stage1.medianPanel.panel_left,
    right: stage1.medianPanel.panel_right,
  };

  const usage = {
    inputTokens: stage1.usage.inputTokens + stage2.usage.inputTokens,
    outputTokens: stage1.usage.outputTokens + stage2.usage.outputTokens,
  };

  return {
    medianPanel: stage1.medianPanel,
    panelBounds,
    mainSwitchSide: stage1.mainSwitchSide,
    lowConfidence: stage1.lowConfidence,
    carrierCount: stage2.carrierCount,
    slotCentersX: stage2.slotCentersX,
    carrierPitchPx: stage2.carrierPitchPx,
    mainSwitchOffset: stage2.mainSwitchOffset,
    mainSwitchSlotIndex: stage2.mainSwitchSlotIndex,
    imageWidth: stage1.imageWidth,
    imageHeight: stage1.imageHeight,
    stageOutputs: {
      stage1: {
        panels: stage1.panels,
        medianPanel: stage1.medianPanel,
        mainSwitchSide: stage1.mainSwitchSide,
        sdPct: stage1.sdPct,
        lowConfidence: stage1.lowConfidence,
        usage: stage1.usage,
      },
      stage2: {
        carrierCount: stage2.carrierCount,
        slotCentersX: stage2.slotCentersX,
        carrierPitchPx: stage2.carrierPitchPx,
        pitchNorm: stage2.pitchNorm,
        mainSwitchOffset: stage2.mainSwitchOffset,
        mainSwitchSlotIndex: stage2.mainSwitchSlotIndex,
        usage: stage2.usage,
      },
    },
    timings: { stage1Ms, stage2Ms },
    usage,
  };
}

/**
 * Classify rewireable pipeline slots — runs Stage 3 (per-slot crop + VLM
 * classify + body-colour → amps fill-in) given a geometry object from
 * `prepareRewireableGeometry`. Includes the main-switch force-tag step so
 * that an inline main switch at a band edge is correctly excluded from
 * downstream circuit numbering even when Stage 3's classifier enum
 * ({rewireable, cartridge, blank}) cannot reach 'main_switch'.
 *
 * Soft-fail: any Stage 3 error is returned on `stage3Error`, `slots` is null.
 * `lowConfidence` combines Stage 1 SD flag with any per-slot confidence below
 * the STAGE3_LOW_CONF_THRESHOLD floor.
 *
 * @param {Buffer} imageBuffer
 * @param {object} preparedGeom  Output of `prepareRewireableGeometry`.
 * @returns {Promise<{
 *   slots: Array|null,
 *   stage3Error: string|null,
 *   lowConfidence: boolean,
 *   timings: { stage3Ms: number },
 *   usage: { inputTokens: number, outputTokens: number },
 *   stageOutputs: { stage3: object }
 * }>}
 */
export async function classifyRewireableSlots(imageBuffer, preparedGeom) {
  if (!preparedGeom || !Array.isArray(preparedGeom.slotCentersX)) {
    throw new Error('classifyRewireableSlots: preparedGeom.slotCentersX must be an array');
  }

  let slots = null;
  let stage3Error = null;
  let stage3Usage = { inputTokens: 0, outputTokens: 0 };
  let stage3BatchCount = 0;
  const t2 = Date.now();
  try {
    const slotCrops = [];
    for (let i = 0; i < preparedGeom.slotCentersX.length; i++) {
      const crop = await cropCarrierSlot(imageBuffer, i, {
        slotCentersX: preparedGeom.slotCentersX,
        carrierPitchPx: preparedGeom.carrierPitchPx,
        panelTopNorm: preparedGeom.medianPanel.panel_top,
        panelBottomNorm: preparedGeom.medianPanel.panel_bottom,
        imageWidth: preparedGeom.imageWidth,
        imageHeight: preparedGeom.imageHeight,
      });
      slotCrops.push({ slotIndex: i, buffer: crop.buffer, bbox: crop.bbox });
    }

    const classified = await classifyCarriers(imageBuffer, slotCrops);
    slots = classified.slots;
    stage3Usage = classified.usage;
    stage3BatchCount = classified.batchCount;

    // Force-tag the main-switch slot. Stage 3's classifier enum is
    // {rewireable, cartridge, blank} — no main_switch option, so when the main
    // switch sits at a band edge (e.g. pull-out switch-fuse integrated with the
    // carrier row) the VLM usually misreads it as "blank" or "rewireable". We
    // know from Stage 2 which slot it is; override the classification directly.
    // Downstream merger rules `cls === 'main_switch' || cls === 'spd' → skip`
    // then naturally exclude it from circuit numbering.
    if (
      Array.isArray(slots) &&
      typeof preparedGeom.mainSwitchSlotIndex === 'number' &&
      slots[preparedGeom.mainSwitchSlotIndex]
    ) {
      const msSlot = slots[preparedGeom.mainSwitchSlotIndex];
      msSlot.classification = 'main_switch';
      msSlot.bodyColour = null;
      msSlot.ratingAmps = null;
      msSlot.bsEn = null;
    }
  } catch (err) {
    stage3Error = err && err.message ? err.message : String(err);
  }
  const stage3Ms = Date.now() - t2;

  // Stage3 lowConfidence: any classified slot below floor. Stage3 soft-fail
  // does not itself raise this flag — stage3Error is sufficient signal.
  // Stage 1's SD flag is combined by the wrapper / caller.
  const stage3LowConf =
    Array.isArray(slots) &&
    slots.some((s) => typeof s.confidence === 'number' && s.confidence < STAGE3_LOW_CONF_THRESHOLD);

  return {
    slots,
    stage3Error,
    lowConfidence: stage3LowConf,
    timings: { stage3Ms },
    usage: stage3Usage,
    stageOutputs: {
      stage3: {
        slots,
        error: stage3Error,
        batchCount: stage3BatchCount,
        batchSize: CCU_REWIREABLE_STAGE3_BATCH_SIZE,
        usage: stage3Usage,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full three-stage rewireable extraction pipeline.
 *
 * THIN WRAPPER around `prepareRewireableGeometry` + `classifyRewireableSlots`.
 * Kept for backward compatibility — the route handler dispatches the two
 * halves separately so Stage 3 and Stage 4 (label pass) can run in parallel.
 *
 * Returns the same outer shape as `extractCcuGeometric` so the route handler
 * can swap between them on the `board_technology` enum without branching on
 * schema. Stages 1/2 throw on failure. Stage 3 is soft-fail: on any error,
 * `slots` is null and `stage3Error` carries the message — Stage 1/2 output
 * is preserved.
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<object>}
 * @throws on any Stage 1 or Stage 2 VLM failure, or missing ANTHROPIC_API_KEY.
 */
export async function extractCcuRewireable(imageBuffer) {
  const prepared = await prepareRewireableGeometry(imageBuffer);
  const classified = await classifyRewireableSlots(imageBuffer, prepared);

  const totalUsage = {
    inputTokens: prepared.usage.inputTokens + classified.usage.inputTokens,
    outputTokens: prepared.usage.outputTokens + classified.usage.outputTokens,
  };

  // Overall lowConfidence: stage1 SD-triggered OR any classified slot below
  // the stage3 confidence floor (delivered by classifyRewireableSlots).
  const lowConfidence = prepared.stageOutputs.stage1.lowConfidence || classified.lowConfidence;

  return {
    schemaVersion: 'ccu-rewireable-v1',
    panelBounds: prepared.panelBounds,
    carrierCount: prepared.carrierCount,
    slotCentersX: prepared.slotCentersX,
    carrierPitch: prepared.carrierPitchPx,
    mainSwitchSide: prepared.mainSwitchSide,
    mainSwitchOffset: prepared.mainSwitchOffset,
    mainSwitchSlotIndex: prepared.mainSwitchSlotIndex,
    slots: classified.slots,
    lowConfidence,
    stage3Error: classified.stage3Error,
    imageWidth: prepared.imageWidth,
    imageHeight: prepared.imageHeight,
    timings: {
      stage1Ms: prepared.timings.stage1Ms,
      stage2Ms: prepared.timings.stage2Ms,
      stage3Ms: classified.timings.stage3Ms,
      totalMs: prepared.timings.stage1Ms + prepared.timings.stage2Ms + classified.timings.stage3Ms,
    },
    usage: totalUsage,
    stageOutputs: {
      stage1: prepared.stageOutputs.stage1,
      stage2: prepared.stageOutputs.stage2,
      stage3: classified.stageOutputs.stage3,
    },
  };
}

// Exported for tests and future callers that may want the colour→amps mapping
// without the full pipeline.
export { BODY_COLOUR_TO_AMPS };
