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
import { readFileSync, existsSync, rmSync, cpSync, mkdtempSync, writeFileSync } from "node:fs";
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

// ─────────────────────────────────────────────────────────────────
// Phase 8 — Plan 08-03 r2-#1: Prototype-chain attack vector closed.
//
// Codex r2-#1 (MAJOR) raised that `scripts/analyze-session.js:1022-1024`
// builds the `outcomes` histogram via `const outcomes = {}` (a normal
// object) and tests membership via `outcome in outcomes`. The `in`
// operator walks `Object.prototype`, so untrusted log data with
// `answer_outcome: "__proto__"` / `"constructor"` / `"toString"` is
// silently treated as a KNOWN histogram key — the unknown-surface
// added in r1-#3 never fires for those names because the `in` check
// returns true on inherited properties.
//
// Fix: `Object.create(null)` for the histogram (no prototype chain) +
// `Object.hasOwn(outcomes, outcome)` for membership (own-properties
// only). This closes the prototype-pollution attack vector while
// preserving the frozen-enum histogram shape and r1-#3's unknown
// surface intact for ordinary unknowns.
//
// Fixture: `proto-pollution-session/` has 6 ask_user rows —
// 2 known (answered, gated) + 2 prototype-chain names
// (__proto__, constructor) + 2 ordinary unknowns (foobar, barbaz —
// regression-lock so we don't break r1-#3 surface while fixing r2-#1).
// ─────────────────────────────────────────────────────────────────

test("Plan 08-03 r2-#1 — prototype-chain names route to unknown_outcomes (not the histogram)", () => {
  const a = runAnalyzer("proto-pollution-session");
  const askUser = a.tool_call_traffic.ask_user;

  // Total = 6 (2 known + 2 proto-chain + 2 ordinary unknowns).
  assert.equal(askUser.total, 6);

  // All 4 unknowns (proto-chain + ordinary) flow into unknown_outcomes.
  assert.equal(askUser.unknown_outcome_count, 4);

  const byValue = Object.fromEntries(
    askUser.unknown_outcomes.map((u) => [u.value, u.count]),
  );
  assert.equal(byValue.__proto__, 1, "__proto__ must appear in unknown_outcomes with count 1");
  assert.equal(byValue.constructor, 1, "constructor must appear in unknown_outcomes with count 1");
  assert.equal(byValue.foobar, 1, "foobar (regression-lock for r1-#3) must still surface");
  assert.equal(byValue.barbaz, 1, "barbaz (regression-lock for r1-#3) must still surface");
});

test("Plan 08-03 r2-#1 — histogram has NO own-property leak from prototype-chain names", () => {
  // The frozen-enum `outcomes` histogram MUST keep exactly the
  // ASK_USER_ANSWER_OUTCOMES keys as own-properties. `__proto__`,
  // `constructor`, `toString` etc. all live on `Object.prototype`
  // and were silently treated as known by the `in`-operator-based
  // membership check. After the fix, NONE of them are own-properties
  // of the histogram.
  const a = runAnalyzer("proto-pollution-session");
  const outcomes = a.tool_call_traffic.ask_user.outcomes;

  // Native Object.hasOwn — survives JSON round-trip because the
  // serialised histogram is itself a plain object on the receiver
  // side; what matters here is that AFTER serialisation, none of
  // the prototype-chain names appear as own enumerable keys.
  assert.ok(
    !Object.hasOwn(outcomes, "__proto__"),
    "__proto__ MUST NOT be an own-property of the histogram",
  );
  assert.ok(
    !Object.hasOwn(outcomes, "constructor"),
    "constructor MUST NOT be an own-property of the histogram",
  );
  assert.ok(
    !Object.hasOwn(outcomes, "toString"),
    "toString MUST NOT be an own-property of the histogram",
  );
});

