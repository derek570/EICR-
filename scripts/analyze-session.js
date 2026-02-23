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

function parseJSONL(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
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
  const finalTranscriptEvt = events.find((e) => e.event === "final_transcript");
  const fullTranscript = (finalTranscriptEvt?.data?.transcript || "").toLowerCase();

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
      "../src/eicr-extraction-session.js"
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
      text: text.substring(0, 300),
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

  const deepgramMinutes = deepgramCostData.minutes || parseFloat(manifest.recordingDurationMin || "0");
  const DEEPGRAM_RATE = 0.0077;
  const deepgramCostUsd = deepgramCostData.cost || (deepgramMinutes * DEEPGRAM_RATE);

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
    // First call: cache_write ($3.75/M), subsequent: cache_read ($0.30/M)
    const firstCallCost = (promptTokens * 3.75) / 1_000_000;
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
        "../src/eicr-extraction-session.js"
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
  console.log(`  Total cost (USD): $${costBreakdown.total_usd.toFixed(4)}`);

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
