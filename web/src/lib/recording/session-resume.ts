'use client';

/**
 * Cross-reload session-resume persistence.
 *
 * Mirrors the iOS app-process state survival contract: iOS keeps the
 * recording state in `DeepgramRecordingViewModel` which is held by the
 * `NavigationStack`. View-controller-level transitions don't tear down
 * the recording. The PWA's analogue is the React `RecordingProvider`
 * which is mounted once at the AppShell layout — but iPad Safari can
 * (and does, per sess_mp9qnay1_h1ik 2026-05-17 12:16 UTC) reap the
 * entire WebContent process during ElevenLabs audio playback,
 * destroying the React tree and the in-memory recording state along
 * with it. The browser then autonomously reloads the tab, giving us a
 * fresh React tree with no awareness that recording was in progress.
 *
 * This module persists a small recording-state snapshot to
 * `sessionStorage` on every state change, so the fresh-mount provider
 * can detect "you were recording before this reload" and surface a
 * resume affordance.
 *
 * **Why `sessionStorage` and not `localStorage`:** sessionStorage
 * survives reloads but is bounded to the current tab session. A user
 * who closes the tab and re-opens it (separate intent) shouldn't be
 * prompted to resume — only a same-tab reload (WebContent process
 * reap, manual refresh, etc.) should. localStorage would persist
 * across browser sessions which is wrong scope.
 *
 * **Why a 5-minute window:** matches the backend's Sonnet-session TTL
 * at `sonnet-stream.js:1912-1918`. After 5 minutes the backend has
 * dropped the multi-turn conversation context anyway, so resuming
 * with the same `sessionId` buys nothing — the resume would land on a
 * fresh-session ack and the inspector loses no more by starting a
 * brand-new session.
 */

const STORAGE_KEY = 'cm-recording-resume-state';

/** Resume window matches the backend Sonnet-session TTL (5 min). */
export const RECORDING_RESUME_TTL_MS = 5 * 60 * 1000;

export interface PersistedRecordingState {
  /** Client-minted session id, e.g. `sess_xxx_yyy`. */
  clientSessionId: string;
  /** Server-minted session id from the most recent `session_ack`. Used
   *  as the rehydrate target on a fresh SonnetSession.connect — when
   *  passed back, the server's `session_resume` path rehydrates the
   *  Anthropic prompt cache. Null until the first session_ack lands. */
  serverSessionId: string | null;
  jobId: string;
  certificateType: 'EICR' | 'EIC';
  /** State at the moment of last persist. We resume only when this was
   *  `'active'` or `'sleeping'` — never `'paused'` (the inspector
   *  deliberately stopped) or `'error'` (a non-recoverable terminal
   *  state). */
  status: 'active' | 'sleeping';
  /** Date.now() at session start — used to enforce the TTL. */
  startedAt: number;
  /** Date.now() at the latest persist — used to decide whether the
   *  cached snapshot is fresh enough to act on (a snapshot from 6
   *  minutes ago is stale even if startedAt was within TTL). */
  lastUpdatedAt: number;
}

/** Best-effort guard against SSR (no window/sessionStorage). */
function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Write the current recording state to sessionStorage. Idempotent —
 * safe to call on every state change. Failures (private-mode,
 * quota-exceeded) are swallowed: persistence is best-effort and
 * losing it just means the next-reload toast won't fire.
 */
export function persistRecordingState(state: PersistedRecordingState): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* swallow — quota / disabled storage */
  }
}

/**
 * Clear the persisted state. Called on explicit `stop()` so a clean
 * teardown doesn't trigger a spurious resume toast on the next mount.
 */
export function clearRecordingState(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* swallow */
  }
}

/**
 * Read + validate the persisted state. Returns null when:
 *   - no storage (SSR / private mode)
 *   - no entry
 *   - entry is malformed JSON
 *   - entry is older than RECORDING_RESUME_TTL_MS
 *   - status is anything other than 'active' / 'sleeping' (a paused
 *     or errored session was intentionally not-recording at the
 *     moment of teardown; resuming makes no sense)
 *
 * On any validation failure, the entry is also REMOVED — a single
 * read clears the slot so the toast can't keep firing if the user
 * dismisses it.
 */
export function loadAndConsumeRecordingState(now = Date.now()): PersistedRecordingState | null {
  const storage = getStorage();
  if (!storage) return null;
  const raw = (() => {
    try {
      return storage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  })();
  if (!raw) return null;
  // Always clear after read — the toast fires once.
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* swallow */
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Partial<PersistedRecordingState>;
  if (
    typeof candidate.clientSessionId !== 'string' ||
    typeof candidate.jobId !== 'string' ||
    (candidate.certificateType !== 'EICR' && candidate.certificateType !== 'EIC') ||
    (candidate.status !== 'active' && candidate.status !== 'sleeping') ||
    typeof candidate.startedAt !== 'number' ||
    typeof candidate.lastUpdatedAt !== 'number'
  ) {
    return null;
  }
  const serverSessionId =
    typeof candidate.serverSessionId === 'string' ? candidate.serverSessionId : null;
  // TTL — measured from lastUpdatedAt because startedAt could be much
  // older for a long session that just got reaped.
  if (now - candidate.lastUpdatedAt > RECORDING_RESUME_TTL_MS) {
    return null;
  }
  return {
    clientSessionId: candidate.clientSessionId,
    serverSessionId,
    jobId: candidate.jobId,
    certificateType: candidate.certificateType,
    status: candidate.status,
    startedAt: candidate.startedAt,
    lastUpdatedAt: candidate.lastUpdatedAt,
  };
}

/**
 * Peek at the persisted state WITHOUT clearing it. For diagnostic
 * paths that want to know "was something persisted" without
 * consuming the entry.
 */
export function peekRecordingState(): PersistedRecordingState | null {
  const storage = getStorage();
  if (!storage) return null;
  const raw = (() => {
    try {
      return storage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  })();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.clientSessionId === 'string') {
      return parsed as PersistedRecordingState;
    }
  } catch {
    /* swallow */
  }
  return null;
}
