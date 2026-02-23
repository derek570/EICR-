/**
 * Gemini audio extraction for EICR chunked recording mode.
 *
 * Receives audio (base64 FLAC/WAV) + context text from iOS,
 * sends to Gemini 2.5 Flash for combined transcription + structured extraction.
 *
 * Returns: { transcript, circuits, supply, installation, board, orphaned_values, usage }
 */

import fssync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGeminiKey } from "./services/secrets.js";
import logger from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_MODEL = (process.env.GEMINI_EXTRACT_MODEL || "gemini-2.5-flash").trim();
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// Load externalized system prompts at module init
const SYSTEM_PROMPT = fssync.readFileSync(
  path.join(__dirname, "..", "config", "prompts", "gemini_system.md"),
  "utf8"
);

/**
 * Call Gemini with audio + context and return structured extraction.
 *
 * @param {string} audioBase64 - Base64-encoded audio data
 * @param {string} audioMimeType - MIME type (audio/flac, audio/wav, etc.)
 * @param {string} contextText - Filled fields + orphans context
 * @param {string|null} previousAudioBase64 - Base64-encoded previous chunk audio (for continuity)
 * @param {string|null} previousAudioMimeType - MIME type of previous chunk audio
 * @returns {Promise<Object>} { transcript, circuits, supply, installation, board, orphaned_values, usage }
 */
export async function geminiExtract(audioBase64, audioMimeType, contextText, previousAudioBase64 = null, previousAudioMimeType = null) {
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const parts = [];
  if (previousAudioBase64 && previousAudioMimeType) {
    parts.push({ inlineData: { mimeType: previousAudioMimeType, data: previousAudioBase64 } });
  }
  parts.push({ inlineData: { mimeType: audioMimeType, data: audioBase64 } });
  parts.push({ text: contextText || "No previous context." });

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
    },
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const start = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });

      const latencyMs = Date.now() - start;

      if (!res.ok) {
        const errBody = await res.text();
        // 429 (rate limit) and 503 (overloaded) are retryable
        if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
          logger.warn("Gemini extract retryable error", { status: res.status, attempt, delay });
          await sleep(delay);
          continue;
        }
        throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 500)}`);
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts
        ?.map(p => p?.text)
        ?.filter(Boolean)
        ?.join("\n")
        ?.trim();

      if (!text) throw new Error("Gemini returned empty response");

      const inputTokens = json?.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = json?.usageMetadata?.candidatesTokenCount ?? 0;

      // Parse the JSON response
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`Gemini returned invalid JSON: ${text.slice(0, 200)}`);
      }

      // Calculate cost (model-aware pricing)
      const isFlash = GEMINI_MODEL.includes("flash");
      const inputRate = isFlash ? 0.15 : 1.25;
      const outputRate = isFlash ? 0.60 : 10.00;
      const cost = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;

      logger.info("Gemini extract success", {
        model: GEMINI_MODEL,
        attempt,
        latencyMs,
        inputTokens,
        outputTokens,
        cost: cost.toFixed(6),
        transcriptLen: parsed.transcript?.length ?? 0,
        circuits: parsed.circuits?.length ?? 0,
        orphans: parsed.orphaned_values?.length ?? 0,
        hasPreviousAudio: !!previousAudioBase64,
      });

      return {
        transcript: parsed.transcript || "",
        circuits: parsed.circuits || [],
        supply: parsed.supply || {},
        installation: parsed.installation || {},
        board: parsed.board || {},
        orphaned_values: parsed.orphaned_values || [],
        usage: { inputTokens, outputTokens, cost: parseFloat(cost.toFixed(6)), latencyMs },
      };

    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES && (err.name === "TimeoutError" || err.name === "AbortError")) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn("Gemini extract timeout, retrying", { attempt, delay });
        await sleep(delay);
        continue;
      }
    }
  }

  throw lastError;
}

// ── Text-based extraction (for Deepgram+Gemini hybrid pipeline) ──

const GEMINI_TEXT_MODEL = (process.env.GEMINI_EXTRACT_TEXT_MODEL || "gemini-2.5-pro").trim();

const TEXT_SYSTEM_PROMPT = fssync.readFileSync(
  path.join(__dirname, "..", "config", "prompts", "gemini_text_system.md"),
  "utf8"
);

/**
 * Call Gemini with transcript TEXT (no audio) + context and return structured extraction.
 * Used by the Deepgram+Gemini hybrid pipeline where Deepgram handles transcription
 * and Gemini handles structured extraction from the transcript text.
 *
 * @param {string} transcriptText - Rolling window of transcript text (~5000 chars)
 * @param {string} contextText - Filled fields + orphans context
 * @returns {Promise<Object>} { circuits, supply, installation, board, orphaned_values, usage }
 */
export async function geminiExtractFromText(transcriptText, contextText) {
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const model = GEMINI_TEXT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const userMessage = `=== TRANSCRIPT ===
${transcriptText}

=== CONTEXT (already filled fields) ===
${contextText || "No previous context."}

Extract structured EICR data from the transcript above. Only extract NEW values not already present in the context.`;

  const body = {
    systemInstruction: { parts: [{ text: TEXT_SYSTEM_PROMPT }] },
    contents: [{ parts: [{ text: userMessage }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
    },
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const start = Date.now();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      const latencyMs = Date.now() - start;

      if (!res.ok) {
        const errBody = await res.text();
        if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
          logger.warn("Gemini text extract retryable error", { status: res.status, attempt, delay });
          await sleep(delay);
          continue;
        }
        throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 500)}`);
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts
        ?.map(p => p?.text)
        ?.filter(Boolean)
        ?.join("\n")
        ?.trim();

      if (!text) throw new Error("Gemini text extract returned empty response");

      const inputTokens = json?.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = json?.usageMetadata?.candidatesTokenCount ?? 0;

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`Gemini text extract returned invalid JSON: ${text.slice(0, 200)}`);
      }

      // Calculate cost (Gemini 2.5 Pro pricing)
      const isFlash = model.includes("flash");
      const inputRate = isFlash ? 0.15 : 1.25;
      const outputRate = isFlash ? 0.60 : 10.00;
      const cost = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;

      logger.info("Gemini text extract success", {
        model,
        attempt,
        latencyMs,
        inputTokens,
        outputTokens,
        cost: cost.toFixed(6),
        circuits: parsed.circuits?.length ?? 0,
        orphans: parsed.orphaned_values?.length ?? 0,
        transcriptLen: transcriptText.length,
      });

      return {
        circuits: parsed.circuits || [],
        supply: parsed.supply || {},
        installation: parsed.installation || {},
        board: parsed.board || {},
        orphaned_values: parsed.orphaned_values || [],
        usage: { inputTokens, outputTokens, cost: parseFloat(cost.toFixed(6)), latencyMs },
      };

    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES && (err.name === "TimeoutError" || err.name === "AbortError")) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn("Gemini text extract timeout, retrying", { attempt, delay });
        await sleep(delay);
        continue;
      }
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
