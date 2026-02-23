import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import logger from "./logger.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const PHOTO_ANALYSIS_PROMPT = `You are analyzing a photo from an EICR (Electrical Installation Condition Report) inspection.

This photo could be one of several types - analyze accordingly:

=== IF THIS IS A CONSUMER UNIT / DISTRIBUTION BOARD PHOTO ===

YOU MUST FOLLOW THESE 4 STEPS IN ORDER. Do not skip any step.

**STEP 1: PHYSICAL DEVICE SCAN (left to right)**
Before extracting any details, scan the board physically from LEFT to RIGHT and list every device by its width in modules.

Module widths (1 module = 18mm = exactly HALF the width of a typical main switch):
- MCB = 1 module wide (narrow, single toggle lever)
- RCBO = 2 modules wide (has BOTH a toggle lever AND a test button, plus RCD type symbol)
- RCD = 2-4 modules wide (has a test button and ON/OFF toggle, but protects multiple circuits -- NOT a circuit breaker itself)
- Main switch / isolator = 2 modules wide (usually red toggles)
- SPD = 2-3 modules wide (no toggle, has a status indicator window)
- Blank plate / spare = 1 module wide (flat cover, no device behind it)

List every device left to right like this:
"Slot A (1 mod): MCB | Slot B (1 mod): MCB | Slot C (2 mod): RCD | Slot D (1 mod): MCB | ..."

Count total modules and cross-check against the board's stated number of ways.

**STEP 2: MAP CIRCUIT LABELS TO PHYSICAL DEVICES**
Look at the circuit labels/numbers printed below or above the devices. Map each label to the physical device from Step 1.

CIRCUIT NUMBERING RULE:
- Find the main switch first. It may be on the LEFT or the RIGHT of the board.
- Circuit 1 is the device immediately NEXT TO the main switch, numbering OUTWARD (away from the main switch).
- Example: if the main switch is on the LEFT, Circuit 1 is the first device to its right, Circuit 2 is next, etc.
- Example: if the main switch is on the RIGHT, Circuit 1 is the first device to its left, Circuit 2 is next, etc.
- If visible circuit labels contradict this rule, follow the LABELS (the installer may have numbered differently).

IMPORTANT:
- RCDs and the main switch are NOT numbered circuits -- labels skip over them
- Blank/spare positions may or may not have a label
- If labels don't align with the physical device count, STOP and note the discrepancy -- do NOT shift ratings to force a match

**STEP 3: EXTRACT DETAILS FOR EACH DEVICE**

**3a. BOARD OVERVIEW:**
- Consumer unit make and model
- Number of ways (cross-check against module count from Step 1)
- Serial numbers or dates visible
- Condition of the installation
- Any defects or issues visible

**3b. MAIN SWITCH:**
- Rating (A) and type (isolator, switch-disconnector, etc.)
- Make and BS/EN standard number

**3c. RCD(s) -- for EVERY stand-alone RCD:**
- Physical position (from Step 1)
- Which circuit numbers it protects (the MCBs adjacent to it, up to the next RCD or board edge)
- Make (e.g., Hager, MK, Wylex, Schneider, Contactum)
- Rated residual current IDn (30mA, 100mA, 300mA)
- RCD TYPE -- CRITICAL, you MUST distinguish Type AC from Type A:
  * Look for the small waveform symbol box on the device face
  * Type AC = ONE waveform line only (simple sine wave). ONE line, nothing else
  * Type A = TWO lines stacked vertically (sine wave PLUS half-wave bumps beneath)
  * Type B = THREE lines stacked
  * Type S = marked with letter "S" (time-delayed)
  * COUNT THE LINES IN THE SYMBOL BOX: 1 line = Type AC. 2 lines = Type A.
  * If the symbol is too small to read, say "Type AC or A -- unclear" and add a question to Step 3h
  * Do NOT just say "RCD" or "Type RCD" -- give the actual type letter (AC, A, B, F, or S)
  * IMPORTANT: RCDs and RCBOs in the same board can be DIFFERENT types -- check each device individually
- Rated current In (63A, 80A, 100A)
- BS/EN standard number (e.g., BS EN 61008)

