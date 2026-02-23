import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import logger from "./logger.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const PHOTO_ANALYSIS_PROMPT = `You are analyzing a photo from an EICR (Electrical Installation Condition Report) inspection.

This photo could be one of several types - analyze accordingly:

=== IF THIS IS A CONSUMER UNIT / DISTRIBUTION BOARD PHOTO ===
Extract ALL visible information:
- Consumer unit make and model
- Number of ways
- Main switch rating (A) and type
- RCD details (type, rating in mA, make, BS/EN standard number)
- For EACH circuit breaker, extract ALL of the following printed on the device face:
  * Position number (1, 2, 3, etc.)
  * Type (MCB or RCBO)
  * Type curve (B, C, or D - usually shown as "B6" meaning Type B 6A)
  * Current rating in Amps (6A, 10A, 16A, 20A, 32A, 40A, etc.)
  * BS/EN standard number (look for "60898" for MCBs, "61009" for RCBOs, often printed as "BS EN 60898-1" or just "60898")
  * Breaking capacity in kA (look for "6kA", "10kA", or numbers like "6000" meaning 6kA - this is CRITICAL)
  * Any circuit label text
- Any labels showing circuit descriptions
- Serial numbers or dates visible
- Condition of the installation
- Any defects or issues visible
- SPD (Surge Protection Device) if present - type and status indicator

CRITICAL FOR CIRCUIT BREAKERS: The BS/EN number and kA rating are printed directly on every breaker face. Look carefully for:
- Small text like "BS EN 60898-1" or just "60898" (the standard)
- Numbers followed by "kA" like "6kA" or "10kA" (breaking capacity)
- These are often in a box or certification mark area on the breaker

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
  * Insulation resistance: IR L-L, IR L-E (in MΩ)
  * RCD: Type, IΔn (mA), trip time (ms), test button OK
  * OCPD: Type (B/C/D), Rating (A), BS/EN number
  * Cable sizes: Live CSA, CPC CSA (in mm²)
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
    model
  };
}
