/**
 * PLAN-E-TERM (Codex cycle-2) — `setAuth` purges the unresolved-audio record
 * on an ACCOUNT SWITCH (a different user over a still-present previous
 * user); a same-user re-authentication keeps its rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuth, setAuth } from '@/lib/auth';
import {
  currentUnresolvedAudioGeneration,
  flushUnresolvedAudioWrites,
} from '@/lib/recording/unresolved-audio-store';
import type { User } from '@/lib/types';

const userA = { id: 'u-A', email: 'a@e.st' } as unknown as User;
const userA2 = { id: 'u-A', email: 'a2@e.st' } as unknown as User;
const userB = { id: 'u-B', email: 'b@e.st' } as unknown as User;

beforeEach(() => localStorage.clear());
afterEach(async () => {
  clearAuth();
  await flushUnresolvedAudioWrites();
});

describe('setAuth account switch', () => {
  it('same user re-authenticating does NOT purge; a different user does', async () => {
    setAuth('t1', userA);
    const g0 = currentUnresolvedAudioGeneration();
    setAuth('t2', userA2);
    expect(currentUnresolvedAudioGeneration()).toBe(g0);
    setAuth('t3', userB);
    expect(currentUnresolvedAudioGeneration()).toBe(g0 + 1);
    await flushUnresolvedAudioWrites();
  });
});
