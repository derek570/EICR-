import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetch } from "undici"; // you installed undici already
import logger from "./logger.js";

const execFileAsync = promisify(execFile);

function mimeFromExt(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".m4a": return "audio/aac";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".aac": return "audio/aac";
    case ".flac": return "audio/flac";
    default: return "application/octet-stream";
  }
}

/**
 * Convert audio to WAV using ffmpeg (16kHz mono PCM16).
 * Returns the path to the WAV file (caller must clean up).
 */
async function convertToWav(inputPath) {
  const wavPath = inputPath.replace(/\.[^.]+$/, "") + "_converted.wav";
  await execFileAsync("ffmpeg", [
    "-y", "-i", inputPath,
    "-ar", "16000", "-ac", "1", "-sample_fmt", "s16",
    "-f", "wav", wavPath,
  ], { timeout: 15_000 });
  return wavPath;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options, timeoutMs = 120_000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export async function geminiGenerateContent({ apiKey, model, body, timeoutMs = 120_000 }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let res;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      timeoutMs
    );
  } catch (err) {
    // Network-level failure: "fetch failed", ECONNRESET, timeout abort, etc.
    const e = new Error(`Gemini network error: ${err?.name || "Error"} ${err?.message || err}`);
    e.isNetworkFailure = true;
    e.original = err;
    throw e;
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    const status = json?.error?.status || "";
    const code = json?.error?.code || res.status;

    const err = new Error(`Gemini error (${code} ${status}): ${msg}`);
    err.httpStatus = res.status;
    err.geminiStatus = status;
    err.geminiCode = code;
    err.raw = text;
    throw err;
  }

  return json;
}

/**
 * Transcribe audio using Gemini (base64 inlineData) with:
 * - retry/backoff on 503 overload
 * - retry/backoff on network failures ("fetch failed")
 * - fallback model
 *
 * Returns { transcript, modelUsed, attempts }
 */