test("Plan 08-03 r2-#1 — prototype-chain names appear in warnings[] entries", () => {
  const a = runAnalyzer("proto-pollution-session");

  const unknownOutcomeWarnings = (a.warnings || []).filter(
    (w) => w.type === "unknown_ask_user_outcome",
  );

  // 4 distinct unknowns → 4 warnings (one per distinct value).
  assert.equal(
    unknownOutcomeWarnings.length,
    4,
    "expected 4 warnings (one per distinct unknown outcome value)",
  );

  const byValue = Object.fromEntries(
    unknownOutcomeWarnings.map((w) => [w.value, w.count]),
  );
  assert.equal(byValue.__proto__, 1);
  assert.equal(byValue.constructor, 1);
  assert.equal(byValue.foobar, 1);
  assert.equal(byValue.barbaz, 1);
});

test("Plan 08-03 r2-#1 — known outcomes still bucket correctly with prototype-chain names present", () => {
  // Sanity check: the prototype-chain hardening MUST NOT regress the
  // known-outcome bucketing. In a session with 2 known (answered, gated)
  // alongside 4 unknowns, the histogram still increments answered=1
  // and gated=1.
  const a = runAnalyzer("proto-pollution-session");
  const askUser = a.tool_call_traffic.ask_user;

  assert.equal(askUser.outcomes.answered, 1);
  assert.equal(askUser.outcomes.gated, 1);

  // Other frozen-enum keys present at default 0.
  assert.equal(askUser.outcomes.timeout, 0);
  assert.equal(askUser.outcomes.user_moved_on, 0);
  assert.equal(askUser.outcomes.dispatcher_error, 0);
});

// ─────────────────────────────────────────────────────────────────
// Phase 8 — Plan 08-03 r2-#2: Malformed ask_user outcomes surfaced.
//
// Codex r2-#2 (MINOR) raised that `scripts/analyze-session.js:1023`
// uses `if (!outcome) continue;` to skip rows where `answer_outcome`
// is empty string, null, or undefined. r1-#3 covered enum-drift
// unknowns ("value not in the frozen enum") but didn't cover
// MALFORMED outcomes ("no value emitted at all"). The two have
// distinct operational signatures:
//   - Unknown = enum drift / backend-deploy out of sync with analyzer.
//   - Malformed = instrumentation failure / row escaped the emit-site
//     `invalid_answer_outcome` throw with NO outcome set.
// Both are operationally serious; both deserve their own surface
// so dashboards can count them separately.
//
// Fix: surface as `malformed_outcome_count` (scalar) +
// `warnings[]` entries of shape
// `{type: 'malformed_ask_user_outcome', value, count}` per distinct
// malformed value. Stringify the value so the warnings JSON
// serialises cleanly: "" → "", null → "null", undefined → "undefined".
//
// Fixture: `malformed-outcome-session/` has 5 ask_user rows —
// 1 known (answered) + 1 empty-string + 1 null + 1 undefined (no
// answer_outcome key at all) + 1 known (gated, regression-lock).
// ─────────────────────────────────────────────────────────────────

test("Plan 08-03 r2-#2 — malformed outcomes surface as malformed_outcome_count", () => {
  const a = runAnalyzer("malformed-outcome-session");
  const askUser = a.tool_call_traffic.ask_user;

  // 5 ask_user rows total: 2 known + 3 malformed.
  assert.equal(askUser.total, 5);

  // 3 distinct malformed shapes (empty, null, undefined) each count 1.
  assert.equal(askUser.malformed_outcome_count, 3);

  // Malformed values are NOT routed to unknown_outcomes (different
  // drift signature: instrumentation failure, not enum drift).
  assert.equal(askUser.unknown_outcome_count, 0);
  assert.deepEqual(askUser.unknown_outcomes, []);
});

test("Plan 08-03 r2-#2 — malformed outcomes surface as warnings entries with stringified value", () => {
  const a = runAnalyzer("malformed-outcome-session");

  const malformedWarnings = (a.warnings || []).filter(
    (w) => w.type === "malformed_ask_user_outcome",
  );

  // 3 distinct malformed values → 3 warnings entries.
  assert.equal(
    malformedWarnings.length,
    3,
    "expected 3 warnings (one per distinct malformed outcome shape)",
  );

  const byValue = Object.fromEntries(
    malformedWarnings.map((w) => [w.value, w.count]),
  );
  // Empty string keeps its empty form; null and undefined are stringified
  // so the warnings JSON serialises with a readable label per shape.
  assert.equal(byValue[""], 1, 'empty-string outcome must surface as warning value=""');
  assert.equal(byValue.null, 1, 'null outcome must surface as warning value="null"');
  assert.equal(byValue.undefined, 1, 'undefined outcome must surface as warning value="undefined"');
});

