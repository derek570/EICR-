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
