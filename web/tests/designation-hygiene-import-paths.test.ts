/**
 * PLAN-B2 (B2-2, web import/preset boundaries) — designation hygiene at
 * the three import ENTRY points: CCU analysis, document extraction, and
 * preset application. Each writes designations into the local job
 * without traversing the backend dispatchers, and the web certificate
 * PDF renders from the local model (WS9) — so a raw "…circuit" label
 * imported here would survive onto the certificate regardless of the
 * backend fix.
 */

import { describe, expect, it } from 'vitest';

import {
  applyCcuAnalysisToJob,
  canonicaliseCcuAnalysisLabels,
} from '../src/lib/recording/apply-ccu-analysis';
import { applyDocumentExtractionToJob } from '../src/lib/recording/apply-document-extraction';
import { applyPresetToJob } from '../src/lib/defaults/service';
import type { CCUAnalysis, JobDetail } from '../src/lib/types';
import type { CertificateDefaultPreset } from '../src/lib/defaults/types';

const emptyJob = (): JobDetail =>
  ({
    id: 'job-1',
    circuits: [],
    boards: [{ id: 'board-1', designation: 'DB1', board_type: 'main' }],
  }) as unknown as JobDetail;

describe('CCU analysis import — designation hygiene at entry', () => {
  it('canonicaliseCcuAnalysisLabels repairs edge tokens on an incoming copy', () => {
    const analysis = {
      circuits: [
        { circuit_number: 1, label: 'Kitchen sockets circuit' },
        { circuit_number: 2, label: 'Circuit' },
        { circuit_number: 3, label: 'Short-circuit tester' },
      ],
    } as unknown as CCUAnalysis;
    const cleaned = canonicaliseCcuAnalysisLabels(analysis);
    expect(cleaned.circuits?.[0].label).toBe('Kitchen sockets');
    // Banned-token-only: unchanged (repair never blanks — spare hazard).
    expect(cleaned.circuits?.[1].label).toBe('Circuit');
    expect(cleaned.circuits?.[2].label).toBe('Short-circuit tester');
    // Original object untouched (incoming COPY semantics).
    expect(analysis.circuits?.[0].label).toBe('Kitchen sockets circuit');
  });

  it('applyCcuAnalysisToJob writes canonical designations even when the caller skipped the entry pass', () => {
    const analysis = {
      circuits: [{ circuit_number: 1, label: 'Upstairs lighting circuit' }],
    } as unknown as CCUAnalysis;
    const { patch } = applyCcuAnalysisToJob(emptyJob(), analysis, {
      mode: 'names_only',
      targetBoardId: 'board-1',
    });
    const rows = patch.circuits as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.circuit_ref === '1')?.circuit_designation).toBe('Upstairs lighting');
  });

  it('full_capture persists a canonicalised analysis blob (ccu_analysis_by_board)', () => {
    const analysis = {
      circuits: [{ circuit_number: 1, label: 'Cooker circuit' }],
    } as unknown as CCUAnalysis;
    const { patch } = applyCcuAnalysisToJob(emptyJob(), analysis, {
      mode: 'full_capture',
      targetBoardId: 'board-1',
    });
    const stored = patch.ccu_analysis_by_board?.['board-1'] as unknown as CCUAnalysis;
    expect(stored.circuits?.[0].label).toBe('Cooker');
  });

  it('dirty and clean edge-token variants resolve to the SAME existing row (no competing duplicate)', () => {
    const job = {
      id: 'job-1',
      boards: [{ id: 'board-1', designation: 'DB1', board_type: 'main' }],
      circuits: [
        {
          id: 'c1',
          board_id: 'board-1',
          circuit_ref: '1',
          circuit_designation: 'Kitchen sockets',
          measured_zs_ohm: '0.42',
        },
      ],
    } as unknown as JobDetail;
    const analysis = {
      circuits: [{ circuit_number: 1, label: 'Kitchen sockets circuit' }],
    } as unknown as CCUAnalysis;
    const { patch } = applyCcuAnalysisToJob(job, analysis, {
      mode: 'names_only',
      targetBoardId: 'board-1',
    });
    const rows = patch.circuits as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    // The existing row keeps its readings and its (already canonical)
    // designation — names_only never stomps a non-empty label.
    expect(rows[0].circuit_designation).toBe('Kitchen sockets');
    expect(rows[0].measured_zs_ohm).toBe('0.42');
  });
});

describe('document extraction import — designation hygiene at entry', () => {
  it('new rows built from the generic field loop carry canonical designations', () => {
    const response = {
      success: true,
      formData: {
        circuits: [{ circuit_ref: '1', circuit_designation: 'Garage supply circuit' }],
      },
    } as unknown as Parameters<typeof applyDocumentExtractionToJob>[1];
    const { patch } = applyDocumentExtractionToJob(emptyJob(), response);
    const rows = patch.circuits as Array<Record<string, unknown>>;
    expect(rows[0].circuit_designation).toBe('Garage supply');
  });

  it('matched-row fill uses the canonical copy (empty existing designation filled clean)', () => {
    const job = {
      id: 'job-1',
      boards: [{ id: 'board-1', designation: 'DB1', board_type: 'main' }],
      circuits: [{ id: 'c1', board_id: 'board-1', circuit_ref: '1', circuit_designation: '' }],
    } as unknown as JobDetail;
    const response = {
      success: true,
      formData: {
        circuits: [{ circuit_ref: '1', circuit_designation: 'circuit immersion heater' }],
      },
    } as unknown as Parameters<typeof applyDocumentExtractionToJob>[1];
    const { patch } = applyDocumentExtractionToJob(job, response);
    const rows = patch.circuits as Array<Record<string, unknown>>;
    expect(rows[0].circuit_designation).toBe('immersion heater');
  });
});

describe('preset application — legacy dirty preset repaired on copy', () => {
  it('applyPresetToJob canonicalises copied circuit designations', () => {
    const preset = {
      id: 'p1',
      user_id: 'u1',
      name: 'Legacy preset',
      certificate_type: 'EICR',
      last_modified: 1,
      default_data: {
        circuits: [
          { id: 'c1', circuit_ref: '1', circuit_designation: 'Upstairs lighting circuit' },
          { id: 'c2', circuit_ref: '2', circuit_designation: 'circuits' },
        ],
      },
    } as unknown as CertificateDefaultPreset;
    const patch = applyPresetToJob(preset, { id: 'job-1', circuits: [] } as unknown as JobDetail);
    const rows = patch.circuits as Array<Record<string, unknown>>;
    expect(rows[0].circuit_designation).toBe('Upstairs lighting');
    // Banned-token-only survives unchanged — blanking would flip to spare.
    expect(rows[1].circuit_designation).toBe('circuits');
  });
});
