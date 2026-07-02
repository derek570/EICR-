/**
 * WS3 item 9b — EIC divert-to-comments voice apply path (2026-07-02).
 *
 * Backend PR #66 added the installation-level `comments` field and PR
 * #68 made the EIC observation flow PROACTIVE: spoken defects on an EIC
 * divert into comments (RULE 0) rather than record_observation. iOS
 * shipped the client apply on 2026-06-25 (the dedicated `comments` case,
 * DeepgramRecordingViewModel.swift:6650-6670). AUDIT confirmed the web
 * FORM cell already existed (extent/page.tsx, ExtentAndType.comments) —
 * the real gap was the VOICE apply: web had no `comments` routing, so a
 * comments reading default-routed to supply_characteristics (invisible
 * in the UI). These tests pin the ported iOS contract:
 *   - EIC: backend sends ONLY the new note; client APPENDS
 *     newline-separated (never overwrites earlier comments);
 *   - EICR: the field is DROPPED (observations are first-class there).
 */
import { describe, it, expect } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { JobDetail } from '@/lib/types';

function makeJob(certType: 'EIC' | 'EICR', comments?: string): JobDetail {
  return {
    id: 'test',
    user_id: 'test',
    folder_name: 'test',
    certificate_type: certType,
    created_date: new Date(0).toISOString(),
    circuits: [],
    ...(comments != null ? { extent_and_type: { comments } } : {}),
  } as unknown as JobDetail;
}

function commentsReading(value: string): ExtractionResult {
  return {
    readings: [{ field: 'comments', value, circuit: 0 }] as ExtractionResult['readings'],
    observations: [],
  };
}

describe('EIC divert-to-comments apply (iOS comments case parity)', () => {
  it('first write on an EIC lands the note in extent_and_type.comments', () => {
    const applied = applyExtractionToJob(
      makeJob('EIC'),
      commentsReading('Damaged socket in garage noted')
    );
    expect(applied).not.toBeNull();
    const extent = applied!.patch.extent_and_type as Record<string, unknown>;
    expect(extent.comments).toBe('Damaged socket in garage noted');
  });

  it('APPENDS newline-separated to existing comments (never overwrites)', () => {
    const job = makeJob('EIC', 'Existing note about meter tails');
    const applied = applyExtractionToJob(job, commentsReading('Second diverted observation'));
    const extent = applied!.patch.extent_and_type as Record<string, unknown>;
    expect(extent.comments).toBe('Existing note about meter tails\nSecond diverted observation');
  });

  it('two comments readings in ONE turn both append in order', () => {
    const job = makeJob('EIC');
    const result: ExtractionResult = {
      readings: [
        { field: 'comments', value: 'First note', circuit: 0 },
        { field: 'comments', value: 'Second note', circuit: 0 },
      ] as ExtractionResult['readings'],
      observations: [],
    };
    const applied = applyExtractionToJob(job, result);
    const extent = applied!.patch.extent_and_type as Record<string, unknown>;
    expect(extent.comments).toBe('First note\nSecond note');
  });

  it('DROPS the comments field on an EICR (iOS eic_field_dropped_on_eicr parity)', () => {
    const applied = applyExtractionToJob(makeJob('EICR'), commentsReading('Should never land'));
    // No extent patch, and definitely no supply_characteristics fallback
    // (the pre-fix default route would have put it there, invisible).
    const extent = applied?.patch.extent_and_type as Record<string, unknown> | undefined;
    expect(extent?.comments).toBeUndefined();
    const supply = applied?.patch.supply_characteristics as Record<string, unknown> | undefined;
    expect(supply?.comments).toBeUndefined();
  });

  it('empty/whitespace note is a no-op', () => {
    const job = makeJob('EIC', 'Keep me');
    const applied = applyExtractionToJob(job, commentsReading('   '));
    const extent = applied?.patch.extent_and_type as Record<string, unknown> | undefined;
    expect(extent?.comments).toBeUndefined();
  });
});
