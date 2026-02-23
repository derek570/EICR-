# CCU Photo Analysis: Gemini Pro 3 + V3 Prompt — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace CCU photo analysis model (GPT Vision → Gemini Pro 3 Preview) and upgrade extraction prompt to v3 with smarter manufacturer-based lookups. Output format stays identical to current `FuseboardAnalysis` — zero iOS changes.

**Architecture:** Single backend change in `api.js`. Replace OpenAI SDK call with Gemini REST API call (same `geminiGenerateContent` pattern already used in `transcribe.js`). New v3 prompt with richer extraction instructions but same output JSON schema.

**Tech Stack:** Google Generative Language REST API, `gemini-3-pro-preview` model, existing `GEMINI_API_KEY` from AWS Secrets.

---

### Task 1: Extract `geminiGenerateContent` into shared utility

The function `geminiGenerateContent()` in `transcribe.js` (lines 50-91) is a well-tested helper with proper error handling, timeout, and retry-friendly error classification. Rather than duplicating it, import it for reuse.

**Files:**
- Modify: `EICR_App/src/transcribe.js:50-91` — add `export` to `geminiGenerateContent`
- No new files needed

**Step 1: Add export to geminiGenerateContent**

In `EICR_App/src/transcribe.js`, change line 50 from:

```js
async function geminiGenerateContent({ apiKey, model, body, timeoutMs = 120_000 }) {
```

to:

```js
export async function geminiGenerateContent({ apiKey, model, body, timeoutMs = 120_000 }) {
```

Also update the `fetchWithTimeout` helper at the top of the file (around line 33) to be exported too, since `geminiGenerateContent` depends on it being in scope. Actually — `geminiGenerateContent` calls `fetchWithTimeout` internally and both are in the same file, so only `geminiGenerateContent` needs the export.

**Step 2: Verify no breakage**

Run: `cd EICR_App && node -e "import('./src/transcribe.js').then(m => console.log('OK:', typeof m.geminiGenerateContent))"`

Expected: `OK: function`

**Step 3: Commit**

```bash
cd EICR_App && git add src/transcribe.js
git commit -m "refactor: export geminiGenerateContent for reuse by CCU endpoint"
```

---

### Task 2: Replace `/api/analyze-ccu` handler with Gemini + V3 prompt

**Files:**
- Modify: `EICR_App/src/api.js` — lines 4218-4432 (the entire handler)

**Step 1: Add import at top of api.js**

Near the other imports at the top of `api.js`, add:

```js
import { geminiGenerateContent } from "./transcribe.js";
```

**Step 2: Replace the handler**

Replace lines 4218-4432 (the entire `app.post("/api/analyze-ccu", ...)` handler) with the new implementation below.

Key changes:
- `GEMINI_API_KEY` instead of `OPENAI_API_KEY`
- `gemini-3-pro-preview` model instead of `gpt-5.2`
- Gemini REST API via `geminiGenerateContent()` instead of OpenAI SDK
- New v3 prompt with manufacturer-based lookups
- `responseMimeType: "application/json"` for native JSON mode
- Gemini response parsing (`candidates[0].content.parts[0].text`)
- Gemini token pricing ($2/1M input, $12/1M output)
- Same `applyBsEnFallback()` + main switch fallbacks
- Same output JSON schema (FuseboardAnalysis-compatible)

```js
app.post("/api/analyze-ccu", auth.requireAuth, upload.single("photo"), async (req, res) => {
  const tempPath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No photo uploaded" });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Gemini API key not configured" });
    }

    const model = (process.env.CCU_MODEL || "gemini-3-pro-preview").trim();

    logger.info("CCU photo analysis requested", {
      userId: req.user.id,
      fileSize: req.file.size,
      model,
    });

    // Read image and convert to base64
    const imageBytes = await fs.readFile(tempPath);
    const base64 = Buffer.from(imageBytes).toString("base64");

    const prompt = `You are an expert UK electrician analysing a photo of a consumer unit for an EICR certificate.

## TASK

Extract every protective device from this consumer unit photo and return structured JSON.

## NUMBERING

Find the main switch first. Circuit 1 starts from the device immediately next to the main switch, numbering outward. The main switch may be on the left or right.

## FOR EACH DEVICE, EXTRACT:

Read directly from the photo where possible:
- Manufacturer, model number, current rating, type curve (B/C/D)
- RCD type symbol (A, AC, F, or B), RCD sensitivity (mA)
- Circuit label if a label chart is visible
- BS/EN standard number printed on device
- Breaking capacity in kA

If any of the following are NOT clearly readable on the device, use your knowledge to look them up based on the manufacturer and model number you CAN see:
- **BS EN number**: Look up the correct standard for that device type (e.g., MCB = BS EN 60898-1, RCBO = BS EN 61009-1)
- **RCD type**: Look up whether this specific model range is Type A or Type AC. Different ranges from the same manufacturer have different RCD types — e.g., Hager ADA = Type A, Hager ADN = Type AC; MK H79xx = Type AC, MK H68xx = Type A; BG CURB = Type AC, BG CUCRB = Type A. Match by model prefix, not just manufacturer.
- **Type curve**: If not visible, B is standard for domestic but flag as assumed.

