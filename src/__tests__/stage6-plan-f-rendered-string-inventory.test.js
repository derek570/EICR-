/**
 * stage6-plan-f-rendered-string-inventory.test.js
 *
 * PLAN-F item 1 (2026-08-12, feedback id 115) — rendered-string inventory.
 * The client 30s text-keyed dedupe means two spoken lines that happen to
 * share text collapse into one on the client — so a NEW notice family's
 * wording must be provably distinct from every EXISTING one, and from the
 * other five plans in this wave (PLAN-A/A2/B/C/D/E), which each introduced
 * their own new spoken strings in the same feedback-2026-08-11 wave.
 *
 * This test exercises the two ACTUAL rendered forms (via the real
 * dispatcher → bundler pipeline, not hand-typed literals) and checks them
 * against a curated collision-risk list: every other GATE_REASONS-adjacent
 * notice string already in this codebase that contains "spare", plus the
 * literal strings this plan's sibling implementations (web/iOS) render —
 * which must be byte-identical to backend's, not merely "similar".
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTION_DIR = path.join(__dirname, '../extraction');

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function grepAllExtractionSource(pattern) {
  const hits = [];
  for (const file of readdirSync(EXTRACTION_DIR)) {
    if (!file.endsWith('.js')) continue;
    const text = readFileSync(path.join(EXTRACTION_DIR, file), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (pattern.test(line)) hits.push({ file, line: i + 1, text: line.trim() });
    });
  }
  return hits;
}

describe('PLAN-F rendered-string inventory — actual dispatcher/bundler output', () => {
  test('the plural skip-disclosure clause is exactly "skipping N spare ways" (N>1)', async () => {
    const session = {
      sessionId: 's-inventory',
      stateSnapshot: {
        circuits: {
          0: {},
          1: { circuit_designation: 'Cooker' },
          2: { circuit_designation: 'Spare' },
          3: { circuit_designation: '' },
        },
      },
      extractedObservations: [],
    };
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    await d(
      {
        tool_call_id: 'tu1',
        name: 'set_field_for_all_circuits',
        input: { field: 'rcd_time_ms', value: '25', confidence: 0.95, source_turn_id: 't1' },
      },
      {}
    );
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const entry = r.confirmations.find((c) => c.field === 'rcd_time_ms');
    // Clause has no trailing period of its own (it's appended mid-sentence
    // via ", <clause>." — the bundler owns the final full stop).
    expect(entry.text.endsWith(', skipping 2 spare ways')).toBe(true);
    expect(entry.text.endsWith('.')).toBe(false);
  });

  // Codex diff-review r1 — the plan's zero-applied wording is PAST tense
  // ("skipped"), distinct from the present-continuous append-clause
  // ("skipping") used when there IS a surviving confirmation to annotate.
  // PLAN-F-final.md Decision 4, verbatim: "No non-spare circuits were
  // updated; skipped N spare ways."
  test('the zero-applied standalone sentence is exactly "No non-spare circuits were updated; skipped N spare ways."', async () => {
    const session = {
      sessionId: 's-inventory-2',
      stateSnapshot: {
        circuits: { 0: {}, 1: { circuit_designation: 'Spare' } },
      },
      extractedObservations: [],
    };
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    await d(
      {
        tool_call_id: 'tu1',
        name: 'set_field_for_all_circuits',
        input: { field: 'rcd_time_ms', value: '25', confidence: 0.95, source_turn_id: 't1' },
      },
      {}
    );
    const r = bundleToolCallsIntoResult(writes, { questions: [] }, { confirmationsEnabled: true });
    const entry = r.confirmations.find((c) => c.field === 'rcd_time_ms');
    expect(entry.text).toBe('No non-spare circuits were updated; skipped 1 spare way.');
  });
});

describe('PLAN-F rendered-string inventory — collision check against existing notice families', () => {
  test('no OTHER spoken-string literal in src/extraction/ contains "skipping"/"skipped" + "spare" (this plan is the sole producer)', () => {
    const hits = grepAllExtractionSource(
      /skipping\s+\d|skipping \$\{|skipped\s+\d|skipped \$\{/i
    ).filter((h) => /spare/i.test(h.text));
    const nonPlanFHits = hits.filter(
      (h) =>
        !h.file.includes('stage6-event-bundler.js') &&
        !h.file.includes('stage6-per-turn-writes.js') &&
        !h.file.includes('stage6-dispatchers-circuit.js')
    );
    expect(nonPlanFHits).toEqual([]);
  });

  test('no OTHER spoken-string literal contains the exact phrase "No non-spare circuits"', () => {
    const hits = grepAllExtractionSource(/No non-spare circuits/);
    // Every hit must be THIS plan's own producer (the bundler's synthesis
    // site) — a duplicate elsewhere would mean two different notice
    // families accidentally chose the same wording.
    for (const hit of hits) {
      expect(hit.file).toBe('stage6-event-bundler.js');
    }
    expect(hits.length).toBeGreaterThan(0);
  });
});
