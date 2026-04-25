#!/usr/bin/env node
/**
 * analyze-session.js — Pre-processor for CertMate v2 session analytics.
 *
 * Parses JSONL debug log + field_sources.json + manifest.json and generates
 * a structured analysis.json for Claude Code consumption.
 *
 * Usage:
 *   node analyze-session.js /path/to/session-analytics-dir/
 *
 * The directory must contain:
 *   - debug_log.jsonl
 *   - field_sources.json
 *   - manifest.json
 *
 * Outputs: analysis.json in the same directory.
 */

import fs from "node:fs";
import path from "node:path";

// ── Helpers ──

/**
 * Parse a JSONL file into an array of objects PLUS a `_warnings` array
 * tracking lines that looked like JSON but failed to parse.
 *
 * Phase 8 Plan 08-01 SC #1 — soft-fail on malformed events. Pre-fix,
 * malformed lines were silently dropped via .filter(Boolean). A truncated
 * debug_log.jsonl (network drop / disk full mid-write) would silently
 * lose a row; downstream consumers had no way to know. Post-fix, the
 * analyzer surfaces these as `warnings` entries in analysis.json so the
 * optimizer + reviewer can see something went wrong without changing
 * the silent-drop behaviour for fully-empty / non-JSON-shaped lines
 * (those stay invisible — they were never log rows to begin with).
 *
 * Two-tier classification:
 *   - empty / pure-whitespace line → silently skip (legacy contract)
 *   - looks like JSON (starts with `{`) but parse fails → push warning
 *     entry of shape {type:'malformed_event', line:<n>, snippet:<60-char-prefix>}
 *     and skip the row
 *   - parses cleanly → include in events
 */
function parseJSONL(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const events = [];
  const warnings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Only warn on lines that LOOK like JSON. Random non-JSON detritus
      // (e.g. a stray printf to stdout that ended up in the log) stays
      // silent to preserve the legacy contract.
      if (line.trimStart().startsWith("{")) {
        warnings.push({
          type: "malformed_event",
          line: i + 1, // 1-indexed for human readability
          snippet: line.slice(0, 60),
        });
      }
    }
  }

  // Stash warnings on the array via a non-enumerable property so existing
  // call sites (which iterate `events` as a plain array) see no behaviour
  // change. analyzeSession() reads `events._warnings` to merge into the
  // analysis.json `warnings` field.
  Object.defineProperty(events, "_warnings", {
    value: warnings,
    enumerable: false,
  });
  return events;
}

function loadJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Number patterns that indicate a measurement value was spoken
// Matches decimals (0.35, 1.82), integers (200, 32), and > prefixed (>200)
const NUMBER_PATTERN = /(?:>?\d+\.\d+|>?\d{1,5})/g;

// Words/phrases that indicate this is general conversation, not a measurement
const CONVERSATION_INDICATORS = [
  "how are you", "thank you", "thanks", "cheers", "morning", "afternoon",
  "hello", "hi there", "no worries", "cup of tea", "coffee", "lunch",
  "weather", "traffic", "parking", "wife", "husband", "kids",
  "okay so", "right then", "let me just", "bear with",
  "customer", "tenant", "landlord", "estate agent", "letting agent",
];

// Electrical terms that indicate a measurement was spoken
const ELECTRICAL_TERMS = [
  "zs", "ze", "r1", "r2", "rn", "r1r2", "r1+r2",
  "pfc", "rcd", "insulation", "continuity", "polarity",
  "ohm", "ohms", "megohm", "milliohm",
  "mcb", "rcbo", "rccb", "afdd",
  "circuit", "ring", "radial", "spur",
  "live", "neutral", "earth", "cpc",
  "trip", "fault", "impedance", "resistance",
  "amp", "amps", "volt", "volts",
  "bonding", "earthing", "tns", "tncs", "tt",
];

// Map field keys to spoken keywords an electrician would use
function getFieldKeywords(fieldKey) {
  // Strip circuit prefix (e.g., "circuit.1.zs" → "zs")
  const parts = fieldKey.split(".");
  const field = parts[parts.length - 1];

  const keywordMap = {
    zs: ["zs", "loop impedance", "impedance"],
    ze: ["ze", "external earth", "external impedance"],
    pfc: ["pfc", "prospective fault", "fault current"],
    r1r2: ["r1 plus r2", "r1+r2", "r1 r2", "continuity"],
    r2: ["r2", "cpc"],
    irLE: ["insulation", "live earth", "live to earth", "ir"],
    irLL: ["live to live", "live live", "l to l"],
    rcd: ["rcd", "trip time", "trip"],
    ringR1: ["ring r1", "r1", "lives"],
    ringRn: ["ring rn", "rn", "neutrals"],
    ringR2: ["ring r2", "earths", "cpc"],
    ocpdRating: ["rating", "amp", "amps"],
    ocpdType: ["type b", "type c", "type d", "mcb", "rcbo"],
    cableSize: ["cable", "cable size", "mm", "two point five", "1.5", "2.5", "4.0", "6.0"],
    earthing: ["earthing", "tns", "tncs", "tt", "pme"],
    polarity: ["polarity"],
    address: ["address", "property"],
    clientName: ["client", "customer", "name"],
    circuitDescription: ["circuit", "description", "designation"],
  };

  return keywordMap[field] || [field.toLowerCase().replace(/_/g, " ")];
}

// ── Main Analysis ──