NEVER return "RCD" as an RCD type. Always return A, AC, F, B, or N/A.

## BOARD INFO

- Identify manufacturer and model if visible (e.g. "Hager", "MK", "Wylex").
- Note main switch position ("left" or "right").

## MAIN SWITCH DETAILS

- Read the current rating in amps (e.g., "63", "80", "100").
- Identify the type: "Isolator", "Switch Disconnector", "RCD", "RCCB", or other.
- Look for BS/EN standard number (e.g., "60947-3", "61008").
- Identify poles: "DP" (double pole), "TP" (triple pole), "TPN", "4P".
- Read voltage rating if printed (e.g., "230", "400").

## SPD (SURGE PROTECTION DEVICE)

- If an SPD module is visible, set spd_present to true and extract: BS/EN standard, SPD type ("Type 1", "Type 2", "Type 1+2", "Type 3"), rated current in amps, short circuit rating in kA.
- If NO SPD is visible, set spd_present to false.

## DEVICE TYPE MAPPING

For each circuit device:
- If it is an RCBO (combined MCB+RCD): set is_rcbo=true, rcd_protected=true
- If it is behind a standalone RCD: set is_rcbo=false, rcd_protected=true
- If it is a plain MCB with no RCD protection: set is_rcbo=false, rcd_protected=false
- Blank/spare positions: set ocpd_type to null, label to null

## OUTPUT FORMAT

Return ONLY valid JSON matching this exact schema:
{
  "board_manufacturer": "string or null",
  "board_model": "string or null",
  "main_switch_rating": "string — amps",
  "main_switch_position": "left or right",
  "main_switch_bs_en": "string or null",
  "main_switch_type": "Isolator|Switch Disconnector|RCD|RCCB or null",
  "main_switch_poles": "DP|TP|TPN|4P",
  "main_switch_current": "string — amps",
  "main_switch_voltage": "string or null",
  "spd_present": false,
  "spd_bs_en": "string or null",
  "spd_type": "string or null",
  "spd_rated_current_a": "string or null",
  "spd_short_circuit_ka": "string or null",
  "confidence": {
    "overall": 0.85,
    "image_quality": "clear|partially_readable|poor",
    "uncertain_fields": ["circuits[2].ocpd_bs_en"],
    "message": "Brief note about any reading difficulties or looked-up values"
  },
  "circuits": [
    {
      "circuit_number": 1,
      "label": "Kitchen Sockets or null",
      "ocpd_type": "B|C|D or null for blanks",
      "ocpd_rating_a": "32 or null",
      "ocpd_bs_en": "60898-1 or null",
      "ocpd_breaking_capacity_ka": "6 or null",
      "is_rcbo": false,
      "rcd_protected": true,
      "rcd_rating_ma": "30 or null",
      "rcd_bs_en": "61008 or null"
    }
  ]
}

## CONFIDENCE SCORING

- "overall": 0.0-1.0 reflecting readability. 1.0 = every marking perfectly clear.
- "image_quality": "clear", "partially_readable", or "poor".
- "uncertain_fields": list field paths you had to guess or look up.
- "message": include which values were looked up vs read, and any reading difficulties.

