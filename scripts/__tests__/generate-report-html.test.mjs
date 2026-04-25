// Phase 8 — Plan 08-04 r3-#1 (MAJOR) — defence-in-depth renderer escape audit.
//
// Codex r3-#1 raised that raw answer_outcome log values flowed into
// analysis.json's unknown_outcomes[] / warnings[] surfaces; the analyzer
// side closed by sanitising-on-the-way-IN (safeDisplayValue). This test
// file closes the renderer side: every user-data slot rendered by
// scripts/generate-report-html.js MUST flow through escapeHtml().
//
// The contract is verified by spawning the renderer as a child process
// against a synthetic summary containing adversarial XSS payloads in
// every slot the renderer reads, then asserting the rendered HTML body
// contains zero live <script> elements + every adversarial payload
// appears in escaped form.
//
// Run with:  node --test scripts/__tests__/generate-report-html.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rendererPath = join(here, "..", "generate-report-html.js");

// Spawn the renderer with synthetic recommendations + summary inputs.
// Returns the rendered HTML string.
function runRenderer({ recommendations, summary }) {
  const dir = mkdtempSync(join(tmpdir(), "report-html-test-"));
  const recsPath = join(dir, "recommendations.json");
  const summaryPath = join(dir, "summary.json");
  const outPath = join(dir, "report.html");
  writeFileSync(recsPath, JSON.stringify(recommendations));
  writeFileSync(summaryPath, JSON.stringify(summary));
  execFileSync(
    process.execPath,
    [rendererPath, recsPath, summaryPath, "test-report-id", outPath],
    { stdio: "pipe" },
  );
  const html = readFileSync(outPath, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return html;
}

// Counts occurrences of literal `<script>` (case-insensitive) opening
// tags that are NOT followed by `>/* legitimate inline JS marker */`.
// The renderer's footer contains legitimate inline JS for interactive
// behaviour — those tags don't carry user-data, but we still need to
// exclude them from the "live script element" assertion.
function countLiveScriptTags(html) {
  // Match `<script` followed by any non-`>` char then `>` — the renderer's
  // own inline scripts use that form (no src= attribute, just `<script>`).
  // Adversarial payloads we inject all use the bare form `<script>...`.
  // We want: (count of `<script` opening tags) minus (count of legitimate
  // ones from the renderer template). Simplest robust signal: compare
  // baseline (clean summary) script count vs adversarial-summary script
  // count; if they differ, the adversarial payload is rendering as live.
  const matches = html.match(/<script\b/gi);
  return matches ? matches.length : 0;
}

// A summary that exercises every user-data slot the renderer reads,
// EXCEPT we leave the slots benign so the test can lock the baseline
// "live script element" count for the renderer's own legitimate inline JS.
function benignSummary() {
  return {
    address: "1 High Street",
    date: "2026-04-23",
    regexFieldsSet: 5,
    sonnetFieldsSet: 3,
    debugIssues: "none",
    field_report: [],
    empty_fields: [],
    utterance_analysis: [],
    cost_breakdown: {
      total_usd: 1.23,
      deepgram: { cost_usd: 0.5, minutes: 6.5 },
      sonnet: { cost_usd: 0.6, turns: 12, compactions: 1, token_breakdown: {} },
      gpt_vision: { cost_usd: 0.1, photos: 2 },
      elevenlabs: { cost_usd: 0.03, characters: 1000 },
    },
    tool_call_traffic: {
      enabled: true,
      tools: [{ name: "ask_user", count: 3, median_duration_ms: 2000, validation_error_count: 0 }],
      ask_user: { total: 3, outcomes: { answered: 3, gated: 0 } },
    },
    sonnet_prompt_audit: { estimated_tokens: 1234, field_count_in_prompt: 50, rules_count: 12, suggested_trims: [] },
  };
}

const XSS_SCRIPT = "<script>alert(1)</script>";
const XSS_IMG = "<img src=x onerror=alert(2)>";
const XSS_SVG = "<svg onload=alert(3)>";
const XSS_QUOTE_BREAK = '"><script>alert(4)</script>';

test("Plan 08-04 r3-#1 — baseline benign summary renders without injecting extra <script> tags", () => {
  // Lock the renderer's own legitimate inline-JS script count. Any
  // adversarial test that exceeds this baseline is a stored-XSS sink.
  const html = runRenderer({ recommendations: [], summary: benignSummary() });
  const baseline = countLiveScriptTags(html);
  // The renderer ships interactive JS (toggleRec, scrollToUtterance,
  // submitFlags, etc) — there's at least one legitimate <script> tag.
  assert.ok(baseline >= 1, "Baseline must include the renderer's own inline JS");
  // Sanity: HTML body must include the benign address verbatim.
  assert.ok(html.includes("1 High Street"));
});

test("Plan 08-04 r3-#1 — tool name with <script> payload is escaped (not live)", () => {
  const baseline = countLiveScriptTags(
    runRenderer({ recommendations: [], summary: benignSummary() }),
  );

  const summary = benignSummary();
  summary.tool_call_traffic.tools = [
    { name: XSS_SCRIPT, count: 1, median_duration_ms: 100, validation_error_count: 0 },
  ];
  const html = runRenderer({ recommendations: [], summary });

  // Live <script> count MUST equal baseline (no new live tags injected).
  assert.equal(
    countLiveScriptTags(html),
    baseline,
    "Adversarial tool name MUST NOT inject a live <script> tag",
  );
  // Escaped form MUST appear in the HTML body.
  assert.ok(
    html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"),
    "Adversarial tool name MUST be HTML-escaped",
  );
  // Raw form MUST NOT appear anywhere (defence-in-depth).
  assert.ok(
    !html.includes(XSS_SCRIPT),
    "Raw <script> form MUST NOT appear in rendered HTML",
  );
});

test("Plan 08-04 r3-#1 — recommendation title with onerror payload is escaped", () => {
  const baseline = countLiveScriptTags(
    runRenderer({ recommendations: [], summary: benignSummary() }),
  );

  const recs = [
    {
      title: XSS_IMG,
      description: "harmless desc",
      file: "src/safe.js",
      category: "bug_fix",
      old_code: "old",
      new_code: "new",
    },
  ];
  const html = runRenderer({ recommendations: recs, summary: benignSummary() });

  // <img onerror=> doesn't inject a <script> per se — but it still
  // executes JS via the error event handler. Defence: the raw form
  // MUST NOT appear in the body.
  assert.ok(
    !html.includes("<img src=x onerror="),
    "Raw <img onerror=> form MUST NOT appear in rendered HTML",
  );
  // Escaped form: < → &lt;, > → &gt;
  assert.ok(
    html.includes("&lt;img src=x onerror=alert(2)&gt;"),
    "Adversarial recommendation title MUST be HTML-escaped",
  );
  // No new live <script> tags either.
  assert.equal(countLiveScriptTags(html), baseline);
});

test("Plan 08-04 r3-#1 — recommendation file path with <script> payload is escaped", () => {
  const recs = [
    {
      title: "harmless title",
      description: "harmless desc",
      file: "../../etc/passwd<script>alert(5)</script>",
      category: "bug_fix",
      old_code: "old",
      new_code: "new",
    },
  ];
  const html = runRenderer({ recommendations: recs, summary: benignSummary() });

  assert.ok(
    !html.includes("passwd<script>"),
    "Raw <script> in file path MUST NOT appear",
  );
  assert.ok(
    html.includes("../../etc/passwd&lt;script&gt;alert(5)&lt;/script&gt;"),
    "Adversarial file path MUST be HTML-escaped",
  );
});

test("Plan 08-04 r3-#1 — empty_fields with adversarial reason MUST not render unescaped class or text", () => {
  // This test specifically targets the "missed values" section
  // (lines ~385-390 of generate-report-html.js): the loop renders
  //   <span class="missed-col-reason missed-reason-${ef.reason}">${reason}</span>
  // BOTH `${ef.reason}` (in the class attribute) AND `${reason}` (text
  // content — falls back to raw `ef.reason` when reasonLabels has no
  // entry) need to be escaped.
  const baseline = countLiveScriptTags(
    runRenderer({ recommendations: [], summary: benignSummary() }),
  );

  const summary = benignSummary();
  // Inject a hostile reason value: an attacker who poisons the analyzer
  // output (or a future analyzer code path) could land an arbitrary
  // string here. Use both an unknown reason key (so the fallback path
  // `ef.reason || "Unknown"` fires for the text content) AND HTML-
  // significant chars in both the class-attr and text-content positions.
  summary.empty_fields = [
    { key: "supply.frequency", reason: XSS_SCRIPT },
    { key: "supply.voltage", reason: XSS_QUOTE_BREAK },
  ];
  // Need at least one field_report entry so buildMissedValues renders
  // (it also reads field_report to compute the unset list, but
  // empty_fields alone is sufficient to enter the per-row loop).
  const html = runRenderer({ recommendations: [], summary });

  // Defence-in-depth: NO new <script> tag. Raw forms MUST NOT appear.
  assert.equal(
    countLiveScriptTags(html),
    baseline,
    "Adversarial reason MUST NOT inject a live <script> tag",
  );
  assert.ok(
    !html.includes(XSS_SCRIPT),
    `Raw <script> reason form MUST NOT appear in rendered HTML; html includes raw script payload (sanitised version is what should appear)`,
  );
  // The attribute-break payload (`"><script>...`) must not break out
  // of any class= attribute. Look for the literal raw form.
  assert.ok(
    !html.includes(XSS_QUOTE_BREAK),
    `Raw quote-break payload MUST NOT appear in rendered HTML`,
  );
  // Escaped form must be present somewhere (we can't pin the exact
  // location without knowing whether it appears in field-attribution
  // or missed-values section; both paths flow through the same
  // adversarial reason).
  assert.ok(
    html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"),
    "Escaped form of <script> reason MUST appear",
  );
});
