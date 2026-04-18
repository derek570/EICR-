#!/usr/bin/env node
// parse-optimizer-output.cjs
//
// Extracts the JSON recommendations block out of a raw Claude CLI output
// (markdown with optional chat preamble / fences) and emits canonical JSON
// on stdout.
//
// Why this exists:
//   The old perl + jq pipeline in session-optimizer.sh silently dropped any
//   Claude output that contained a literal newline inside a JSON string
//   literal (seen in the wild on session DAEF3165, where a multi-line
//   `old_code` field had real `\n` bytes instead of the two-char escape).
//   jq rejected the block; the caller swallowed the error via `|| echo "[]"`
//   and reported "no recommendations" despite a perfectly-good suggestion.
//
// This helper:
//   1. Extracts the JSON block (prefers ```json fences, falls back to the
//      last `{...}` greedy match to match the old perl behaviour).
//   2. Runs a character-level repair pass that escapes literal
//      \n / \r / \t bytes found INSIDE string literals. Structural
//      whitespace outside strings is left untouched.
//   3. Parses with JSON.parse.
//   4. On success → canonical JSON to stdout, exit 0.
//      On failure → error detail to stderr, exit non-zero.
//
// The caller (session-optimizer.sh) treats non-zero exit as a hard failure
// and escalates via Pushover (Layer C) instead of silently falling back to
// an empty array.

"use strict";

const fs = require("fs");

function readAllInput() {
  if (process.argv[2]) {
    return fs.readFileSync(process.argv[2], "utf8");
  }
  return fs.readFileSync(0, "utf8");
}

// Extract the JSON candidate from Claude's markdown output.
// Strategy:
//   1. If there's a fenced ```json … ``` block, take the LAST one — Claude
//      sometimes includes earlier example fences in its reasoning.
//   2. Otherwise fall back to the old perl regex behaviour: greedy match
//      from the first `{` on a line to the last `}` in the file.
// Returns { block, source } or null if no candidate found.
function extractJsonCandidate(raw) {
  const fenceRe = /```json\s*\n([\s\S]*?)\n```/g;
  let lastFence = null;
  let m;
  while ((m = fenceRe.exec(raw)) !== null) {
    lastFence = m[1];
  }
  if (lastFence !== null) {
    return { block: lastFence, source: "fenced" };
  }

  // Fallback: match the old perl regex (.*(\{[\s\S]*\})/m). Single `.` does
  // not cross newlines, so this anchors on the line of the first `{` and
  // grabs everything through the last `}`.
  const greedy = raw.match(/.*(\{[\s\S]*\})/m);
  if (greedy) {
    return { block: greedy[1], source: "greedy" };
  }

  return null;
}

// Character-level repair pass.
// Walks the candidate JSON; when inside a string literal, converts any
// literal newline / carriage return / tab into its escape sequence. Escaped
// quotes (\") are honoured so we don't flip the "in string" state mid-value.
function repairJsonStrings(src) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
    }
    out += ch;
  }
  return out;
}

function main() {
  const raw = readAllInput();

  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    process.stderr.write(
      "parse-optimizer-output: no JSON block found in Claude output\n",
    );
    process.exit(2);
  }

  // First try the candidate as-is (fast path for well-formed output).
  let parsed;
  try {
    parsed = JSON.parse(candidate.block);
  } catch (_firstErr) {
    // Repair pass: escape literal newlines/tabs inside string literals.
    const repaired = repairJsonStrings(candidate.block);
    try {
      parsed = JSON.parse(repaired);
    } catch (secondErr) {
      process.stderr.write(
        `parse-optimizer-output: JSON.parse failed after repair pass: ${secondErr.message}\n`,
      );
      process.stderr.write(
        `parse-optimizer-output: candidate source=${candidate.source}, bytes=${candidate.block.length}\n`,
      );
      process.exit(3);
    }
  }

  process.stdout.write(JSON.stringify(parsed));
  process.stdout.write("\n");
  process.exit(0);
}

main();
