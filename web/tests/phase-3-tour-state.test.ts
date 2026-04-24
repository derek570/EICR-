/**
 * Phase 3 — tour state (IDB-backed).
 *
 * Asserts the state transitions that drive auto-start vs. manual-start
 * of the guided tour:
 *   1. Defaults on a fresh DB: `{ seen: false, disabled: false }`.
 *   2. `writeTourState` round-trips through `readTourState`.
 *   3. `updateTourState` merges with the persisted state.
 *   4. `resetTourState` returns to defaults (for settings "Start tour").
 *
 * The tour-state module piggybacks on the job-cache DB (`certmate-cache`)
 * and creates an `app-settings` store via `onupgradeneeded`. We rely on
 * `fake-indexeddb/auto` from the shared `tests/setup.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('tour state (IDB)', () => {
  beforeEach(async () => {
    // Wipe the shared DB via the public API so we start from a clean
    // slate for every test.
    const { clearJobCache } = await import('@/lib/pwa/job-cache');
    await clearJobCache();
  });

  afterEach(async () => {
    const { clearJobCache } = await import('@/lib/pwa/job-cache');
    await clearJobCache();
  });

  it('readTourState returns defaults when nothing is persisted', async () => {
    const { readTourState } = await import('@/lib/tour/state');
    const state = await readTourState();
    expect(state).toEqual({ seen: false, disabled: false });
  });

  it('writeTourState persists and readTourState returns the same value', async () => {
    const { readTourState, writeTourState } = await import('@/lib/tour/state');
    await writeTourState({ seen: true, disabled: false });
    const after = await readTourState();
    expect(after).toEqual({ seen: true, disabled: false });
  });

  it('updateTourState shallow-merges with the persisted state', async () => {
    const { readTourState, updateTourState, writeTourState } = await import('@/lib/tour/state');
    await writeTourState({ seen: true, disabled: false });
    const merged = await updateTourState({ disabled: true });
    expect(merged).toEqual({ seen: true, disabled: true });
    const read = await readTourState();
    expect(read).toEqual({ seen: true, disabled: true });
  });

  it('resetTourState restores fresh-install defaults', async () => {
    const { readTourState, resetTourState, writeTourState } = await import('@/lib/tour/state');
    await writeTourState({ seen: true, disabled: true });
    await resetTourState();
    const after = await readTourState();
    expect(after).toEqual({ seen: false, disabled: false });
  });

  it('subscribeTourChanges fires after a write', async () => {
    const { subscribeTourChanges, writeTourState } = await import('@/lib/tour/state');
    let hits = 0;
    const unsub = subscribeTourChanges(() => {
      hits += 1;
    });
    await writeTourState({ seen: true, disabled: false });
    // Two more writes should fire two more notifications.
    await writeTourState({ seen: true, disabled: true });
    await writeTourState({ seen: false, disabled: false });
    unsub();
    // Each write is a notification — we expect exactly 3.
    expect(hits).toBe(3);
  });
});
