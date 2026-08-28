/**
 * PLAN-E-TERM — the CLIENT-WIDE active recording-session set.
 *
 * The unresolved-audio visibility predicate and the certificate clear both
 * key on "is this row's recording session still active on THIS client".
 * Rows are shared across tabs (IDB + BroadcastChannel), so a second tab
 * must not treat the first tab's live session as inactive — it would
 * surface a still-recovering row early, or `certificate_cleared` it while
 * loss is still accruing (Codex E-TERM cycle-1).
 *
 * Mechanism: the recording tab announces its session id on a heartbeat
 * while `isStillActive()` holds (the provider's session ref — cleared by
 * the frozen `stop()` — so no stop edit is needed), posts an explicit
 * `ended` when it stops, and every tab keeps a lease table that expires
 * on its own so a crashed tab's session drops out after `LEASE_MS`.
 */

const CHANNEL_NAME = 'cm-active-recording-sessions';
export const ACTIVE_SESSION_HEARTBEAT_MS = 3000;
/** Long enough to survive background-tab timer throttling (≈1 tick/min),
 *  short enough that a crashed tab's session drops out within ~1.5 min. */
export const ACTIVE_SESSION_LEASE_MS = 75_000;

type Message =
  | { readonly kind: 'alive'; readonly sessionId: string }
  | { readonly kind: 'ended'; readonly sessionId: string }
  /** A tab that just opened asks live recorders to re-announce NOW, so a
   *  late subscriber never waits a heartbeat for its first lease. */
  | { readonly kind: 'query' };

const remoteLeases = new Map<string, number>();
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
let localSessionId: string | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<Message>) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.kind === 'query') {
        if (localSessionId && localIsStillActive?.())
          post({ kind: 'alive', sessionId: localSessionId });
        return;
      }
      if (typeof msg.sessionId !== 'string') return;
      if (msg.kind === 'alive') remoteLeases.set(msg.sessionId, Date.now());
      else remoteLeases.delete(msg.sessionId);
      for (const fn of listeners) fn();
    };
    // Ask already-open recorders to announce themselves immediately.
    try {
      channel.postMessage({ kind: 'query' } satisfies Message);
    } catch {
      /* non-critical */
    }
  }
  return channel;
}

let localIsStillActive: (() => boolean) | null = null;

function post(msg: Message): void {
  try {
    getChannel()?.postMessage(msg);
  } catch {
    /* non-critical */
  }
}

/** Subscribe to remote lease changes (banner refresh). */
export function subscribeActiveSessionChanges(fn: () => void): () => void {
  listeners.add(fn);
  getChannel();
  return () => listeners.delete(fn);
}

/**
 * Announce `sessionId` as active while `isStillActive()` holds. The
 * heartbeat stops itself the first time the predicate is false (the
 * session ref rotated or cleared) and posts `ended`.
 */
export function announceActiveSession(sessionId: string, isStillActive: () => boolean): () => void {
  localSessionId = sessionId;
  localIsStillActive = isStillActive;
  post({ kind: 'alive', sessionId });
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    if (timer !== null) clearInterval(timer);
    if (localSessionId === sessionId) {
      localSessionId = null;
      localIsStillActive = null;
    }
    post({ kind: 'ended', sessionId });
  };
  const timer: ReturnType<typeof setInterval> | null =
    typeof setInterval === 'undefined'
      ? null
      : setInterval(() => {
          if (!isStillActive()) {
            end();
            return;
          }
          post({ kind: 'alive', sessionId });
        }, ACTIVE_SESSION_HEARTBEAT_MS);
  return end;
}

/**
 * The full active set: the caller's own live session (if any) plus every
 * remote session whose lease is fresh. `now` is injectable for tests.
 */
export function getActiveSessionIds(
  localActive: string | null,
  now: number = Date.now()
): Set<string> {
  const out = new Set<string>();
  if (localActive) out.add(localActive);
  for (const [id, seenAt] of remoteLeases) {
    if (now - seenAt <= ACTIVE_SESSION_LEASE_MS) out.add(id);
    else remoteLeases.delete(id);
  }
  return out;
}

/** Test seam: feed a remote lease without a real BroadcastChannel. */
export function __noteRemoteSessionForTests(sessionId: string, seenAt: number): void {
  remoteLeases.set(sessionId, seenAt);
}

export function __resetActiveSessionRegistryForTests(): void {
  remoteLeases.clear();
  localSessionId = null;
  localIsStillActive = null;
}