test("Plan 08-03 r2-#2 — known outcomes still bucket correctly when malformed rows present", () => {
  // Sanity check: the malformed-outcome surface MUST NOT regress
  // the known-outcome bucketing. In a session with 2 known (answered,
  // gated) alongside 3 malformed rows, the histogram still increments
  // answered=1 and gated=1.
  const a = runAnalyzer("malformed-outcome-session");
  const askUser = a.tool_call_traffic.ask_user;

  assert.equal(askUser.outcomes.answered, 1);
  assert.equal(askUser.outcomes.gated, 1);

  // Frozen-enum histogram shape preserved — none of "", "null",
  // "undefined" leak in as own-properties.
  assert.ok(
    !Object.hasOwn(askUser.outcomes, ""),
    'empty string MUST NOT be a histogram own-property',
  );
  assert.ok(
    !Object.hasOwn(askUser.outcomes, "null"),
    '"null" string MUST NOT be a histogram own-property',
  );
  assert.ok(
    !Object.hasOwn(askUser.outcomes, "undefined"),
    '"undefined" string MUST NOT be a histogram own-property',
  );
});

test("Plan 08-03 r2-#2 — sessions WITHOUT malformed outcomes produce 0 count + no warnings", () => {
  // Regression check: re-run the existing tool-call-only-session fixture
  // (which has only known outcomes). The new malformed_outcome_count
  // must be present (stable shape) but report 0.
  const a = runAnalyzer("tool-call-only-session");
  const askUser = a.tool_call_traffic.ask_user;

  assert.equal(askUser.malformed_outcome_count, 0);

  // No `malformed_ask_user_outcome` warnings either.
  const malformedWarnings = (a.warnings || []).filter(
    (w) => w.type === "malformed_ask_user_outcome",
  );
  assert.equal(malformedWarnings.length, 0);
});

// ── Phase 8 — Plan 08-04 r3-#1: XSS injection lock for unknown_outcomes + warnings values ──
//
// Codex r3-#1 (MAJOR) raised that `scripts/analyze-session.js:1077` (the
// `unknown_outcomes[]` array push and `events._warnings` warnings push)
// copies raw `answer_outcome` log values verbatim into the analysis.json
// surface that downstream consumers (generate-report-html.js) render.
// If any future renderer addition skips `escapeHtml()`, an attacker-
// poisoned debug log can inject markup or script (stored XSS).
//
// Defence-in-depth: sanitise on the way IN at the analyzer (this round
// of tests) so the values entering the report surface are already
// length-bounded + control-char-stripped + type-info-preserving.
//
// Fixture: `xss-injection-session/` has 5 ask_user rows —
// 1 known (`answered`), 3 adversarial unknowns (`<script>alert(1)
// </script>` payload, 200-char `"AAAA…"` length-bomb, control-char
// `evil\x00\x1Bvalue`), 1 known (`gated`).
test("Plan 08-04 r3-#1 — short HTML-significant payload passes through but stays length-bounded", () => {
  const a = runAnalyzer("xss-injection-session");
  const askUser = a.tool_call_traffic.ask_user;

  // The 30-char `<script>alert(1)</script>` payload is below the 100-char
  // cap and contains no control chars, so it should pass through the
  // sanitiser byte-identical. The HTML-significant chars themselves are
  // safe to carry in JSON; the renderer's `escapeHtml()` is the second
  // gate that prevents them from rendering as markup.
  const scriptEntry = askUser.unknown_outcomes.find(
    (e) => e.value === "<script>alert(1)</script>",
  );
  assert.ok(
    scriptEntry,
    "<script>alert(1)</script> payload should appear in unknown_outcomes (pass-through, length OK)",
  );
  assert.equal(scriptEntry.count, 1);
  assert.ok(
    scriptEntry.value.length <= 100,
    "Sanitised value MUST be ≤100 chars",
  );
});

