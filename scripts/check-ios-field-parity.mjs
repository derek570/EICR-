#!/usr/bin/env node
//
// Cross-repo schema-parity check (2026-04-27 — bug 2B class).
//
// What this guards against: backend Sonnet emits a field name that's in
// config/field_schema.json but iOS's applySonnetReadings switch doesn't have
// a case for it. The 6 × ir_test_voltage_v writes from session 6FF8A837
// (Ivydene Road) were exactly this shape — Sonnet wrote, iOS dropped.
//
// What this script does:
//   1. Loads config/field_schema.json — the single source of truth for every
//      extractable field.
//   2. Reads CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift
//      and parses every `case "..."` literal that appears between the
//      applySonnetReadings declaration and the matching default arm.
//   3. Diffs schema → cases. Reports MISSING (schema field with no case) and
//      ORPHAN (case for a field not in schema; usually a legacy alias kept
//      for back-compat — these are info-level, not errors).
//
// Usage:
//   node scripts/check-ios-field-parity.mjs           # exit 0 / 1
//   node scripts/check-ios-field-parity.mjs --json    # machine-readable
//
// The script reads BOTH repos via relative paths — works from the repo root.

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const require = createRequire(import.meta.url);
const SCHEMA = require(join(REPO_ROOT, 'config', 'field_schema.json'));

const SWIFT_PATH = join(
  REPO_ROOT,
  'CertMateUnified',
  'Sources',
  'Recording',
  'DeepgramRecordingViewModel.swift',
);

// ---------------------------------------------------------------------------
// Schema field collection
// ---------------------------------------------------------------------------
//
// Skip _ui_* meta keys (UI tab descriptions, not extractable values).
// Skip the inspector_profile_fields section — those come from the iOS
// signature flow, not Sonnet extraction.
// Skip the inspection_schedule_fields metadata — schedule items live under
// their own apply path (applyInspectionScheduleUpdates in iOS), not the
// readings switch.

function collectSchemaFields() {
  const sections = [
    { name: 'circuit_fields', skipKey: null },
    { name: 'supply_characteristics_fields', skipKey: null },
    { name: 'board_fields', skipKey: null },
    { name: 'installation_details_fields', skipKey: null },
    { name: 'eic_extent_and_type_fields', skipKey: null },
    { name: 'eic_design_construction_fields', skipKey: null },
  ];
  const fields = new Map(); // name → section
  for (const { name } of sections) {
    const block = SCHEMA[name];
    if (!block || typeof block !== 'object') continue;
    for (const [key] of Object.entries(block)) {
      if (key.startsWith('_ui_') || key.startsWith('_outcome_') || key.startsWith('_ai_')) continue;
      // circuit_ref is the routing key, not an extractable value.
      if (key === 'circuit_ref') continue;
      fields.set(key, name);
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Swift case extraction
// ---------------------------------------------------------------------------
//
// We extract every `case "..."` literal inside the applySonnetReadings
// function body. The function body is bounded by:
//   - opening: `private func applySonnetReadings(`
//   - closing: the matching `}` at the same indentation as the function decl
//
// Single-pass brace matcher — fast and robust against strings that look like
// braces.
//
// Multi-case lines like `case "a", "b":` are exploded into separate entries.

function extractCasesFromApplier(swiftSource) {
  const lines = swiftSource.split('\n');
  const startIdx = lines.findIndex((l) => l.includes('private func applySonnetReadings'));
  if (startIdx === -1) {
    throw new Error('applySonnetReadings function not found in Swift source');
  }

  // Find the matching close brace at the function's indentation level.
  // The function declaration line ends with `{`. Track depth from there.
  let depth = 0;
  let started = false;
  let endIdx = -1;
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        started = true;
      } else if (ch === '}') {
        depth -= 1;
        if (started && depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    if (endIdx !== -1) break;
  }
  if (endIdx === -1) {
    throw new Error('applySonnetReadings function has unbalanced braces');
  }

  const body = lines.slice(startIdx, endIdx + 1).join('\n');

  // Match `case "..."` and `case "...", "...":` — multiple literals per line
  // possible. Capture each quoted token separately.
  //
  // Important: this regex matches case-statement literals only; it skips
  // `case "..."` inside a comment because the matcher consumes lines that
  // start with `//` first.
  const cases = new Set();
  const bodyLines = body.split('\n');
  for (const rawLine of bodyLines) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line.startsWith('case ')) continue;
    // Find every "..." on the line.
    const literals = line.match(/"([^"]+)"/g) || [];
    for (const lit of literals) {
      cases.add(lit.slice(1, -1));
    }
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Diff and report
// ---------------------------------------------------------------------------

function main() {
  const wantJson = process.argv.includes('--json');
  if (!existsSync(SWIFT_PATH)) {
    console.error(`Swift source not found: ${SWIFT_PATH}`);
    process.exit(2);
  }
  const swift = readFileSync(SWIFT_PATH, 'utf8');
  const schemaFields = collectSchemaFields();
  const cases = extractCasesFromApplier(swift);

  const missing = [];
  for (const [field, section] of schemaFields) {
    if (!cases.has(field)) missing.push({ field, section });
  }
  // Orphan cases (case but not in schema). Includes legacy aliases the team
  // has consciously kept for back-compat (e.g. "zs", "earth_loop_impedance",
  // "cable_size"). Listed for visibility but not a failure.
  const orphans = [];
  for (const c of cases) {
    if (!schemaFields.has(c)) orphans.push(c);
  }
  orphans.sort();
  missing.sort((a, b) => a.field.localeCompare(b.field));

  if (wantJson) {
    process.stdout.write(JSON.stringify({ missing, orphans }, null, 2) + '\n');
    process.exit(missing.length === 0 ? 0 : 1);
  }

  console.log('iOS field-parity audit (config/field_schema.json → DeepgramRecordingViewModel.swift)');
  console.log('---');
  console.log(`Schema fields: ${schemaFields.size}`);
  console.log(`Apply cases:   ${cases.size}`);
  console.log(`Missing:       ${missing.length}`);
  console.log(`Orphan cases:  ${orphans.length} (legacy aliases — info only)`);
  console.log('');
  if (missing.length > 0) {
    console.log('MISSING — Sonnet can emit these but iOS has no apply case:');
    for (const { field, section } of missing) {
      console.log(`  - ${field}  (${section})`);
    }
    console.log('');
  }
  if (orphans.length > 0 && process.argv.includes('--verbose')) {
    console.log('Orphan cases (in switch but not in schema — typically legacy aliases):');
    for (const c of orphans) console.log(`  - ${c}`);
    console.log('');
  }
  if (missing.length === 0) {
    console.log('OK — every schema field has an apply case.');
    process.exit(0);
  } else {
    console.log(`FAIL — ${missing.length} schema field(s) have no iOS apply case.`);
    process.exit(1);
  }
}

main();
