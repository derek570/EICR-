/**
 * Diagnostics collector (Phase 6).
 *
 * Gathers a consolidated JSON snapshot of the PWA's runtime state for
 * support / bug-report workflows. Mirrors iOS
 * `DebugDashboardView.swift` "Export Diagnostics" + the bespoke
 * state-dump inspectors occasionally request when a job won't sync.
 *
 * Includes (and explicitly does NOT include):
 *   ✓ Signed-in user (id, email, name, role — from getUser()).
 *   ✓ IDB contents across every store in `certmate-cache`.
 *   ✓ Service worker registration list (scope + active state).
 *   ✓ App version (NEXT_PUBLIC_APP_VERSION when set, otherwise
 *     `package.json` version bundled into the build as a fallback).
 *   ✓ localStorage keys + values — stripped of anything that smells
 *     like a secret (see SENSITIVE_PATTERN below).
 *   ✓ User agent + language + platform (navigator-only).
 *
 *   ✗ Auth tokens / bearer JWTs — blacklisted through
 *     SENSITIVE_PATTERN.
 *   ✗ Signature / logo / photo blobs — the IDB dump filters large
 *     `ArrayBuffer`/`Blob` values to `{ kind: 'blob', size }` so we
 *     don't balloon the report with binary that Derek can't inspect
 *     anyway.
 *
 * Implementation notes:
 *   - Pure "collect" is async because IDB is async; wrapped in a
 *     single top-level function so the settings page can await it in
 *     a click handler.
 *   - Return shape is stable JSON; the caller serialises with
 *     `JSON.stringify(result, null, 2)` and hands it to
 *     `downloadBlob`.
 */

import { DB_NAME, isSupported, openDB } from '@/lib/pwa/job-cache';
import { getUser } from '@/lib/auth';

/**
 * Keys / values matching this regex are redacted in the dump. The
 * test (`phase-6-diagnostics.test.ts`) locks this list so a future
 * refactor can't accidentally exfiltrate a token by renaming the
 * storage key.
 */
const SENSITIVE_PATTERN = /token|secret|password|jwt|authorization|api.?key/i;

export interface DiagnosticsUser {
  id: string;
  email: string;
  name?: string;
  role?: string;
  company_id?: string;
  company_role?: string;
}

export interface DiagnosticsSnapshot {
  generated_at: string;
  app: {
    version: string;
    user_agent: string;
    platform: string;
    language: string;
    online: boolean;
  };
  user: DiagnosticsUser | null;
  service_worker: {
    supported: boolean;
    registrations: Array<{ scope: string; active_state: string | null }>;
  };
  local_storage: Record<string, string | { redacted: true; length: number }>;
  session_storage: Record<string, string | { redacted: true; length: number }>;
  idb: {
    supported: boolean;
    db_name: string;
    stores: Record<string, unknown[]>;
    error?: string;
  };
}

/** App version — build-time env wins so we can override per-channel. */
function resolveVersion(): string {
  const env = process.env.NEXT_PUBLIC_APP_VERSION;
  if (env && env.length > 0) return env;
  return '0.1.0';
}

export function redactStorage(
  store: Storage | null
): Record<string, string | { redacted: true; length: number }> {
  if (!store) return {};
  const out: Record<string, string | { redacted: true; length: number }> = {};
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key == null) continue;
    const value = store.getItem(key) ?? '';
    if (SENSITIVE_PATTERN.test(key) || SENSITIVE_PATTERN.test(value)) {
      out[key] = { redacted: true, length: value.length };
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function collectIDB(): Promise<DiagnosticsSnapshot['idb']> {
  if (!isSupported()) {
    return { supported: false, db_name: DB_NAME, stores: {} };
  }
  try {
    const db = await openDB();
    const storeNames = Array.from(db.objectStoreNames);
    const stores: Record<string, unknown[]> = {};
    for (const name of storeNames) {
      const tx = db.transaction(name, 'readonly');
      const store = tx.objectStore(name);
      const rows: unknown[] = await new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve((req.result ?? []) as unknown[]);
        req.onerror = () => resolve([]);
      });
      // Normalise binary payloads so the JSON isn't bloated by
      // inline ArrayBuffers. IDB can hold Blobs too via keyPath objects.
      stores[name] = rows.map((row) => normaliseIDBRow(row));
    }
    return { supported: true, db_name: DB_NAME, stores };
  } catch (err) {
    return {
      supported: true,
      db_name: DB_NAME,
      stores: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function normaliseIDBRow(row: unknown): unknown {
  if (row == null) return row;
  if (row instanceof Blob) {
    return { kind: 'blob', size: row.size, type: row.type };
  }
  if (typeof ArrayBuffer !== 'undefined' && row instanceof ArrayBuffer) {
    return { kind: 'arraybuffer', byteLength: row.byteLength };
  }
  if (Array.isArray(row)) {
    return row.map(normaliseIDBRow);
  }
  if (typeof row === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      if (SENSITIVE_PATTERN.test(key)) {
        out[key] = { redacted: true };
      } else {
        out[key] = normaliseIDBRow(value);
      }
    }
    return out;
  }
  return row;
}

async function collectServiceWorker(): Promise<DiagnosticsSnapshot['service_worker']> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return { supported: false, registrations: [] };
  }
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    return {
      supported: true,
      registrations: regs.map((r) => ({
        scope: r.scope,
        active_state: r.active?.state ?? null,
      })),
    };
  } catch {
    return { supported: true, registrations: [] };
  }
}

/**
 * Top-level collector. Safe to call in the browser only.
 */
export async function collectDiagnostics(): Promise<DiagnosticsSnapshot> {
  const user = getUser();
  const diagnosticsUser: DiagnosticsUser | null = user
    ? {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        company_id: user.company_id,
        company_role: user.company_role,
      }
    : null;

  const idb = await collectIDB();
  const sw = await collectServiceWorker();

  const safeLocal = typeof localStorage !== 'undefined' ? redactStorage(localStorage) : {};
  const safeSession = typeof sessionStorage !== 'undefined' ? redactStorage(sessionStorage) : {};

  return {
    generated_at: new Date().toISOString(),
    app: {
      version: resolveVersion(),
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      platform: typeof navigator !== 'undefined' ? navigator.platform : '',
      language: typeof navigator !== 'undefined' ? navigator.language : '',
      online: typeof navigator !== 'undefined' ? navigator.onLine : false,
    },
    user: diagnosticsUser,
    service_worker: sw,
    local_storage: safeLocal,
    session_storage: safeSession,
    idb,
  };
}
