#!/usr/bin/env node
// generate-report-html.js
// Usage: node generate-report-html.js <recommendations.json> <session-summary.json> <report-id> <output.html>

import fs from "fs";
import path from "path";

const recsPath = process.argv[2];
const summaryPath = process.argv[3];
const reportId = process.argv[4];
const outputPath = process.argv[5];

if (!recsPath || !summaryPath || !reportId || !outputPath) {
  console.error("Usage: node generate-report-html.js <recommendations.json> <session-summary.json> <report-id> <output.html>");
  process.exit(1);
}

let recommendations;
try {
  recommendations = JSON.parse(fs.readFileSync(recsPath, "utf8"));
} catch {
  recommendations = [];
}
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

const USD_TO_GBP = 0.79;

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toGBP(usd) {
  return (parseFloat(usd || 0) * USD_TO_GBP).toFixed(4);
}

function toGBP2(usd) {
  return (parseFloat(usd || 0) * USD_TO_GBP).toFixed(2);
}

function formatTokens(n) {
  if (!n) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

// ── Category colors for recommendations ──

const CATEGORY_COLORS = {
  regex_improvement: { bg: "#22c55e", label: "Regex" },
  sonnet_prompt_trim: { bg: "#a855f7", label: "Sonnet Trim" },
  sonnet_prompt_addition: { bg: "#3b82f6", label: "Sonnet Addition" },
  number_normaliser: { bg: "#eab308", label: "Number Normaliser" },
  keyword_boost: { bg: "#f97316", label: "Keyword Boost" },
  config_change: { bg: "#6b7280", label: "Config Change" },
  bug_fix: { bg: "#ef4444", label: "Bug Fix" },
};

// ── Source colors for field attribution ──

const SOURCE_COLORS = {
  regex: { bg: "#22c55e22", border: "#22c55e", text: "#22c55e", label: "Regex" },
  sonnet: { bg: "#a855f722", border: "#a855f7", text: "#a855f7", label: "Sonnet" },
  preExisting: { bg: "#6b728022", border: "#6b7280", text: "#9ca3af", label: "Pre-existing" },
  corrected: { bg: "#eab30822", border: "#eab308", text: "#eab308", label: "Corrected" },
  empty: { bg: "#ef444422", border: "#ef4444", text: "#ef4444", label: "Empty" },
};

// ── Section 1: Cost Dashboard ──

function buildCostDashboard() {
  const cost = summary.cost_breakdown;
  if (!cost) {
    return `<div class="card"><p class="muted">No cost data available for this session.</p></div>`;
  }

  const dg = cost.deepgram || {};
  const sn = cost.sonnet || {};
  const gv = cost.gpt_vision || {};
  const el = cost.elevenlabs || {};
  const tb = sn.token_breakdown || {};

  return `
    <div class="cost-total">
      <span class="cost-total-label">Session Cost</span>
      <span class="cost-total-value">&pound;${toGBP2(cost.total_usd)}</span>
    </div>

    <div class="cost-grid">
      <div class="cost-item">
        <div class="cost-item-header">
          <span class="cost-item-name">Deepgram Nova-3</span>
          <span class="cost-item-price">&pound;${toGBP(dg.cost_usd)}</span>
        </div>
        <div class="cost-item-detail">${(dg.minutes || 0).toFixed(1)} min @ $0.0077/min</div>
      </div>

      <div class="cost-item">
        <div class="cost-item-header">
          <span class="cost-item-name">Sonnet 4.5</span>
          <span class="cost-item-price">&pound;${toGBP(sn.cost_usd)}</span>
        </div>
        <div class="cost-item-detail">${sn.turns || 0} turns, ${sn.compactions || 0} compactions</div>
        <div class="token-grid">
          <div class="token-row"><span class="token-label">Cache Read</span><span class="token-val">${formatTokens(tb.cache_read)}</span><span class="token-rate">$0.30/M</span></div>
          <div class="token-row"><span class="token-label">Cache Write</span><span class="token-val">${formatTokens(tb.cache_write)}</span><span class="token-rate">$6.00/M</span></div>
          <div class="token-row"><span class="token-label">Input</span><span class="token-val">${formatTokens(tb.input)}</span><span class="token-rate">$3.00/M</span></div>
          <div class="token-row"><span class="token-label">Output</span><span class="token-val">${formatTokens(tb.output)}</span><span class="token-rate">$15.00/M</span></div>
        </div>
      </div>

      <div class="cost-item">
        <div class="cost-item-header">
          <span class="cost-item-name">GPT Vision</span>
          <span class="cost-item-price">&pound;${toGBP(gv.cost_usd)}${gv.estimated ? ' <span class="est-badge">est</span>' : ''}</span>
        </div>
        <div class="cost-item-detail">${gv.photos || 0} photo${(gv.photos || 0) !== 1 ? 's' : ''} analysed</div>
      </div>

      <div class="cost-item">
        <div class="cost-item-header">
          <span class="cost-item-name">ElevenLabs TTS</span>
          <span class="cost-item-price">&pound;${toGBP(el.cost_usd)}</span>
        </div>
        <div class="cost-item-detail">${el.characters || 0} chars @ $0.03/K</div>
      </div>
    </div>`;
}

// ── Section 2: Field Attribution Table ──

function buildFieldAttribution() {
  const fieldReport = summary.field_report || [];
  const emptyFields = summary.empty_fields || [];
  if (fieldReport.length === 0 && emptyFields.length === 0) {
    return `<div class="card"><p class="muted">No field data available.</p></div>`;
  }

  // Group fields by section
  const sections = {};
  const sectionOrder = [];

  function addToSection(sectionName, entry) {
    if (!sections[sectionName]) {
      sections[sectionName] = [];
      sectionOrder.push(sectionName);
    }
    sections[sectionName].push(entry);
  }

  function getSectionName(key) {
    if (key.startsWith("supply.")) return "Supply";
    if (key.startsWith("board.") || key.startsWith("fuseboard.")) return "Board";
    if (key.startsWith("circuit.")) {
      const match = key.match(/^circuit\.(\d+)\./);
      return match ? `Circuit ${match[1]}` : "Circuits";
    }
    if (key.startsWith("installation.") || key.startsWith("install.")) return "Installation";
    if (key.startsWith("client.")) return "Client";
    if (key.startsWith("inspector.")) return "Inspector";
    return "Other";
  }

  for (const f of fieldReport) {
    const section = getSectionName(f.key);
    const shortKey = f.key.split(".").pop();
    let source = f.final_source || "unknown";
    let note = "";

    if (f.was_overwritten) {
      source = "corrected";
      if (f.regex_value && f.sonnet_value) {
        note = `Regex had ${escapeHtml(f.regex_value)}`;
      }
    }

    if (!f.final_value && !f.regex_value && !f.sonnet_value) {
      source = "empty";
    }

    // Check if Sonnet caught something regex missed
    if (source === "sonnet" && !f.regex_value && f.sonnet_value) {
      note = note || "Regex missed";
    }

    const colors = SOURCE_COLORS[source] || SOURCE_COLORS.empty;

    addToSection(section, {
      key: shortKey,
      fullKey: f.key,
      source,
      sourceLabel: colors.label,
      value: f.final_value || f.sonnet_value || f.regex_value || "",
      note,
      colors,
    });
  }

  // Add empty fields from the empty_fields analysis
  const reportedKeys = new Set(fieldReport.map((f) => f.key));
  for (const ef of emptyFields) {
    if (reportedKeys.has(ef.key)) continue;
    const section = getSectionName(ef.key);
    const shortKey = ef.key.split(".").pop();
    const reasonLabels = {
      not_spoken: "Not spoken",
      regex_missed_sonnet_missed: "Spoken but not captured",
      circuit_not_mentioned: "Circuit not mentioned",
    };
    addToSection(section, {
      key: shortKey,
      fullKey: ef.key,
      source: "empty",
      sourceLabel: "Empty",
      value: "",
      note: reasonLabels[ef.reason] || ef.reason || "",
      colors: SOURCE_COLORS.empty,
    });
  }

  let html = "";
  for (const sectionName of sectionOrder) {
    const fields = sections[sectionName];
    html += `
      <div class="field-section">
        <div class="field-section-header">${escapeHtml(sectionName)}</div>
        <div class="field-table">
          ${fields.map((f) => `
            <div class="field-row">
              <span class="field-name">${escapeHtml(f.key)}</span>
              <span class="field-source" style="background:${f.colors.bg};border-color:${f.colors.border};color:${f.colors.text};">${escapeHtml(f.sourceLabel)}</span>
              <span class="field-value">${f.value ? escapeHtml(f.value) : '<span class="field-dash">&mdash;</span>'}</span>
              ${f.note ? `<span class="field-note">${escapeHtml(f.note)}</span>` : ''}
            </div>`).join("")}
        </div>
      </div>`;
  }

  return html;
}

// ── Section 3: Annotated Transcript Viewer ──

function buildTranscriptViewer() {
  const utterances = summary.utterance_analysis || [];
  if (utterances.length === 0) {
    return `<div class="card"><p class="muted">No transcript data available.</p></div>`;
  }

  const repeatedValues = summary.repeated_values || [];
  const repeatedSet = new Set(repeatedValues.map((r) => `${r.field_hint || ""}:${r.value}`));

  let html = `<div class="transcript-controls">
    <label class="toggle-label"><input type="checkbox" id="toggle-conversation" checked> Show conversation</label>
    <span class="transcript-stat">${utterances.length} utterances</span>
    <span class="transcript-stat flagged-count" id="flagged-count" style="display:none">0 flagged</span>
  </div>`;

  html += `<div class="transcript-list">`;

  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i];
    const time = u.timestamp ? new Date(u.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    const hasCaptures = (u.regex_captures || []).length > 0 || (u.sonnet_captures || []).length > 0;
    const hasUncaptured = (u.uncaptured_values || []).length > 0;
    const isRepeat = u.repeat_count >= 2;
    const isConv = u.is_conversation;

    let classes = "utt";
    if (isConv) classes += " utt-conversation";
    if (hasUncaptured && !isConv) classes += " utt-uncaptured";
    if (isRepeat) classes += " utt-repeat";

    html += `<div class="${classes}" data-idx="${i}" data-conversation="${isConv ? '1' : '0'}">`;
    html += `<div class="utt-header">`;
    html += `<span class="utt-time">${escapeHtml(time)}</span>`;
    html += `<span class="utt-text">${escapeHtml(u.text || "")}</span>`;
    if (hasUncaptured && !isConv) {
      html += `<span class="utt-uncaptured-badge">uncaptured</span>`;
    }
    if (isRepeat) {
      html += `<span class="utt-repeat-badge">repeated ${u.repeat_count}x</span>`;
    }
    html += `</div>`;

    // Annotations
    if (hasCaptures || hasUncaptured) {
      html += `<div class="utt-annotations">`;

      for (const rc of (u.regex_captures || [])) {
        html += `<div class="ann ann-regex"><span class="ann-source">Regex</span> <span class="ann-field">${escapeHtml(rc.field)}</span> = <span class="ann-value">${escapeHtml(rc.value)}</span></div>`;
      }

      for (const sc of (u.sonnet_captures || [])) {
        const latency = sc.latency_ms ? ` <span class="ann-latency">(${(sc.latency_ms / 1000).toFixed(1)}s)</span>` : "";
        html += `<div class="ann ann-sonnet"><span class="ann-source">Sonnet</span> <span class="ann-field">${escapeHtml(sc.field)}</span> = <span class="ann-value">${escapeHtml(sc.value)}</span>${latency}</div>`;
      }

      if (hasUncaptured && !isConv) {
        for (const val of (u.uncaptured_values || [])) {
          html += `<div class="ann ann-missed">NOT CAPTURED: "${escapeHtml(val)}" <button class="flag-btn" onclick="flagUtterance(${i})">Flag for improvement</button></div>`;
        }
      }

      html += `</div>`;
    }

    html += `</div>`;
  }

  html += `</div>`;

  // Floating flag panel
  html += `
    <div class="flag-panel" id="flag-panel" style="display:none">
      <div class="flag-panel-header">
        <span>Flagged Items</span>
        <button class="flag-panel-close" onclick="clearFlags()">Clear</button>
      </div>
      <div class="flag-panel-list" id="flag-panel-list"></div>
      <button class="btn btn-flag-submit" onclick="submitFlags()">Submit flagged items</button>
    </div>`;

  return html;
}