test("Plan 08-04 r3-#1 — long payload (>100 chars) truncated with U+2026 ellipsis", () => {
  const a = runAnalyzer("xss-injection-session");
  const askUser = a.tool_call_traffic.ask_user;

  // The 200-char `"AAAA..."` length-bomb should be truncated to exactly
  // 100 chars total: 99 × "A" + 1-char U+2026 ellipsis marker.
  const truncatedEntry = askUser.unknown_outcomes.find(
    (e) => e.value.startsWith("AAAA") && e.value.length === 100,
  );
  assert.ok(
    truncatedEntry,
    "200-char length-bomb should be truncated to exactly 100 chars",
  );
  assert.equal(truncatedEntry.count, 1);
  // U+2026 (HORIZONTAL ELLIPSIS) — single Unicode codepoint, single
  // JS string char. Use the literal character to lock the contract.
  assert.equal(
    truncatedEntry.value[truncatedEntry.value.length - 1],
    "…",
    "Truncation marker MUST be U+2026 ellipsis (single char)",
  );
  // Verify the 99 chars before the ellipsis are all "A".
  assert.equal(
    truncatedEntry.value.slice(0, 99),
    "A".repeat(99),
    "First 99 chars MUST be the original payload prefix",
  );
});

test("Plan 08-04 r3-#1 — control-char payload has 0x00 and 0x1B bytes stripped", () => {
  const a = runAnalyzer("xss-injection-session");
  const askUser = a.tool_call_traffic.ask_user;

  // Fixture row 4 carries `evil\x00\x1Bvalue` (11 chars: e-v-i-l-NUL-ESC-v-a-l-u-e).
  // Sanitiser strips the NUL (0x00) and ESC (0x1B), leaving "evilvalue" (9 chars).
  const stripped = askUser.unknown_outcomes.find(
    (e) => e.value === "evilvalue",
  );
  assert.ok(
    stripped,
    "Control bytes (0x00 + 0x1B) MUST be stripped, leaving 'evilvalue'",
  );
  assert.equal(stripped.count, 1);

  // Defence-in-depth: the raw control-char form MUST NOT survive into
  // unknown_outcomes (would corrupt logs / break terminals downstream).
  const raw = askUser.unknown_outcomes.find(
    (e) => e.value === "evil\x00\x1Bvalue",
  );
  assert.equal(
    raw,
    undefined,
    "Raw control-char form MUST NOT appear in unknown_outcomes",
  );
});

test("Plan 08-04 r3-#1 — sanitised values appear in warnings[] entries with same shape", () => {
  const a = runAnalyzer("xss-injection-session");

  const xssWarnings = (a.warnings || []).filter(
    (w) => w.type === "unknown_ask_user_outcome",
  );
  // Three distinct adversarial unknowns: <script>, length-bomb, control-char.
  assert.equal(xssWarnings.length, 3);

  // Each warning's value MUST match the same sanitised form found in
  // unknown_outcomes — defence-in-depth applies to BOTH surfaces (the
  // analysis.json field AND the warnings array).
  const scriptWarn = xssWarnings.find(
    (w) => w.value === "<script>alert(1)</script>",
  );
  assert.ok(scriptWarn, "<script> warning entry");
  assert.equal(scriptWarn.count, 1);

  const truncatedWarn = xssWarnings.find(
    (w) => typeof w.value === "string" && w.value.length === 100 && w.value.endsWith("…"),
  );
  assert.ok(truncatedWarn, "Truncated length-bomb warning entry");
  assert.equal(truncatedWarn.count, 1);

  const strippedWarn = xssWarnings.find((w) => w.value === "evilvalue");
  assert.ok(strippedWarn, "Stripped control-char warning entry");
  assert.equal(strippedWarn.count, 1);

  // Backstop: NO warning carries the 200-char length-bomb in raw form.
  const rawLong = xssWarnings.find(
    (w) => typeof w.value === "string" && w.value.length > 100,
  );
  assert.equal(
    rawLong,
    undefined,
    "Warnings MUST NOT carry values longer than 100 chars",
  );
});