export async function transcribeAudio(audioPath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY in .env");

  const primaryModel = (process.env.GEMINI_MODEL || "gemini-3-pro-preview").trim();
  const fallbackModel = (process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash").trim();

  const mimeType = mimeFromExt(audioPath);
  const bytes = await fs.readFile(audioPath);
  const fileSizeMB = bytes.length / (1024 * 1024);
  const base64 = Buffer.from(bytes).toString("base64");
  const base64SizeMB = (base64.length * 0.75) / (1024 * 1024); // Approximate decoded size

  // Log file size for debugging
  const fileName = path.basename(audioPath);
  logger.info(`Transcribing audio file`, {
    fileName,
    fileSizeMB: fileSizeMB.toFixed(2),
    base64SizeMB: base64SizeMB.toFixed(2)
  });

  // Warn if file is large (approaching 20MB API limit)
  if (base64SizeMB > 15) {
    logger.warn(`Large audio file may hit API limits`, {
      fileName,
      base64SizeMB: base64SizeMB.toFixed(2),
      recommendation: "Consider splitting into smaller files or using Gemini Files API"
    });
  }

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "You are transcribing an electrician's EICR testing dictation.\n\n" +
              "Output THREE sections:\n\n" +
              "1) RAW_TRANSCRIPT: verbatim text with timestamps.\n" +
              "   - Include a timestamp [MM:SS] at the START of the transcript\n" +
              "   - Add timestamps every 30-60 seconds OR when the topic changes (new circuit, new area, new observation)\n" +
              "   - Format: [MM:SS] followed by the speech\n" +
              "   - Example:\n" +
              "     [00:00] Starting inspection at 14 Acacia Avenue...\n" +
              "     [00:35] Circuit one, lights, R1 plus R2 is 0.52 ohms...\n" +
              "     [01:20] Moving to circuit two, ring final...\n" +
              "     [02:15] Taking a photo of the consumer unit now...\n\n" +
              "2) TEST_VALUES: bullet list grouped by circuit where possible.\n\n" +
              "3) PHOTO_MOMENTS: list any moments where the electrician mentions taking a photo or describes what they're photographing.\n" +
              "   Format: [MM:SS] - description of what's being photographed\n" +
              "   Example:\n" +
              "     [02:15] - Consumer unit overview\n" +
              "     [05:30] - Close-up of damaged screw\n\n" +
              "CRITICAL RULES:\n" +
              "- Technical terms to recognise: observation, circuit, bonding, earthing, RCD, RCBO, MCB, TN-C-S, TN-S, TT, Ze, Zs, R1, R2, PFC, PSCC, prospective fault current, kA, IR, insulation resistance, megohms, ohms, amps, volts, csa, CPC, ring, radial, spur, socket, lighting, cooker, shower, immersion.\n" +
              "- TRANSCRIBE EVERYTHING. Do NOT skip or summarize any spoken content.\n" +
              "- Include ALL test values mentioned: R1+R2, Zs, Ze, ring continuity (r1/rn/r2), IR, RCD times, PFC, PSCC, prospective fault current, kA.\n" +
              "- NEVER omit numbers. If unsure, include best guess and mark (uncertain).\n" +
              "- If I correct myself, keep BOTH values and mark earlier as (superseded).\n" +
              "- Preserve decimals and units exactly: ohms, MOhm, ms, mA, A, V.\n" +
              "- Timestamps should be approximate but consistent throughout.\n" +
              "- Include conversations with customers - they often contain important context about limitations or agreed work.\n" +
              "- Include verbal observations: 'that's a fail', 'observation', 'too big', 'exceeds limit', etc.\n" +
              "- Silent periods can be noted briefly as (testing in progress) but do NOT skip spoken content.\n" +
              "- No summaries. No markdown. Verbatim transcription is essential."
          },
          { inlineData: { mimeType, data: base64 } }
        ]
      }
    ],
    generationConfig: { temperature: 0 }
  };

  const models = [primaryModel, fallbackModel];
  let lastErr;

  for (const model of models) {
    let delay = 800;
    const maxAttempts = 7; // slightly higher because we now retry network blips too

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const json = await geminiGenerateContent({ apiKey, model, body });

        const transcript =
          json?.candidates?.[0]?.content?.parts
            ?.map((p) => p?.text)
            ?.filter(Boolean)
            ?.join("\n")
            ?.trim() || "";

        if (!transcript) throw new Error("Gemini returned empty transcript.");

        // Extract usage metadata from Gemini response
        const usage = json?.usageMetadata || null;

        logger.info('Gemini transcription complete', {
          model,
          attempt,
          transcriptLength: transcript.length,
          promptTokens: usage?.promptTokenCount || 0,
          responseTokens: usage?.candidatesTokenCount || 0,
        });
        logger.debug('Gemini full transcript', { transcript });

        return { transcript, modelUsed: model, attempts: attempt, usage };
      } catch (err) {
        lastErr = err;

        const isOverloaded =
          err?.httpStatus === 503 ||
          err?.geminiStatus === "UNAVAILABLE" ||
          String(err?.message || "").toLowerCase().includes("overloaded");

        const isNetworkBlip = err?.isNetworkFailure === true;

        // Only retry the two “safe to retry” cases:
        if (!(isOverloaded || isNetworkBlip)) {
          throw err;
        }

        if (attempt < maxAttempts) {
          await sleep(delay);
          delay = Math.min(delay * 2, 10_000);
          continue;
        }
        // exhausted attempts for this model -> try fallback
      }
    }
  }

  throw lastErr || new Error("Gemini transcription failed after retries + fallback.");
}

/**
 * Fast, lightweight chunk transcription using Gemini Flash.
 * Used by the real-time recording pipeline for individual audio chunks.
 *
 * Returns { transcript, modelUsed, attempts }
 */
