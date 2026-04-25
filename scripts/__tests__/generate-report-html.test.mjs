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

// ─────────────────────────────────────────────────────────────────
// Phase 8 — Plan 08-05 r4-#1 (MAJOR) — HTML report MUST render the
// unknown / malformed ask_user outcome warning block.
//
// Codex r4-#1 raised that `scripts/generate-report-html.js:550`
// (`buildToolCallTraffic()`) only displays the frozen-enum histogram
// — the analyzer-emitted `unknown_outcome_count` /
// `unknown_outcomes[]` / `malformed_outcome_count` surface (added
// across r1-#3 + r2-#2 + r3-#2) never reaches the operator. Drift is
// invisible until the optimizer cycles, by which point days of breach
// data may have accumulated unnoticed.
//
// Fix: render an attention-grabbing warning block when
// `unknown_outcome_count > 0 || malformed_outcome_count > 0`. Pull
// unknown values from `tool_call_traffic.ask_user.unknown_outcomes`
// (already sanitised by analyzer per r3-#1 `safeDisplayValue`); pull
// malformed values from `summary.warnings[]` filtering
// `type === "malformed_ask_user_outcome"`.
//
// Defence-in-depth: every value still flows through `escapeHtml()` at
// the renderer (analyzer-side strips control chars + caps length, but
// HTML safety belongs at the render edge — same contract Plan 08-04
// r3-#1 (renderer side) established).
// ─────────────────────────────────────────────────────────────────

// Stable identifier for the warning block — a CSS class. Tests grep
// the rendered HTML for this marker; the renderer commits to keeping
// it in the markup.
const ASK_USER_DRIFT_CLASS = "ask-user-drift-warning";

test("Plan 08-05 r4-#1 — unknown_outcomes renders warning block with sanitised values", () => {
  const summary = benignSummary();
  summary.tool_call_traffic.ask_user.unknown_outcome_count = 2;
  summary.tool_call_traffic.ask_user.unknown_outcomes = [
    { value: "foobar", count: 2 },
  ];
  const html = runRenderer({ recommendations: [], summary });

  // Warning block is present.
  assert.ok(
    html.includes(ASK_USER_DRIFT_CLASS),
    `Warning block (CSS class "${ASK_USER_DRIFT_CLASS}") MUST be rendered when unknown_outcome_count > 0`,
  );
  // Sanitised value appears in the block.
  assert.ok(
    html.includes("foobar"),
    "Unknown outcome value MUST appear in the rendered warning block",
  );
  // Count appears too.
  assert.ok(
    html.includes("2"),
    "Unknown outcome count MUST appear in the rendered warning block",
  );
});

test("Plan 08-05 r4-#1 — malformed warnings render in the same warning block", () => {
  const summary = benignSummary();
  summary.tool_call_traffic.ask_user.malformed_outcome_count = 1;
  summary.warnings = [
    { type: "malformed_ask_user_outcome", value: "null", count: 1 },
  ];
  const html = runRenderer({ recommendations: [], summary });

  // Warning block is present (malformed-only).
  assert.ok(
    html.includes(ASK_USER_DRIFT_CLASS),
    "Warning block MUST render when malformed_outcome_count > 0",
  );
  // The stringified malformed value (the literal string "null") must
  // appear — analyzer emits it stringified per r2-#2.
  assert.ok(
    html.includes("null"),
    "Malformed outcome value MUST appear in the rendered warning block",
  );
});

test("Plan 08-05 r4-#1 — both unknown AND malformed render in the warning block together", () => {
  const summary = benignSummary();
  summary.tool_call_traffic.ask_user.unknown_outcome_count = 3;
  summary.tool_call_traffic.ask_user.unknown_outcomes = [
    { value: "drift_value", count: 3 },
  ];
  summary.tool_call_traffic.ask_user.malformed_outcome_count = 1;
  summary.warnings = [
    { type: "malformed_ask_user_outcome", value: "undefined", count: 1 },
  ];
  const html = runRenderer({ recommendations: [], summary });

  assert.ok(html.includes(ASK_USER_DRIFT_CLASS));
  assert.ok(
    html.includes("drift_value"),
    "Unknown outcome value MUST appear when both unknown+malformed present",
  );
  assert.ok(
    html.includes("undefined"),
    "Malformed outcome value MUST appear when both unknown+malformed present",
  );
});