// ── Phase 8 — Plan 08-04 r3-#2: Non-string outcomes routed to malformed ──
//
// Codex r3-#2 (MINOR) raised that Plan 08-03's malformed predicate at
// scripts/analyze-session.js:1057 matches ONLY `outcome === "" ||
// outcome === null || outcome === undefined`. Non-string outcomes
// (numbers, booleans, objects, arrays) fall through to the unknown
// branch where Object.hasOwn(outcomes, outcome) coerces the key to a
// string for property lookup — corrupting the unknown bucket silently.
//
// Specific failure modes pre-fix:
// - `0` (falsy non-string) → r2-#2 branch matched it ONLY because `0`
//   is falsy and the OLD predicate `if (!outcome)` caught it; the
//   r2-#2 fix tightened to `=== "" || === null || === undefined` and
//   r3-#2 surfaces that 0 now falls through to unknown.
// - `false` → unknown bucket as the string "false" via JS coercion.
// - `42` → unknown bucket as the string "42".
// - `{}` → unknown bucket as the string "[object Object]" via coercion.
// - `[]` → unknown bucket as the empty string "" via array coercion!
//   That collides with the r2-#2 empty-string malformed surface
//   silently — a hostile array-typed outcome corrupts the malformed
//   count without bumping the unknown count.
//
// Fix: widen the malformed predicate to `typeof outcome !== "string" ||
// outcome === ""`. Bucket key derivation flows through safeDisplayValue
// (introduced for r3-#1) which JSON.stringifies non-strings.
//
// Fixture: `non-string-outcome-session/` has 7 ask_user rows —
// 1 known (`answered`), 5 non-string (`0`, `false`, `{}`, `[]`, `42`),
// 1 known (`gated`).
test("Plan 08-04 r3-#2 — non-string outcomes surface as malformed_outcome_count", () => {
  const a = runAnalyzer("non-string-outcome-session");
  const askUser = a.tool_call_traffic.ask_user;

  // 5 non-string outcomes: 0, false, {}, [], 42.
  assert.equal(
    askUser.malformed_outcome_count,
    5,
    "All 5 non-string outcomes MUST route to malformed (not unknown)",
  );

  // Backstop: no non-string outcome leaks into unknown_outcomes.
  assert.equal(
    askUser.unknown_outcome_count,
    0,
    "No non-string outcome MUST appear in unknown_outcomes",
  );
});

test("Plan 08-04 r3-#2 — non-string outcomes appear in warnings[] with stringified value per shape", () => {
  const a = runAnalyzer("non-string-outcome-session");

  const malformedWarnings = (a.warnings || []).filter(
    (w) => w.type === "malformed_ask_user_outcome",
  );

  // Five distinct shapes: 0, false, {}, [], 42 → "0", "false", "{}", "[]", "42".
  // Each via JSON.stringify-then-safeDisplayValue.
  const expectedValues = ["0", "false", "{}", "[]", "42"];
  assert.equal(
    malformedWarnings.length,
    expectedValues.length,
    `Expected ${expectedValues.length} warnings (one per distinct non-string shape)`,
  );

  for (const expected of expectedValues) {
    const entry = malformedWarnings.find((w) => w.value === expected);
    assert.ok(
      entry,
      `Warnings MUST contain a malformed_ask_user_outcome with value === ${JSON.stringify(expected)}`,
    );
    assert.equal(entry.count, 1, `${expected} count should be 1`);
  }
});

