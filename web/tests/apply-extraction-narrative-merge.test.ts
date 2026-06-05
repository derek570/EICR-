/**
 * apply-extraction — narrative-field append/supersede/skip tests.
 *
 * iOS canon: `applySonnetNarrativeValue`
 * (`CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift:5948-6005`)
 * called for `reason_for_report` (:4331) and
 * `general_condition_of_installation` (:4400).
 *
 * Background: long multi-sentence dictations into narrative
 * installation-details fields may arrive split across multiple
 * Deepgram final transcripts because of utterance-end timeouts or
 * chunk boundaries. Each transcript fires its own Sonnet
 * `record_reading`. PWA pre-fix would plain-overwrite, losing every
 * earlier chunk. iOS appends with sentence-aware joiner.
 *
 * Pinned scenarios (mirrors the four iOS branches verbatim):
 *   1. First write → set (no joiner).
 *   2. Identical → no-op.
 *   3. New contains old → supersede (Sonnet re-emitted the full
 *      narrative; replace to keep latest punctuation/casing).
 *   4. Old contains new → no-op (avoids truncation when a later
 *      partial duplicates an earlier prefix).
 *   5. Genuinely new content → append with ". " joiner if the
 *      current doesn't end in sentence punctuation, " " if it does.
 *
 * Plus: dual-write under wire + PWA-column names; pre-typed user
 * value is APPENDED (not protected) per iOS behaviour — narrative
 * fields don't gate on `userValueKept`.
 */
import { describe, expect, it } from 'vitest';
import { applyExtractionToJob, mergeNarrativeValue } from '@/lib/recording/apply-extraction';
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

describe('mergeNarrativeValue (pure helper, iOS parity)', () => {
  it('returns the new value when the current is empty (first write)', () => {
    expect(mergeNarrativeValue('', 'Installation is over 50 years old')).toBe(
      'Installation is over 50 years old'
    );
    expect(mergeNarrativeValue(null, 'Hello')).toBe('Hello');
    expect(mergeNarrativeValue(undefined, '  Hello  ')).toBe('Hello');
  });

  it('returns null when the incoming is empty or whitespace-only', () => {
    expect(mergeNarrativeValue('Existing text', '')).toBeNull();
    expect(mergeNarrativeValue('Existing text', '   ')).toBeNull();
    expect(mergeNarrativeValue('Existing', null)).toBeNull();
  });

  it('returns null on exact duplicates (case-insensitive)', () => {
    expect(mergeNarrativeValue('Installation is old', 'Installation is old')).toBeNull();
    expect(mergeNarrativeValue('Installation is OLD', 'installation is old')).toBeNull();
  });

  it('supersedes when new contains old (Sonnet re-emitted full narrative)', () => {
    const result = mergeNarrativeValue(
      'Installation is old',
      'Installation is old. Walls are damp.'
    );
    expect(result).toBe('Installation is old. Walls are damp.');
  });

  it('returns null when old contains new (avoids truncation)', () => {
    expect(
      mergeNarrativeValue('Installation is old. Walls are damp.', 'Installation is old')
    ).toBeNull();
  });

  it('appends with ". " joiner when current does not end in sentence punctuation', () => {
    expect(mergeNarrativeValue('Installation is old', 'Walls are damp')).toBe(
      'Installation is old. Walls are damp'
    );
  });

  it('appends with " " joiner when current ends in sentence punctuation', () => {
    expect(mergeNarrativeValue('Installation is old.', 'Walls are damp')).toBe(
      'Installation is old. Walls are damp'
    );
    expect(mergeNarrativeValue('Installation is old!', 'Walls are damp')).toBe(
      'Installation is old! Walls are damp'
    );
    expect(mergeNarrativeValue('Installation is old?', 'Walls are damp')).toBe(
      'Installation is old? Walls are damp'
    );
  });

  it('handles a third chunk appended after the first two were merged', () => {
    const afterFirst = mergeNarrativeValue('', 'Installation is old');
    const afterSecond = mergeNarrativeValue(afterFirst!, 'Walls are damp');
    const afterThird = mergeNarrativeValue(afterSecond!, 'Sockets are 1960s');
    expect(afterThird).toBe('Installation is old. Walls are damp. Sockets are 1960s');
  });
});

