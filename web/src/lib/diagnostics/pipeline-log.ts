'use client';

/**
 * Recording pipeline log — fine-grained tracing of every stage of the
 * voice → transcript → Sonnet → apply-extraction flow.
 *
 * Sinks (fanout, best-effort, never throws):
 *   1. In-memory ring buffer (RING_SIZE) — surfaced on
 *      /settings/diagnostics for the user to skim live and shipped in
 *      the JSON export collectDiagnostics() produces.
 *   2. localStorage tail ring (LS_TAIL_SIZE) — last N entries persist
 *      across reloads. The recording WebSocket dying at the same moment
 *      as a hard reload is exactly the case the live ring can't help
 *      with; the localStorage tail does.
 *   3. console.info with a `[pipeline:<stage>]` prefix so devtools-open
 *      users see the trail without parsing JSON.
 *   4. clientDiagnostic() — forwards each event to the backend as a
 *      `client_diagnostic` WS frame, landing in CloudWatch as the
 *      existing `Client diagnostic` log row. The `category` field is
 *      always prefixed `pipeline.` so the CloudWatch query
 *      `filter @message like /pipeline\./` cleanly isolates the trail.
 *
 * PII discipline: callers MUST redact free-text fields before passing
 * them as payload (length + 40-char preview, mirroring the existing
 * `textPreview` convention in client-diagnostic.ts callers). The ring
 * is exported by the diagnostics page and pasted into support tickets;
 * raw transcripts / value strings are off-limits.
 *
 * Why a ring and not a stream: the recording pipeline can fire
 * hundreds of events per minute; unbounded growth would blow
 * localStorage quota and bloat the JSON export. 500 entries covers
 * ~60-90 seconds of dense activity, which is plenty for diagnosing the
 * "WS died ~300ms after the second utterance" class of bug we're
 * chasing.
 */

import { clientDiagnostic } from '@/lib/recording/client-diagnostic';

const RING_SIZE = 500;
const LS_TAIL_SIZE = 100;
const LS_KEY = 'cm:pipeline-log-tail';

export interface PipelineEvent {
  /** Monotonic counter — increments per push regardless of clock skew. */
  seq: number;
  /** Epoch ms when the event was recorded. */
  ts: number;
  /** Stage tag, always prefixed `pipeline.` on the wire. */
  stage: string;
  /** Free-form payload. Caller is responsible for redacting PII. */
  payload?: Record<string, unknown>;
}

type Subscriber = () => void;

let seqCounter = 0;
const ring: PipelineEvent[] = [];
const subscribers = new Set<Subscriber>();
// Re-entrancy guard. The clientDiagnostic forward eventually calls the
// SonnetSession's sendClientDiagnostic → sendRaw, and sendRaw also
// pipelineLogs its sends. sendRaw filters out the `client_diagnostic`
// type already, but a second line of defence stops any unforeseen
// re-entry path from looping the call stack.
let inFlight = false;

function loadTailFromStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const e of parsed) {
      if (
        e &&
        typeof e.seq === 'number' &&
        typeof e.ts === 'number' &&
        typeof e.stage === 'string'
      ) {
        ring.push(e as PipelineEvent);
        if (e.seq >= seqCounter) seqCounter = e.seq + 1;
      }
    }
  } catch {
    // ignore
  }
}

// Hydrate on first import in the browser. SSR no-ops.
loadTailFromStorage();

function persistTail(): void {
  if (typeof window === 'undefined') return;
  try {
    const tail = ring.slice(-LS_TAIL_SIZE);
    window.localStorage.setItem(LS_KEY, JSON.stringify(tail));
  } catch {
    // Quota or private mode — silently drop the persistence. The
    // in-memory ring still serves the live diagnostics panel.
  }
}

function notify(): void {
  for (const sub of subscribers) {
    try {
      sub();
    } catch {
      // never let a subscriber crash the producer
    }
  }
}

/**
 * Push one pipeline event. Fans out to ring + localStorage tail +
 * console + clientDiagnostic. Best-effort, never throws.
 *
 * @param stage Short kebab-style tag. Will be prefixed `pipeline.`
 *              on the CloudWatch wire (so backend filters can match
 *              `pipeline.*` cleanly). Local sinks keep the bare tag.
 * @param payload Free-form structured data. Counts/IDs/enums raw;
 *                free-text MUST be reduced to `{textLength, textPreview}`
 *                by the caller.
 */
export function pipelineLog(stage: string, payload?: Record<string, unknown>): void {
  if (inFlight) return;
  inFlight = true;
  try {
    const entry: PipelineEvent = {
      seq: seqCounter++,
      ts: Date.now(),
      stage,
      payload: payload && Object.keys(payload).length > 0 ? payload : undefined,
    };
    ring.push(entry);
    if (ring.length > RING_SIZE) {
      ring.splice(0, ring.length - RING_SIZE);
    }
    persistTail();
    notify();
    // console.info gives devtools-open users a live trail. console.info
    // (not warn/error) keeps the default filter level from drowning real
    // warnings during a debug session.
    try {
      console.info(`[pipeline:${stage}]`, payload ?? {});
    } catch {
      /* ignore */
    }
    // Forward to backend. clientDiagnostic itself is best-effort and
    // drops cleanly when no WS sink is active (SSR, post-stop window).
    try {
      clientDiagnostic(`pipeline.${stage}`, payload);
    } catch {
      /* ignore */
    }
  } catch {
    // last-resort swallow — diagnostic logging MUST NOT crash the app
  } finally {
    inFlight = false;
  }
}

/** Snapshot of the current ring. Returns a copy. */
export function getPipelineLog(): PipelineEvent[] {
  return ring.slice();
}

/** Wipe both the in-memory ring and the localStorage tail. */
export function clearPipelineLog(): void {
  ring.length = 0;
  seqCounter = 0;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(LS_KEY);
    } catch {
      /* ignore */
    }
  }
  notify();
}

/**
 * Subscribe to ring mutations. Returns an unsubscribe fn. Used by the
 * diagnostics page's auto-refresh affordance.
 */
export function subscribePipelineLog(cb: Subscriber): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
