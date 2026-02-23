/**
 * Generate structured bug reports from verbal debug segments.
 *
 * Uses Gemini (consistent with the rest of the pipeline) to analyse the
 * debug transcript and produce a JSON bug report + markdown summary,
 * then saves both to S3 under debug-reports/{userId}/{timestamp}/.
 */

import { getGeminiKey } from "./services/secrets.js";
import * as storage from "./storage.js";
import logger from "./logger.js";

const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-3-pro-preview").trim();
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

/**
 * Generate and save debug reports for all segments in a session.
 * Called from saveSession — fire-and-forget (errors logged, not thrown).
 */
export async function generateAndSaveDebugReports(session) {
  for (const segment of session.debugSegments) {
    try {
      const report = await generateReport(segment, session);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const prefix = `debug-reports/${session.userId}/${timestamp}`;

      await Promise.all([
        storage.uploadJson(report.json, `${prefix}/debug_report.json`),
        storage.uploadText(report.markdown, `${prefix}/debug_report.md`),
        storage.uploadJson({
          userId: session.userId,
          jobId: session.jobId,
          address: session.address,
          sessionId: session.sessionId,
          accumulatedTranscript: (session.preDebugContext || session.eicrBuffer?.fullText || session.geminiFullTranscript || "").slice(-2000),
        }, `${prefix}/context.json`),
      ]);

      logger.info("Debug report saved", { prefix, severity: report.json.severity, title: report.json.title });
    } catch (err) {
      logger.error("Failed to generate/save debug report", {
        userId: session.userId,
        segment: segment.transcript?.substring(0, 100),
        error: err.message,
      });
    }
  }
}

async function generateReport(segment, session) {
  const apiKey = await getGeminiKey();
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY for debug report generation");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const prompt = `You are a bug report generator for CertMate, an electrical certificate app.

An electrician verbally described a problem mid-recording. Produce a structured bug report.

## Debug Transcript
"${segment.transcript}"

## Job Context
- Address: ${session.address || "Unknown"}
- Certificate type: ${session.certificateType || "EICR"}
- Session ID: ${session.sessionId || "unknown"}
${segment.autoClosedOnSessionEnd ? "- Note: Debug auto-closed (user forgot \"end debug\")" : ""}

## Certificate Transcript (for context)
"${(session.preDebugContext || session.eicrBuffer?.fullText || session.geminiFullTranscript || "").slice(-500)}"

## CRITICAL: Two-Tier Extraction Architecture

**Tier 1 — On-Device Regex (Early Sniper):**
- File: TranscriptFieldMatcher.swift on iOS
- Runs instantly for immediate field population via pattern matching
- Example: "Ze is 0.31" → regex fills ze field immediately
- Only catches predictable phrasings

**Tier 2 — Gemini API (Heavy Lifting):**
- Files: src/transcribe.js (transcription), src/extract.js (extraction) — both use Gemini
- Runs on accumulated transcript with full context
- Handles unusual phrasing, ambiguity, photo cross-referencing
- The extraction prompt in extract.js tells Gemini what fields to extract and how

When categorising:
- Value not appearing DURING recording → likely Tier 1 regex issue
- Value not appearing AFTER full processing → likely Tier 2 Gemini extraction prompt
- Transcript itself is wrong/garbled → Gemini transcription issue

## Codebase Files
- Tier 1 regex: TranscriptFieldMatcher.swift
- Tier 2 transcription: src/transcribe.js (Gemini with rolling context)
- Tier 2 extraction: src/extract.js (Gemini structured extraction)
- Tier 2 chunk extraction: src/extract_chunk.js
- Tier 2 photo analysis: src/analyze_photos.js
- Backend API: src/api.js
- Field schema: config/field_schema.json
- iOS views: Sources/ViewModels/, Sources/Views/

## Output (JSON only)
{
  "title": "Brief bug title (max 80 chars)",
  "severity": "low|medium|high|critical",
  "category": "regex|transcription|extraction|ui|pdf|sync|other",
  "tier": "1_regex|2_extraction|2_transcription|frontend|backend|unknown",
  "problem_description": "Clear description",
  "steps_to_reproduce": ["Step 1", "Step 2"],
  "expected_behaviour": "What should happen",
  "actual_behaviour": "What actually happened",
  "affected_fields": ["exact_field_names from config/field_schema.json"],
  "affected_circuits": [],
  "affected_files": ["src/extract.js"],
  "suggested_fix": "What to investigate or change",
  "auto_fixable": true,
  "raw_transcript": "verbatim debug transcript"
}

## auto_fixable Decision Guide

Set "auto_fixable": true for:
- Missing or incorrect regex patterns in TranscriptFieldMatcher.swift
- Gemini extraction prompt needs a field-specific tweak
- Simple field mapping issues (field name mismatch in api.js or extract.js)
- Missing default values
- Simple UI display bugs

Set "auto_fixable": false ONLY for:
- Structural changes to the extraction prompt that could break OTHER field extractions
- Changes to the rolling context window logic in transcribe.js
- Changes that affect the Gemini transcription model or parameters
- Complex multi-file architectural changes
- Anything that fundamentally changes how extraction works for all jobs`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const errBody = await res.text();
        if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
          logger.warn("Debug report Gemini retryable error", { status: res.status, attempt, delay });
          await new Promise(r => setTimeout(r, delay));
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

      if (!text) throw new Error("Gemini returned empty response for debug report");

      const parsed = JSON.parse(text);
      const markdown = formatMarkdown(parsed, session.address);
      return { json: parsed, markdown };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

function formatMarkdown(report, address) {
  return `# Bug Report: ${report.title}

**Severity:** ${(report.severity || "unknown").toUpperCase()}
**Category:** ${report.category || "unknown"}
**Tier:** ${report.tier || "unknown"}
**Auto-fixable:** ${report.auto_fixable ? "Yes" : "No — needs review"}
**Job:** ${address || "Unknown"}
**Generated:** ${new Date().toISOString()}

## Problem
${report.problem_description || "No description provided."}

## Steps to Reproduce
${(report.steps_to_reproduce || []).map((s, i) => `${i + 1}. ${s}`).join("\n") || "Not specified."}

## Expected Behaviour
${report.expected_behaviour || "Not specified."}

## Actual Behaviour
${report.actual_behaviour || "Not specified."}

## Affected Fields
${(report.affected_fields || []).map(f => `- \`${f}\``).join("\n") || "None specified."}

${report.affected_circuits?.length ? `## Affected Circuits\n${report.affected_circuits.map(c => `- Circuit ${c}`).join("\n")}` : ""}

## Likely Files to Investigate
${(report.affected_files || []).map(f => `- \`${f}\``).join("\n") || "None specified."}

## Suggested Fix
${report.suggested_fix || "Needs investigation."}

## Raw Debug Transcript
> ${report.raw_transcript || "Not available."}

---
*Auto-generated by CertMate Debug Audio feature*
`;
}
