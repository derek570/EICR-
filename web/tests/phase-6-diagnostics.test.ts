/**
 * Phase 6 — diagnostics collector.
 *
 * Locks two invariants that inspectors depend on when pasting a dump
 * into a support ticket:
 *   1. Sensitive-looking storage keys (token / secret / password / jwt /
 *      authorization / api_key) are replaced with `{redacted: true}`.
 *      Values matching the same pattern are also stripped even when
 *      the KEY looks harmless (e.g. `cm_user` that happens to contain
 *      the JWT verbatim).
 *   2. Top-level snapshot shape has the sections the support triage
 *      flow relies on: `app`, `user`, `service_worker`, `idb`,
 *      `local_storage`, `session_storage`. Adding fields is fine;
 *      renaming / removing is a breaking change for the support
 *      process.
 *
 * We do NOT exercise the IDB path here — `fake-indexeddb/auto` already
 * seeds `indexedDB`, and a minimal stub store would only duplicate the
 * coverage the job-cache tests already provide. Keeping the surface
 * tight so the test runs in < 50ms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectDiagnostics, redactStorage } from '@/lib/diagnostics';

describe('Phase 6 · diagnostics redaction', () => {
  it('redacts sensitive keys and leaves benign keys intact', () => {
    const fake = new Map<string, string>([
      ['cm_token', 'eyJhbGciOi-real-jwt-string'],
      ['cm_user', 'Derek'],
      ['cm-debug', '1'],
      ['JWT_SECRET', 'server-secret'],
      ['api-key-cached', 'should-also-redact'],
      ['theme', 'dark'],
      ['circuits-view', 'cards'],
    ]);
    const shim = {
      get length() {
        return fake.size;
      },
      clear() {
        fake.clear();
      },
      getItem(k: string) {
        return fake.get(k) ?? null;
      },
      key(i: number) {
        return Array.from(fake.keys())[i] ?? null;
      },
      removeItem(k: string) {
        fake.delete(k);
      },
      setItem(k: string, v: string) {
        fake.set(k, v);
      },
    } as Storage;

    const out = redactStorage(shim);
    // Sensitive keys are replaced with a redaction marker; length is
    // preserved so support can at least check the value wasn't empty.
    expect(out['cm_token']).toEqual({
      redacted: true,
      length: 'eyJhbGciOi-real-jwt-string'.length,
    });
    expect(out['JWT_SECRET']).toMatchObject({ redacted: true });
    expect(out['api-key-cached']).toMatchObject({ redacted: true });
    // Benign keys flow through verbatim.
    expect(out['cm-debug']).toBe('1');
    expect(out['theme']).toBe('dark');
    expect(out['circuits-view']).toBe('cards');
    // Non-sensitive key, non-sensitive value — untouched.
    expect(out['cm_user']).toBe('Derek');
  });

  it('redacts when the VALUE looks sensitive even if the key does not', () => {
    const fake = new Map<string, string>([['cm_user', '{"Authorization":"Bearer abc"}']]);
    const shim = {
      get length() {
        return fake.size;
      },
      clear() {
        fake.clear();
      },
      getItem(k: string) {
        return fake.get(k) ?? null;
      },
      key(i: number) {
        return Array.from(fake.keys())[i] ?? null;
      },
      removeItem(k: string) {
        fake.delete(k);
      },
      setItem(k: string, v: string) {
        fake.set(k, v);
      },
    } as Storage;

    const out = redactStorage(shim);
    expect(out['cm_user']).toMatchObject({ redacted: true });
  });

  it('returns an empty map when storage is null (SSR fallback)', () => {
    expect(redactStorage(null)).toEqual({});
  });
});

describe('Phase 6 · diagnostics snapshot shape', () => {
  beforeEach(() => {
    // Seed localStorage + mock navigator / SW so the collector has
    // something real to walk.
    localStorage.clear();
    localStorage.setItem('cm_user', JSON.stringify({ id: 'u1', email: 'a@b.co' }));
    localStorage.setItem('cm_token', 'SECRET-TOKEN-XYZ');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('produces a snapshot with the sections support needs', async () => {
    const snap = await collectDiagnostics();
    expect(snap).toHaveProperty('generated_at');
    expect(snap).toHaveProperty('app');
    expect(snap).toHaveProperty('user');
    expect(snap).toHaveProperty('service_worker');
    expect(snap).toHaveProperty('local_storage');
    expect(snap).toHaveProperty('session_storage');
    expect(snap).toHaveProperty('idb');

    // Token-key was redacted — we never ship bearer tokens in a dump.
    expect(snap.local_storage['cm_token']).toMatchObject({ redacted: true });
    // User was pulled from the stored cm_user blob via getUser().
    expect(snap.user?.id).toBe('u1');

    // Generated_at is a valid ISO timestamp.
    expect(() => new Date(snap.generated_at).toISOString()).not.toThrow();
  });
});