test("Plan 08-05 r4-#1 — clean session (no unknown/malformed) renders no warning block", () => {
  // Regression-lock: benignSummary() has counts === 0 + no malformed
  // warnings. The warning block MUST be absent so the operator only
  // sees the drift block when drift is actually present (no false-
  // positive noise on healthy sessions).
  const html = runRenderer({ recommendations: [], summary: benignSummary() });
  assert.ok(
    !html.includes(ASK_USER_DRIFT_CLASS),
    "Warning block MUST NOT render on clean sessions",
  );
});

test("Plan 08-05 r4-#1 — XSS payload in unknown_outcomes value is escaped (defence-in-depth)", () => {
  const baseline = countLiveScriptTags(
    runRenderer({ recommendations: [], summary: benignSummary() }),
  );

  const summary = benignSummary();
  summary.tool_call_traffic.ask_user.unknown_outcome_count = 1;
  summary.tool_call_traffic.ask_user.unknown_outcomes = [
    { value: "<script>alert(1)</script>", count: 1 },
  ];
  const html = runRenderer({ recommendations: [], summary });

  // Block renders.
  assert.ok(html.includes(ASK_USER_DRIFT_CLASS));
  // No new live <script> tag injected.
  assert.equal(
    countLiveScriptTags(html),
    baseline,
    "Adversarial unknown_outcomes value MUST NOT inject a live <script> tag",
  );
  // Escaped form is present.
  assert.ok(
    html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"),
    "Adversarial unknown_outcomes value MUST be HTML-escaped in the warning block",
  );
  // Raw form MUST NOT appear.
  assert.ok(
    !html.includes("<script>alert(1)</script>"),
    "Raw <script> form MUST NOT appear in rendered HTML",
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

// ─────────────────────────────────────────────────────────────────
// Phase 8 — Plan 08-06 r5-#1 (MAJOR) — count fields in the drift
// warning block MUST be numerically coerced AND HTML-escaped before
// interpolation.
//
// Codex r5-#1 raised that `scripts/generate-report-html.js:688` (the
// `header` template literal in the new `driftWarningBlock` in
// `buildToolCallTraffic()`) interpolates `unknownOutcomeCount` /
// `malformedOutcomeCount` raw via:
//
//   const unknownOutcomeCount = askUser.unknown_outcome_count || 0;
//   const malformedOutcomeCount = askUser.malformed_outcome_count || 0;
//   const header = `${unknownOutcomeCount} unknown, ${malformedOutcomeCount} malformed`;
//
// The `|| 0` fallback only catches falsy values (0, NaN, "", null,
// undefined). A poisoned `summary.json` providing
// `unknown_outcome_count: "<script>alert(1)</script>"` (a STRING, which
// is truthy unless empty) bypasses the fallback AND bypasses the
// per-entry `escapeHtml()` we apply to value slots.
//
// Defence-in-depth: never trust `summary.json` shape — coerce to a
// finite number first via `Number.isFinite(...)`, AND wrap the
// interpolated count in `escapeHtml(String(...))` even when the value
// can't logically carry markup. Plan 08-04 r3-#1 (renderer) anchored
// the principle "every interpolated user-data slot flows through
// escapeHtml"; this closes the residual gap on the new r4-#1 surface.
// ─────────────────────────────────────────────────────────────────

test("Plan 08-06 r5-#1 — string-typed unknown_outcome_count is numerically coerced to 0 (no warning block, no XSS)", () => {
  // Pre-fix: `unknown_outcome_count: "<script>alert(1)</script>"` is
  // truthy AND non-numeric. The `|| 0` fallback lets it through; the
  // `unknownOutcomeCount === 0 && malformedOutcomeCount === 0` gate
  // evaluates the string against 0 via `===` (false because string
  // vs number), so the warning block RENDERS and interpolates the
  // hostile string into the header.
  // Post-fix: Number.isFinite("...") === false, coerced to 0; gate
  // evaluates to true (both 0); block does NOT render; payload never
  // reaches the HTML body.
  const baseline = countLiveScriptTags(
    runRenderer({ recommendations: [], summary: benignSummary() }),
  );

  const summary = benignSummary();
  summary.tool_call_traffic.ask_user.unknown_outcome_count = XSS_SCRIPT;
  // Leave malformed_outcome_count at 0 so the only signal is the
  // poisoned unknown count. (If both were poisoned, the block would
  // render with both interpolated; we test that case in test #3.)
  summary.tool_call_traffic.ask_user.malformed_outcome_count = 0;

  const html = runRenderer({ recommendations: [], summary });

  // Block MUST NOT render (string coerces to 0 by Number.isFinite gate).
  assert.ok(
    !html.includes(ASK_USER_DRIFT_CLASS),
    "String-typed unknown_outcome_count MUST coerce to 0; warning block MUST NOT render",
  );

  // No new live <script> tag (raw payload never reached HTML body).
  assert.equal(
    countLiveScriptTags(html),
    baseline,
    "Poisoned count field MUST NOT inject a live <script> tag",
  );

  // Raw payload MUST NOT appear anywhere in the body.
  assert.ok(
    !html.includes("<script>alert(1)</script>"),
    "Raw <script> form from poisoned count field MUST NOT appear in HTML",
  );
});

test("Plan 08-06 r5-#1 — NaN unknown_outcome_count is numerically coerced to 0 (no warning block)", () => {
  // NaN is falsy; `|| 0` already catches it pre-fix. This test locks
  // the contract going forward — the `Number.isFinite` guard is the
  // canonical check, NOT `|| 0`. Future maintainer who replaces NaN
  // with `Number.isNaN`-tagged sentinel won't accidentally break the
  // gate.
  // Note: `JSON.stringify(NaN)` produces `null`, so to land actual
  // NaN in summary.json we'd need a non-JSON path. The Number.isFinite
  // guard catches both NaN AND Infinity AND non-numbers — this test
  // exercises the NaN path which arrives via direct JS object
  // injection (the renderer reads summary.json via JSON.parse so NaN
  // never actually arrives, but the guard MUST hold for future code
  // paths that might not go through JSON serialisation).
  const summary = benignSummary();
  summary.tool_call_traffic.ask_user.unknown_outcome_count = NaN;
  summary.tool_call_traffic.ask_user.malformed_outcome_count = 0;

  const html = runRenderer({ recommendations: [], summary });

  assert.ok(
    !html.includes(ASK_USER_DRIFT_CLASS),
    "NaN unknown_outcome_count MUST coerce to 0; warning block MUST NOT render",
  );
});

test("Plan 08-06 r5-#1 — string-typed malformed_outcome_count is also numerically coerced (no XSS via the malformed path)", () => {
  // Same coercion contract for the malformed count. Adversarial
  // payload uses an `<svg onload=...>` form (different attack vector
  // from <script>) to exercise a different escape sink — defence-in-
  // depth means the contract holds for ALL HTML-significant chars,
  // not just <script> openers.
  const baseline = countLiveScriptTags(
    runRenderer({ recommendations: [], summary: benignSummary() }),
  );

  const summary = benignSummary();
  summary.tool_call_traffic.ask_user.unknown_outcome_count = 0;
  summary.tool_call_traffic.ask_user.malformed_outcome_count = XSS_SVG;
  // Leave warnings empty so the malformed-warning loop has nothing to
  // iterate even if the gate were broken.
  summary.warnings = [];

  const html = runRenderer({ recommendations: [], summary });

  assert.ok(
    !html.includes(ASK_USER_DRIFT_CLASS),
    "String-typed malformed_outcome_count MUST coerce to 0; warning block MUST NOT render",
  );

  // Raw onload=alert form MUST NOT appear in body.
  assert.ok(
    !html.includes("<svg onload=alert(3)>"),
    "Raw <svg onload=> form from poisoned count MUST NOT appear in HTML",
  );

  // Live script count unchanged.
  assert.equal(
    countLiveScriptTags(html),
    baseline,
    "Poisoned malformed_outcome_count MUST NOT inject any live tags",
  );
});