**3d. CIRCUIT BREAKERS -- in the order identified in Step 1:**
For each MCB or RCBO, read the ACTUAL text printed on THAT specific device face:
  * Circuit number and label (from Step 2 mapping)
  * Device type: "MCB" (1 module wide) or "RCBO" (2 modules wide, has test button)
  * Type curve letter and current rating -- read the EXACT text (e.g., "B32" = Type B, 32A)
  * CRITICAL: Read the amp rating from the DEVICE FACE at this physical position. Do NOT assume ratings from circuit labels. A "Shower" label does not mean 40A -- read the actual breaker. A "Cooker" label does not mean 32A -- read the actual breaker. The rating is what is PRINTED ON THE DEVICE, not what you expect from the circuit name.
  * IF RCBO: RCD type (count waveform lines on THIS specific device: 1 line = AC, 2 lines = A)
  * IF RCBO: Rated residual current IDn
  * BS/EN standard number (MCBs: 60898, RCBOs: 61009)
  * Breaking capacity in kA
  * Which RCD protects this circuit (from Step 1 positioning), or "self-protected" if RCBO

**3e. SURGE PROTECTION DEVICE (SPD) -- Do NOT skip:**
- Is an SPD present? (YES / NO / NOT VISIBLE)
- If YES: make, model, SPD Type (1, 2, 3, or combination), status indicator colour, BS/EN
- If NO: explicitly state "No SPD present"

**3f. OTHER DEVICES:**
- AFDD, time switches, contactors, bell transformers, etc.

**3g. CIRCUIT LABELS / SCHEDULE:**
- Any labels or schedule card visible -- transcribe all entries

**3h. QUESTIONS FOR INSPECTOR (TTS):**
If ANY information is unclear, list questions in plain English suitable for text-to-speech:
- "I can see the RCD protecting circuits 3 to 5 but the type symbol is too small to read. Is it Type AC or Type A?"
- "The RCBO on circuit 2 -- is it Type A or Type AC?"
- "The breaker at position 4 -- I can't read the rating clearly. Is it 32A or 40A?"
Do NOT guess when uncertain -- ask instead. These questions will be read aloud to the inspector via TTS during the recording session.

**STEP 4: CROSS-CHECK (mandatory)**
Before finishing, verify ALL of the following:
1. Does the number of MCBs + RCBOs match the number of circuit labels?
2. Does the total module count add up to the board's number of ways?
3. Are there any labels without a matching device, or devices without a label?
4. Have you read each breaker's amp rating from the device face (not assumed from the circuit name)?
5. Have you identified the RCD type (AC, A, B, etc.) for every RCD and RCBO?
6. Have you checked for an SPD?
If ANYTHING doesn't add up, state the discrepancy explicitly.

CRITICAL REMINDERS:
- Stand-alone RCDs are NOT circuit rows. Their type and IDn go into the RCD fields of the circuits they protect.
- RCBOs ARE circuit rows. Their RCD details also go into the RCD fields for that circuit.
- BLANK / SPARE WAYS: list as "Spare" with NO device type, NO BS/EN, NO rating.
- Do NOT assume amp ratings from circuit labels -- read the actual device face.
- RCD types can differ between devices in the same board -- check each one.

=== IF THIS IS A CIRCUIT LAYOUT / DIAGRAM ===
Extract:
- Circuit numbers and their descriptions
- Breaker ratings for each circuit
- Which RCD protects which circuits
- Any circuit groupings (e.g., upstairs/downstairs)
- Cable sizes if shown
- Any notes or annotations

=== IF THIS IS A HANDWRITTEN FORM / TEST SHEET ===
Transcribe ALL handwritten data exactly as written, including:
- Circuit reference numbers (circuit_ref)
- Circuit descriptions/designations (circuit_designation)
- Test readings for ALL 29 circuit schedule fields where visible:
  * Continuity: R1+R2, r1, rn, r2, R2 (in ohms)
  * Earth fault loop impedance: Zs (measured_zs_ohm)
  * Insulation resistance: IR L-L, IR L-E (in megohms)
  * RCD: Type, IDn (mA), trip time (ms), test button OK
  * OCPD: Type (B/C/D), Rating (A), BS/EN number
  * Cable sizes: Live CSA, CPC CSA (in mm2)
  * Polarity confirmed (OK/Y/N)
  * AFDD test button (if present)
- Tick marks and their meanings
- Any observations or notes
- Property address if visible
- Date of inspection
- Tester name if visible

Format as structured data where possible:
Circuit | Designation | R1+R2 | Zs | IR L-E | RCD ms | Polarity | Notes
1       | Lights GF   | 0.52  | 0.72 | >200 | 18     | OK       | ...

