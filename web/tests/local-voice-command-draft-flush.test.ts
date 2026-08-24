/**
 * PLAN-B2 cycle-5 — the LOCAL voice-command parse path flushes
 * designation drafts before mutating.
 *
 * The pinned regression: `parseVoiceCommand` accepts designation
 * apply_field commands ("designation Kitchen for circuit 3"), and the
 * local dispatch applied them against `jobRef.current` WITHOUT the
 * draft flush the server voice-response path performs — so a focused
 * manual designation draft survived the voice mutation and the next
 * blur flushed the OLDER draft over the spoken value.
 *
 * The RecordingProvider is not unit-mountable (see
 * transcript-gate-wiring.test.ts / ws7-haptic-call-sites.test.tsx), so
 * this is a source-adjacency assertion on the real
 * `recording-context.tsx`, the project's established pattern for
 * locking wiring inside that provider. The flush BEHAVIOUR itself is
 * covered behaviourally by the JobProvider suite
 * (designation-hygiene-job-provider.test.tsx); this file locks the
 * call-site ordering.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../src/lib/recording-context.tsx'), 'utf8');

describe('local voice-command dispatch — draft-flush ordering', () => {
  it('flushes drafts and adopts the snapshot BEFORE applying a locally parsed command', () => {
    const parseIdx = src.indexOf('parseVoiceCommand(text)');
    expect(parseIdx).toBeGreaterThan(-1);
    const applyIdx = src.indexOf('applyVoiceCommand(command', parseIdx);
    expect(applyIdx).toBeGreaterThan(-1);
    const flushIdx = src.indexOf('flushDraftsAndGetSnapshotRef.current()', parseIdx);
    expect(flushIdx).toBeGreaterThan(parseIdx);
    expect(flushIdx).toBeLessThan(applyIdx);
    // The adopted snapshot must be what the command applies against.
    const adoption = src.slice(flushIdx - 'jobRef.current = '.length, flushIdx);
    expect(adoption).toBe('jobRef.current = ');
  });

  it('records the designation alias for designation-bearing local commands, matching the server path', () => {
    const parseIdx = src.indexOf('parseVoiceCommand(text)');
    const applyIdx = src.indexOf('applyVoiceCommand(command', parseIdx);
    const aliasIdx = src.indexOf('recordDesignationAliasRef.current(command.value)', parseIdx);
    expect(aliasIdx).toBeGreaterThan(parseIdx);
    expect(aliasIdx).toBeLessThan(applyIdx);
  });
});
