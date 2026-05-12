/**
 * apply-extraction — observation parity pass (M4/M9/M10/M11).
 *
 *  M4  — ObservationRow.board_id captured from wire.
 *  M9  — iOS-canon dedup (40-char prefix + 70 % word-set overlap).
 *  M10 — invalid BPG4 code → observation DROPPED (not rendered
 *        as un-coded).
 *  M11 — schedule_item validated against the cert-type-aware
 *        reference; unknown refs stripped from the row.
 *
 * iOS canon: `DeepgramRecordingViewModel.applySonnetObservations`
 * (:5470+) — same dedup, drop, and validation rules.
 */
import { describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { JobDetail } from '@/lib/types';

function makeJob(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job_1',
    job_id: 'job_1',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: 'a',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    ...over,
  } as unknown as JobDetail;
}

function makeResult(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    readings: [],
    field_clears: [],
    circuit_updates: [],
    observations: [],
    validation_alerts: [],
    confirmations: [],
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────
// M4 — board_id capture
// ────────────────────────────────────────────────────────────────────
describe('apply-extraction M4 — observation board_id capture', () => {
  it('captures board_id onto ObservationRow', () => {
    const result = makeResult({
      observations: [
        {
          observation_text: 'Loose neutral in garage CU',
          code: 'C2',
          board_id: 'sub-garage',
        },
      ],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied!.patch.observations![0].board_id).toBe('sub-garage');
  });

  it("omits board_id when wire doesn't carry one", () => {
    const result = makeResult({
      observations: [{ observation_text: 'Generic defect', code: 'C3' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied!.patch.observations![0].board_id).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// M9 — bidirectional fuzzy dedup
// ────────────────────────────────────────────────────────────────────
describe('apply-extraction M9 — observation dedup (40-char prefix + 70% word overlap)', () => {
  it('dedups exact case-insensitive match (old behaviour preserved)', () => {
    const job = makeJob({
      observations: [{ id: 'e-1', description: 'damaged socket outlet', code: 'C2' }],
    });
    const result = makeResult({
      observations: [{ observation_text: 'DAMAGED SOCKET OUTLET', code: 'C2' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied?.patch.observations).toBeUndefined();
  });

  it('dedups via 40-char prefix match', () => {
    const longText =
      'The neutral terminal on the consumer unit is loose and needs to be retightened to spec';
    const job = makeJob({
      observations: [{ id: 'e-1', description: longText, code: 'C2' }],
    });
    const result = makeResult({
      observations: [
        // First 40 chars match — old text shortened.
        {
          observation_text: 'The neutral terminal on the consumer uni',
          code: 'C2',
        },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied?.patch.observations).toBeUndefined();
  });

  it('dedups via 70 % word-set overlap (Sonnet rewording)', () => {
    const job = makeJob({
      observations: [
        { id: 'e-1', description: 'loose neutral terminal in consumer unit', code: 'C2' },
      ],
    });
    const result = makeResult({
      observations: [
        // "loose neutral connection in consumer unit" — 5 of 6 words
        // overlap (loose / neutral / in / consumer / unit) = 83 %.
        {
          observation_text: 'loose neutral connection in consumer unit',
          code: 'C2',
        },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied?.patch.observations).toBeUndefined();
  });

  it('does NOT dedup unrelated defects', () => {
    const job = makeJob({
      observations: [{ id: 'e-1', description: 'damaged socket outlet', code: 'C2' }],
    });
    const result = makeResult({
      observations: [{ observation_text: 'missing main switch label', code: 'C3' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied!.patch.observations).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────────
// M10 — invalid code → DROP
// ────────────────────────────────────────────────────────────────────
describe('apply-extraction M10 — invalid observation code → drop', () => {
  it('drops the row when code is not in C1/C2/C3/FI', () => {
    const result = makeResult({
      observations: [{ observation_text: 'Defect with bogus code', code: 'NC' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied).toBeNull();
  });

  it('keeps the row when code is omitted entirely (notes-only)', () => {
    // M10 drops INVALID codes only. A null/empty code is acceptable
    // (notes-only observation) — Sonnet's narrative output for
    // future investigation.
    const result = makeResult({
      observations: [{ observation_text: 'Free-form note for follow-up' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied).not.toBeNull();
    expect(applied!.patch.observations).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// M11 — schedule_item validation
// ────────────────────────────────────────────────────────────────────
describe('apply-extraction M11 — schedule_item validation', () => {
  it('keeps a valid EICR schedule ref', () => {
    // 1.1 is in EICR Section 1 "Condition of the consumer's intake
    // equipment" — a stable real ref.
    const result = makeResult({
      observations: [
        {
          observation_text: 'Service head condition concerns',
          code: 'C3',
          schedule_item: '1.1',
        },
      ],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied!.patch.observations![0].schedule_item).toBe('1.1');
  });

  it('strips an invalid schedule ref', () => {
    const result = makeResult({
      observations: [
        {
          observation_text: 'Hallucinated ref defect',
          code: 'C2',
          schedule_item: '99.99',
        },
      ],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    const obs = applied!.patch.observations![0];
    expect(obs.schedule_item).toBeUndefined();
    // Observation itself still lands.
    expect(obs.description).toBe('Hallucinated ref defect');
  });
});
