import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getUserRole, getCompanyRole } from '@/lib/auth';
import type { User } from '@/lib/types';

/**
 * Wave 4 D4 — client-side role getters.
 *
 * These are UX-only helpers (render/hide admin chrome); write
 * authorisation goes through the middleware + server. These tests
 * lock in the "return one of the enum values or null" contract so a
 * future expansion to the role model doesn't silently leak an unknown
 * string into downstream comparisons.
 */

const LOCAL_STORAGE_KEY = 'cm_user';

describe('auth — getUserRole / getCompanyRole', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('returns the explicit user arg when passed in', () => {
    const u: User = {
      id: '1',
      email: 'a@b.c',
      name: 'A',
      role: 'admin',
      company_role: 'owner',
    };
    expect(getUserRole(u)).toBe('admin');
    expect(getCompanyRole(u)).toBe('owner');
  });

  it('falls back to localStorage when no argument is supplied', () => {
    const stored: User = {
      id: '1',
      email: 'a@b.c',
      name: 'A',
      role: 'user',
      company_role: 'employee',
    };
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stored));
    expect(getUserRole()).toBe('user');
    expect(getCompanyRole()).toBe('employee');
  });

  it('returns null when there is no user (signed-out)', () => {
    expect(getUserRole()).toBeNull();
    expect(getCompanyRole()).toBeNull();
  });

  it('returns null for an unknown role enum value (no string leakage)', () => {
    const weird = {
      id: '1',
      email: 'a@b.c',
      name: 'A',
      role: 'superuser',
      company_role: 'deity',
    } as unknown as User;
    expect(getUserRole(weird)).toBeNull();
    expect(getCompanyRole(weird)).toBeNull();
  });

  it('distinguishes null (user missing a role claim) from a bogus claim', () => {
    const noRoles: User = {
      id: '1',
      email: 'a@b.c',
      name: 'A',
    };
    expect(getUserRole(noRoles)).toBeNull();
    expect(getCompanyRole(noRoles)).toBeNull();
  });
});

describe('auth — clearAuth purges designation-draft state (cycle-6/9)', () => {
  it('sign-out sweeps a stranded draft record so the next login cannot inherit it', async () => {
    const { clearAuth } = await import('@/lib/auth');
    // Nothing writes these any more — the localStorage journal was
    // removed in cycle 9 — but a device that ran a pre-removal build of
    // this branch may still hold records, and sign-out is exactly where
    // another inspector's abandoned text must not survive.
    window.localStorage.setItem(
      'cm-designation-draft:job-1:designation:c1',
      'Previous inspector draft'
    );
    clearAuth();
    expect(window.localStorage.getItem('cm-designation-draft:job-1:designation:c1')).toBeNull();
  });

  it('sign-out also clears the in-memory load-repair alias ledger', async () => {
    const { clearAuth } = await import('@/lib/auth');
    const { repairJobCircuitDesignations, getLoadRepairAliases } =
      await import('@/lib/repair-job-designations');
    // A recording session seeds its alias store from this ledger, so a
    // designation from the previous inspector's job must not survive the
    // sign-out that wipes the IDB cache it came from.
    repairJobCircuitDesignations({
      circuits: [{ circuit_designation: 'Upstairs lighting circuit' }],
    } as never);
    expect(getLoadRepairAliases().length).toBeGreaterThan(0);
    clearAuth();
    expect(getLoadRepairAliases()).toHaveLength(0);
  });
});