export async function transcribeChunk(audioPath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY in .env");

  const primaryModel = (process.env.GEMINI_CHUNK_MODEL || "gemini-2.5-pro").trim();
  const fallbackModel = (process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash").trim();

  // Convert M4A/AAC to WAV for reliable Gemini compatibility
  let actualPath = audioPath;
  let wavCleanup = null;
  const ext = path.extname(audioPath).toLowerCase();
  if (ext === ".m4a" || ext === ".aac") {
    try {
      actualPath = await convertToWav(audioPath);
      wavCleanup = actualPath;
      logger.info(`[transcribeChunk] Converted ${ext} → WAV: ${path.basename(actualPath)}`);
    } catch (convErr) {
      logger.warn(`[transcribeChunk] ffmpeg conversion failed, using original: ${convErr.message}`);
      actualPath = audioPath;
    }
  }

  const mimeType = mimeFromExt(actualPath);
  const bytes = await fs.readFile(actualPath);
  const base64 = Buffer.from(bytes).toString("base64");

  logger.info(`[transcribeChunk] file=${path.basename(actualPath)}, size=${bytes.length}B, mime=${mimeType}, base64len=${base64.length}, primaryModel=${primaryModel}, fallbackModel=${fallbackModel}`);

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: "Transcribe this audio from a UK electrician conducting an EICR inspection.\nTechnical terms include: observation, circuit, bonding, earthing, RCD, RCBO, MCB, TN-C-S, TN-S, TT, Ze, Zs, R1, R2, PFC, PSCC, prospective fault current, kA, IR, insulation resistance, megohms, ohms, amps, volts, csa, CPC, ring, radial, spur, socket, lighting, cooker, shower, immersion.\nInclude all numbers and units exactly as spoken. Plain text only.",
          },
          { inlineData: { mimeType, data: base64 } },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 2048 },
  };

  // Try primary model, then fallback model if primary returns empty or fails
  const modelsToTry = [primaryModel];
  if (fallbackModel && fallbackModel !== primaryModel) {
    modelsToTry.push(fallbackModel);
  }

  let lastErr;

  for (const model of modelsToTry) {
    let delay = 500;
    const maxAttempts = 3; // 3 attempts per model (empty transcripts are often transient)

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const json = await geminiGenerateContent({ apiKey, model, body, timeoutMs: 30_000 });

        const transcript =
          json?.candidates?.[0]?.content?.parts
            ?.map((p) => p?.text)
            ?.filter(Boolean)
            ?.join("\n")
            ?.trim() || "";

        if (!transcript) {
          // Empty transcript — retry same model (Gemini empty responses are often transient)
          logger.warn(`[transcribeChunk] Empty transcript from ${model} (attempt ${attempt}/${maxAttempts})`, {
            model, mimeType, audioSize: bytes.length,
          });
          lastErr = new Error(`Gemini returned empty transcript (${model}).`);
          if (attempt < maxAttempts) {
            await sleep(delay);
            delay = Math.min(delay * 2, 5_000);
            continue; // Retry same model
          }
          break; // All attempts exhausted for this model, try fallback
        }

        const usage = json?.usageMetadata || null;

        logger.info(`[transcribeChunk] model=${model}, attempt=${attempt}, len=${transcript.length}, tokens: prompt=${usage?.promptTokenCount || "?"}, response=${usage?.candidatesTokenCount || "?"}`);

        if (wavCleanup) fs.unlink(wavCleanup).catch(() => {});
        return { transcript, modelUsed: model, attempts: attempt, usage };
      } catch (err) {
        lastErr = err;
        logger.error(`[transcribeChunk] attempt=${attempt} failed: ${err.message}`, {
          httpStatus: err.httpStatus,
          geminiStatus: err.geminiStatus,
          raw: err.raw?.substring(0, 500),
          model,
          mimeType,
          audioSize: bytes.length,
        });

        const isOverloaded =
          err?.httpStatus === 503 ||
          err?.geminiStatus === "UNAVAILABLE" ||
          String(err?.message || "").toLowerCase().includes("overloaded");
        const isNetworkBlip = err?.isNetworkFailure === true;

        // Non-retryable errors (400, auth, etc) — skip to fallback model
        if (!(isOverloaded || isNetworkBlip)) {
          break;
        }

        if (attempt < maxAttempts) {
          await sleep(delay);
          delay = Math.min(delay * 2, 5_000);
        }
      }
    }

    // If we got here, this model failed — log and try next
    if (modelsToTry.indexOf(model) < modelsToTry.length - 1) {
      logger.info(`[transcribeChunk] Primary model ${model} failed, trying fallback ${fallbackModel}`, {
        mimeType, audioSize: bytes.length,
      });
    }
  }

  if (wavCleanup) fs.unlink(wavCleanup).catch(() => {});
  throw lastErr || new Error("Chunk transcription failed after all models.");
}

