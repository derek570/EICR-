/**
 * Guided-tour persistent state (Phase 3).
 *
 * Mirrors the iOS tour state machine (`CertMateApp.swift`
 * `@AppStorage("appTourEnabled")` + `TourManager.hasStartedThisSession`)
 * but scoped to a single IDB record so the state survives hard reloads,
 * PWA re-installs, and the browser closing while preserving the site
 * data partition.
 *
 * Why IDB (not localStorage):
 *   - We already have the `certmate-cache` IDB open for the job-cache +
 *     outbox, so there's no new DB/quota cost.
 *   - `clearJobCache()` (called on sign-out) wipes the tour flag too,
 *     which is desirable on shared devices — a new inspector should see
 *     the tour on their first login, not inherit the previous inspector's
 *     "seen" flag.
 *   - localStorage on PWA iOS Safari is aggressively purged when the
 *     device is under storage pressure; IDB is the durable partition.
 *
 * State shape:
 *   - `seen`  — the tour has been auto-started at least once. Determines
 *               whether the tour auto-starts on next mount. Flipped on
 *               first auto-start (NOT on manual re-runs).
 *   - `disabled` — user explicitly turned the tour off via the dashboard
 *                  tile. Prevents auto-start AND manual re-run attempts
 *                  from firing. Users re-enable by tapping "Start tour"
 *                  from /settings, which also flips `disabled` → false.
 *
 * The schema slot `kind: 'tour-state'` is a sentinel so we can add
 * sibling settings rows later without bumping the DB version.
 */

import { openDB, isSupported, wrapRequest, wrapTransaction } from '@/lib/pwa/job-cache';

const STORE_SETTINGS = 'app-settings';
const KEY_TOUR_STATE = 'tour-state';

export interface TourState {
  seen: boolean;
  disabled: boolean;
}

const DEFAULT_STATE: TourState = {
  seen: false,
  disabled: false,
};

/**
 * Resolve the shared DB handle. The `app-settings` store is created
 * by the job-cache v3 upgrade, so `openDB()` returning is sufficient —
 * no sneak-upgrade that would invalidate the module-level dbPromise
 * used by job-cache / outbox for the rest of the tab.
 */
async function ensureSettingsStore(): Promise<IDBDatabase | null> {
  if (!isSupported()) return null;
  try {
    return await openDB();
  } catch (err) {
    console.warn('[tour-state] openDB failed', err);
    return null;
  }
}

interface SettingsRow {
  key: string;
  value: unknown;
}

export async function readTourState(): Promise<TourState> {
  const db = await ensureSettingsStore();
  if (!db) return DEFAULT_STATE;
  try {
    const tx = db.transaction(STORE_SETTINGS, 'readonly');
    const store = tx.objectStore(STORE_SETTINGS);
    const row = (await wrapRequest(store.get(KEY_TOUR_STATE))) as SettingsRow | null;
    if (!row || typeof row.value !== 'object' || row.value === null) return DEFAULT_STATE;
    const v = row.value as Partial<TourState>;
    return {
      seen: typeof v.seen === 'boolean' ? v.seen : DEFAULT_STATE.seen,
      disabled: typeof v.disabled === 'boolean' ? v.disabled : DEFAULT_STATE.disabled,
    };
  } catch (err) {
    console.warn('[tour-state] readTourState failed', err);
    return DEFAULT_STATE;
  }
}

export async function writeTourState(next: TourState): Promise<void> {
  const db = await ensureSettingsStore();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_SETTINGS, 'readwrite');
    const store = tx.objectStore(STORE_SETTINGS);
    const row: SettingsRow = { key: KEY_TOUR_STATE, value: next };
    store.put(row);
    await wrapTransaction(tx);
    broadcastTourChange();
  } catch (err) {
    console.warn('[tour-state] writeTourState failed', err);
  }
}

export async function updateTourState(patch: Partial<TourState>): Promise<TourState> {
  const current = await readTourState();
  const next = { ...current, ...patch };
  await writeTourState(next);
  return next;
}

/**
 * Reset the tour to its first-run defaults so the next mount auto-starts.
 * Distinct from `updateTourState({ seen: false })` because we also want
 * to clear `disabled` — a user manually re-enabling the tour should not
 * inherit a previously-disabled flag.
 */
export async function resetTourState(): Promise<void> {
  await writeTourState(DEFAULT_STATE);
}

// ----------------------------------------------------------------
// Cross-tab + same-tab notifier
//
// Small BroadcastChannel + in-memory fan-out so useTour() in another
// component (e.g. dashboard + overlay) can re-read when settings
// flips the flag. Mirrors the pattern established by the outbox
// subscriber in `use-outbox-state.ts`.
// ----------------------------------------------------------------

const CHANNEL_NAME = 'certmate-tour';
let channel: BroadcastChannel | null = null;
const localListeners = new Set<() => void>();

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (channel) return channel;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = () => {
    for (const fn of localListeners) fn();
  };
  return channel;
}

function broadcastTourChange(): void {
  for (const fn of localListeners) fn();
  try {
    getChannel()?.postMessage({ type: 'tour-state-changed' });
  } catch {
    // BroadcastChannel can fail in iframes / private mode; not fatal.
  }
}

export function subscribeTourChanges(listener: () => void): () => void {
  localListeners.add(listener);
  // Ensure channel is live so cross-tab messages reach us.
  getChannel();
  return () => {
    localListeners.delete(listener);
  };
}