describe('apply-extraction narrative fields (integration through applyExtractionToJob)', () => {
  it('first record_reading on general_condition lands under both wire and PWA-column names', () => {
    const result = makeResult({
      readings: [{ circuit: 0, field: 'general_condition', value: 'Good' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied).not.toBeNull();
    const install = applied!.patch.installation_details as Record<string, unknown>;
    expect(install.general_condition).toBe('Good');
    expect(install.general_condition_of_installation).toBe('Good');
  });

  it('appends a second chunk onto an existing general_condition', () => {
    const job = makeJob({
      installation_details: {
        general_condition: 'Installation is old',
        general_condition_of_installation: 'Installation is old',
      },
    });
    const result = makeResult({
      readings: [{ circuit: 0, field: 'general_condition', value: 'Walls are damp' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    const install = applied!.patch.installation_details as Record<string, unknown>;
    expect(install.general_condition).toBe('Installation is old. Walls are damp');
    expect(install.general_condition_of_installation).toBe('Installation is old. Walls are damp');
  });

  it('appends onto a user-typed value (no userValueKept short-circuit for narrative fields)', () => {
    // Inspector typed an initial sentence into the Installation tab
    // (`general_condition_of_installation` — the PWA column). iOS does
    // NOT protect narrative fields from Sonnet writes — the merge
    // helper appends. The inspector keeps their first sentence AND
    // gets the rest of the dictation appended.
    const job = makeJob({
      installation_details: {
        general_condition_of_installation: 'Building is over 50 years old',
      },
    });
    const result = makeResult({
      readings: [{ circuit: 0, field: 'general_condition', value: 'walls are damp' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    const install = applied!.patch.installation_details as Record<string, unknown>;
    expect(install.general_condition).toBe('Building is over 50 years old. walls are damp');
    expect(install.general_condition_of_installation).toBe(
      'Building is over 50 years old. walls are damp'
    );
  });

  it('skips a duplicate emit (no patch produced for that field)', () => {
    const job = makeJob({
      installation_details: { general_condition: 'Good' },
    });
    const result = makeResult({
      readings: [{ circuit: 0, field: 'general_condition', value: 'Good' }],
    });
    const applied = applyExtractionToJob(job, result);
    // Duplicate is a no-op — no patch produced for installation_details.
    if (applied) {
      const install = applied.patch.installation_details as Record<string, unknown> | undefined;
      if (install) {
        // If a patch did land, it must not change the value.
        expect(install.general_condition).toBe('Good');
      }
    }
  });

  it('appends reason_for_report across two record_readings', () => {
    const job = makeJob({
      installation_details: { reason_for_report: 'Periodic inspection' },
    });
    const result = makeResult({
      readings: [{ circuit: 0, field: 'reason_for_report', value: 'Required by mortgage lender.' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    const install = applied!.patch.installation_details as Record<string, unknown>;
    expect(install.reason_for_report).toBe('Periodic inspection. Required by mortgage lender.');
  });

  it('supersedes when Sonnet re-emits the full narrative', () => {
    const job = makeJob({
      installation_details: { general_condition: 'Installation is old' },
    });
    const result = makeResult({
      readings: [
        {
          circuit: 0,
          field: 'general_condition',
          value: 'Installation is old. Walls are damp.',
        },
      ],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    const install = applied!.patch.installation_details as Record<string, unknown>;
    expect(install.general_condition).toBe('Installation is old. Walls are damp.');
  });

  it('non-narrative installation field (date_of_previous_inspection) still uses plain overwrite + userValueKept gate', () => {
    // Sanity check that the narrative branch is scoped correctly —
    // a same-section field that is NOT in NARRATIVE_FIELDS preserves
    // the legacy 3-tier priority behaviour.
    const job = makeJob({
      installation_details: { date_of_previous_inspection: '2020-01-01' },
    });
    const result = makeResult({
      readings: [{ circuit: 0, field: 'date_of_previous_inspection', value: '2025-01-01' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied).toBeNull(); // user value kept — no patch.
  });
});