function analyzeSession(sessionDir) {
  const debugLogPath = path.join(sessionDir, "debug_log.jsonl");
  const fieldSourcesPath = path.join(sessionDir, "field_sources.json");
  const manifestPath = path.join(sessionDir, "manifest.json");

  if (!fs.existsSync(debugLogPath)) {
    console.error(`Error: debug_log.jsonl not found in ${sessionDir}`);
    process.exit(1);
  }

  const jobSnapshotPath = path.join(sessionDir, "job_snapshot.json");
  const costSummaryPath = path.join(sessionDir, "cost_summary.json");

  const events = parseJSONL(debugLogPath);
  const fieldSources = fs.existsSync(fieldSourcesPath) ? loadJSON(fieldSourcesPath) : {};
  const manifest = fs.existsSync(manifestPath) ? loadJSON(manifestPath) : {};
  const jobSnapshot = fs.existsSync(jobSnapshotPath) ? loadJSON(jobSnapshotPath) : null;
  const costSummary = fs.existsSync(costSummaryPath) ? loadJSON(costSummaryPath) : null;

  // ── 1. Build field report ──

  // Group field events by key
  const fieldHistory = {}; // key -> [{event, timestamp, value, source}]
  for (const evt of events) {
    if (!evt.data) continue;
    const key = evt.data?.key;
    if (!key) continue;

    if (["field_set", "field_update", "discrepancy_overwrite"].includes(evt.event)) {
      if (!fieldHistory[key]) fieldHistory[key] = [];

      const entry = {
        event: evt.event,
        timestamp: evt.timestamp,
        category: evt.category,
      };

      if (evt.event === "discrepancy_overwrite") {
        entry.regex_value = evt.data.regex_value;
        entry.sonnet_value = evt.data.sonnet_value;
      } else {
        entry.value = evt.data.value || evt.data.new || "";
        if (evt.data.old) entry.old_value = evt.data.old;
      }

      fieldHistory[key].push(entry);
    }
  }

  const fieldReport = [];
  const allFieldKeys = new Set([...Object.keys(fieldHistory), ...Object.keys(fieldSources)]);

  for (const key of allFieldKeys) {
    const history = fieldHistory[key] || [];
    const finalSource = fieldSources[key] || "unknown";

    const regexEvents = history.filter((h) => h.category === "regex");
    const sonnetEvents = history.filter((h) => h.category === "sonnet");
    const discrepancies = history.filter((h) => h.event === "discrepancy_overwrite");

    const regexValue = regexEvents.length > 0
      ? regexEvents[regexEvents.length - 1].value
        || regexEvents[regexEvents.length - 1].new
        || regexEvents[regexEvents.length - 1].regex_value
      : null;
    const sonnetValue = sonnetEvents.length > 0
      ? sonnetEvents[sonnetEvents.length - 1].value
        || sonnetEvents[sonnetEvents.length - 1].new
        || sonnetEvents[sonnetEvents.length - 1].sonnet_value
      : null;

    const entry = {
      key,
      final_source: finalSource,
      final_value: sonnetValue || regexValue || "",
      was_overwritten: discrepancies.length > 0,
    };

    if (regexValue) {
      entry.regex_value = regexValue;
      entry.regex_set_at = regexEvents[0]?.timestamp;
    }
    if (sonnetValue) {
      entry.sonnet_value = sonnetValue;
      entry.sonnet_set_at = sonnetEvents[0]?.timestamp;
    }
    if (discrepancies.length > 0) {
      entry.note = "Sonnet corrected regex value";
    }

    fieldReport.push(entry);
  }

  // ── 2. Regex performance ──

  const regexAttempts = events.filter((e) => e.event === "regex_attempt");
  const regexFieldSets = events.filter(
    (e) => e.category === "regex" && (e.event === "field_set" || e.event === "field_update")
  );
  const sonnetFieldSets = events.filter(
    (e) => e.category === "sonnet" && (e.event === "field_set" || e.event === "field_update")
  );
  const discrepancyOverwrites = events.filter((e) => e.event === "discrepancy_overwrite");

  // Fields that regex matched
  const regexFieldKeys = new Set(regexFieldSets.map((e) => e.data?.key).filter(Boolean));
  // Fields that sonnet matched
  const sonnetFieldKeys = new Set(sonnetFieldSets.map((e) => e.data?.key).filter(Boolean));
  // Fields sonnet caught but regex missed
  const sonnetOnlyKeys = [...sonnetFieldKeys].filter((k) => !regexFieldKeys.has(k));
  // Fields where regex was later corrected by sonnet
  const correctedBySONnet = discrepancyOverwrites.map((e) => e.data?.key).filter(Boolean);

  // Find transcript utterances that mention electrical terms but no field was matched nearby
  const utterances = events.filter((e) => e.event === "transcript_utterance");
  const unmatchedSegments = [];
  for (const utt of utterances) {
    const text = (utt.data?.normalised_text || utt.data?.text || "").toLowerCase();
    const hasElectricalTerm = ELECTRICAL_TERMS.some((term) => text.includes(term));
    if (hasElectricalTerm) {
      // Check if any field was set within ~2s of this utterance
      const uttTime = new Date(utt.timestamp).getTime();
      const nearbyFieldSets = [...regexFieldSets, ...sonnetFieldSets].filter((e) => {
        const evtTime = new Date(e.timestamp).getTime();
        return Math.abs(evtTime - uttTime) < 5000;
      });
      if (nearbyFieldSets.length === 0) {
        unmatchedSegments.push(utt.data?.normalised_text || utt.data?.text || "");
      }
    }
  }

  const regexPerformance = {
    total_regex_attempts: regexAttempts.length,
    total_fields_matched: regexFieldKeys.size,
    fields_later_corrected_by_sonnet: correctedBySONnet.length,
    fields_sonnet_caught_but_regex_missed: sonnetOnlyKeys.length,
    sonnet_only_fields: sonnetOnlyKeys,
    corrected_fields: correctedBySONnet,
    unmatched_transcript_segments: unmatchedSegments.slice(0, 20), // cap at 20
  };

  // ── 3. Sonnet performance ──

  // v2 pipeline: server-side extraction logs 'server_extraction_received' on iOS
  // v1 pipeline (legacy): on-device extraction logged 'sonnet_input'/'sonnet_output'
  const serverExtractions = events.filter((e) => e.event === "server_extraction_received");
  const sonnetInputs = serverExtractions.length > 0 ? serverExtractions : events.filter((e) => e.event === "sonnet_input");
  const sonnetOutputs = serverExtractions.length > 0 ? serverExtractions : events.filter((e) => e.event === "sonnet_output");

  const latencies = sonnetOutputs
    .map((e) => e.data?.latency_ms)
    .filter((v) => typeof v === "number");
  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;

  const totalReadings = sonnetOutputs.reduce(
    (sum, e) => sum + (e.data?.readings_count || 0), 0
  );

  // Unmapped fields (Sonnet extracted but couldn't map to job model)
  const unmappedEvents = events.filter(
    (e) => e.category === "sonnet" && e.event === "unmapped_field"
  );
  const unmappedFields = [...new Set(unmappedEvents.map((e) => e.data?.field).filter(Boolean))];

  const sonnetPerformance = {
    total_calls: sonnetInputs.length,
    total_readings_extracted: totalReadings,
    average_latency_ms: avgLatency,
    total_cost_usd: parseFloat(manifest.sonnetCostUSD || "0"),
    unmapped_fields: unmappedFields,
  };

  // If server-side cost_summary.json exists, use its more accurate cost data
  if (costSummary) {
    sonnetPerformance.server_side = true;
    sonnetPerformance.total_cost_usd = costSummary.totalJobCost || sonnetPerformance.total_cost_usd;
    sonnetPerformance.sonnet_cost = costSummary.sonnet || {};
    sonnetPerformance.deepgram_cost = costSummary.deepgram || {};
    sonnetPerformance.total_turns = costSummary.extraction?.turns || sonnetPerformance.total_calls;
    sonnetPerformance.compactions = costSummary.extraction?.compactions || 0;
    sonnetPerformance.total_readings_extracted = costSummary.extraction?.readingsExtracted || sonnetPerformance.total_readings_extracted;
  }

  // ── 4. Transcript issues ──

  const transcriptIssues = [];
  for (const utt of utterances.slice(0, 50)) { // cap analysis at 50 utterances
    const raw = utt.data?.text || "";
    const normalised = utt.data?.normalised_text || "";
    if (raw !== normalised && raw.length > 0) {
      transcriptIssues.push({
        utterance: raw,
        normalised: normalised,
        potential_misheard: false, // Could be enhanced with pattern detection
      });
    }
  }

  // ── 5. Empty fields ──

  // Get final transcript to check what was spoken
  const finalTranscriptEvt = events.find(
    (e) => e.event === "final_transcript" && e.category === "session"
  );
  const fullTranscriptOriginal = finalTranscriptEvt?.data?.transcript || "";
  const fullTranscript = fullTranscriptOriginal.toLowerCase();

  // Build expected field keys from circuits and supply
  const emptyFields = [];
  const circuitCount = manifest.circuitCount || 0;
  const expectedCircuitFields = [
    "zs", "r1r2", "irLE", "irLL", "rcd", "ringR1", "ringRn", "ringR2",
    "ocpdRating", "ocpdType", "cableSize",
  ];
  const expectedSupplyFields = ["ze", "pfc", "earthing"];

  for (let i = 1; i <= circuitCount; i++) {
    for (const field of expectedCircuitFields) {
      const key = `circuit.${i}.${field}`;
      if (!fieldSources[key] && !fieldHistory[key]) {
        // Check if related terms were spoken
        const fieldTerms = {
          zs: ["zs", "impedance", "loop impedance"],
          r1r2: ["r1", "r2", "r1+r2", "continuity"],
          irLE: ["insulation", "live earth", "ir"],
          irLL: ["live to live", "live live"],
          rcd: ["rcd", "trip time"],
          ringR1: ["ring", "r1"],
          ringRn: ["rn"],
          ringR2: ["ring r2"],
          ocpdRating: ["rating", "amp"],
          ocpdType: ["type", "mcb", "rcbo"],
          cableSize: ["cable", "mm"],
        };
        const terms = fieldTerms[field] || [];
        const circuitMentioned = fullTranscript.includes(`circuit ${i}`);
        const termMentioned = terms.some((t) => fullTranscript.includes(t));

        let reason = "not_spoken";
        if (circuitMentioned && termMentioned) {
          reason = "regex_missed_sonnet_missed";
        } else if (!circuitMentioned) {
          reason = "circuit_not_mentioned";
        }

        emptyFields.push({ key, reason });
      }
    }
  }

  for (const field of expectedSupplyFields) {
    const key = `supply.${field}`;
    if (!fieldSources[key] && !fieldHistory[key]) {
      emptyFields.push({ key, reason: "not_spoken" });
    }
  }

  // ── 6. Debug issues ──

  const debugIssueStarts = events.filter((e) => e.event === "debug_issue_start");
  const debugIssueCaptured = events.filter((e) => e.event === "debug_issue_captured");
  const debugIssueAutoClosed = events.filter((e) => e.event === "debug_issue_auto_closed");
  const debugIssuesSent = events.filter((e) => e.event === "debug_issues_sent");
  const runtimePatternInjected = events.filter((e) => e.event === "runtime_pattern_injected");

  const debugIssuesList = [];

  // Build issues from captured events (includes single-utterance and multi-utterance)
  for (const captured of debugIssueCaptured) {
    const issueText = captured.data?.issue || "";
    if (!issueText) continue;

    // Find matching start event (by proximity — start comes before captured)
    const capturedTime = new Date(captured.timestamp).getTime();
    const matchingStart = debugIssueStarts.find((s) => {
      const startTime = new Date(s.timestamp).getTime();
      return startTime <= capturedTime && capturedTime - startTime < 120_000; // within 2 minutes
    });

    // Check if this issue was sent to Sonnet
    const wasSentToSonnet = debugIssuesSent.some((s) => {
      const issues = s.data?.issues || "";
      return issues.includes(issueText.substring(0, 30)); // partial match
    });

    // Check if a hot-fix pattern was injected for this issue
    // Match by looking for runtime_pattern_injected events after this capture
    const hotFixPatterns = runtimePatternInjected.filter((p) => {
      const patternTime = new Date(p.timestamp).getTime();
      return patternTime >= capturedTime && patternTime - capturedTime < 60_000;
    });

    const entry = {
      issue_text: issueText,
      reported_at: matchingStart?.timestamp || captured.timestamp,
      resolved_by_sonnet: wasSentToSonnet,
      hot_fix_injected: hotFixPatterns.length > 0,
    };

    if (hotFixPatterns.length > 0) {
      entry.hot_fix_field = hotFixPatterns[0].data?.field || null;
      entry.hot_fix_pattern = hotFixPatterns[0].data?.pattern || null;
    }

    debugIssuesList.push(entry);
  }

  // Also include auto-closed issues (user stopped recording before saying "end debug")
  for (const autoClosed of debugIssueAutoClosed) {
    const issueText = autoClosed.data?.issue || "";
    if (!issueText) continue;
    // Avoid duplicates with captured issues
    if (debugIssuesList.some((d) => d.issue_text === issueText)) continue;
    debugIssuesList.push({
      issue_text: issueText,
      reported_at: autoClosed.timestamp,
      resolved_by_sonnet: false,
      hot_fix_injected: false,
      auto_closed: true,
    });
  }

  const debugIssues = {
    total_reported: debugIssuesList.length,
    issues: debugIssuesList,
    auto_closed: debugIssueAutoClosed.length,
    total_hot_fixes: runtimePatternInjected.length,
  };

  // ── 7. Regex opportunities ──
  // For each field set by Sonnet (not regex), check if the transcript contains a
  // clear spoken pattern that a regex could have matched.

  const regexOpportunities = [];
  for (const entry of fieldReport) {
    if (entry.final_source !== "sonnet") continue;
    if (!entry.sonnet_value) continue;

    // Search utterances for a phrase that contains both a field keyword and the value
    const fieldKeywords = getFieldKeywords(entry.key);
    const value = String(entry.sonnet_value).toLowerCase();

    for (const utt of utterances) {
      const text = (utt.data?.normalised_text || utt.data?.text || "").toLowerCase();
      const matchedKeyword = fieldKeywords.find((kw) => text.includes(kw));
      if (matchedKeyword && text.includes(value)) {
        // Suggest a regex pattern based on the spoken phrase
        const escapedKw = matchedKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escapedVal = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        regexOpportunities.push({
          field: entry.key,
          value: entry.sonnet_value,
          spoken_phrase: (utt.data?.normalised_text || utt.data?.text || "").substring(0, 120),
          pattern_suggestion: `${escapedKw}[\\s:]+([\\d.>]+)`,
        });
        break; // One match per field is enough
      }
    }
  }

  // ── 8. Sonnet prompt stats ──
  // Read the eicr-extraction-session.js to estimate system prompt size.

  let sonnetPromptStats = { estimated_tokens: 0, field_count_in_prompt: 0, rules_count: 0 };
  try {
    const extractionSessionPath = path.resolve(
      decodeURIComponent(path.dirname(new URL(import.meta.url).pathname)),
      "../src/extraction/eicr-extraction-session.js"
    );
    const extractionSource = fs.readFileSync(extractionSessionPath, "utf8");

    // Extract the EICR_SYSTEM_PROMPT string content between the backticks
    const promptMatch = extractionSource.match(
      /export const EICR_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`;/
    );
    if (promptMatch) {
      const promptText = promptMatch[1];
      const estimatedTokens = Math.ceil(promptText.length / 4);

      // Count field definitions (lines like "- field_name:" in CIRCUIT FIELDS and SUPPLY FIELDS)
      const fieldLines = promptText.match(/^- \w[\w_]+:/gm) || [];

      // Count major rule sections (lines starting with all-caps words followed by colon)
      const ruleSections = promptText.match(/^[A-Z][A-Z _]+(?:\([^)]+\))?:/gm) || [];

      sonnetPromptStats = {
        estimated_tokens: estimatedTokens,
        field_count_in_prompt: fieldLines.length,
        rules_count: ruleSections.length,
      };
    }
  } catch (err) {
    console.warn(`Could not read eicr-extraction-session.js for prompt stats: ${err.message}`);
  }

  // ── 9. Extraction efficiency ──

  const sonnetCalls = sonnetPerformance.total_calls || 0;
  const sonnetFieldCount = sonnetFieldKeys.size;
  const totalCost = sonnetPerformance.total_cost_usd || 0;

  const extractionEfficiency = {
    sonnet_calls: sonnetCalls,
    fields_per_call: sonnetCalls > 0
      ? parseFloat((sonnetFieldCount / sonnetCalls).toFixed(2))
      : 0,
    cost_per_field_usd: sonnetFieldCount > 0
      ? parseFloat((totalCost / sonnetFieldCount).toFixed(6))
      : 0,
  };

  // ── 10. Utterance-level analysis ──
  // Correlate each transcript_utterance with field_set/field_update events by timestamp.
  // Tag which fields were extracted by regex and/or Sonnet.
  // Flag utterances containing number patterns but no corresponding field_set events.

  const allFieldEvents = events.filter(
    (e) => ["field_set", "field_update", "discrepancy_overwrite"].includes(e.event) && e.data?.key
  );

  // Track spoken values across utterances for repeat detection
  const spokenValueTracker = {}; // "fieldHint:value" -> count

  const utteranceAnalysis = utterances.map((utt) => {
    const text = utt.data?.normalised_text || utt.data?.text || "";
    const textLower = text.toLowerCase();
    const uttTime = new Date(utt.timestamp).getTime();
    const WINDOW_MS = 3000;

    // Find field events within +-3s of this utterance
    const nearbyFieldEvents = allFieldEvents.filter((e) => {
      const evtTime = new Date(e.timestamp).getTime();
      return Math.abs(evtTime - uttTime) < WINDOW_MS;
    });

    // Separate by source category
    const regexCaptures = nearbyFieldEvents
      .filter((e) => e.category === "regex")
      .map((e) => ({
        field: e.data.key,
        value: e.data.value || e.data.new || "",
      }));

    const sonnetCaptures = nearbyFieldEvents
      .filter((e) => e.category === "sonnet")
      .map((e) => {
        const evtTime = new Date(e.timestamp).getTime();
        return {
          field: e.data.key,
          value: e.data.value || e.data.new || "",
          latency_ms: evtTime - uttTime,
        };
      });

    // Detect conversation vs measurement utterance
    const isConversation =
      CONVERSATION_INDICATORS.some((phrase) => textLower.includes(phrase)) &&
      !ELECTRICAL_TERMS.some((term) => textLower.includes(term));

    // Extract all number patterns from the utterance text
    const numberMatches = textLower.match(NUMBER_PATTERN) || [];
    const capturedValues = new Set(
      [...regexCaptures, ...sonnetCaptures].map((c) => String(c.value).toLowerCase())
    );
    // Uncaptured = numbers in speech that no field event captured
    const uncapturedValues = numberMatches.filter((num) => {
      // Skip very small integers that are likely circuit numbers or ordinals
      const n = parseFloat(num.replace(">", ""));
      if (Number.isInteger(n) && n >= 1 && n <= 20 && !num.includes(".")) return false;
      return !capturedValues.has(num) && !capturedValues.has(num.replace(">", ""));
    });

    // Track for repeat detection
    let repeatCount = 0;
    if (!isConversation) {
      for (const num of numberMatches) {
        const contextTerms = ELECTRICAL_TERMS.filter((t) => textLower.includes(t));
        const hint = contextTerms.length > 0 ? contextTerms[0] : "_any";
        const trackKey = `${hint}:${num}`;
        spokenValueTracker[trackKey] = (spokenValueTracker[trackKey] || 0) + 1;
        if (spokenValueTracker[trackKey] > 1) {
          repeatCount = Math.max(repeatCount, spokenValueTracker[trackKey]);
        }
      }
    }

    return {
      timestamp: utt.timestamp,
      text: text,
      regex_captures: regexCaptures,
      sonnet_captures: sonnetCaptures,
      uncaptured_values: uncapturedValues,
      is_conversation: isConversation,
      repeat_count: repeatCount,
    };
  });

  // ── 11. Cost breakdown ──
  // Comprehensive cost breakdown across all services, including GPT Vision estimate.

  const sonnetCostData = costSummary?.sonnet || {};
  const deepgramCostData = costSummary?.deepgram || {};
  const elevenLabsCostData = costSummary?.elevenlabs || {};

  // Prefer iOS-reported streaming minutes (accurate, excludes VAD doze pauses)
  // over backend timer (which may not know about iOS-side pauses).
  const deepgramMinutes = manifest.deepgramStreamingMinutes
    || deepgramCostData.minutes
    || parseFloat(manifest.recordingDurationMin || "0");
  const DEEPGRAM_RATE = 0.0077;
  const deepgramCostUsd = deepgramMinutes * DEEPGRAM_RATE;

  const sonnetTokenBreakdown = {
    cache_read: sonnetCostData.cacheReads || 0,
    cache_write: sonnetCostData.cacheWrites || 0,
    input: sonnetCostData.input || 0,
    output: sonnetCostData.output || 0,
  };
  const sonnetCostUsd = sonnetCostData.cost || parseFloat(manifest.sonnetCostUSD || "0");
  const sonnetTurns = sonnetCostData.turns || costSummary?.extraction?.turns || sonnetPerformance.total_calls;
  const sonnetCompactions = sonnetCostData.compactions || costSummary?.extraction?.compactions || 0;

  const elevenLabsChars = elevenLabsCostData.characters || 0;
  const elevenLabsCostUsd = elevenLabsCostData.cost || 0;

  // GPT Vision cost estimate from job snapshot (count of CCU photos analysed)
  // GPT-4V: ~$0.01/image + ~$0.01/1K input tokens + $0.03/1K output tokens
  let gptVisionCostUsd = 0;
  let gptVisionPhotos = 0;

  if (costSummary?.gptVision?.photos > 0) {
    gptVisionCostUsd = costSummary.gptVision.cost || 0;
    gptVisionPhotos = costSummary.gptVision.photos || 0;
  } else if (jobSnapshot) {
    // Estimate from job data: count boards with photos
    const boards = jobSnapshot.boards || jobSnapshot.fuseboards || [];
    for (const board of boards) {
      const photos = board.photos || board.photoUrls || [];
      if (photos.length > 0) {
        gptVisionPhotos += photos.length;
      }
    }
    const GPT_VISION_COST_PER_PHOTO = 0.03;
    gptVisionCostUsd = gptVisionPhotos * GPT_VISION_COST_PER_PHOTO;
  }

  const totalCostUsd = deepgramCostUsd + sonnetCostUsd + gptVisionCostUsd + elevenLabsCostUsd;

  // Doze savings: compare actual streaming minutes to total session duration
  const sessionDurationMin = parseFloat(manifest.recordingDurationMin || "0");
  const dozeSavedMinutes = sessionDurationMin > 0 ? Math.max(0, sessionDurationMin - deepgramMinutes) : 0;
  const dozeSavedCostUsd = dozeSavedMinutes * DEEPGRAM_RATE;
  const hypotheticalDeepgramCostUsd = sessionDurationMin * DEEPGRAM_RATE;
  const dozeSavingsPercent = hypotheticalDeepgramCostUsd > 0
    ? parseFloat(((dozeSavedCostUsd / hypotheticalDeepgramCostUsd) * 100).toFixed(1))
    : 0;
  const streamingPercent = sessionDurationMin > 0
    ? parseFloat(((deepgramMinutes / sessionDurationMin) * 100).toFixed(1))
    : 100;

  const costBreakdown = {
    deepgram: {
      cost_usd: parseFloat(deepgramCostUsd.toFixed(6)),
      minutes: parseFloat(deepgramMinutes.toFixed(2)),
    },
    sonnet: {
      cost_usd: parseFloat(sonnetCostUsd.toFixed(6)),
      turns: sonnetTurns,
      compactions: sonnetCompactions,
      token_breakdown: sonnetTokenBreakdown,
    },
    gpt_vision: {
      cost_usd: parseFloat(gptVisionCostUsd.toFixed(6)),
      photos: gptVisionPhotos,
      estimated: !costSummary?.gptVision,
    },
    elevenlabs: {
      cost_usd: parseFloat(elevenLabsCostUsd.toFixed(6)),
      characters: elevenLabsChars,
    },
    total_usd: parseFloat(totalCostUsd.toFixed(6)),
    doze_savings: {
      session_duration_min: parseFloat(sessionDurationMin.toFixed(2)),
      streaming_min: parseFloat(deepgramMinutes.toFixed(2)),
      streaming_percent: streamingPercent,
      saved_min: parseFloat(dozeSavedMinutes.toFixed(2)),
      saved_usd: parseFloat(dozeSavedCostUsd.toFixed(4)),
      savings_percent: dozeSavingsPercent,
      hypothetical_deepgram_usd: parseFloat(hypotheticalDeepgramCostUsd.toFixed(4)),
    },
  };

  // ── 12. Sonnet prompt audit ──
  // Enhanced prompt analysis: token count, cost per session, suggested trims, warnings.

  const sonnetPromptAudit = {
    estimated_tokens: sonnetPromptStats.estimated_tokens,
    field_count_in_prompt: sonnetPromptStats.field_count_in_prompt,
    rules_count: sonnetPromptStats.rules_count,
    cost_per_session: 0,
    suggested_trims: [],
    warning: null,
  };

  if (sonnetPromptStats.estimated_tokens > 0) {
    const promptTokens = sonnetPromptStats.estimated_tokens;
    const turns = sonnetTurns || 1;
    // First call: cache_write ($6.00/M, 1-hour extended cache), subsequent: cache_read ($0.30/M)
    const firstCallCost = (promptTokens * 6.00) / 1_000_000;
    const cachedCallCost = (promptTokens * 0.30) / 1_000_000;
    const promptCostPerSession = firstCallCost + (Math.max(0, turns - 1) * cachedCallCost);
    sonnetPromptAudit.cost_per_session = parseFloat(promptCostPerSession.toFixed(6));

    if (promptTokens > 4000) {
      sonnetPromptAudit.warning = `System prompt is ~${promptTokens} tokens (>4000 threshold). Consider trimming to reduce cache write cost.`;
    }

    // Analyse prompt sections for trim suggestions
    try {
      const extractionSessionPath = path.resolve(
        decodeURIComponent(path.dirname(new URL(import.meta.url).pathname)),
        "../src/extraction/eicr-extraction-session.js"
      );
      const extractionSource = fs.readFileSync(extractionSessionPath, "utf8");
      const promptMatch = extractionSource.match(
        /export const EICR_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`;/
      );
      if (promptMatch) {
        const promptText = promptMatch[1];
        const sectionPattern = /^([A-Z][A-Z _]+(?:\([^)]+\))?):$/gm;
        let sMatch;
        const sections = [];
        while ((sMatch = sectionPattern.exec(promptText)) !== null) {
          sections.push({ name: sMatch[1], start: sMatch.index });
        }
        for (let i = 0; i < sections.length; i++) {
          const end = i + 1 < sections.length ? sections[i + 1].start : promptText.length;
          const sectionText = promptText.substring(sections[i].start, end);
          sections[i].tokens = Math.ceil(sectionText.length / 4);
        }
        sections.sort((a, b) => b.tokens - a.tokens);
        for (const section of sections.slice(0, 3)) {
          if (section.tokens > 200) {
            sonnetPromptAudit.suggested_trims.push({
              section: section.name,
              estimated_tokens: section.tokens,
              suggestion: `"${section.name}" is ~${section.tokens} tokens. Review for redundant examples or verbose rules.`,
            });
          }
        }
      }
    } catch {
      // Skip trim suggestions if file read fails
    }
  }

  // ── 13. Repeated-value summary ──

  const repeatedValues = Object.entries(spokenValueTracker)
    .filter(([, count]) => count >= 2)
    .map(([key, count]) => {
      const [hint, value] = key.split(":");
      return { field_hint: hint === "_any" ? null : hint, value, times_spoken: count };
    })
    .sort((a, b) => b.times_spoken - a.times_spoken);

  // ── 14. VAD Sleep/Wake Analysis ──
  // Analyse sleep manager events to understand Deepgram cost savings and wake reliability.
  // Events from DebugLogger: sleep_state_dozing, sleep_state_sleeping, sleep_state_wake,
  // sleep_enter_dozing, sleep_enter_sleeping, sleep_wake, buffer_replayed,
  // reconnect_queue_flushed, reconnect_timeout, post_wake_no_transcript
  // Events from DeepgramService: STREAM_PAUSED, STREAM_RESUMED, BUFFER_REPLAY

  const sleepEvents = events.filter((e) =>
    [
      "sleep_state_dozing", "sleep_state_sleeping", "sleep_state_wake",
      "sleep_enter_dozing", "sleep_enter_sleeping", "sleep_wake",
    ].includes(e.event)
  );
  const bufferReplayEvents = events.filter((e) =>
    ["buffer_replayed", "BUFFER_REPLAY"].includes(e.event)
  );
  const streamPauseEvents = events.filter((e) =>
    ["STREAM_PAUSED"].includes(e.event)
  );
  const streamResumeEvents = events.filter((e) =>
    ["STREAM_RESUMED"].includes(e.event)
  );
  const reconnectQueueEvents = events.filter((e) => e.event === "reconnect_queue_flushed");
  const reconnectTimeoutEvents = events.filter((e) => e.event === "reconnect_timeout");
  const postWakeNoTranscriptEvents = events.filter((e) => e.event === "post_wake_no_transcript");

  // Build sleep cycles: each dozing event starts a cycle, wake ends it
  const sleepCycles = [];
  // Use only one event name per transition to avoid double-counting
  // (SleepManager logs both audio-category and session-category events)
  const dozingEvents = sleepEvents.filter((e) => e.event === "sleep_enter_dozing");
  const wakeEvents = sleepEvents.filter((e) => e.event === "sleep_wake");
  const sleepingEvents = sleepEvents.filter((e) => e.event === "sleep_enter_sleeping");

  for (let i = 0; i < dozingEvents.length; i++) {
    const dozeTime = new Date(dozingEvents[i].timestamp).getTime();

    // Find the next wake event after this doze
    const nextWake = wakeEvents.find((w) => new Date(w.timestamp).getTime() > dozeTime);
    const wakeTime = nextWake ? new Date(nextWake.timestamp).getTime() : null;

    // Did it transition to sleeping before waking?
    const wentToSleep = sleepingEvents.some((s) => {
      const sleepTime = new Date(s.timestamp).getTime();
      return sleepTime > dozeTime && (!wakeTime || sleepTime < wakeTime);
    });

    // Find buffer replay for this cycle
    const cycleReplay = bufferReplayEvents.find((r) => {
      const replayTime = new Date(r.timestamp).getTime();
      return wakeTime && Math.abs(replayTime - wakeTime) < 5000;
    });

    const cycle = {
      doze_start: dozingEvents[i].timestamp,
      wake_time: nextWake?.timestamp || null,
      reached_sleeping: wentToSleep,
      duration_ms: wakeTime ? wakeTime - dozeTime : null,
      duration_sec: wakeTime ? parseFloat(((wakeTime - dozeTime) / 1000).toFixed(3)) : null,
      wake_from: nextWake?.data?.fromState || nextWake?.data?.from || (wentToSleep ? "sleeping" : "dozing"),
      buffer_replayed: !!cycleReplay,
      buffer_bytes: cycleReplay?.data?.bytes || 0,
    };

    sleepCycles.push(cycle);
  }

  // Calculate Deepgram cost savings from sleep cycles
  const totalSleepDurationMs = sleepCycles.reduce((sum, c) => sum + (c.duration_ms || 0), 0);
  const totalSleepDurationSec = parseFloat((totalSleepDurationMs / 1000).toFixed(3));
  const deepgramSavedMinutes = totalSleepDurationMs / 60000;

  // Calculate total stream pause time (doze + TTS + any other pauses) from STREAM_PAUSED/RESUMED pairs
  let totalStreamPausedMs = 0;
  const sortedPauses = streamPauseEvents.map((e) => new Date(e.timestamp).getTime()).sort((a, b) => a - b);
  const sortedResumes = streamResumeEvents.map((e) => new Date(e.timestamp).getTime()).sort((a, b) => a - b);
  for (const pauseTime of sortedPauses) {
    const nextResume = sortedResumes.find((r) => r > pauseTime);
    if (nextResume) {
      totalStreamPausedMs += nextResume - pauseTime;
    }
  }
  const totalStreamPausedMin = totalStreamPausedMs / 60000;
  const deepgramSavedCostUsd = totalStreamPausedMin * DEEPGRAM_RATE;

  const vadSleepAnalysis = {
    total_sleep_cycles: sleepCycles.length,
    cycles: sleepCycles,
    total_sleep_duration_sec: totalSleepDurationSec,
    total_sleep_duration_min: parseFloat(deepgramSavedMinutes.toFixed(3)),
    total_stream_paused_ms: totalStreamPausedMs,
    total_stream_paused_min: parseFloat(totalStreamPausedMin.toFixed(2)),
    deepgram_saved_usd: parseFloat(deepgramSavedCostUsd.toFixed(6)),
    stream_pauses: streamPauseEvents.length,
    stream_resumes: streamResumeEvents.length,
    buffer_replays: bufferReplayEvents.length,
    reconnect_queue_flushes: reconnectQueueEvents.length,
    reconnect_timeouts: reconnectTimeoutEvents.length,
    post_wake_no_transcript: postWakeNoTranscriptEvents.length,
    deepgram_streaming_stopped: sleepCycles.length > 0,
  };

  // ── 14b. Tool-call traffic summary (Phase 8 Plan 08-01 SC #2) ──
  //
  // Surfaces stage6_tool_call + stage6.ask_user log rows as a per-session
  // histogram so the optimizer report + CloudWatch dashboards have a
  // stable view of agentic-extraction behaviour during the shadow → live
  // transition (and forever after live cutover).
  //
  // Tool-call surface:
  //   - count by `tool` (record_reading / clear_reading / create_circuit /
  //     rename_circuit / record_observation / delete_observation / ask_user)
  //   - median duration_ms per tool (sort durations, pick middle / mean
  //     of two middles)
  //   - validation_error_count per tool — rows with is_error=true
  //
  // ask_user surface:
  //   - total count (all stage6.ask_user rows regardless of mode)
  //   - histogram by `answer_outcome` covering EVERY frozen
  //     ASK_USER_ANSWER_OUTCOMES enum member (missing outcomes default to
  //     0 so dashboards splitting by the dimension see a stable shape).
  //
  // Source-of-truth for the enum: src/extraction/stage6-dispatcher-logger.js.
  // Duplicated here verbatim because the analyzer ships independently to
  // the optimizer mac and shouldn't have a runtime dep on backend modules.
  // If the backend enum drifts, the analyze-session.test.mjs SC #2 test
  // fails loudly (the test re-duplicates the list independently).
  const ASK_USER_ANSWER_OUTCOMES = [
    "answered",
    "timeout",
    "user_moved_on",
    "restrained_mode",
    "ask_budget_exhausted",
    "gated",
    "shadow_mode",
    "validation_error",
    "session_terminated",
    "session_stopped",
    "session_reconnected",
    "duplicate_tool_call_id",
    "transcript_already_extracted",
    "dispatcher_error",
    "prompt_leak_blocked",
  ];

  const toolCallEvents = events.filter((e) => e.event === "stage6_tool_call");
  const askUserEvents = events.filter((e) => e.event === "stage6.ask_user");

  // Tool histogram — group by tool name
  const toolMap = new Map();
  for (const evt of toolCallEvents) {
    const data = evt.data || {};
    const name = data.tool || "unknown";
    if (!toolMap.has(name)) {
      toolMap.set(name, { name, durations: [], errorCount: 0 });
    }
    const entry = toolMap.get(name);
    if (typeof data.duration_ms === "number") {
      entry.durations.push(data.duration_ms);
    }
    if (data.is_error === true) entry.errorCount += 1;
  }

  function median(nums) {
    if (nums.length === 0) return 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }

  // Plan 08-04 r3-#1 (MAJOR): defence-in-depth normaliser for any
  // log-derived value that flows into the dashboards / warnings.
  //
  // Codex r3-#1 surfaced that raw `answer_outcome` log values were being
  // copied verbatim into `tool_call_traffic.ask_user.unknown_outcomes[]`
  // and `events._warnings`. Those analysis.json surfaces are consumed by
  // `scripts/generate-report-html.js` (which renders into the operator
  // dashboard). The renderer escapes via `escapeHtml()` at the render
  // sites it currently has — but `unknown_outcomes[]` and `warnings[]`
  // are not yet rendered, and any future renderer addition that drops
  // the escape would introduce a stored-XSS sink.
  //
  // Defence-in-depth: sanitise on the way IN here (analyzer), so the
  // values entering the report surface are already safe-display-bounded:
  //   1. Stringify non-strings via JSON.stringify (preserves type info —
  //      0 → "0", false → "false", {} → "{}", [] → "[]"). Pairs with the
  //      r3-#2 fix that routes non-string outcomes to the malformed
  //      surface where this same helper stringifies them.
  //   2. Strip control codepoints (Unicode 0x00..0x1F + 0x7F). Raw
  //      control bytes corrupt log files / break terminals downstream
  //      AND can carry CR/LF injection payloads in some renderers.
  //   3. Truncate to 100 chars with a U+2026 (HORIZONTAL ELLIPSIS)
  //      marker. Bounds report size against length-bomb payloads.
  //
  // Run BEFORE bucketing so the Map keys are already-safe; collapses
  // attacker-distinct evil strings whose only difference was control
  // chars or 100+ char prefixes (acceptable conflation — count
  // aggregates correctly per visible shape; the operational signal is
  // "something unknown showed up", not the exact byte contents).
  //
  // The renderer's `escapeHtml()` (`scripts/generate-report-html.js:28`)
  // is the SECOND gate — it escapes HTML-significant chars (`<`, `>`,
  // `&`, `"`) at every render site. Both gates must hold for the
  // contract to be safe; this helper closes the analyzer side, the
  // renderer's escape audit (Plan 08-04 Task 3-4) closes the renderer
  // side.
  function safeDisplayValue(raw) {
    let s;
    if (typeof raw === "string") {
      s = raw;
    } else if (raw === undefined || raw === null) {
      // JSON.stringify(undefined) returns the JS value `undefined`
      // (not a string), and JSON.stringify(null) returns the string
      // "null". For consistency with r2-#2's String()-based labels
      // (`null` → `"null"`, `undefined` → `"undefined"`), handle these
      // two explicitly via String() before the strip+cap.
      s = String(raw);
    } else {
      // JSON.stringify covers numbers (0 → "0"), booleans (false →
      // "false"), objects ({} → "{}"), arrays ([] → "[]"), and any
      // other JSON-serialisable value. For exotic types (Symbol,
      // function) JSON.stringify returns undefined; fall back to
      // String() so the call site never sees a non-string `s`.
      const j = JSON.stringify(raw);
      s = typeof j === "string" ? j : String(raw);
    }
    // Strip control chars (Unicode 0x00..0x1F + 0x7F). Some hostile
    // log writers encode literal control bytes inside JSON strings
    // rather than the safer `\u00XX` form; this catches both forms
    // (parsed JSON yields the literal char in either case).
    // eslint-disable-next-line no-control-regex
    const stripped = s.replace(/[\x00-\x1F\x7F]/g, "");
    if (stripped.length <= 100) return stripped;
    // Single-char U+2026 ellipsis (NOT three dots ".") so the cap is
    // exactly 100 JS chars / Unicode codepoints. Three-dot ASCII
    // would be 102 chars and break the length contract.
    return stripped.slice(0, 99) + "…";
  }

  // Plan 08-06 r5-#2 (MINOR): bucket on the RAW canonicalised value,
  // not on the truncated display form.
  //
  // Codex r5-#2 raised that safeDisplayValue() was applied BEFORE
  // bucketing — the call site set the Map key TO the truncated form.
  // Two distinct outcomes that share their first 99 chars but diverge
  // at char 100+ both produced the same "AAA…" key and collapsed into
  // one entry. True drift shape (two distinct values) was hidden.
  //
  // canonicaliseRaw() mirrors safeDisplayValue's per-type
  // stringification + control-char strip but does NOT length-cap.
  // This is the BUCKET KEY — distinct underlying values stay distinct
  // even when their rendered display form is the same.
  //
  // Length-cap is applied at the materialisation pass (when building
  // the unknown_outcomes[] / malformed_outcomes[] arrays for JSON
  // output) so the operator-facing display value still bounds report
  // size.
  //
  // Why share the per-type stringification path: the bucket key MUST
  // be a primitive (Map keys are compared by SameValueZero, so two
  // separate `{}` objects would never bucket together). Stringifying
  // gives a stable primitive key per per-type shape, mirroring the
  // r3-#2 contract where `0` → `"0"`, `false` → `"false"`, `{}` →
  // `"{}"`, etc.
  //
  // Why share the control-char strip: hostile log writers can encode
  // distinct control-byte payloads that would render identically
  // (after strip) but bucket separately if we kept the raw form.
  // Bucketing on the stripped form aligns with the operational
  // signal: "evil\x00value" and "evil\x01value" are the same drift
  // event from the operator's perspective. (If we ever want to
  // distinguish them, this is the call site to revisit.)
  //
  // Contract anchor: scripts/__tests__/analyze-session.test.mjs
  // "Plan 08-06 r5-#2" block — 4 tests (1 RED→GREEN + 3 regression
  // locks for the legacy length-bomb / control-char / sum-invariant
  // cases) + new fixture near-collision-session/.
  function canonicaliseRaw(raw) {
    let s;
    if (typeof raw === "string") {
      s = raw;
    } else if (raw === undefined || raw === null) {
      s = String(raw);
    } else {
      const j = JSON.stringify(raw);
      s = typeof j === "string" ? j : String(raw);
    }
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\x00-\x1F\x7F]/g, "");
  }

  const tools = [...toolMap.values()]
    .map((entry) => ({
      name: entry.name,
      count: entry.durations.length || toolCallEvents.filter((e) => (e.data?.tool) === entry.name).length,
      median_duration_ms: median(entry.durations),
      validation_error_count: entry.errorCount,
    }))
    .sort((a, b) => b.count - a.count);

  // ask_user outcomes histogram — every frozen enum key, default 0.
  //
  // Plan 08-02 r1-#3 (MAJOR): unknown outcomes (values NOT in the frozen
  // ASK_USER_ANSWER_OUTCOMES enum) are surfaced via TWO side channels —
  //   1. `unknown_outcome_count` (scalar) + `unknown_outcomes[]` (array
  //      of `{value, count}`) within `tool_call_traffic.ask_user`.
  //   2. `warnings[]` entry of shape
  //      `{type: 'unknown_ask_user_outcome', value, count}` per distinct
  //      unknown value (same surface used for SC #1 malformed_event
  //      warnings; appended to `events._warnings` so the existing
  //      analysis.warnings merge picks them up).
  //
  // The frozen-enum `outcomes` histogram itself stays exactly
  // ASK_USER_ANSWER_OUTCOMES shape — adding `foobar`-shaped keys would
  // break CloudWatch dashboards that split by the dimension. Unknowns
  // go to the side channel only.
  //
  // Why surface them at all: the backend's `invalid_answer_outcome:`
  // throw at the emit site (`stage6-dispatcher-logger.js`) is the FIRST
  // gate. If a row reaches the analyzer with an unknown outcome, that's
  // either enum drift (backend adds a new key without coordinating with
  // the analyzer) or instrumentation failure (a row escaped the throw).
  // Either is operationally serious. Silently dropping the row would
  // hide the failure from the optimizer / report.
  //
  // Plan 08-03 r2-#1 (MAJOR): log data is UNTRUSTED. The previous shape
  // — `const outcomes = {};` + `if (outcome in outcomes)` — walks
  // `Object.prototype` on every membership check, so an `answer_outcome`
  // value of "__proto__", "constructor", or "toString" passes the
  // membership test as if it were a known frozen-enum key — silently
  // bypassing the unknown-surface added by r1-#3. We close the
  // prototype-pollution attack vector by:
  //   - building the histogram via `Object.create(null)` so it has NO
  //     prototype chain at all (own-properties only — JSON.stringify
  //     walks own enumerable keys, which is exactly the frozen-enum
  //     set we want);
  //   - testing membership via `Object.hasOwn(outcomes, outcome)` so
  //     the lookup ONLY tests own-properties.
  // Same defence as a `Set`-backed lookup, lighter at the call site,
  // and preserves the existing `analysis.json` shape byte-identical
  // for known-only sessions.
  // Plan 08-03 r2-#2 (MINOR): the previous shape — `if (!outcome) continue;`
  // — silently dropped empty-string / null / undefined outcomes. r1-#3
  // covered enum-drift unknowns ("value not in the frozen enum") but
  // didn't cover MALFORMED outcomes ("no value emitted at all"). The
  // two failure modes have distinct operational signatures:
  //   - Unknown = enum drift; backend deploy out of sync with analyzer.
  //   - Malformed = instrumentation failure; the row escaped the
  //     emit-site `invalid_answer_outcome` throw with NO outcome set.
  // Both are operationally serious; both deserve their own surface so
  // optimizer dashboards can count them separately.
  //
  // Plan 08-04 r3-#2 (MINOR): r2-#2's predicate matched ONLY
  // `outcome === "" || outcome === null || outcome === undefined`.
  // Non-string outcomes (`0`, `false`, `42`, `{}`, `[]`) fell through
  // to the unknown branch where `Object.hasOwn(outcomes, outcome)`
  // coerces the key to a string for property lookup — corrupting the
  // unknown bucket silently. Worst case: an array-typed outcome
  // coerces to `""` for the property lookup AND collides with the
  // r2-#2 empty-string malformed surface, depending on which branch
  // ran first. Operationally, "outcome was the wrong type entirely"
  // is the SAME class of instrumentation failure as "outcome was
  // missing" — both belong on the malformed surface. We widen the
  // predicate to `typeof outcome !== "string" || outcome === ""`,
  // which catches: null, undefined, all numbers (incl. 0), all
  // booleans (incl. false), all objects, all arrays, all symbols,
  // all functions — everything except non-empty strings. The
  // safeDisplayValue helper from r3-#1 then JSON.stringifies the
  // non-string values into readable per-shape labels:
  //   0 → "0",  false → "false",  42 → "42",
  //   {} → "{}",  [] → "[]",  {a:1} → '{"a":1}',
  //   "" → "",  null → "null",  undefined → "undefined".
  // Routing malformed values through the unknown-outcome surface
  // would misattribute the failure mode (an enum-drift fix is the
  // wrong remediation for an instrumentation failure).
  const outcomes = Object.create(null);
  for (const o of ASK_USER_ANSWER_OUTCOMES) outcomes[o] = 0;
  const unknownOutcomeMap = new Map();
  const malformedOutcomeMap = new Map();
  for (const evt of askUserEvents) {
    const outcome = evt.data?.answer_outcome;
    // Plan 08-04 r3-#2 (MINOR): treat ANY non-string outcome as
    // malformed (instrumentation failure). The r2-#2 contract for
    // `"" / null / undefined` is preserved — null/undefined satisfy
    // the `typeof !== "string"` check, empty-string is caught by the
    // explicit `=== ""` clause.
    //
    // Plan 08-06 r5-#2 (MINOR): bucket on the RAW canonicalised value
    // (canonicaliseRaw — same per-type stringification + control-char
    // strip as safeDisplayValue but WITHOUT the length cap). Length-
    // cap is applied at the materialisation pass below. Distinct raw
    // values that share a 99-char prefix now stay in distinct buckets.
    if (typeof outcome !== "string" || outcome === "") {
      const bucketKey = canonicaliseRaw(outcome);
      malformedOutcomeMap.set(bucketKey, (malformedOutcomeMap.get(bucketKey) || 0) + 1);
      continue;
    }
    // Plan 08-06 r5-#2 (MINOR): same restructure on the unknown branch.
    // The frozen-enum check (`Object.hasOwn(outcomes, outcome)`) still
    // uses the RAW string outcome — known-enum keys are pure ASCII and
    // bounded length, so bucket-vs-known disambiguation is unaffected.
    if (Object.hasOwn(outcomes, outcome)) {
      outcomes[outcome] += 1;
    } else {
      const bucketKey = canonicaliseRaw(outcome);
      unknownOutcomeMap.set(bucketKey, (unknownOutcomeMap.get(bucketKey) || 0) + 1);
    }
  }

  // Plan 08-06 r5-#2: materialisation pass — apply safeDisplayValue
  // (length-cap + control-char strip — though the strip is redundant
  // here because canonicaliseRaw already stripped) to the bucket keys
  // when building the output arrays. The COUNT distribution carries
  // the operational signal (two distinct raw values past the cap show
  // up as two entries with their own counts, even when they render to
  // the same display string); the displayed `value` is just the
  // operator-facing label and is bounded by the length cap.
  const unknownOutcomes = [...unknownOutcomeMap.entries()].map(([rawKey, count]) => ({
    value: safeDisplayValue(rawKey),
    count,
  }));
  const unknownOutcomeCount = unknownOutcomes.reduce((sum, e) => sum + e.count, 0);

  const malformedOutcomes = [...malformedOutcomeMap.entries()].map(([rawKey, count]) => ({
    value: safeDisplayValue(rawKey),
    count,
  }));
  const malformedOutcomeCount = malformedOutcomes.reduce((sum, e) => sum + e.count, 0);

  // Append per-distinct-value warning entries onto the parser's warnings
  // accumulator. `events._warnings` is created by parseJSONL() as a
  // non-enumerable property so this re-use is safe — analyzeSession()
  // merges `events._warnings` into the top-level `warnings` field at
  // serialise time.
  if (events._warnings && unknownOutcomes.length > 0) {
    for (const { value, count } of unknownOutcomes) {
      events._warnings.push({ type: "unknown_ask_user_outcome", value, count });
    }
  }
  if (events._warnings && malformedOutcomes.length > 0) {
    for (const { value, count } of malformedOutcomes) {
      events._warnings.push({ type: "malformed_ask_user_outcome", value, count });
    }
  }

  const toolCallTraffic = {
    enabled: true,
    tools,
    ask_user: {
      total: askUserEvents.length,
      outcomes,
      unknown_outcome_count: unknownOutcomeCount,
      unknown_outcomes: unknownOutcomes,
      malformed_outcome_count: malformedOutcomeCount,
    },
  };

  // ── 15. Voice commands ──
  // Extract voice_command_sent/response events to surface user intentions expressed via voice commands.

  const voiceCommandSent = events.filter((e) => e.event === "voice_command_sent");
  const voiceCommandResponse = events.filter((e) => e.event === "voice_command_response");
  const voiceCommandUnknown = events.filter((e) => e.event === "voice_command_unknown_action");
  const voiceCommandReorder = events.filter((e) => e.event === "voice_command_reorder_complete");
  const voiceCommandAddCircuit = events.filter((e) => e.event === "voice_command_add_circuit");
  const voiceCommandDeleteCircuit = events.filter((e) => e.event === "voice_command_delete_circuit");

  const voiceCommandsList = voiceCommandSent.map((sent) => {
    const sentTime = new Date(sent.timestamp).getTime();
    // Find matching response within 10s
    const response = voiceCommandResponse.find((r) => {
      const rTime = new Date(r.timestamp).getTime();
      return rTime >= sentTime && rTime - sentTime < 10000;
    });
    return {
      timestamp: sent.timestamp,
      command: sent.data?.command || "",
      understood: response?.data?.understood ?? null,
      action: response?.data?.action || null,
      response_text: response?.data?.response || null,
    };
  });

  const voiceCommands = {
    total_sent: voiceCommandSent.length,
    total_understood: voiceCommandsList.filter((c) => c.understood === true).length,
    total_failed: voiceCommandsList.filter((c) => c.understood === false).length,
    unknown_actions: voiceCommandUnknown.length,
    reorders: voiceCommandReorder.length,
    circuits_added: voiceCommandAddCircuit.length,
    circuits_deleted: voiceCommandDeleteCircuit.length,
    commands: voiceCommandsList,
  };

  // ── 16. TTS-discarded utterances ──
  // User speech that was discarded because TTS was playing at the time.

  const ttsDiscarded = events
    .filter((e) => e.event === "tts_echo_discarded")
    .map((e) => ({
      timestamp: e.timestamp,
      text: e.data?.text || "",
    }));

  // ── 17. Observation capture quality ──
  // Measures how cleanly the observation capture workflow ran:
  //  • observation_confirmation questions fired (ideally 0 for explicit triggers)
  //  • "what code?" / "what's the observation?" questions fired (ideally 0)
  //  • observations created (silently via queueVisualOnly)
  //  • observations refined by the server-side BPG4 web search
  //  • turns-per-observation ratio — > 2 means Sonnet is asking for clarification
  //
  // Rationale: Session B607831E showed 4 observation questions for one dictated
  // observation. These metrics let the optimizer spot regressions of that class
  // at a glance, independent of overall session-level counts.

  const observationCreatedEvents = events.filter(
    (e) => e.event === "observation_created"
  );
  const observationRefinedEvents = events.filter(
    (e) => e.event === "observation_refined"
  );
  const observationUpdateNoMatch = events.filter(
    (e) => e.event === "observation_update_no_match"
  );
  const questionAskedObs = events.filter(
    (e) =>
      e.event === "question_asked" &&
      /observation/i.test(String(e.data?.type || "")) === true
  );
  const questionAskedCodeLike = events.filter(
    (e) =>
      e.event === "question_asked" &&
      String(e.data?.type || "") === "unclear" &&
      !e.data?.field &&
      !e.data?.circuit
  );
  const questionDedupedObs = events.filter(
    (e) =>
      e.event === "question_deduped" &&
      e.data?.isObservationQuestion === "true"
  );
  // Phase F: TTS misattribution heuristic — reply consumed an in-flight
  // question that was >5s old AND there was a newer question already queued.
  // High values here correlate with Sonnet re-asking the same question or
  // TTS queue churn — both signal an opportunity to tighten the flow.
  const replyMisattribSuspected = events.filter(
    (e) => e.event === "reply_misattribution_suspected"
  );
  // Phase F: iOS inflight_question_anchored events give us queue-depth-at-
  // anchor — a secondary signal. If > 25% of anchors happen with a non-empty
  // queue, TTS delivery is lagging.
  const inflightAnchored = events.filter(
    (e) => e.event === "inflight_question_anchored"
  );
  const anchoredWithQueue = inflightAnchored.filter(
    (e) => parseInt(e.data?.queueDepth || "0", 10) > 0
  );

  const observationCount = observationCreatedEvents.length;
  const obsQuestionCount = questionAskedObs.length + questionAskedCodeLike.length;
  const refinedCount = observationRefinedEvents.length;

  // "Clean" capture = observation appeared with zero associated TTS questions
  // in a ±5s window. Approximates "inspector said observation and the app
  // silently recorded it".
  const cleanCaptureCount = observationCreatedEvents.filter((created) => {
    const t = new Date(created.timestamp).getTime();
    const nearbyQuestion = [...questionAskedObs, ...questionAskedCodeLike].some(
      (q) => Math.abs(new Date(q.timestamp).getTime() - t) < 5000
    );
    return !nearbyQuestion;
  }).length;

  const observationCaptureQuality = {
    observations_created: observationCount,
    observations_refined: refinedCount,
    observations_refined_no_match: observationUpdateNoMatch.length,
    refinement_rate:
      observationCount > 0
        ? parseFloat((refinedCount / observationCount).toFixed(2))
        : 0,
    observation_questions_asked: obsQuestionCount,
    observation_questions_deduped: questionDedupedObs.length,
    clean_captures: cleanCaptureCount,
    clean_capture_rate:
      observationCount > 0
        ? parseFloat((cleanCaptureCount / observationCount).toFixed(2))
        : null,
    questions_per_observation:
      observationCount > 0
        ? parseFloat((obsQuestionCount / observationCount).toFixed(2))
        : 0,
    // Signal for optimizer: anything > 1 here means a regression of the
    // B607831E class (multiple prompts for one observation).
    regression_flag: observationCount > 0 && obsQuestionCount / observationCount > 1,
    // ── Phase F signals ──
    // `refinement_lost_on_reconnect` proxies via observation_update_no_match
    // on iOS — the server sent an update but the client couldn't match it
    // to a local row (likely because the observation row was never created
    // or was overwritten). Distinct from server-side
    // observation_update_unmatched (logged at session stop when
    // pendingRefinements still has entries) — that's in CloudWatch only.
    refinement_lost_on_reconnect: observationUpdateNoMatch.length,
    // `reply_misattribution_suspected`: TTS reply anchored to a stale
    // in-flight question while a newer question was queued. Heuristic.
    reply_misattribution_suspected: replyMisattribSuspected.length,
    // `update_blocked_by_dedup`: server-side recentlyRefinedIds TTL hits.
    // The iOS client can't see this directly — populated only when the
    // session optimizer enriches with CloudWatch (null here signals
    // "unavailable without CloudWatch", not zero).
    update_blocked_by_dedup: null,
    // Queue-depth-at-anchor: how often a question was anchored to TTS
    // while OTHER questions were already queued ahead of it. High ratio
    // means TTS delivery is the bottleneck, not Sonnet.
    inflight_anchored_total: inflightAnchored.length,
    inflight_anchored_with_queue: anchoredWithQueue.length,
    inflight_queue_pressure:
      inflightAnchored.length > 0
        ? parseFloat(
            (anchoredWithQueue.length / inflightAnchored.length).toFixed(2)
          )
        : null,
  };

  // ── Build analysis output ──

  const analysis = {
    session_meta: manifest,
    field_report: fieldReport,
    regex_performance: regexPerformance,
    sonnet_performance: sonnetPerformance,
    transcript_issues: transcriptIssues,
    empty_fields: emptyFields,
    debug_issues: debugIssues,
    regex_opportunities: regexOpportunities,
    sonnet_prompt_stats: sonnetPromptStats,
    extraction_efficiency: extractionEfficiency,
    // New sections (report redesign)
    utterance_analysis: utteranceAnalysis,
    cost_breakdown: costBreakdown,
    sonnet_prompt_audit: sonnetPromptAudit,
    repeated_values: repeatedValues,
    vad_sleep_analysis: vadSleepAnalysis,
    observation_capture_quality: observationCaptureQuality,
    // Phase 8 Plan 08-01 SC #2 — tool-call traffic summary (post Phase 1+2+3
    // tool-call rollout). Always emitted; .enabled=true even on legacy-shape
    // sessions so downstream consumers can rely on the section's presence.
    tool_call_traffic: toolCallTraffic,
    // Phase 8 Plan 08-01 SC #1 — soft-fail breadcrumbs from parseJSONL.
    // Always an array (empty on a clean log). Non-empty when the analyzer
    // saw a JSON-shaped line that failed to parse (typically a truncated
    // last record from a network drop or disk-full mid-write). Surfacing
    // these means the optimizer + reviewer can tell "session was clean"
    // from "session got cut off" — pre-fix both looked identical.
    warnings: events._warnings || [],
    // Full transcript and voice commands (intent visibility)
    full_transcript: fullTranscriptOriginal,
    voice_commands: voiceCommands,
    tts_discarded: ttsDiscarded,
    job_snapshot: jobSnapshot,
    cost_summary: costSummary,
  };

  // Write output
  const outputPath = path.join(sessionDir, "analysis.json");
  fs.writeFileSync(outputPath, JSON.stringify(analysis, null, 2));
  console.log(`Analysis written to: ${outputPath}`);
  console.log(`  Fields tracked: ${fieldReport.length}`);
  console.log(`  Regex fields: ${regexFieldKeys.size}`);
  console.log(`  Sonnet fields: ${sonnetFieldKeys.size}`);
  console.log(`  Discrepancies: ${correctedBySONnet.length}`);
  console.log(`  Unmatched segments: ${unmatchedSegments.length}`);
  console.log(`  Empty fields: ${emptyFields.length}`);
  console.log(`  Debug issues: ${debugIssues.total_reported}`);
  console.log(`  Hot-fix patterns: ${debugIssues.total_hot_fixes}`);
  console.log(`  Regex opportunities: ${regexOpportunities.length}`);
  console.log(`  Prompt tokens (est): ${sonnetPromptStats.estimated_tokens}`);
  console.log(`  Fields/Sonnet call: ${extractionEfficiency.fields_per_call}`);
  console.log(`  Utterances analysed: ${utteranceAnalysis.length}`);
  const uncapturedCount = utteranceAnalysis.reduce((sum, u) => sum + u.uncaptured_values.length, 0);
  console.log(`  Uncaptured values: ${uncapturedCount}`);
  console.log(`  Repeated values: ${repeatedValues.length}`);
  console.log(`  Full transcript: ${fullTranscriptOriginal.length} chars`);
  console.log(`  Voice commands: ${voiceCommands.total_sent} sent, ${voiceCommands.total_understood} understood, ${voiceCommands.total_failed} failed`);
  console.log(`  TTS-discarded utterances: ${ttsDiscarded.length}`);
  console.log(`  Sleep cycles: ${vadSleepAnalysis.total_sleep_cycles}`);
  console.log(
    `  Observations: ${observationCaptureQuality.observations_created} captured, ${observationCaptureQuality.observations_refined} refined, ${observationCaptureQuality.observation_questions_asked} questions, clean=${observationCaptureQuality.clean_capture_rate ?? "-"}`
  );
  if (observationCaptureQuality.regression_flag) {
    console.log(
      `  ⚠ Observation regression: ${observationCaptureQuality.questions_per_observation} questions per observation (> 1)`
    );
  }
  console.log(`  Sleep duration: ${vadSleepAnalysis.total_sleep_duration_sec}s (${vadSleepAnalysis.total_sleep_cycles} cycles)`);
  console.log(`  Total stream paused: ${vadSleepAnalysis.total_stream_paused_min}min (saved $${vadSleepAnalysis.deepgram_saved_usd.toFixed(4)} Deepgram)`);
  console.log(`  Buffer replays: ${vadSleepAnalysis.buffer_replays}`);
  console.log(`  Wake failures: ${vadSleepAnalysis.post_wake_no_transcript}`);
  console.log(`  Tool-call traffic: ${toolCallTraffic.tools.length} tools, ${toolCallTraffic.ask_user.total} ask_user calls`);
  if (analysis.warnings.length > 0) {
    console.log(`  ⚠ Warnings: ${analysis.warnings.length} malformed event(s) in debug_log.jsonl`);
  }
  console.log(`  Total cost (USD): $${costBreakdown.total_usd.toFixed(4)}`);
  if (costBreakdown.doze_savings.session_duration_min > 0) {
    console.log(`  ── Doze Savings ──`);
    console.log(`  Session duration: ${costBreakdown.doze_savings.session_duration_min}min, Streamed: ${costBreakdown.doze_savings.streaming_min}min (${costBreakdown.doze_savings.streaming_percent}%)`);
    console.log(`  Deepgram saved: $${costBreakdown.doze_savings.saved_usd.toFixed(4)} (${costBreakdown.doze_savings.savings_percent}% reduction)`);
    console.log(`  Without doze: $${costBreakdown.doze_savings.hypothetical_deepgram_usd.toFixed(4)} → With doze: $${costBreakdown.deepgram.cost_usd.toFixed(4)}`);
  }

  return analysis;
}

// ── CLI entry point ──

const sessionDir = process.argv[2];
if (!sessionDir) {
  console.error("Usage: node analyze-session.js /path/to/session-analytics-dir/");
  process.exit(1);
}

if (!fs.existsSync(sessionDir)) {
  console.error(`Error: Directory not found: ${sessionDir}`);
  process.exit(1);
}

analyzeSession(sessionDir);
