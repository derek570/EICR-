import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { isUsingS3, downloadText, uploadText } from "./storage.js";

// Pricing per 1K tokens by model (updated January 2026)
// Sources: https://platform.openai.com/docs/pricing, https://ai.google.dev/gemini-api/docs/pricing
const PRICING = {
  // OpenAI GPT-5.2: $1.75/1M input, $14/1M output
  "gpt-5.2": { input: 0.00175, output: 0.014 },
  // Gemini 3 Pro Preview: $2/1M input, $12/1M output (≤200K context)
  "gemini-3-pro-preview": { input: 0.002, output: 0.012 },
  // Gemini 2.5 Pro: $1.25/1M input, $10/1M output (≤200K context)
  "gemini-2.5-pro": { input: 0.00125, output: 0.01 },
  // Gemini 2.5 Flash: $0.075/1M input, $0.30/1M output
  "gemini-2.5-flash": { input: 0.000075, output: 0.0003 },
  // Default fallback (use GPT-5.2 pricing)
  "default": { input: 0.00175, output: 0.014 }
};

const CSV_HEADERS = "timestamp,job_id,address,gemini_tokens,gemini_cost,gpt_tokens,gpt_cost,total_tokens,total_cost";

/**
 * Calculate cost based on token usage and model
 */
export function calculateCost(inputTokens, outputTokens, model = "default") {
  const pricing = PRICING[model] || PRICING["default"];
  const inputCost = (inputTokens / 1000) * pricing.input;
  const outputCost = (outputTokens / 1000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * Create a token accumulator for tracking usage across a job
 * Tracks usage separately by model for accurate cost calculation
 */
export function createTokenAccumulator() {
  return {
    entries: [], // Array of { model, inputTokens, outputTokens }

    add(usage, model) {
      if (!usage) return;

      // Support both OpenAI format (prompt_tokens) and Gemini format (promptTokenCount)
      const inputTokens = usage.prompt_tokens || usage.promptTokenCount || 0;
      const outputTokens = usage.completion_tokens || usage.candidatesTokenCount || 0;

      if (inputTokens || outputTokens) {
        this.entries.push({ model: model || "unknown", inputTokens, outputTokens });
      }
    },

    getTotals() {
      let geminiTokens = 0;
      let geminiCost = 0;
      let gptTokens = 0;
      let gptCost = 0;

      for (const entry of this.entries) {
        const tokens = entry.inputTokens + entry.outputTokens;
        const cost = calculateCost(entry.inputTokens, entry.outputTokens, entry.model);

        if (entry.model && entry.model.startsWith("gemini")) {
          geminiTokens += tokens;
          geminiCost += cost;
        } else {
          gptTokens += tokens;
          gptCost += cost;
        }
      }

      return {
        geminiTokens,
        geminiCost,
        gptTokens,
        gptCost,
        totalTokens: geminiTokens + gptTokens,
        totalCost: geminiCost + gptCost
      };
    }
  };
}

/**
 * Escape a value for CSV output
 */
function escapeCsv(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Append a usage record to the token usage CSV
 * Shows Gemini cost, GPT cost, and total per certificate
 * Stores in S3 when running in cloud mode, local filesystem otherwise
 */
export async function logTokenUsage({ dataDir, jobId, address, geminiTokens, geminiCost, gptTokens, gptCost, totalTokens, totalCost }) {
  const row = [
    new Date().toISOString(),
    escapeCsv(jobId),
    escapeCsv(address),
    geminiTokens,
    geminiCost.toFixed(6),
    gptTokens,
    gptCost.toFixed(6),
    totalTokens,
    totalCost.toFixed(6)
  ].join(",");

  if (isUsingS3()) {
    // S3 mode: download existing CSV, append row, upload back
    const s3Key = "token_usage.csv";
    let csvContent = await downloadText(s3Key);

    if (csvContent) {
      // Append to existing
      csvContent = csvContent.trimEnd() + "\n" + row + "\n";
    } else {
      // Create new with headers
      csvContent = CSV_HEADERS + "\n" + row + "\n";
    }

    await uploadText(csvContent, s3Key);
    return { csvPath: `s3://${process.env.S3_BUCKET}/${s3Key}`, totalTokens, totalCost };
  } else {
    // Local mode: write to filesystem
    const csvPath = path.join(dataDir, "token_usage.csv");

    if (!fssync.existsSync(csvPath)) {
      await fs.writeFile(csvPath, CSV_HEADERS + "\n" + row + "\n", "utf8");
    } else {
      await fs.appendFile(csvPath, row + "\n", "utf8");
    }

    return { csvPath, totalTokens, totalCost };
  }
}