IMPORTANT: If you cannot read the BS/EN number from the device, use your knowledge to look it up based on manufacturer and model. Only leave as null if you cannot identify the device at all.`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: base64 } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 4000,
        responseMimeType: "application/json",
      },
    };

    const json = await geminiGenerateContent({ apiKey, model, body, timeoutMs: 60_000 });

    const content = json?.candidates?.[0]?.content?.parts
      ?.map((p) => p?.text)
      ?.filter(Boolean)
      ?.join("") || "";

    const promptTokens = json?.usageMetadata?.promptTokenCount || 0;
    const completionTokens = json?.usageMetadata?.candidatesTokenCount || 0;

    logger.info("CCU analysis complete", {
      userId: req.user.id,
      model,
      promptTokens,
      completionTokens,
      responseLength: content.length,
    });

    // Parse JSON (Gemini JSON mode should return clean JSON, but strip fences just in case)
    let jsonStr = content;
    if (jsonStr.startsWith("```json")) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith("```")) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    let analysis = JSON.parse(jsonStr);

    // Apply BS/EN fallback for any circuits missing BS numbers
    analysis = applyBsEnFallback(analysis);

    // Main switch fallbacks
    if (!analysis.main_switch_current && analysis.main_switch_rating) {
      analysis.main_switch_current = analysis.main_switch_rating;
    }
    if (!analysis.main_switch_bs_en) {
      analysis.main_switch_bs_en = "60947-3";
    }
    if (!analysis.main_switch_poles) {
      analysis.main_switch_poles = "DP";
    }
    if (!analysis.main_switch_voltage) {
      analysis.main_switch_voltage = "230";
    }

    // Attach cost data (Gemini Pro 3 Preview: $2/1M input, $12/1M output)
    const inputCost = promptTokens * 0.002 / 1000;
    const outputCost = completionTokens * 0.012 / 1000;
    analysis.gptVisionCost = {
      cost_usd: parseFloat((inputCost + outputCost).toFixed(6)),
      input_tokens: promptTokens,
      output_tokens: completionTokens,
      image_count: 1
    };

    logger.info("CCU analysis parsed", {
      userId: req.user.id,
      model,
      boardManufacturer: analysis.board_manufacturer,
      boardModel: analysis.board_model,
      circuitCount: analysis.circuits?.length || 0,
      mainSwitchCurrent: analysis.main_switch_current,
      spdPresent: analysis.spd_present,
      confidenceOverall: analysis.confidence?.overall,
      confidenceQuality: analysis.confidence?.image_quality,
      uncertainFieldCount: analysis.confidence?.uncertain_fields?.length || 0,
      confidenceMessage: analysis.confidence?.message,
      costUsd: analysis.gptVisionCost.cost_usd,
    });

    res.json(analysis);
  } catch (error) {
    logger.error("CCU analysis failed", {
      userId: req.user.id,
      error: error.message,
    });
    res.status(500).json({ error: error.message });
  } finally {
    // Clean up temp file
    if (tempPath) {
      try { await fs.unlink(tempPath); } catch {}
    }
  }
});
```

**Step 3: Verify module loads**

Run: `cd EICR_App && node -e "import('./src/api.js').then(() => console.log('OK')).catch(e => console.error('FAIL:', e.message))"`

Expected: Server starts or module loads without syntax errors.

**Step 4: Commit**

```bash
cd EICR_App && git add src/api.js
git commit -m "feat: switch CCU analysis to Gemini Pro 3 Preview with v3 prompt

Replace GPT Vision (gpt-5.2) with Gemini Pro 3 Preview for consumer unit
photo analysis. New v3 prompt adds manufacturer-based RCD type lookup,
BS EN standard inference, and smarter device identification.

Output JSON format unchanged — no iOS changes needed."
```

---

### Task 3: Update CLAUDE.md changelog and docs

**Files:**
- Modify: `EICR_App/CLAUDE.md` — changelog table + tech stack table + future plans

**Step 1: Update tech stack table**

In the Tech Stack table, change the "Photo/Batch AI" row from:

```
| Photo/Batch AI | OpenAI GPT + Vision API |
```

to:

```
| Photo/Batch AI | Gemini Pro 3 Preview (CCU) + OpenAI GPT (batch) |
```

**Step 2: Add changelog entry**

Add to the top of the Changelog table:

```
| 2026-02-19 | CCU photo analysis: switch from GPT Vision to Gemini Pro 3 Preview, v3 prompt with manufacturer-based BS EN and RCD type lookups | api.js, transcribe.js |
```

**Step 3: Update Future Plans**

In the "Future Plans" section, update the bullet about CCU photo analysis to reflect it's now done:

Change:
```
- Evaluate Claude vs GPT for **batch** CCU photo analysis (`POST /api/analyze-ccu`)
```

to:
```
- CCU photo analysis now uses Gemini Pro 3 Preview (switched from GPT Vision, 2026-02-19)
```

**Step 4: Commit**

```bash
cd EICR_App && git add CLAUDE.md
git commit -m "docs: update changelog and tech stack for Gemini CCU switch"
```

---

### Task 4: Deploy and verify

**Step 1: Build and push Docker image**

```bash
cd EICR_App
docker build -f Dockerfile.backend -t eicr-backend .
aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin 196390795898.dkr.ecr.eu-west-2.amazonaws.com
docker tag eicr-backend:latest 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend:latest
docker push 196390795898.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend:latest
aws ecs update-service --cluster eicr-cluster-production --service eicr-backend --force-new-deployment --region eu-west-2
```

**Step 2: Monitor deployment**

```bash
aws ecs describe-services --cluster eicr-cluster-production --services eicr-backend --region eu-west-2 --query "services[*].{Running:runningCount,Status:deployments[0].rolloutState}" --output table
```

Wait for `COMPLETED` status.

**Step 3: Check logs for startup**

```bash
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 5m --filter-pattern "secrets"
```

Verify `GEMINI_API_KEY` is loaded from secrets.

**Step 4: Test from iOS**

Take a CCU photo in the app and verify circuits populate correctly.

**Step 5: Check logs for successful analysis**

```bash
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 5m --filter-pattern "CCU analysis"
```

Look for `CCU analysis parsed` with `model: gemini-3-pro-preview` and valid circuit data.
