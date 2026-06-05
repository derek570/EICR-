'use client';

/**
 * Lifecycle event log — survives across page reloads via localStorage so
 * we can diagnose "the page kept refreshing itself, killing the
 * recording" complaints from the field. iOS Safari (and PWAs in
 * standalone mode) don't expose a console without a Mac, so a
 * server-roundtrip-free in-app log is the only way to see the
 * page-suspend / SW-reload / error-boundary-reload timeline an inspector
 * just experienced.
 *
 * Storage shape: localStorage['cm:lifecycle-log'] is a JSON array of
 * { ts: epoch_ms, event: string, [payload...] } entries. Capped at 100
 * to keep the diagnostics export readable; a recording session
 * typically produces 5–10 events. localStorage was chosen over
 * sessionStorage because sessionStorage clears on a hard reload — and
 * an unexplained reload is exactly the case we need to capture.
 *
 * The existing diagnostics collector at `lib/diagnostics.ts` already
 * dumps localStorage verbatim, so this log is automatically included in
 * any "Export Diagnostics" the inspector sends to support — no separate
 * plumbing required.
 *
 * SAFETY: never store PII here. Events should describe lifecycle
 * transitions ("recording-start", "error-boundary"), not user data.
 */

const STORAGE_KEY = 'cm:lifecycle-log';
const MAX_ENTRIES = 100;

export interface LifecycleEvent {
  ts: number;
  event: string;
  [k: string]: unknown;
}

function read(): LifecycleEvent[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LifecycleEvent[]) : [];
  } catch {
    return [];
  }
}

function write(entries: LifecycleEvent[]): void {
  if (typeof window === 'undefined') return;
  try {
    // Keep only the most recent N entries — the buffer is a ring; older
    // events are dropped silently. The export is what gets sent to
    // support, and 100 entries covers ~30 minutes of typical activity.
    const trimmed = entries.slice(-MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota exceeded / private mode — silently swallow. A blank log is
    // a safer fallback than a thrown exception during recording.
  }
}

/**
 * Append a lifecycle event. Best-effort, never throws — used in hot
 * paths (error boundaries, reload handlers) where a failure to log
 * must NOT block the work the caller is doing.
 */
export function record(event: string, payload?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  try {
    const entries = read();
    entries.push({ ts: Date.now(), event, ...(payload ?? {}) });
    write(entries);
    // Mirror to console for anyone with devtools open. Tagged so it's
    // grep-able alongside the persisted log.
    console.warn(`[cm:lifecycle] ${event}`, payload ?? {});
  } catch {
    // ignore — diagnostic logging must never crash the app
  }
}

/**
 * Read the full event log for display in the diagnostics page. Returns
 * a copy so callers can sort/filter without mutating the store.
 */
export function getLog(): LifecycleEvent[] {
  return read().slice();
}

/**
 * Clear the lifecycle log. Used by the diagnostics "Clear log" button —
 * the export-then-clear flow is how inspectors hand off a clean slate
 * after sending support a snapshot.
 */
export function clearLog(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
