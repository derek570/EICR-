/**
 * Sonnet text extraction for the Deepgram + Sonnet hybrid pipeline.
 *
 * Replaces gemini_extract.js — uses Anthropic Claude instead of Gemini.
 * Uses raw fetch() (no SDK) to match the existing pattern in gemini_extract.js.
 *
 * Exports:
 *   sonnetExtractFromText  — transcript text → structured extraction (replaces geminiExtractFromText)
 *   sonnetExtractFromAudio — audio → Deepgram transcription → Sonnet extraction (replaces geminiExtract)
 */

import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAnthropicKey, getDeepgramKey } from './services/secrets.js';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SONNET_MODEL = (process.env.SONNET_EXTRACT_MODEL || 'claude-sonnet-4-6').trim();
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// Anthropic API pricing for claude-sonnet-4-6 (per 1M tokens)
const SONNET_INPUT_RATE = 3.0;
const SONNET_OUTPUT_RATE = 15.0;

// Load text extraction system prompt (designed for single-turn stateless extraction)
const TEXT_SYSTEM_PROMPT = fssync.readFileSync(
  path.join(__dirname, '..', 'config', 'prompts', 'gemini_text_system.md'),
  'utf8'
);

/**
 * Call Sonnet with transcript TEXT (no audio) + context and return structured extraction.
 * Used by the Deepgram+Sonnet hybrid pipeline where Deepgram handles transcription
 * and Sonnet handles structured extraction from the transcript text.
 *
 * Replaces geminiExtractFromText — identical interface.
 *
 * @param {string} transcriptText - Rolling window of transcript text (~5000 chars)
 * @param {string} contextText - Filled fields + orphans context
 * @returns {Promise<Object>} { circuits, supply, installation, board, orphaned_values, usage }
 */
export async function sonnetExtractFromText(transcriptText, contextText) {
  const apiKey = await getAnthropicKey();
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');

  const userMessage = `=== TRANSCRIPT ===
${transcriptText}

=== CONTEXT (already filled fields) ===
${contextText || 'No previous context.'}

Extract structured EICR data from the transcript above. Only extract NEW values not already present in the context.`;

  const body = {
    model: SONNET_MODEL,
    max_tokens: 4096,
    temperature: 0,
    system: TEXT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const start = Date.now();
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      const latencyMs = Date.now() - start;

      if (!res.ok) {
        const errBody = await res.text();
        // 529 (overloaded) and 429 (rate limit) are retryable
        if ((res.status === 529 || res.status === 429) && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
          logger.warn('Sonnet text extract retryable error', {
            status: res.status,
            attempt,
            delay,
          });
          await sleep(delay);
          continue;
        }
        throw new Error(`Anthropic HTTP ${res.status}: ${errBody.slice(0, 500)}`);
      }

      const json = await res.json();
      const text = (json.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      if (!text) throw new Error('Sonnet returned empty response');

      const inputTokens = json.usage?.input_tokens ?? 0;
      const outputTokens = json.usage?.output_tokens ?? 0;

      let parsed;
      try {
        // Strip markdown code blocks if present
        const jsonMatch =
          text.match(/```json\s*([\s\S]*?)```/) || text.match(/```\s*([\s\S]*?)```/);
        const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        throw new Error(`Sonnet returned invalid JSON: ${text.slice(0, 200)}`);
      }

      const cost =
        (inputTokens * SONNET_INPUT_RATE + outputTokens * SONNET_OUTPUT_RATE) / 1_000_000;

      logger.info('Sonnet text extract success', {
        model: SONNET_MODEL,
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
      if (attempt < MAX_RETRIES && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn('Sonnet text extract timeout, retrying', { attempt, delay });
        await sleep(delay);
        continue;
      }
    }
  }

  throw lastError;
}

/**
 * Transcribe audio with Deepgram, then extract structured data with Sonnet.
 * Replaces geminiExtract for the chunked audio pipeline.
 *
 * Identical interface to geminiExtract — callers need only update the import.
 *
 * @param {string} audioBase64 - Base64-encoded audio data
 * @param {string} audioMimeType - MIME type (audio/flac, audio/wav, etc.)
 * @param {string} contextText - Filled fields + orphans context
 * @param {string|null} previousAudioBase64 - Unused (Deepgram processes each chunk independently)
 * @param {string|null} previousAudioMimeType - Unused
 * @returns {Promise<Object>} { transcript, circuits, supply, installation, board, orphaned_values, usage }
 */
export async function sonnetExtractFromAudio(
  audioBase64,
  audioMimeType,
  contextText,
  previousAudioBase64 = null,
  previousAudioMimeType = null
) {
  const deepgramKey = await getDeepgramKey();
  if (!deepgramKey) throw new Error('Missing DEEPGRAM_API_KEY');

  // ── Step 1: Transcribe audio with Deepgram pre-recorded API ──────────────────
  const transcriptionStart = Date.now();
  const audioBuffer = Buffer.from(audioBase64, 'base64');

  const dgParams = new URLSearchParams({
    model: 'nova-3',
    language: 'en-GB',
    smart_format: 'true',
    punctuate: 'true',
    numerals: 'true',
    diarize: 'false',
  });

  // Add electrical keyterm boosts (matching iOS config)
  for (const kt of [
    'Ze:2',
    'Zs:2',
    'R1:2',
    'R2:2',
    'Rn:2',
    'PFC:2',
    'MCB:2',
    'RCBO:2',
    'RCD:2',
    'AFDD:2',
  ]) {
    dgParams.append('keyterm', kt);
  }

  const dgUrl = `https://api.deepgram.com/v1/listen?${dgParams.toString()}`;

  const dgRes = await fetch(dgUrl, {
    method: 'POST',
    headers: {
      Authorization: `Token ${deepgramKey}`,
      'Content-Type': audioMimeType || 'audio/flac',
    },
    body: audioBuffer,
    signal: AbortSignal.timeout(30_000),
  });

  if (!dgRes.ok) {
    const errBody = await dgRes.text();
    throw new Error(`Deepgram transcription HTTP ${dgRes.status}: ${errBody.slice(0, 300)}`);
  }

  const dgJson = await dgRes.json();
  const transcript = dgJson?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  const transcriptionLatencyMs = Date.now() - transcriptionStart;

  logger.info('Deepgram transcription complete (audio→Sonnet)', {
    latencyMs: transcriptionLatencyMs,
    transcriptLen: transcript.length,
    mimeType: audioMimeType,
  });

  // Empty transcript — return empty result without calling Sonnet
  if (!transcript.trim()) {
    return {
      transcript: '',
      circuits: [],
      supply: {},
      installation: {},
      board: {},
      orphaned_values: [],
      usage: { inputTokens: 0, outputTokens: 0, cost: 0, latencyMs: transcriptionLatencyMs },
    };
  }

  // ── Step 2: Extract structured data from transcript using Sonnet ─────────────
  const extraction = await sonnetExtractFromText(transcript, contextText);

  return {
    transcript,
    ...extraction,
    usage: {
      ...extraction.usage,
      latencyMs: extraction.usage.latencyMs + transcriptionLatencyMs,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
