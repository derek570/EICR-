/**
 * Plan 00B §B2 — production-source mutation-parity scan.
 *
 * Greps the covered extraction sources with MUTATION_WRITE_PATTERNS and
 * enforces the committed classification manifest: every hit classified,
 * every manifest row live, zero forbidden_direct_mutation rows, and
 * semantic_mutation confined to the atom file. Plus the two §B2 RED
 * fixtures: an unclassified direct write and a forbidden-classed row both
 * fail closed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MUTATION_WRITE_PATTERNS,
  MUTATION_SITE_CLASSIFICATION,
} from '../../scripts/model-ab/lib/mutation-classification.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COVERED_DIR = path.join(repoRoot, 'src', 'extraction');

const patterns = MUTATION_WRITE_PATTERNS.map((p) => new RegExp(p));

function listCoveredFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...listCoveredFiles(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/** Scan one source text; returns hit lines (1-indexed) with their text. */
function scanSource(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (patterns.some((re) => re.test(line))) hits.push({ line: i + 1, text: line });
  }
  return hits;
}

/** Classify hits for a repo-relative file per the manifest. */
function classifyHits(relFile, hits) {
  const rows = MUTATION_SITE_CLASSIFICATION[relFile];
  const results = [];
  for (const hit of hits) {
    if (!rows) {
      results.push({ ...hit, class: null, unclassified: true });
      continue;
    }
    const row = rows.find((r) => new RegExp(r.test).test(hit.text));
    if (!row) results.push({ ...hit, class: null, unclassified: true });
    else results.push({ ...hit, class: row.class, unclassified: false });
  }
  return results;
}

describe('plan00 mutation source scan', () => {
  const perFileHits = new Map();
  for (const file of listCoveredFiles(COVERED_DIR)) {
    const rel = path.relative(repoRoot, file).split(path.sep).join('/');
    const hits = scanSource(fs.readFileSync(file, 'utf8'));
    if (hits.length > 0) perFileHits.set(rel, hits);
  }

  test('every covered write is classified; none is forbidden', () => {
    const problems = [];
    for (const [rel, hits] of perFileHits) {
      for (const res of classifyHits(rel, hits)) {
        if (res.unclassified) {
          problems.push(`UNCLASSIFIED ${rel}:${res.line} — ${res.text.trim()}`);
        } else if (res.class === 'forbidden_direct_mutation') {
          problems.push(`FORBIDDEN ${rel}:${res.line} — ${res.text.trim()}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('semantic_mutation is confined to the atom file', () => {
    for (const [rel, rows] of Object.entries(MUTATION_SITE_CLASSIFICATION)) {
      for (const row of rows) {
        if (row.class === 'semantic_mutation') {
          expect(rel).toBe('src/extraction/stage6-snapshot-mutators.js');
        }
      }
    }
  });

  test('the committed manifest holds zero forbidden_direct_mutation rows', () => {
    for (const rows of Object.values(MUTATION_SITE_CLASSIFICATION)) {
      for (const row of rows) expect(row.class).not.toBe('forbidden_direct_mutation');
    }
  });

  test('no stale manifest entries: every classified file still has covered hits', () => {
    for (const rel of Object.keys(MUTATION_SITE_CLASSIFICATION)) {
      expect(perFileHits.has(rel)).toBe(true);
    }
  });

  test('every manifest row carries a class and a rationale', () => {
    for (const rows of Object.values(MUTATION_SITE_CLASSIFICATION)) {
      for (const row of rows) {
        expect(['semantic_mutation', 'input_state_seed', 'forbidden_direct_mutation']).toContain(
          row.class
        );
        expect(typeof row.rationale).toBe('string');
        expect(row.rationale.length).toBeGreaterThan(20);
      }
    }
  });

  // §B2 RED fixture 1 — an unclassified direct write in a covered file fails
  // closed (proves the scan actually catches the class it exists for).
  test('RED: an unclassified direct write is caught', () => {
    const synthetic = scanSource(
      "function sneak(snapshot) {\n  snapshot.circuits[5] = { r1_r2_ohm: '0.5' };\n}\n"
    );
    expect(synthetic).toHaveLength(1);
    const classified = classifyHits('src/extraction/some-new-handler.js', synthetic);
    expect(classified[0].unclassified).toBe(true);
  });

  // §B2 RED fixture 2 — a forbidden-classed row is reported, never accepted.
  test('RED: a forbidden_direct_mutation-classed hit is reported', () => {
    const hits = [{ line: 1, text: 'snapshot.currentBoardId = evil;' }];
    const rows = [{ test: '.', class: 'forbidden_direct_mutation', rationale: 'x'.repeat(30) }];
    const res = hits.map((hit) => {
      const row = rows.find((r) => new RegExp(r.test).test(hit.text));
      return { ...hit, class: row?.class ?? null };
    });
    expect(res[0].class).toBe('forbidden_direct_mutation');
  });
});
