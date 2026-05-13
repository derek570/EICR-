/**
 * L2 obs-photo sprint (2026-05-13) — Phase 2.
 *
 * Pins the window constant + `isWithinLinkWindow` helper that the
 * Phase 3 forward-link and the Phase 4 capture handler both depend
 * on. Tiny by design — the bigger merge-into-observations suite
 * lands with Phase 3.
 */

import { describe, expect, it } from 'vitest';
import {
  isWithinLinkWindow,
  OBSERVATION_PHOTO_LINK_WINDOW_MS,
} from '@/lib/recording/observation-photo';

describe('OBSERVATION_PHOTO_LINK_WINDOW_MS', () => {
  it('is 60 seconds (matches iOS DeepgramRecordingViewModel.swift:493)', () => {
    expect(OBSERVATION_PHOTO_LINK_WINDOW_MS).toBe(60_000);
  });
});

describe('isWithinLinkWindow', () => {
  const NOW = 1_700_000_000_000;

  it('returns true for `now`', () => {
    expect(isWithinLinkWindow(NOW, NOW)).toBe(true);
  });

  it('returns true 1 ms before the boundary', () => {
    expect(isWithinLinkWindow(NOW, NOW + OBSERVATION_PHOTO_LINK_WINDOW_MS - 1)).toBe(true);
  });

  it('returns false exactly at the boundary', () => {
    // Closed-open interval — 60 s exactly is treated as expired so a
    // capture at t=0 and an observation at t=60_000 never collide in
    // a race condition where both think they own the slot.
    expect(isWithinLinkWindow(NOW, NOW + OBSERVATION_PHOTO_LINK_WINDOW_MS)).toBe(false);
  });

  it('returns false past the boundary', () => {
    expect(isWithinLinkWindow(NOW, NOW + OBSERVATION_PHOTO_LINK_WINDOW_MS + 1_000)).toBe(false);
  });

  it('returns false for future timestamps (negative delta)', () => {
    // A capture in the "future" relative to now — should never happen
    // in practice but guard anyway so a clock-skew oddity doesn't
    // accidentally pin a photo into perpetual eligibility.
    expect(isWithinLinkWindow(NOW + 5_000, NOW)).toBe(false);
  });

  it('returns false for non-finite inputs', () => {
    expect(isWithinLinkWindow(Number.NaN, NOW)).toBe(false);
    expect(isWithinLinkWindow(NOW, Number.NaN)).toBe(false);
    expect(isWithinLinkWindow(Number.POSITIVE_INFINITY, NOW)).toBe(false);
  });

  it('uses Date.now() as the default reference', () => {
    // The helper without an explicit `now` reads Date.now. A timestamp
    // 1 second ago must still be within the window when no override
    // is passed.
    expect(isWithinLinkWindow(Date.now() - 1_000)).toBe(true);
  });
});