test("Plan 08-04 r3-#2 — known outcomes still bucket correctly when non-string rows present", () => {
  // Sanity check: r3-#2 widening the malformed branch must NOT regress
  // the histogram bucketing for legitimate known outcomes.
  const a = runAnalyzer("non-string-outcome-session");
  const askUser = a.tool_call_traffic.ask_user;

  assert.equal(askUser.outcomes.answered, 1, "answered should bucket to 1");
  assert.equal(askUser.outcomes.gated, 1, "gated should bucket to 1");

  // Histogram shape preserved — no own-property leak from non-string forms.
  assert.ok(
    !Object.hasOwn(askUser.outcomes, "0"),
    'numeric "0" string MUST NOT be a histogram own-property',
  );
  assert.ok(
    !Object.hasOwn(askUser.outcomes, "false"),
    '"false" string MUST NOT be a histogram own-property',
  );
  assert.ok(
    !Object.hasOwn(askUser.outcomes, "{}"),
    '"{}" string MUST NOT be a histogram own-property',
  );
  assert.ok(
    !Object.hasOwn(askUser.outcomes, "[]"),
    '"[]" string MUST NOT be a histogram own-property',
  );
  assert.ok(
    !Object.hasOwn(askUser.outcomes, "42"),
    '"42" string MUST NOT be a histogram own-property',
  );
});

test("Plan 08-04 r3-#2 — repeated non-string outcomes of same shape bucket together", () => {
  // Synthetic-fixture-via-temp-write: build a fresh fixture with three
  // identical-shape `{}` outcomes inline so the bucket-coalescing
  // contract is locked. This is OUTSIDE the committed fixture pool
  // because the scenario only tests the merger logic, not a separate
  // operational signature.
  //
  // The runAnalyzer helper copies a committed fixture directory into a
  // tmpdir. For this dynamic test we manually replicate that flow.
  const dir = mkdtempSync(join(tmpdir(), "non-string-bucket-merge-"));
  const lines = [
    { timestamp: "2026-04-23T13:00:00.000Z", event: "session_started", category: "session", data: {} },
    // Three identical {} outcomes — must bucket to one warning entry, count=3.
    { timestamp: "2026-04-23T13:00:01.000Z", event: "stage6.ask_user", category: "stage6",
      data: { sessionId: "merge-001", turnId: "t1", phase: 3, mode: "live", tool_call_id: "m1",
        question: "Q1?", reason: "missing_context", context_field: null, context_circuit: null,
        answer_outcome: {}, wait_duration_ms: 100 } },
    { timestamp: "2026-04-23T13:00:02.000Z", event: "stage6.ask_user", category: "stage6",
      data: { sessionId: "merge-001", turnId: "t2", phase: 3, mode: "live", tool_call_id: "m2",
        question: "Q2?", reason: "missing_context", context_field: null, context_circuit: null,
        answer_outcome: {}, wait_duration_ms: 100 } },
    { timestamp: "2026-04-23T13:00:03.000Z", event: "stage6.ask_user", category: "stage6",
      data: { sessionId: "merge-001", turnId: "t3", phase: 3, mode: "live", tool_call_id: "m3",
        question: "Q3?", reason: "missing_context", context_field: null, context_circuit: null,
        answer_outcome: {}, wait_duration_ms: 100 } },
    { timestamp: "2026-04-23T13:05:00.000Z", event: "session_ended", category: "session", data: {} },
  ];
  writeFileSync(
    join(dir, "debug_log.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  // Run analyzer in-place on this dynamic dir.
  execFileSync(process.execPath, [scriptPath, dir], { stdio: "pipe" });
  const analysisPath = join(dir, "analysis.json");
  assert.ok(existsSync(analysisPath));
  const a = JSON.parse(readFileSync(analysisPath, "utf8"));
  rmSync(dir, { recursive: true, force: true });

  const askUser = a.tool_call_traffic.ask_user;
  assert.equal(
    askUser.malformed_outcome_count,
    3,
    "Three same-shape {} outcomes MUST contribute to malformed_outcome_count = 3",
  );

  const objWarning = (a.warnings || []).find(
    (w) => w.type === "malformed_ask_user_outcome" && w.value === "{}",
  );
  assert.ok(objWarning, "Single {} warning entry expected");
  assert.equal(
    objWarning.count,
    3,
    'Same-shape "{}" warnings MUST coalesce to count=3',
  );
});
