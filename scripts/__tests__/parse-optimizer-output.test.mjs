// parse-optimizer-output.cjs tests.
//
// Runs the parser against committed fixture files and asserts that:
//   - Valid Claude output is extracted + parsed
//   - Recoverable output (literal \n or \t inside JSON strings) is repaired
//   - Irrecoverable output (unclosed quotes, missing JSON block) fails loud
// Uses node's built-in test runner — no jest dependency.
//
// Run with:  node --test scripts/__tests__/parse-optimizer-output.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const parserPath = join(here, "..", "parse-optimizer-output.cjs");
const fixturesDir = join(here, "fixtures", "optimizer-output");

function runParser(fixtureName) {
  const input = readFileSync(join(fixturesDir, fixtureName), "utf8");
  const res = spawnSync(process.execPath, [parserPath], {
    input,
    encoding: "utf8",
  });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

test("happy path — clean JSON parses unchanged", () => {
  const res = runParser("happy-path.md");
  assert.equal(res.status, 0, `expected success, got stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.recommendations.length, 1);
  assert.equal(out.recommendations[0].category, "keyword_boost");
  assert.ok(out.summary.includes("Clean session"));
});

test("literal newline in old_code (DAEF3165 failure mode) is repaired", () => {
  const res = runParser("multiline-old-code.md");
  assert.equal(
    res.status,
    0,
    `DAEF3165 must parse after repair. stderr: ${res.stderr}`,
  );
  const out = JSON.parse(res.stdout);
  assert.equal(out.recommendations.length, 1);
  const rec = out.recommendations[0];
  assert.ok(
    rec.title.toLowerCase().includes("caversham"),
    "Caversham recommendation must survive the parse",
  );
  // The literal newline must have been preserved as part of the string value
  // (turned into a real \n character in the parsed JS string, which renders
  // multi-line in the old_code snippet).
  assert.ok(
    rec.old_code.includes("\n") && rec.old_code.includes("postcode"),
    "old_code must contain the multi-line postcode/customer snippet",
  );
  assert.ok(
    rec.new_code.includes("Caversham"),
    "new_code must contain the Caversham insertion",
  );
});

test("literal tab in description is repaired", () => {
  const res = runParser("literal-tab-in-description.md");
  assert.equal(res.status, 0, `expected success, got stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.recommendations.length, 1);
  assert.ok(
    out.recommendations[0].description.includes("\t"),
    "tab should survive as a real tab char in the parsed string",
  );
});

test("mismatched quote fails loudly (non-zero exit, no silent empty)", () => {
  const res = runParser("mismatched-quote.md");
  assert.notEqual(res.status, 0, "truly broken JSON must NOT exit 0");
  assert.ok(
    res.stderr.length > 0,
    "error detail must land on stderr for the caller to log",
  );
  assert.equal(res.stdout.trim(), "", "no stdout payload on failure");
});

test("output with no JSON block at all fails loudly", () => {
  const res = runParser("no-json-block.md");
  assert.notEqual(res.status, 0, "missing JSON must NOT exit 0");
  assert.ok(
    res.stderr.includes("no JSON block"),
    `stderr should explain the missing block, got: ${res.stderr}`,
  );
});

test("JSON wrapped in markdown fences with chat preamble is extracted", () => {
  const res = runParser("markdown-fences-and-preamble.md");
  assert.equal(res.status, 0, `expected success, got stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.recommendations.length, 1);
  assert.equal(out.recommendations[0].title, "Single-field tweak");
  // Ensures we did NOT accidentally grab the lone `{` from the preamble.
  assert.ok(out.summary.includes("Fence-wrapped"));
});

test("escaped quote inside string does not flip parser state", () => {
  const res = runParser("escaped-quote-in-string.md");
  assert.equal(res.status, 0, `expected success, got stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.equal(out.recommendations.length, 1);
  assert.ok(
    out.recommendations[0].description.includes('"the installation is sound"'),
    "escaped quote must round-trip back to a real quote in the parsed string",
  );
  assert.ok(
    out.summary.includes('"quoted"'),
    "summary with escaped quotes must survive",
  );
});