// ── Section 4: Missed Values Analysis ──

function buildMissedValues() {
  const emptyFields = summary.empty_fields || [];
  const fieldReport = summary.field_report || [];

  // Also include fields from field_report that are empty
  const emptyFromReport = fieldReport.filter((f) => !f.final_value && !f.regex_value && !f.sonnet_value);
  const allEmptyKeys = new Set(emptyFields.map((e) => e.key));
  for (const f of emptyFromReport) {
    if (!allEmptyKeys.has(f.key)) {
      emptyFields.push({ key: f.key, reason: "not_set" });
    }
  }

  if (emptyFields.length === 0) {
    return `<div class="card"><p class="muted">All expected fields were captured.</p></div>`;
  }

  const reasonLabels = {
    not_spoken: "Not spoken",
    regex_missed_sonnet_missed: "Spoken but not captured",
    circuit_not_mentioned: "Circuit not mentioned",
    not_set: "Not set",
  };

  // Find transcript references for spoken-but-not-captured
  const utterances = summary.utterance_analysis || [];

  let html = `<div class="missed-table">
    <div class="missed-header-row">
      <span class="missed-col-field">Field</span>
      <span class="missed-col-reason">Reason</span>
      <span class="missed-col-ref">Transcript</span>
    </div>`;

  for (const ef of emptyFields) {
    const reason = reasonLabels[ef.reason] || ef.reason || "Unknown";
    let transcriptRef = "&mdash;";

    if (ef.reason === "regex_missed_sonnet_missed") {
      // Try to find a relevant utterance
      const fieldParts = ef.key.split(".");
      const fieldName = fieldParts[fieldParts.length - 1].toLowerCase();
      for (let i = 0; i < utterances.length; i++) {
        const text = (utterances[i].text || "").toLowerCase();
        if (text.includes(fieldName)) {
          const time = utterances[i].timestamp ? new Date(utterances[i].timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : `#${i}`;
          transcriptRef = `<a href="#" onclick="scrollToUtterance(${i});return false;" class="missed-link">${time}</a>`;
          break;
        }
      }
    }

    html += `
      <div class="missed-row">
        <span class="missed-col-field">${escapeHtml(ef.key)}</span>
        <span class="missed-col-reason missed-reason-${ef.reason || 'unknown'}">${reason}</span>
        <span class="missed-col-ref">${transcriptRef}</span>
      </div>`;
  }

  html += `</div>`;
  return html;
}

// ── Section 5: Recommendations ──

function buildCategoryBadge(category) {
  const cat = CATEGORY_COLORS[category];
  if (!cat) return "";
  return `<span class="category-badge" style="background:${cat.bg};">${escapeHtml(cat.label)}</span>`;
}

function buildTokenImpactBadge(rec) {
  if (!rec.token_impact) return "";
  const val = rec.token_impact;
  const sign = val > 0 ? "+" : "";
  const cls = val > 0 ? "token-plus" : "token-minus";
  return `<span class="token-badge ${cls}">${sign}${val} tokens</span>`;
}

function buildRecommendationCards(recs) {
  if (!recs.length) {
    return `<div class="card"><p class="muted">No code changes recommended for this session.</p></div>`;
  }
  return recs.map((rec, i) => `
    <div class="card rec-card" id="rec-${i}" onclick="toggleRec(event, ${i})">
      <div class="card-header">
        <label class="checkbox-label" onclick="event.stopPropagation()">
          <input type="checkbox" name="accepted" value="${i}" checked>
          <span class="rec-title">${escapeHtml(rec.title)}</span>
        </label>
        ${buildCategoryBadge(rec.category)}
        ${buildTokenImpactBadge(rec)}
      </div>
      <p class="rec-desc">${escapeHtml(rec.description)}</p>
      <div class="file-path">${escapeHtml(rec.file)}</div>
      <details onclick="event.stopPropagation()">
        <summary>View diff</summary>
        <div class="diff">
          <div class="diff-old">- ${escapeHtml(rec.old_code)}</div>
          <div class="diff-new">+ ${escapeHtml(rec.new_code)}</div>
        </div>
      </details>
    </div>
  `).join("\n");
}

// ── Section 6: VAD Sleep/Wake Analysis ──

function buildVadAnalysis() {
  const vad = summary.vad_analysis;
  if (!vad || !vad.total_sleep_cycles) {
    return `<div class="card"><p class="muted">No sleep/wake data for this session.</p></div>`;
  }

  const cycles = vad.cycles || [];
  const wakeFailures = vad.post_wake_no_transcript || 0;

  let html = `
    <div class="vad-grid">
      <div class="vad-stat">
        <span class="vad-stat-value">${vad.total_sleep_cycles}</span>
        <span class="vad-stat-label">Sleep Cycles</span>
      </div>
      <div class="vad-stat">
        <span class="vad-stat-value">${(vad.total_sleep_duration_sec || 0).toFixed(1)}s</span>
        <span class="vad-stat-label">Total Doze</span>
      </div>
      <div class="vad-stat">
        <span class="vad-stat-value">${vad.buffer_replays || 0}</span>
        <span class="vad-stat-label">Replays</span>
      </div>
      <div class="vad-stat">
        <span class="vad-stat-value ${wakeFailures > 0 ? 'audit-warning' : ''}">${wakeFailures}</span>
        <span class="vad-stat-label">Wake Fails</span>
      </div>
    </div>`;

  if (vad.total_stream_paused_min) {
    html += `<div class="card" style="margin-bottom:12px;">
      <span style="font-size:13px;color:#888;">Stream paused: </span>
      <span style="font-weight:600;color:#22c55e;">${vad.total_stream_paused_min.toFixed(2)} min</span>
      <span style="font-size:13px;color:#888;"> (saved </span>
      <span style="font-weight:600;color:#22c55e;">&pound;${toGBP(vad.deepgram_saved_usd || 0)}</span>
      <span style="font-size:13px;color:#888;"> Deepgram)</span>
    </div>`;
  }

  if (cycles.length > 0) {
    html += `<div class="card"><div class="vad-cycles">`;
    for (const c of cycles) {
      const dozeTime = c.doze_start ? new Date(c.doze_start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "?";
      const dur = c.duration_sec != null ? c.duration_sec.toFixed(1) + "s" : "ongoing";
      const fromClass = c.wake_from === "sleeping" ? "vad-from-sleeping" : "vad-from-dozing";
      const fromLabel = c.wake_from === "sleeping" ? "Deep" : "Doze";
      html += `
        <div class="vad-cycle">
          <span class="vad-cycle-time">${escapeHtml(dozeTime)}</span>
          <span class="vad-cycle-from ${fromClass}">${fromLabel}</span>
          <span class="vad-cycle-dur">${dur}</span>
          ${c.buffer_replayed ? '<span class="vad-cycle-replay">replayed</span>' : ''}
        </div>`;
    }
    html += `</div></div>`;
  }

  return html;
}

// ── Section 7: Sonnet Prompt Audit ──

function buildPromptAudit() {
  const audit = summary.sonnet_prompt_audit;
  if (!audit || !audit.estimated_tokens) {
    return `<div class="card"><p class="muted">No prompt audit data available.</p></div>`;
  }

  const tokens = audit.estimated_tokens;
  const isOverThreshold = tokens > 4000;
  const trims = audit.suggested_trims || [];

  let html = `
    <div class="audit-stats">
      <div class="audit-stat">
        <span class="audit-stat-value ${isOverThreshold ? 'audit-warning' : ''}">${formatTokens(tokens)}</span>
        <span class="audit-stat-label">Prompt tokens</span>
      </div>
      <div class="audit-stat">
        <span class="audit-stat-value">&pound;${toGBP(audit.cost_per_session)}</span>
        <span class="audit-stat-label">Prompt cost/session</span>
      </div>
      <div class="audit-stat">
        <span class="audit-stat-value">${audit.field_count_in_prompt || 0}</span>
        <span class="audit-stat-label">Fields defined</span>
      </div>
      <div class="audit-stat">
        <span class="audit-stat-value">${audit.rules_count || 0}</span>
        <span class="audit-stat-label">Rule sections</span>
      </div>
    </div>`;

  if (audit.warning) {
    html += `<div class="audit-warning-box">${escapeHtml(audit.warning)}</div>`;
  }

  if (trims.length > 0) {
    html += `<div class="audit-trims-title">Suggested Trims</div>`;
    for (const trim of trims) {
      const savings = trim.estimated_tokens ? ` (~${trim.estimated_tokens} tokens)` : "";
      html += `
        <div class="audit-trim-item">
          <span class="audit-trim-section">${escapeHtml(trim.section)}${savings}</span>
          <span class="audit-trim-suggestion">${escapeHtml(trim.suggestion)}</span>
        </div>`;
    }
  }

  // Net token change from recommendations
  const tokenImpacts = recommendations.filter((r) => r.token_impact);
  if (tokenImpacts.length > 0) {
    const netChange = tokenImpacts.reduce((sum, r) => sum + (r.token_impact || 0), 0);
    const sign = netChange > 0 ? "+" : "";
    const cls = netChange > 0 ? "audit-warning" : "audit-good";
    html += `<div class="audit-net-change">Net token change from recommendations: <span class="${cls}">${sign}${netChange} tokens</span></div>`;
  }

  return html;
}

// ── Assemble the full HTML ──

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CertMate Session Review</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 0; margin: 0; }

    /* ── Sticky nav ── */
    .nav { position: sticky; top: 0; z-index: 100; background: #12122a; border-bottom: 1px solid #2a2a4a; display: flex; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .nav a { flex: 0 0 auto; padding: 10px 14px; font-size: 13px; font-weight: 600; color: #888; text-decoration: none; white-space: nowrap; border-bottom: 2px solid transparent; transition: color 0.2s, border-color 0.2s; }
    .nav a:hover, .nav a.active { color: #4cc9f0; border-bottom-color: #4cc9f0; }

    /* ── Page container ── */
    .page { max-width: 640px; margin: 0 auto; padding: 16px; padding-bottom: 100px; }

    /* ── Header ── */
    h1 { font-size: 20px; margin-bottom: 4px; color: #fff; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 16px; }

    /* ── Scoreboard ── */
    .scoreboard { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
    .score-box { flex: 1; min-width: 70px; padding: 10px 8px; border-radius: 10px; text-align: center; }
    .score-box .score-value { font-size: 22px; font-weight: 800; display: block; }
    .score-box .score-label { font-size: 11px; opacity: 0.85; display: block; margin-top: 2px; }
    .score-regex { background: #22c55e22; border: 1px solid #22c55e; color: #22c55e; }
    .score-sonnet { background: #a855f722; border: 1px solid #a855f7; color: #a855f7; }
    .score-missed { background: #ef444422; border: 1px solid #ef4444; color: #ef4444; }
    .score-total { background: #4cc9f022; border: 1px solid #4cc9f0; color: #4cc9f0; }

    /* ── Section headings ── */
    .section { margin-top: 24px; }
    .section-title { font-size: 17px; font-weight: 700; color: #fff; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid #2a2a4a; display: flex; align-items: center; justify-content: space-between; cursor: pointer; }
    .section-title .collapse-icon { font-size: 14px; color: #666; transition: transform 0.2s; }
    .section-title .collapse-icon.collapsed { transform: rotate(-90deg); }
    .section-body { overflow: visible; transition: max-height 0.3s ease; }
    .section-body.collapsed { max-height: 0 !important; overflow: hidden; }

    /* ── Card ── */
    .card { background: #16213e; border-radius: 10px; padding: 14px; margin-bottom: 12px; border: 1px solid #2a2a4a; }
    .muted { color: #666; font-size: 13px; }

    /* ── Cost Dashboard ── */
    .cost-total { text-align: center; margin-bottom: 16px; padding: 16px; background: #16213e; border-radius: 12px; border: 1px solid #2a2a4a; }
    .cost-total-label { display: block; font-size: 13px; color: #888; margin-bottom: 4px; }
    .cost-total-value { display: block; font-size: 32px; font-weight: 800; color: #4cc9f0; }
    .cost-grid { display: flex; flex-direction: column; gap: 8px; }
    .cost-item { background: #16213e; border-radius: 10px; padding: 12px 14px; border: 1px solid #2a2a4a; }
    .cost-item-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
    .cost-item-name { font-weight: 600; font-size: 14px; color: #e0e0e0; }
    .cost-item-price { font-weight: 700; font-size: 14px; color: #4cc9f0; }
    .cost-item-detail { font-size: 12px; color: #888; }
    .token-grid { margin-top: 8px; border-top: 1px solid #2a2a4a; padding-top: 6px; }
    .token-row { display: flex; justify-content: space-between; font-size: 12px; color: #999; padding: 2px 0; }
    .token-label { min-width: 80px; }
    .token-val { font-weight: 600; color: #ccc; min-width: 50px; text-align: right; }
    .token-rate { min-width: 60px; text-align: right; color: #666; }
    .est-badge { font-size: 10px; background: #eab30833; color: #eab308; padding: 1px 5px; border-radius: 4px; }

    /* ── Field Attribution ── */
    .field-section { margin-bottom: 12px; }
    .field-section-header { font-size: 13px; font-weight: 700; color: #4cc9f0; padding: 6px 0 4px; border-bottom: 1px solid #2a2a4a; margin-bottom: 4px; }
    .field-table { display: flex; flex-direction: column; }
    .field-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid #1a1a2e; flex-wrap: wrap; }
    .field-name { font-family: monospace; font-size: 12px; color: #ccc; min-width: 90px; flex: 0 0 auto; }
    .field-source { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; border: 1px solid; flex: 0 0 auto; }
    .field-value { font-family: monospace; font-size: 13px; color: #fff; font-weight: 600; flex: 1; }
    .field-dash { color: #444; }
    .field-note { font-size: 11px; color: #888; font-style: italic; flex: 0 0 100%; padding-left: 98px; }

    /* ── Transcript Viewer ── */
    .transcript-controls { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
    .toggle-label { font-size: 13px; color: #888; display: flex; align-items: center; gap: 4px; cursor: pointer; }
    .toggle-label input { accent-color: #4cc9f0; }
    .transcript-stat { font-size: 12px; color: #666; }
    .flagged-count { color: #ef4444 !important; font-weight: 600; }
    .transcript-list { max-height: 500px; overflow-y: auto; border: 1px solid #2a2a4a; border-radius: 10px; background: #12122a; }

    .utt { padding: 8px 12px; border-bottom: 1px solid #1a1a2e; }
    .utt:last-child { border-bottom: none; }
    .utt-header { display: flex; align-items: flex-start; gap: 8px; }
    .utt-time { font-family: monospace; font-size: 11px; color: #666; min-width: 60px; flex: 0 0 auto; padding-top: 2px; }
    .utt-text { font-size: 13px; color: #ddd; line-height: 1.4; flex: 1; }
    .utt-conversation { opacity: 0.4; }
    .utt-conversation.hidden { display: none; }
    .utt-uncaptured { border-left: 3px solid #ef4444; }
    .utt-repeat { border-left: 3px solid #eab308; }
    .utt-uncaptured-badge { font-size: 10px; background: #ef444433; color: #ef4444; padding: 1px 6px; border-radius: 4px; flex: 0 0 auto; }
    .utt-repeat-badge { font-size: 10px; background: #eab30833; color: #eab308; padding: 1px 6px; border-radius: 4px; flex: 0 0 auto; }

    .utt-annotations { padding-left: 68px; margin-top: 4px; }
    .ann { font-size: 12px; padding: 2px 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .ann-source { font-weight: 700; font-size: 11px; padding: 1px 6px; border-radius: 4px; }
    .ann-regex .ann-source { background: #22c55e22; color: #22c55e; }
    .ann-sonnet .ann-source { background: #a855f722; color: #a855f7; }
    .ann-missed { color: #ef4444; }
    .ann-missed .ann-source { background: #ef444422; color: #ef4444; }
    .ann-field { font-family: monospace; color: #ccc; }
    .ann-value { font-weight: 600; color: #fff; }
    .ann-latency { color: #666; font-size: 11px; }

    .flag-btn { font-size: 11px; background: #ef444422; color: #ef4444; border: 1px solid #ef444466; border-radius: 6px; padding: 2px 8px; cursor: pointer; margin-left: 4px; }
    .flag-btn:hover { background: #ef444444; }
    .flag-btn.flagged { background: #ef4444; color: #fff; }

    /* ── Flag panel ── */
    .flag-panel { position: fixed; bottom: 0; left: 0; right: 0; max-width: 640px; margin: 0 auto; background: #1e1e3a; border-top: 2px solid #ef4444; border-radius: 12px 12px 0 0; padding: 12px 16px; z-index: 200; box-shadow: 0 -4px 20px rgba(0,0,0,0.5); }
    .flag-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-weight: 700; color: #ef4444; }
    .flag-panel-close { font-size: 12px; background: none; border: 1px solid #666; color: #888; padding: 2px 8px; border-radius: 4px; cursor: pointer; }
    .flag-panel-list { max-height: 120px; overflow-y: auto; margin-bottom: 8px; }
    .btn-flag-submit { display: block; width: 100%; padding: 10px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; background: #ef4444; color: #fff; }

    /* ── Missed Values ── */
    .missed-table { border: 1px solid #2a2a4a; border-radius: 10px; overflow: hidden; }
    .missed-header-row { display: flex; background: #16213e; padding: 8px 12px; font-size: 12px; font-weight: 700; color: #888; border-bottom: 1px solid #2a2a4a; }
    .missed-row { display: flex; padding: 8px 12px; border-bottom: 1px solid #1a1a2e; font-size: 13px; }
    .missed-row:last-child { border-bottom: none; }
    .missed-col-field { flex: 2; font-family: monospace; font-size: 12px; color: #ccc; }
    .missed-col-reason { flex: 2; font-size: 12px; }
    .missed-col-ref { flex: 1; text-align: right; }
    .missed-reason-not_spoken { color: #666; }
    .missed-reason-regex_missed_sonnet_missed { color: #ef4444; }
    .missed-reason-circuit_not_mentioned { color: #888; }
    .missed-reason-not_set { color: #666; }
    .missed-link { color: #4cc9f0; text-decoration: none; font-size: 12px; }
    .missed-link:hover { text-decoration: underline; }

    /* ── Recommendations ── */
    .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
    .checkbox-label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
    .rec-title { font-weight: 600; font-size: 15px; color: #fff; }
    .rec-desc { font-size: 13px; color: #aaa; margin-bottom: 8px; line-height: 1.4; }
    .file-path { font-family: monospace; font-size: 12px; color: #4cc9f0; margin-bottom: 6px; }
    details { margin-top: 6px; }
    summary { font-size: 13px; color: #888; cursor: pointer; }
    .diff { font-family: monospace; font-size: 12px; margin-top: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
    .diff-old { background: #3d1f1f; color: #ff6b6b; padding: 4px 8px; border-radius: 4px; margin-bottom: 2px; }
    .diff-new { background: #1f3d2a; color: #51cf66; padding: 4px 8px; border-radius: 4px; }
    input[type="checkbox"] { width: 24px; height: 24px; accent-color: #2ecc71; min-width: 24px; }
    .rec-card { cursor: pointer; -webkit-tap-highlight-color: rgba(46,204,113,0.2); transition: border-color 0.15s; }
    .rec-card:active { border-color: #2ecc71; }
    .rec-card.deselected { opacity: 0.5; }
    .category-badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; color: #fff; margin-left: 6px; white-space: nowrap; vertical-align: middle; }
    .token-badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; margin-left: 4px; white-space: nowrap; vertical-align: middle; }
    .token-plus { background: #ef444422; border: 1px solid #ef4444; color: #ef4444; }
    .token-minus { background: #22c55e22; border: 1px solid #22c55e; color: #22c55e; }

    /* ── Sonnet Prompt Audit ── */
    .audit-stats { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .audit-stat { flex: 1; min-width: 70px; background: #16213e; border-radius: 10px; padding: 10px 8px; text-align: center; border: 1px solid #2a2a4a; }
    .audit-stat-value { font-size: 20px; font-weight: 800; color: #e0e0e0; display: block; }
    .audit-stat-label { font-size: 11px; color: #888; display: block; margin-top: 2px; }
    .audit-warning { color: #ef4444 !important; }
    .audit-good { color: #22c55e !important; }
    .audit-warning-box { background: #ef444415; border: 1px solid #ef444440; border-radius: 8px; padding: 10px 14px; font-size: 13px; color: #ef4444; margin-bottom: 12px; }
    .audit-trims-title { font-size: 14px; font-weight: 600; color: #ccc; margin: 12px 0 6px; }
    .audit-trim-item { background: #16213e; border-radius: 8px; padding: 10px 12px; margin-bottom: 6px; border: 1px solid #2a2a4a; }
    .audit-trim-section { display: block; font-weight: 600; font-size: 13px; color: #a855f7; margin-bottom: 2px; }
    .audit-trim-suggestion { font-size: 12px; color: #999; }
    .audit-net-change { margin-top: 12px; padding: 10px 14px; background: #16213e; border-radius: 8px; border: 1px solid #2a2a4a; font-size: 13px; color: #ccc; }

    /* ── Actions ── */
    .actions-bar { position: sticky; bottom: 0; background: #1a1a2e; padding: 12px 16px; border-top: 1px solid #2a2a4a; z-index: 50; margin: 0 -16px; }
    .btn { display: block; width: 100%; padding: 14px; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; margin-bottom: 8px; -webkit-tap-highlight-color: rgba(46,204,113,0.3); }
    .btn-accept { background: #2ecc71; color: #fff; }
    .btn-accept:active { background: #27ae60; }
    .btn-reject { background: #444; color: #ccc; }
    .btn-reject:active { background: #555; }
    .btn-rerun { background: #3498db; color: #fff; }
    .btn:disabled { opacity: 0.5; }
    textarea { width: 100%; min-height: 80px; padding: 12px; border-radius: 8px; border: 1px solid #2a2a4a; background: #16213e; color: #e0e0e0; font-size: 14px; font-family: inherit; resize: vertical; margin-bottom: 8px; }
    .context-section { margin-top: 16px; margin-bottom: 80px; }
    .context-label { font-size: 14px; color: #888; margin-bottom: 6px; }
    .result-msg { padding: 14px; border-radius: 10px; text-align: center; font-size: 15px; margin-bottom: 12px; display: none; }
    .result-ok { background: #1f3d2a; color: #2ecc71; }
    .result-err { background: #3d1f1f; color: #ff6b6b; }

    /* ── VAD Sleep/Wake Analysis ── */
    .vad-grid { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .vad-stat { flex: 1; min-width: 70px; background: #16213e; border-radius: 10px; padding: 10px 8px; text-align: center; border: 1px solid #2a2a4a; }
    .vad-stat-value { font-size: 20px; font-weight: 800; color: #e0e0e0; display: block; }
    .vad-stat-label { font-size: 11px; color: #888; display: block; margin-top: 2px; }
    .vad-cycles { margin-top: 8px; }
    .vad-cycle { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid #1a1a2e; font-size: 12px; color: #ccc; }
    .vad-cycle:last-child { border-bottom: none; }
    .vad-cycle-time { font-family: monospace; min-width: 60px; color: #888; }
    .vad-cycle-dur { font-weight: 600; min-width: 50px; text-align: right; }
    .vad-cycle-from { font-size: 11px; padding: 1px 6px; border-radius: 4px; }
    .vad-from-dozing { background: #eab30822; color: #eab308; }
    .vad-from-sleeping { background: #a855f722; color: #a855f7; }
    .vad-cycle-replay { font-size: 10px; color: #22c55e; }

    /* ── Debug issues ── */
    .debug-section { background: #2a1a1a; border: 1px solid #4a2a2a; border-radius: 10px; padding: 14px; margin-bottom: 16px; }
    .debug-title { color: #ff6b6b; font-weight: 600; margin-bottom: 6px; }
  </style>
</head>
<body>

  <nav class="nav">
    <a href="#section-cost" class="active" onclick="scrollToSection('section-cost')">Cost</a>
    <a href="#section-fields" onclick="scrollToSection('section-fields')">Fields</a>
    <a href="#section-transcript" onclick="scrollToSection('section-transcript')">Transcript</a>
    <a href="#section-missed" onclick="scrollToSection('section-missed')">Missed</a>
    <a href="#section-recs" onclick="scrollToSection('section-recs')">Recs</a>
    <a href="#section-vad" onclick="scrollToSection('section-vad')">Sleep</a>
    <a href="#section-audit" onclick="scrollToSection('section-audit')">Audit</a>
  </nav>

  <div class="page">
    <h1>Session Review</h1>
    <div class="subtitle">${escapeHtml(summary.address || "Unknown address")} &mdash; ${escapeHtml(summary.date || "")}</div>

    <div class="scoreboard">
      <div class="score-box score-regex">
        <span class="score-value">${summary.regexFieldsSet || summary.regexFields || 0}</span>
        <span class="score-label">Regex</span>
      </div>
      <div class="score-box score-sonnet">
        <span class="score-value">${summary.sonnetFieldsSet || summary.sonnetFields || 0}</span>
        <span class="score-label">Sonnet</span>
      </div>
      <div class="score-box score-missed">
        <span class="score-value">${(summary.empty_fields || []).length || summary.missedFields || 0}</span>
        <span class="score-label">Missed</span>
      </div>
      <div class="score-box score-total">
        <span class="score-value">${(summary.regexFieldsSet || summary.regexFields || 0) + (summary.sonnetFieldsSet || summary.sonnetFields || 0)}</span>
        <span class="score-label">Total Set</span>
      </div>
    </div>

    ${summary.debugIssues ? `
    <div class="debug-section">
      <div class="debug-title">Debug Issues Reported</div>
      <p style="font-size:13px;color:#ccc;">${escapeHtml(summary.debugIssues)}</p>
    </div>` : ""}

    <!-- Section 1: Cost Dashboard -->
    <div class="section" id="section-cost">
      <div class="section-title" onclick="toggleSection('cost')">
        <span>Cost Dashboard</span>
        <span class="collapse-icon" id="icon-cost">&#9660;</span>
      </div>
      <div class="section-body" id="body-cost">
        ${buildCostDashboard()}
      </div>
    </div>

    <!-- Section 2: Field Attribution -->
    <div class="section" id="section-fields">
      <div class="section-title" onclick="toggleSection('fields')">
        <span>Field Attribution</span>
        <span class="collapse-icon" id="icon-fields">&#9660;</span>
      </div>
      <div class="section-body" id="body-fields">
        ${buildFieldAttribution()}
      </div>
    </div>

    <!-- Section 3: Annotated Transcript -->
    <div class="section" id="section-transcript">
      <div class="section-title" onclick="toggleSection('transcript')">
        <span>Annotated Transcript</span>
        <span class="collapse-icon" id="icon-transcript">&#9660;</span>
      </div>
      <div class="section-body" id="body-transcript">
        ${buildTranscriptViewer()}
      </div>
    </div>

    <!-- Section 4: Missed Values -->
    <div class="section" id="section-missed">
      <div class="section-title" onclick="toggleSection('missed')">
        <span>Missed Values</span>
        <span class="collapse-icon" id="icon-missed">&#9660;</span>
      </div>
      <div class="section-body" id="body-missed">
        ${buildMissedValues()}
      </div>
    </div>

    <!-- Section 5: Recommendations -->
    <div class="section" id="section-recs">
      <div class="section-title" onclick="toggleSection('recs')">
        <span>Recommendations (${recommendations.length})</span>
        <span class="collapse-icon" id="icon-recs">&#9660;</span>
      </div>
      <div class="section-body" id="body-recs">
        <div id="recommendations">
          ${buildRecommendationCards(recommendations)}
        </div>
      </div>
    </div>

    <!-- Actions bar: OUTSIDE section-body to avoid overflow:hidden clipping -->
    ${recommendations.length > 0 ? `
    <div id="result-msg" class="result-msg"></div>
    <div style="height:80px;"></div>
    <div class="actions-bar">
      <button class="btn btn-accept" id="btn-accept" onclick="acceptSelected()">Accept Selected</button>
      <button class="btn btn-reject" id="btn-reject" onclick="rejectAll()">Reject All</button>
    </div>
    ` : ''}

    <!-- Section 6: VAD Sleep/Wake Analysis -->
    <div class="section" id="section-vad">
      <div class="section-title" onclick="toggleSection('vad')">
        <span>Sleep/Wake Analysis</span>
        <span class="collapse-icon" id="icon-vad">&#9660;</span>
      </div>
      <div class="section-body" id="body-vad">
        ${buildVadAnalysis()}
      </div>
    </div>

    <!-- Section 7: Sonnet Prompt Audit -->
    <div class="section" id="section-audit">
      <div class="section-title" onclick="toggleSection('audit')">
        <span>Sonnet Prompt Audit</span>
        <span class="collapse-icon" id="icon-audit">&#9660;</span>
      </div>
      <div class="section-body" id="body-audit">
        ${buildPromptAudit()}
      </div>
    </div>

    <!-- Re-run section -->
    <div class="context-section">
      <div class="section-title" style="cursor:default;">Re-run with more context</div>
      <div class="context-label">Add context for the optimizer to consider:</div>
      <textarea id="context" placeholder="e.g. 'Type A was for wiring type not RCD type' or 'the regex for r1r2 needs to handle spoken decimals better'"></textarea>
      <button class="btn btn-rerun" onclick="rerunWithContext()">Re-run Analysis</button>
    </div>
  </div>

  <script>
    var REPORT_ID = "${reportId}";
    var API_BASE = "";

    // ── Section collapsing ──

    function toggleSection(name) {
      var body = document.getElementById("body-" + name);
      var icon = document.getElementById("icon-" + name);
      if (body.classList.contains("collapsed")) {
        body.classList.remove("collapsed");
        body.style.maxHeight = body.scrollHeight + "px";
        icon.classList.remove("collapsed");
      } else {
        body.classList.add("collapsed");
        body.style.maxHeight = "0";
        icon.classList.add("collapsed");
      }
    }

    // Initialize section heights
    document.addEventListener("DOMContentLoaded", function() {
      var bodies = document.querySelectorAll(".section-body");
      for (var i = 0; i < bodies.length; i++) {
        bodies[i].style.maxHeight = bodies[i].scrollHeight + "px";
      }
    });

    // ── Nav scroll ──

    function scrollToSection(id) {
      var el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      // Update active nav
      var links = document.querySelectorAll(".nav a");
      for (var i = 0; i < links.length; i++) { links[i].classList.remove("active"); }
      var link = document.querySelector('.nav a[href="#' + id + '"]');
      if (link) link.classList.add("active");
    }

    // Update nav on scroll
    var navSections = ["section-cost", "section-fields", "section-transcript", "section-missed", "section-recs", "section-vad", "section-audit"];
    window.addEventListener("scroll", function() {
      var scrollPos = window.scrollY + 60;
      for (var i = navSections.length - 1; i >= 0; i--) {
        var el = document.getElementById(navSections[i]);
        if (el && el.offsetTop <= scrollPos) {
          var links = document.querySelectorAll(".nav a");
          for (var j = 0; j < links.length; j++) { links[j].classList.remove("active"); }
          var link = document.querySelector('.nav a[href="#' + navSections[i] + '"]');
          if (link) link.classList.add("active");
          break;
        }
      }
    });

    // ── Conversation toggle ──

    var toggleConv = document.getElementById("toggle-conversation");
    if (toggleConv) {
      toggleConv.addEventListener("change", function() {
        var convUtts = document.querySelectorAll('.utt[data-conversation="1"]');
        for (var i = 0; i < convUtts.length; i++) {
          if (toggleConv.checked) {
            convUtts[i].classList.remove("hidden");
          } else {
            convUtts[i].classList.add("hidden");
          }
        }
      });
    }

    // ── Transcript flagging ──

    var flaggedItems = [];

    function flagUtterance(idx) {
      var utts = document.querySelectorAll(".utt");
      if (idx >= utts.length) return;
      var utt = utts[idx];
      var textEl = utt.querySelector(".utt-text");
      var textContent = textEl ? textEl.textContent : "";
      var btn = utt.querySelector(".flag-btn");

      // Toggle flag
      var existingIdx = -1;
      for (var i = 0; i < flaggedItems.length; i++) {
        if (flaggedItems[i].idx === idx) { existingIdx = i; break; }
      }

      if (existingIdx >= 0) {
        flaggedItems.splice(existingIdx, 1);
        if (btn) btn.classList.remove("flagged");
      } else {
        flaggedItems.push({ idx: idx, text: textContent });
        if (btn) btn.classList.add("flagged");
      }

      updateFlagPanel();
    }

    function updateFlagPanel() {
      var panel = document.getElementById("flag-panel");
      var list = document.getElementById("flag-panel-list");
      var countEl = document.getElementById("flagged-count");

      if (flaggedItems.length === 0) {
        panel.style.display = "none";
        countEl.style.display = "none";
        return;
      }

      panel.style.display = "block";
      countEl.style.display = "inline";
      countEl.textContent = flaggedItems.length + " flagged";

      // Build flag panel list safely using DOM methods
      while (list.firstChild) { list.removeChild(list.firstChild); }
      for (var i = 0; i < flaggedItems.length; i++) {
        var div = document.createElement("div");
        div.className = "flag-panel-item";
        div.textContent = flaggedItems[i].text.substring(0, 100);
        list.appendChild(div);
      }
    }

    function clearFlags() {
      flaggedItems = [];
      var btns = document.querySelectorAll(".flag-btn.flagged");
      for (var i = 0; i < btns.length; i++) { btns[i].classList.remove("flagged"); }
      updateFlagPanel();
    }

    function submitFlags() {
      if (flaggedItems.length === 0) return;
      var parts = ["FLAGGED TRANSCRIPT SEGMENTS FOR IMPROVEMENT:", ""];
      for (var i = 0; i < flaggedItems.length; i++) {
        parts.push((i + 1) + ". " + flaggedItems[i].text);
      }
      var context = parts.join("\\n");

      showResult("Submitting " + flaggedItems.length + " flagged items...", true);

      fetch(API_BASE + "/api/optimizer-report/" + REPORT_ID + "/rerun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: context })
      }).then(function(res) { return res.json(); }).then(function(data) {
        if (data.success) {
          showResult("Flagged items submitted. New report URL via Pushover in ~3-5 min.", true);
          clearFlags();
        } else {
          showResult("Error: " + (data.error || "Unknown error"), false);
        }
      }).catch(function(e) {
        showResult("Network error: " + e.message, false);
      });
    }

    // ── Scroll to utterance (from Missed Values links) ──

    function scrollToUtterance(idx) {
      var utts = document.querySelectorAll(".utt");
      if (idx < utts.length) {
        // Ensure transcript section is open
        var body = document.getElementById("body-transcript");
        if (body.classList.contains("collapsed")) {
          toggleSection("transcript");
        }
        setTimeout(function() {
          utts[idx].scrollIntoView({ behavior: "smooth", block: "center" });
          utts[idx].style.background = "#4cc9f022";
          setTimeout(function() { utts[idx].style.background = ""; }, 2000);
        }, 300);
      }
    }

    // ── Result messages ──

    function showResult(msg, ok) {
      var el = document.getElementById("result-msg");
      el.textContent = msg;
      el.className = "result-msg " + (ok ? "result-ok" : "result-err");
      el.style.display = "block";
    }

    function disableButtons() {
      document.getElementById("btn-accept").disabled = true;
      document.getElementById("btn-reject").disabled = true;
    }

    // ── Toggle recommendation card ──

    function toggleRec(event, idx) {
      var cb = document.querySelector('#rec-' + idx + ' input[type="checkbox"]');
      if (!cb) return;
      cb.checked = !cb.checked;
      var card = document.getElementById('rec-' + idx);
      if (card) {
        if (cb.checked) { card.classList.remove('deselected'); }
        else { card.classList.add('deselected'); }
      }
    }

    // ── Accept/Reject/Rerun ──

    function acceptSelected() {
      try {
        var checkboxes = document.querySelectorAll('input[name="accepted"]:checked');
        var checked = [];
        for (var i = 0; i < checkboxes.length; i++) { checked.push(parseInt(checkboxes[i].value)); }
        if (checked.length === 0) { showResult("No recommendations selected", false); return; }
        disableButtons();
        showResult("Applying " + checked.length + " change(s)...", true);
        var url = API_BASE + "/api/optimizer-report/" + REPORT_ID + "/accept";
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accepted: checked })
        }).then(function(res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        }).then(function(data) {
          if (data.success) {
            var msg = "Changes queued. Pushover confirmation when applied (~2 min).";
            showResult(msg, true);
            try { window.alert(msg); } catch(e) {}
          } else {
            showResult("Error: " + (data.error || "Unknown error"), false);
          }
        }).catch(function(e) {
          var msg = "Network error: " + e.message;
          showResult(msg, false);
          try { window.alert(msg + "\\n\\nURL: " + url); } catch(e2) {}
        });
      } catch(e) {
        var msg = "JS error: " + e.message;
        showResult(msg, false);
        try { window.alert(msg); } catch(e2) {}
      }
    }

    function rejectAll() {
      disableButtons();
      fetch(API_BASE + "/api/optimizer-report/" + REPORT_ID + "/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }).then(function() {
        showResult("All recommendations rejected.", true);
      }).catch(function() {
        showResult("Noted. No changes will be applied.", true);
      });
    }

    function rerunWithContext() {
      var context = document.getElementById("context").value.trim();
      if (!context) { showResult("Please enter some context first", false); return; }
      showResult("Submitting re-run request...", true);
      fetch(API_BASE + "/api/optimizer-report/" + REPORT_ID + "/rerun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: context })
      }).then(function(res) { return res.json(); }).then(function(data) {
        if (data.success) {
          showResult("Re-run queued. New Pushover URL when ready (~3-5 min).", true);
        } else {
          showResult("Error: " + (data.error || "Unknown error"), false);
        }
      }).catch(function(e) {
        showResult("Network error: " + e.message, false);
      });
    }
  </script>
</body>
</html>`;

fs.writeFileSync(outputPath, html, "utf8");
console.log("Report generated: " + outputPath);