=== IF THIS IS WRITTEN OBSERVATIONS / NOTES ===
Transcribe ALL text exactly including:
- Defects found and their locations
- Recommendations
- Code classifications (C1, C2, C3, FI)
- Regulation references (e.g., 411.3.3)
- Any sketch annotations

=== IF THIS SHOWS DEFECTS / INSTALLATION ISSUES ===
Describe:
- What the defect is
- Location
- Severity assessment
- Relevant BS 7671 regulation if obvious

=== GENERAL RULES ===
- Be precise with all numbers, ratings, and technical details
- If you can't read something clearly, say "unclear" rather than guessing
- For handwritten text, transcribe exactly what you see even if there are spelling errors
- Format your response as structured text with clear labels
- If multiple types of content are in one photo, extract all of them

=== IMPORTANT: INDICATE CERTAINTY ===
- For each piece of information, indicate if you can see it CLEARLY or if it's PARTIALLY VISIBLE
- If a label exists but you can't read it fully, say "label present but text unclear"
- Distinguish between "not visible in this photo" vs "confirmed not present"
- If this is a close-up photo, note that it may show details not visible in wider shots
- Example: "Circuit 5 label: PARTIALLY VISIBLE - appears to show text but cannot read clearly from this angle"
- This helps cross-reference with other photos that may show the same thing more clearly`;

function mimeFromExt(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

async function analyzeImage(openai, model, imagePath) {
  const mimeType = mimeFromExt(imagePath);
  const bytes = await fs.readFile(imagePath);
  const base64 = Buffer.from(bytes).toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const response = await openai.chat.completions.create({
    model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: PHOTO_ANALYSIS_PROMPT },
        { type: "image_url", image_url: { url: dataUrl } }
      ]
    }],
    temperature: 0
  });

  return {
    analysis: response.choices?.[0]?.message?.content?.trim() || "",
    usage: response.usage || null
  };
}

/**
 * Analyze all photos in a folder and return combined analysis
 */
export async function analyzePhotos(photosDir) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY in .env");

  const model = (process.env.EXTRACTION_MODEL || "gpt-5.2").trim();
  const openai = new OpenAI({ apiKey });

  let files = [];
  try {
    files = await fs.readdir(photosDir);
  } catch {
    return { analysis: "", photoCount: 0, usage: null, model };
  }

  const imageFiles = files.filter(f =>
    IMAGE_EXTS.has(path.extname(f).toLowerCase()) && !f.startsWith(".")
  );

  if (imageFiles.length === 0) {
    return { analysis: "", photoCount: 0, usage: null, model };
  }

  const results = [];
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for (const file of imageFiles) {
    const imagePath = path.join(photosDir, file);
    logger.debug(`Analyzing photo`, { file });

    try {
      const { analysis, usage } = await analyzeImage(openai, model, imagePath);
      results.push({
        file,
        analysis
      });

      if (usage) {
        totalUsage.prompt_tokens += usage.prompt_tokens || 0;
        totalUsage.completion_tokens += usage.completion_tokens || 0;
        totalUsage.total_tokens += usage.total_tokens || 0;
      }
    } catch (err) {
      logger.error(`Failed to analyze photo`, { file, error: err.message });
      results.push({
        file,
        analysis: `[Analysis failed: ${err.message}]`
      });
    }
  }

  // Combine all analyses
  const combined = results
    .map((r, i) => `=== Photo ${i + 1}: ${r.file} ===\n\n${r.analysis}`)
    .join("\n\n");

  return {
    analysis: combined,
    photoCount: imageFiles.length,
    details: results,
    usage: totalUsage.total_tokens > 0 ? totalUsage : null,
    model,
    questionsForInspector: extractQuestions(combined)
  };
}

/**
 * Extract "Questions for Inspector" from CCU analysis text.
 * These are read aloud via TTS during the recording session.
 */
function extractQuestions(analysisText) {
  const match = analysisText.match(
    /(?:questions?\s+for\s+inspector|3h[.:]\s*questions)[:\s]*\n?([\s\S]*?)(?:\n\n(?:\*\*|===|STEP)|$)/i
  );
  if (!match) return [];

  return match[1]
    .split("\n")
    .map(line => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(line => line.length > 10 && line.includes("?"));
}
