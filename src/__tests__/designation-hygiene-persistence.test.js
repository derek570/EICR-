/**
 * PLAN-B B1 ingress 5+8 (feedback id 128) — designation hygiene at the
 * persistence boundaries.
 *
 * `circuitsToCSV` (src/export.js) is the COMMON serializer every save path
 * funnels through — jobs PUT save (src/routes/jobs.js:744), address
 * migration (:820), job clone (:1101), recording CSV upload/enrichment
 * (src/routes/recording.js:243/:491), export (src/routes/export.js:30) and
 * OCR create-job (src/routes/ocr.js:72). Repairing the circuit_designation
 * cell inside the serializer makes persistence enforcement exhaustive at
 * one boundary; the caller-inventory test below pins that each named route
 * still routes through it (so a route rewrite that stops calling the
 * serializer breaks loudly here, not silently in the field).
 *
 * `process_job.js` is the SECOND CSV writer (builds test_results.csv
 * directly) and repairs its extracted rows pre-salvage — covered by the
 * repair-helper unit tests plus the source-level pin below.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import { circuitsToCSV } from '../export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

function cell(csv, rowIdx, field) {
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',');
  const col = headers.indexOf(field);
  return lines[rowIdx + 1].split(',')[col];
}

describe('circuitsToCSV — designation repair at the persistence boundary', () => {
  it('strips standalone edge circuit/circuits tokens on serialisation', () => {
    const csv = circuitsToCSV([
      { circuit_ref: '1', circuit_designation: 'Upstairs lighting circuit' },
      { circuit_ref: '2', circuit_designation: 'Circuit upstairs sockets' },
      { circuit_ref: '3', circuit_designation: 'Lighting circuits' },
    ]);
    expect(cell(csv, 0, 'circuit_designation')).toBe('Upstairs lighting');
    expect(cell(csv, 1, 'circuit_designation')).toBe('upstairs sockets');
    expect(cell(csv, 2, 'circuit_designation')).toBe('Lighting');
  });

  it('leaves a banned-token-only value UNCHANGED (repair-never-reject; empty = spare hazard)', () => {
    const csv = circuitsToCSV([{ circuit_ref: '1', circuit_designation: 'Circuit' }]);
    expect(cell(csv, 0, 'circuit_designation')).toBe('Circuit');
  });

  it('interior tokens and hyphen compounds untouched; clean values byte-identical', () => {
    const csv = circuitsToCSV([
      { circuit_ref: '1', circuit_designation: 'Ring circuit sockets' },
      { circuit_ref: '2', circuit_designation: 'Short-circuit tester' },
      { circuit_ref: '3', circuit_designation: 'Kitchen sockets' },
      { circuit_ref: '4', circuit_designation: '' },
    ]);
    expect(cell(csv, 0, 'circuit_designation')).toBe('Ring circuit sockets');
    expect(cell(csv, 1, 'circuit_designation')).toBe('Short-circuit tester');
    expect(cell(csv, 2, 'circuit_designation')).toBe('Kitchen sockets');
    expect(cell(csv, 3, 'circuit_designation')).toBe('');
  });

  it("never mutates the caller's circuit objects (serialiser stays pure)", () => {
    const input = [{ circuit_ref: '1', circuit_designation: 'Upstairs lighting circuit' }];
    circuitsToCSV(input);
    expect(input[0].circuit_designation).toBe('Upstairs lighting circuit');
  });
});

describe('caller inventory — every persistence route still funnels through the repaired serializer', () => {
  // Source-level pins: these six callers are what makes the ONE-boundary
  // enforcement exhaustive. If a route stops calling circuitsToCSV (or
  // process_job stops repairing its rows), the repair silently stops
  // covering that path — this makes it loud instead.
  const expectations = [
    ['src/routes/jobs.js', /circuitsToCSV\(/],
    ['src/routes/recording.js', /circuitsToCSV\(/],
    ['src/routes/export.js', /circuitsToCSV\(/],
    ['src/routes/ocr.js', /circuitsToCSV\(/],
    ['src/process_job.js', /repairCircuitDesignation\(/],
  ];

  for (const [file, pattern] of expectations) {
    it(`${file} routes designations through the repaired boundary`, () => {
      const src = readFileSync(path.join(repoRoot, file), 'utf8');
      expect(pattern.test(src)).toBe(true);
    });
  }
});
