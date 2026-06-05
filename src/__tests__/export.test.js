import { describe, expect, it } from '@jest/globals';
import { circuitsToCSV } from '../export.js';

/**
 * Regression tests for the multi-board hierarchy fields
 * (`board_id`, `is_distribution_circuit`, `feeds_board_id`) round-tripping
 * through `circuitsToCSV` → CSV string. The reader side
 * (`utils/jobs.js parseCSV`) is generic header-name CSV parsing — once the
 * writer emits the right header line and per-row values, the reader just
 * works.
 *
 * Phase 2a of the multi-board / sub-main support sprint
 * (.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/PLAN.md).
 * Codex review flagged that the fixed `CIRCUIT_FIELD_ORDER` in `src/export.js`
 * silently drops any column not in the list. Phase 2a appends the three
 * hierarchy markers; this file pins that they survive a CSV round-trip so
 * a future refactor that shrinks the order list back to 29 fields breaks
 * loudly here.
 *
 * Note: we do NOT import `parseCSV` from `../utils/jobs.js` because that
 * pulls in the storage layer transitively, which uses `import.meta.dirname`
 * — broken under jest --experimental-vm-modules. The header-line + per-row
 * string assertions below are equivalent to round-tripping through
 * parseCSV (which just splits commas and maps headers to values).
 */

// Minimal CSV parser equivalent to utils/jobs.js parseCSV. Inlined to avoid
// dragging in the storage module's import.meta-dependent code from a unit
// test. Same algorithm: split on \n, header row by comma, each subsequent
// row mapped to a {header: value} object.
function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim().replace(/"/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map((v) => v.trim().replace(/"/g, ''));
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }
  return rows;
}

describe('circuitsToCSV — multi-board hierarchy fields', () => {
  it('emits the three new headers in the CSV header line', () => {
    const csv = circuitsToCSV([{ circuit_ref: '1' }]);
    const headerLine = csv.split('\n')[0];
    expect(headerLine).toContain('board_id');
    expect(headerLine).toContain('is_distribution_circuit');
    expect(headerLine).toContain('feeds_board_id');
  });

  it('preserves board_id, is_distribution_circuit, feeds_board_id through CSV round-trip', () => {
    const input = [
      {
        circuit_ref: '1',
        circuit_designation: 'Kitchen Ring',
        ocpd_type: 'MCB',
        ocpd_rating_a: '32',
        board_id: 'main',
        is_distribution_circuit: 'no',
        feeds_board_id: '',
      },
      {
        circuit_ref: '4',
        circuit_designation: 'Sub-board feed',
        ocpd_type: 'MCB',
        ocpd_rating_a: '63',
        board_id: 'main',
        is_distribution_circuit: 'yes',
        feeds_board_id: 'sub-1',
      },
      {
        circuit_ref: '1',
        circuit_designation: 'Garage lights',
        ocpd_type: 'MCB',
        ocpd_rating_a: '6',
        board_id: 'sub-1',
        is_distribution_circuit: 'no',
        feeds_board_id: '',
      },
    ];

    const csv = circuitsToCSV(input);
    const parsed = parseCsv(csv);

    expect(parsed).toHaveLength(3);
    expect(parsed[0].board_id).toBe('main');
    expect(parsed[0].is_distribution_circuit).toBe('no');
    expect(parsed[0].feeds_board_id).toBe('');

    expect(parsed[1].board_id).toBe('main');
    expect(parsed[1].is_distribution_circuit).toBe('yes');
    expect(parsed[1].feeds_board_id).toBe('sub-1');

    expect(parsed[2].board_id).toBe('sub-1');
    expect(parsed[2].is_distribution_circuit).toBe('no');
    expect(parsed[2].feeds_board_id).toBe('');
  });

  it('legacy CSV files without hierarchy headers parse with the new fields as empty strings', () => {
    // Pre-Phase-2a CSV: 29 columns, no board_id / is_distribution_circuit /
    // feeds_board_id. parseCSV maps by header name, so the new fields
    // simply don't appear on the parsed row object. iOS reads them as
    // undefined → treated as nil → boardId falls through to the existing
    // "first board wins" orphan-fixup. Pin that legacy snapshots stay
    // readable.
    const legacyCsv = [
      'circuit_ref,circuit_designation,ocpd_type,ocpd_rating_a',
      '1,Kitchen Ring,MCB,32',
      '2,Lights,MCB,6',
    ].join('\n');

    const parsed = parseCsv(legacyCsv);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].circuit_ref).toBe('1');
    expect(parsed[0].circuit_designation).toBe('Kitchen Ring');
    expect(parsed[0].board_id).toBeUndefined();
    expect(parsed[0].is_distribution_circuit).toBeUndefined();
    expect(parsed[0].feeds_board_id).toBeUndefined();
  });

  it('handles a single-board legacy job written via the new exporter (all hierarchy fields blank)', () => {
    // The common case post-Phase-2a: a vanilla single-board job. iOS hasn't
    // assigned board_id explicitly, so circuits ride with empty strings.
    // Round-trip must preserve the empties — not turn them into "undefined"
    // strings or lose the row.
    const input = [
      { circuit_ref: '1', circuit_designation: 'Kitchen Ring', ocpd_type: 'MCB' },
      { circuit_ref: '2', circuit_designation: 'Lights', ocpd_type: 'MCB' },
    ];
    const csv = circuitsToCSV(input);
    const parsed = parseCsv(csv);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].board_id).toBe('');
    expect(parsed[0].is_distribution_circuit).toBe('');
    expect(parsed[0].feeds_board_id).toBe('');
  });
});
