// Fixture tests for analyze-session.js.
//
// Runs the CLI against committed fixture directories, parses the produced
// analysis.json, and asserts the shape and key counts are what we expect.
// Uses node's built-in test runner (no jest / mocha dependency needed).
//
// Run with:  node --test scripts/__tests__/analyze-session.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", "analyze-session.js");
const fixturesRoot = join(here, "fixtures");

// analyze-session.js writes analysis.json back into the session dir. We copy
// each fixture into a tmpdir so repeated test runs stay hermetic and the
// committed fixture folder never gets dirty.
function runAnalyzer(fixtureName) {
  const src = join(fixturesRoot, fixtureName);
  const tmp = mkdtempSync(join(tmpdir(), `analyze-session-${fixtureName}-`));
  cpSync(src, tmp, { recursive: true });
  // Use process.execPath so we always invoke the same node binary that's
  // running the test (PATH isn't guaranteed to contain `node` in sandboxes).
  execFileSync(process.execPath, [scriptPath, tmp], { stdio: "pipe" });
  const analysisPath = join(tmp, "analysis.json");
  assert.ok(existsSync(analysisPath), "analysis.json should be produced");
  const analysis = JSON.parse(readFileSync(analysisPath, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
  return analysis;
}

test("empty session produces valid analysis with zero counts", () => {
  const a = runAnalyzer("empty-session");

  // Canonical top-level sections must exist so downstream consumers
  // (session-optimizer.sh, generate-report-html.js) never crash on a missing key.
  for (const key of [
    "session_meta",
    "field_report",
    "regex_performance",
    "sonnet_performance",
    "empty_fields",
    "debug_issues",
    "cost_breakdown",
    "utterance_analysis",
    "repeated_values",
    "vad_sleep_analysis",
  ]) {
    assert.ok(key in a, `analysis.json missing section: ${key}`);
  }

  assert.equal(a.field_report.length, 0, "no fields should be tracked");
  assert.equal(a.regex_performance.total_regex_attempts, 0);
  assert.equal(a.sonnet_performance.total_calls, 0);
  assert.equal(a.session_meta.address, "Empty Fixture");
});

test("typical session tracks regex, sonnet, and discrepancy correctly", () => {
  const a = runAnalyzer("typical-session");

  // Three fields touched: ze (regex-only), pfc (sonnet-only), earthing (both).
  const keys = a.field_report.map((f) => f.key).sort();
  assert.deepEqual(keys, ["earthing", "pfc", "ze"]);

  const byKey = Object.fromEntries(a.field_report.map((f) => [f.key, f]));
  assert.equal(byKey.ze.final_source, "regex");
  assert.equal(byKey.ze.regex_value, "0.35");
  assert.equal(byKey.pfc.final_source, "sonnet");
  assert.equal(byKey.pfc.sonnet_value, "1.82");
  assert.equal(byKey.earthing.final_source, "sonnet");
  assert.equal(byKey.earthing.was_overwritten, true, "earthing should be flagged as overwritten");

  // Regex performance reflects one discrepancy + one sonnet-only capture.
  assert.equal(a.regex_performance.total_regex_attempts, 1);
  assert.equal(a.regex_performance.fields_later_corrected_by_sonnet, 1);
  assert.ok(
    a.regex_performance.fields_sonnet_caught_but_regex_missed >= 1,
    "pfc should be counted as sonnet-only catch",
  );

  // Sonnet performance: 2 server_extraction_received events with latencies.
  assert.equal(a.sonnet_performance.total_calls, 2);
  assert.ok(a.sonnet_performance.average_latency_ms > 0, "avg latency should be positive");

  // Session metadata flows through from manifest.
  assert.equal(a.session_meta.address, "12 Fixture Road, Testville");
  assert.equal(a.session_meta.durationSeconds, 300);
});

test("typical session output is deterministic across runs", () => {
  // Two runs on the same fixture should yield identical field_report ordering
  // (by key set) and identical discrepancy counts. Catches accidental
  // non-deterministic iteration (e.g. Set-based ordering changes).
  const a1 = runAnalyzer("typical-session");
  const a2 = runAnalyzer("typical-session");
  assert.deepEqual(
    a1.field_report.map((f) => f.key).sort(),
    a2.field_report.map((f) => f.key).sort(),
  );
  assert.equal(
    a1.regex_performance.fields_later_corrected_by_sonnet,
    a2.regex_performance.fields_later_corrected_by_sonnet,
  );
});

// ─────────────────────────────────────────────────────────────────
// Phase 8 — Plan 08-01 SC #1: Dual-shape parsing.
//
// The analyzer must understand sessions that contain (a) ONLY tool-call
// events (post-Phase-7 cutover), (b) BOTH legacy field_set AND tool-call
// events (the transition window), and (c) MALFORMED / truncated logs
// (network drop mid-session, disk full mid-write). All three must
// produce a valid analysis.json without crashing.
// ─────────────────────────────────────────────────────────────────

test("Plan 08-01 SC #1 — tool-call-only session produces tool_call_traffic section + empty field_report", () => {
  const a = runAnalyzer("tool-call-only-session");

  // SC #1: tool_call_traffic section MUST exist (even if empty in shape).
  assert.ok(
    "tool_call_traffic" in a,
    "analysis.json missing tool_call_traffic section",
  );
  assert.equal(a.tool_call_traffic.enabled, true);

  // Legacy field_report must be empty (no field_set rows in this fixture).
  assert.equal(a.field_report.length, 0);

  // session_meta still flows through.
  assert.equal(a.session_meta.address, "Tool-Call Only Session");
});

test("Plan 08-01 SC #1 — dual-shape session reports BOTH legacy field_report AND tool_call_traffic", () => {
  const a = runAnalyzer("dual-shape-session");

  // Legacy surface present.
  assert.ok(a.field_report.length > 0, "expected legacy field_report rows");
  assert.ok(
    a.field_report.some((f) => f.key === "ze"),
    "expected ze in field_report",
  );

  // Tool-call surface present.
  assert.equal(a.tool_call_traffic.enabled, true);
  assert.ok(
    a.tool_call_traffic.tools.length > 0,
    "expected tool_call_traffic.tools to be non-empty",
  );
});

test("Plan 08-01 SC #1 — truncated session does NOT crash; emits warnings entry", () => {
  // Fixture's debug_log.jsonl ends mid-record. Pre-fix this would silently
  // drop the bad line via .filter(Boolean). Post-fix the analyzer surfaces
  // a warning so the optimizer + reviewer can see something went wrong.
  const a = runAnalyzer("truncated-session");

  assert.ok(Array.isArray(a.warnings), "analysis.json must carry a warnings array");
  assert.ok(
    a.warnings.some((w) => w.type === "malformed_event"),
    "expected at least one malformed_event warning for the truncated last line",
  );

  // The valid first tool_call row before the truncation MUST still be parsed.
  assert.equal(a.tool_call_traffic.enabled, true);
});

// ─────────────────────────────────────────────────────────────────
// Phase 8 — Plan 08-01 SC #2: Tool-call traffic summary.
//
// Histogram over tool name + duration medians + validation-error count
// per tool + ask_user answer_outcome histogram covering ALL frozen
// ASK_USER_ANSWER_OUTCOMES enum members (so dashboards have a stable
// shape — missing outcomes appear as 0, not absent keys).
// ─────────────────────────────────────────────────────────────────

const ASK_USER_ANSWER_OUTCOMES = [
  // Source of truth: src/extraction/stage6-dispatcher-logger.js
  // (kept verbatim here so the test fails loudly if the analyzer's
  // local copy drifts from the backend's frozen enum).
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

test("Plan 08-01 SC #2 — tool histogram counts by tool name", () => {
  const a = runAnalyzer("tool-call-only-session");
  const tools = a.tool_call_traffic.tools;

  // 4 stage6_tool_call rows: 3 record_reading, 1 create_circuit.
  // (Note: 1 of the record_reading rows has is_error=true — still counted in
  // total `count`; the validation_error_count splits it out.)
  const recordReading = tools.find((t) => t.name === "record_reading");
  const createCircuit = tools.find((t) => t.name === "create_circuit");

  assert.ok(recordReading, "record_reading entry missing");
  assert.equal(recordReading.count, 3);
  assert.ok(createCircuit, "create_circuit entry missing");
  assert.equal(createCircuit.count, 1);
});

test("Plan 08-01 SC #2 — median duration_ms per tool", () => {
  const a = runAnalyzer("tool-call-only-session");
  const recordReading = a.tool_call_traffic.tools.find(
    (t) => t.name === "record_reading",
  );

  // record_reading durations in fixture: [12, 15, 4]. Sorted: [4, 12, 15].
  // Median (odd count) = middle element = 12.
  assert.equal(recordReading.median_duration_ms, 12);
});

test("Plan 08-01 SC #2 — validation_error_count tallies is_error rows per tool", () => {
  const a = runAnalyzer("tool-call-only-session");
  const recordReading = a.tool_call_traffic.tools.find(
    (t) => t.name === "record_reading",
  );

  // 1 of 3 record_reading rows in fixture has is_error: true (validation_error: circuit_not_found).
  assert.equal(recordReading.validation_error_count, 1);
});

test("Plan 08-01 SC #2 — ask_user outcomes histogram covers every frozen enum member", () => {
  const a = runAnalyzer("tool-call-only-session");
  const askUser = a.tool_call_traffic.ask_user;

  // 3 stage6.ask_user rows: 2 answered, 1 gated.
  assert.equal(askUser.total, 3);
  assert.equal(askUser.outcomes.answered, 2);
  assert.equal(askUser.outcomes.gated, 1);

  // EVERY frozen ASK_USER_ANSWER_OUTCOMES key MUST be present (even if 0)
  // so CloudWatch dashboards split by the dimension see a stable surface.
  for (const outcome of ASK_USER_ANSWER_OUTCOMES) {
    assert.ok(
      outcome in askUser.outcomes,
      `outcome key missing from histogram: ${outcome}`,
    );
  }

  // Outcomes-not-emitted-in-fixture must default to 0.
  assert.equal(askUser.outcomes.timeout, 0);
  assert.equal(askUser.outcomes.user_moved_on, 0);
  assert.equal(askUser.outcomes.restrained_mode, 0);
  assert.equal(askUser.outcomes.dispatcher_error, 0);
  assert.equal(askUser.outcomes.prompt_leak_blocked, 0);
});

// ─────────────────────────────────────────────────────────────────
// Phase 8 — Plan 08-02 r1-#3: Unknown ask_user outcomes surfaced explicitly.
//
// Codex r1-#3 (MAJOR) raised that `scripts/analyze-session.js:992` silently
// drops `stage6.ask_user.answer_outcome` values that aren't in the frozen
// `ASK_USER_ANSWER_OUTCOMES` enum. Enum drift / instrumentation failures
// become invisible — a dispatcher that started emitting a new outcome
// (e.g. via a backend deploy that adds the key without coordinating with
// the analyzer) just disappears from the histogram with zero diagnostic.
//
// Fix: surface unknown outcomes in TWO places —
//   1. `analysis.tool_call_traffic.ask_user.unknown_outcome_count` +
//      `unknown_outcomes[]` (per-distinct-value entries with counts).
//   2. `analysis.warnings[]` entry per distinct unknown outcome value
//      (same surface as Plan 08-01 SC #1's malformed_event warnings).
//
// The frozen-enum histogram (`outcomes`) keeps its stable shape — unknowns
// go to the side surface, NOT into the main histogram. CloudWatch
// dashboards that split by the histogram dimension are unaffected.
// ─────────────────────────────────────────────────────────────────

test("Plan 08-02 r1-#3 — unknown outcomes surface as unknown_outcome_count + unknown_outcomes[]", () => {
  const a = runAnalyzer("unknown-outcome-session");
  const askUser = a.tool_call_traffic.ask_user;

  // 4 stage6.ask_user rows: 2 known (answered, gated), 2 unknown (foobar, barbaz).
  assert.equal(askUser.total, 4);

  // Total unknown count surfaced as a scalar.
  assert.equal(askUser.unknown_outcome_count, 2);

  // Per-distinct-value entries.
  assert.ok(Array.isArray(askUser.unknown_outcomes), "unknown_outcomes must be an array");
  assert.equal(askUser.unknown_outcomes.length, 2);

  const byValue = Object.fromEntries(askUser.unknown_outcomes.map((u) => [u.value, u.count]));
  assert.equal(byValue.foobar, 1, "foobar should appear with count 1");
  assert.equal(byValue.barbaz, 1, "barbaz should appear with count 1");
});

test("Plan 08-02 r1-#3 — unknown outcomes also surface as warnings entries", () => {
  const a = runAnalyzer("unknown-outcome-session");

  assert.ok(Array.isArray(a.warnings), "analysis.warnings must be an array");

  // Each distinct unknown outcome gets its own warning entry.
  const unknownOutcomeWarnings = a.warnings.filter(
    (w) => w.type === "unknown_ask_user_outcome",
  );
  assert.equal(
    unknownOutcomeWarnings.length,
    2,
    "expected 2 warnings (one per distinct unknown outcome)",
  );

  const byValue = Object.fromEntries(
    unknownOutcomeWarnings.map((w) => [w.value, w.count]),
  );
  assert.equal(byValue.foobar, 1);
  assert.equal(byValue.barbaz, 1);
});

test("Plan 08-02 r1-#3 — known outcomes still bucket correctly + don't appear in unknown list", () => {
  const a = runAnalyzer("unknown-outcome-session");
  const askUser = a.tool_call_traffic.ask_user;

  // Known outcomes go into the frozen-enum histogram as before.
  assert.equal(askUser.outcomes.answered, 1);
  assert.equal(askUser.outcomes.gated, 1);

  // Known outcome values MUST NOT appear in unknown_outcomes.
  const unknownValues = askUser.unknown_outcomes.map((u) => u.value);
  assert.ok(
    !unknownValues.includes("answered"),
    "answered is a known enum member; must NOT appear in unknown_outcomes",
  );
  assert.ok(
    !unknownValues.includes("gated"),
    "gated is a known enum member; must NOT appear in unknown_outcomes",
  );
});

test("Plan 08-02 r1-#3 — frozen-enum histogram shape preserved (no `foobar` key)", () => {
  // Critical: the `outcomes` object MUST keep exactly the
  // ASK_USER_ANSWER_OUTCOMES keys. Adding `foobar`/`barbaz` as keys
  // would break CloudWatch dashboards that group by the dimension —
  // they'd suddenly see new dimension values for one session and
  // not others. Unknown values go to the side surface only.
  const a = runAnalyzer("unknown-outcome-session");
  const askUser = a.tool_call_traffic.ask_user;

  assert.ok(!("foobar" in askUser.outcomes), "foobar must NOT be a histogram key");
  assert.ok(!("barbaz" in askUser.outcomes), "barbaz must NOT be a histogram key");

  // Every frozen-enum key STILL present.
  for (const outcome of ASK_USER_ANSWER_OUTCOMES) {
    assert.ok(outcome in askUser.outcomes, `outcome key missing: ${outcome}`);
  }
});

test("Plan 08-02 r1-#3 — sessions WITHOUT unknowns produce empty unknown_outcomes[] + 0 count", () => {
  // Regression check: re-run the existing tool-call-only-session fixture
  // (which has only known outcomes). The new fields must be present
  // (stable shape) but report zero unknowns.
  const a = runAnalyzer("tool-call-only-session");
  const askUser = a.tool_call_traffic.ask_user;

  assert.equal(askUser.unknown_outcome_count, 0);
  assert.deepEqual(askUser.unknown_outcomes, []);

  // No `unknown_ask_user_outcome` warnings either.
  const unknownOutcomeWarnings = (a.warnings || []).filter(
    (w) => w.type === "unknown_ask_user_outcome",
  );
  assert.equal(unknownOutcomeWarnings.length, 0);
});
