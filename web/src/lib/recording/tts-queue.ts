'use client';

import { clientDiagnostic } from './client-diagnostic';

/**
 * Confirmation-TTS FIFO queue — web port of the iOS "TTS FIFO Queue"
 * (AlertManager Phase 7.1, `CertMateUnified/Sources/Recording/AlertManager.swift:236-355`
 * + the pump/resume/purge machinery at `:1576-1896`).
 *
 * WHY this exists: pre-fix the web confirmation path
 * (`recording-context.tsx onExtraction` → `speakConfirmation`) cancelled
 * the in-flight utterance on EVERY new confirmation (`speakElevenLabs`
 * calls `cancelElevenLabs()` at its top). So a Sonnet turn that read back
 * TWO circuit renames fired both ~5ms apart and only the LAST was heard —
 * a direct violation of Audio-First invariant #1 ("every dictated reading
 * read back, exactly once, never zero"). iOS does NOT cancel; it FIFO-queues
 * confirmations so back-to-back read-backs play in order. This module is the
 * web analogue.
 *
 * SCOPE — confirmations (+ future fast-path TTS) ONLY. iOS Phase 7.1 is
 * deliberately confirmations/fast-path only; `speakAlertMessage` /
 * `speakResponse` / `ask_user` prompts run through the SEPARATE direct
 * `speakWithTTS` path with their own single `deferredTTS` slot. Routing an
 * `ask_user` disambiguation question through this FIFO would make it wait
 * behind up to 6 queued read-backs — strictly worse than today. So the
 * direct `speak()` path stays in `tts.ts` and PREEMPTS this queue via
 * `preemptFlush()`; only `speakConfirmation()` enqueues here.
 *
 * DESIGN — framework-free, unit-testable against a fake clock + injected
 * player. The audio player is dependency-INJECTED per call (`item.play`),
 * NOT imported, so there is no `tts.ts` ↔ `tts-queue.ts` circular import.
 * The injected player must guarantee EXACTLY ONE terminal callback per head
 * (`onEnd` OR `onError`) and must call `controls.onStart` at the moment real
 * audio begins (this drives `startedPlayback`, the "was it ever heard?"
 * flag used by every teardown path).
 *
 * NEVER a permanent read-back drop (Audio-First #1): the caller records a
 * confirmation's dedupe key at enqueue. Any item discarded WITHOUT ever
 * starting playback (`startedPlayback === false`) — an overflow drop-oldest,
 * a `reset()` / `purge()` / `preemptFlush()`, a deferred head, OR the current
 * head torn down mid-fetch/pre-playback — fires the injected `onDiscarded(key)`
 * SYNCHRONOUSLY so the caller un-records the key and the backend can re-speak
 * it on a later re-emit. Items with `startedPlayback === true` keep their key
 * (they were heard).
 */

/** Prepared-audio handle handed back by the injected player AFTER fetch/decode
 *  (post-fetch, pre-`audio.play()`), so the queue can apply the last-mile
 *  deferral gate (iOS `playOrDeferQueueHead`, AlertManager.swift:1648). */
export interface PreparedAudio {
  /** Play the already-fetched/decoded audio. Fires the head's `onStart`
   *  (real audio begins) then `onEnd` / `onError`. NO re-fetch. */
  play: () => void;
  /** Discard the prepared audio WITHOUT playing (revoke blob / detach).
   *  Used when a prepared-but-deferred head is torn down — it never played,
   *  so no hard audio cancel is issued, only this cleanup. */
  discard: () => void;
}

/** Callbacks the queue passes to the injected `play(text, controls)`.
 *  The player MUST fire exactly one terminal (`onEnd` OR `onError`) per head. */
export interface QueuePlayControls {
  /** Real audio began (ElevenLabs `playing` / native `utterance.onstart`).
   *  Sets `startedPlayback = true`. LOAD-BEARING on the native iOS-Safari
   *  default path — without a native `onStart` a heard confirmation would be
   *  un-recorded on teardown and double-read on re-emit. */
  onStart: () => void;
  /** Natural end — advances the pump. */
  onEnd: () => void;
  /** Terminal error (after the player's own fallback/abort handling) —
   *  advances the pump. The pump advances on `onEnd` OR `onError` because a
   *  preempt/purge abort fires `onError` (not `onEnd`) and a head that
   *  advanced only off `onEnd` would stall. */
  onError: (reason?: unknown) => void;
  /** Player calls this AFTER fetch/decode, BEFORE `audio.play()`. The queue
   *  applies the last-mile deferral gate: if `shouldDeferPlayback()` is true
   *  the prepared audio is parked as `deferredHead` (no play, no re-fetch on
   *  resume); else it plays immediately. */
  ready: (prepared: PreparedAudio) => void;
  /** Player registers a hard-abort fn (abort in-flight fetch / stop audio).
   *  Called by `purge`/`preemptFlush`/`reset` to tear down a started or
   *  mid-fetch head. Idempotent. */
  registerCanceller: (cancel: () => void) => void;
}

export type ConfirmationPlayFn = (text: string, controls: QueuePlayControls) => void;

export interface ConfirmationQueueItem {
  text: string;
  /** Prefix key for `cancel_pending_tts` purge. Confirmations set NONE today,
   *  so `purge`'s head-match branch is dormant until fast-path TTS lands. */
  cancelKey?: string;
  /** Confirmation dedupe key. Un-recorded via `onDiscarded` iff the item is
   *  discarded before ever starting playback. */
  dedupeKey?: string;
  play: ConfirmationPlayFn;
  /** Optional per-item natural-completion hook (diagnostic; not correctness). */
  onEnd?: () => void;
}

interface QueueHead extends ConfirmationQueueItem {
  id: number;
}

/** iOS `AlertManager.maxQueueDepth = 6` (AlertManager.swift:355). Counts the
 *  current head PLUS the waiting queue (total pending in-flight), so a 7th
 *  enqueue behind a busy head drops the OLDEST waiting item. */
export const MAX_QUEUE_DEPTH = 6;

let queue: QueueHead[] = [];
let head: QueueHead | null = null;
let currentHeadId: number | null = null;
let busy = false;
let startedPlayback = false;
let deferredHead: { item: QueueHead; prepared: PreparedAudio } | null = null;
let currentCanceller: (() => void) | null = null;
let idCounter = 0;

/** Deferral gate. Defaults to `() => false` — a confirmation enqueued with NO
 *  session wiring (the tour path) plays immediately and never defers.
 *  Recording-context registers the real gate at session open and `reset()`
 *  restores this default. */
let shouldDeferPlayback: () => boolean = () => false;
/** Un-record hook. Null until recording-context registers it; `reset()` clears
 *  it so a later tour (no session) runs against no callback. */
let onDiscarded: ((dedupeKey: string) => void) | null = null;

export function setShouldDeferPlayback(fn: () => boolean): void {
  shouldDeferPlayback = fn;
}

export function setOnDiscarded(fn: (dedupeKey: string) => void): void {
  onDiscarded = fn;
}

/** Fire the un-record hook synchronously for a never-played item. No-op when
 *  the item has no dedupeKey or no hook is registered (tour path). */
function fireDiscarded(item: { dedupeKey?: string }): void {
  if (item.dedupeKey && onDiscarded) {
    try {
      onDiscarded(item.dedupeKey);
    } catch {
      /* swallow — a bad consumer must not wedge the queue */
    }
  }
}

/**
 * Append a confirmation. Enforces `MAX_QUEUE_DEPTH` by DROPPING THE OLDEST
 * still-queued item (iOS AlertManager.swift:352-354 drop-oldest parity — keeps
 * the freshest read-backs). On an overflow drop it fires the dropped item's
 * `onDiscarded` synchronously and returns `{ enqueued: true, discardedCount: 1 }`.
 * Correctness rides on `onDiscarded`, not the return.
 */
export function enqueueConfirmation(item: ConfirmationQueueItem): {
  enqueued: boolean;
  discardedCount: number;
} {
  const entry: QueueHead = { ...item, id: ++idCounter };
  let discardedCount = 0;
  // Drop-oldest overflow. Depth = current head (if any) + waiting queue.
  const inflight = (head ? 1 : 0) + queue.length;
  if (inflight >= MAX_QUEUE_DEPTH && queue.length > 0) {
    const dropped = queue.shift();
    if (dropped) {
      discardedCount = 1;
      fireDiscarded(dropped); // never played
      clientDiagnostic('tts_queue_overflow', {
        droppedId: dropped.id,
        droppedDedupeKey: dropped.dedupeKey ?? null,
      });
    }
  }
  queue.push(entry);
  clientDiagnostic('tts_queue_enqueue', { id: entry.id, depth: queue.length, busy });
  pumpIfIdle();
  return { enqueued: true, discardedCount };
}

/** Take the head if idle, stamp it current, and play it via its injected
 *  player. Advances `completeHead` off the terminal `onEnd`-or-`onError`. */
function pumpIfIdle(): void {
  if (busy) return; // a live (playing OR deferred) head owns the slot
  const next = queue.shift();
  if (!next) return;
  head = next;
  currentHeadId = next.id;
  startedPlayback = false;
  busy = true;
  currentCanceller = null;
  const myId = next.id;
  clientDiagnostic('tts_queue_dequeue', { id: myId, depthRemaining: queue.length });
  next.play(next.text, {
    onStart: () => {
      if (currentHeadId !== myId) return; // superseded
      startedPlayback = true;
    },
    onEnd: () => completeHead(myId),
    onError: () => completeHead(myId),
    ready: (prepared) => {
      if (currentHeadId !== myId) {
        // Superseded during the fetch window — the prepared audio is stale.
        try {
          prepared.discard();
        } catch {
          /* swallow */
        }
        return;
      }
      // Last-mile deferral gate (iOS playOrDeferQueueHead, post-fetch).
      if (shouldDeferPlayback()) {
        deferredHead = { item: next, prepared };
        clientDiagnostic('tts_queue_deferred', { id: myId });
        // Stays busy; head + currentHeadId set; startedPlayback false. No play.
        return;
      }
      prepared.play();
    },
    registerCanceller: (cancel) => {
      if (currentHeadId !== myId) return;
      currentCanceller = cancel;
    },
  });
}

/**
 * NORMAL terminal-callback advance path — idempotent, keyed on `currentHeadId`.
 * If `id !== currentHeadId` it no-ops: this is what swallows the SYNCHRONOUS
 * `onEnd` that `cancelElevenLabs()` fires when `purge`/`preemptFlush`/`reset`
 * hard-cancel a head (they null `currentHeadId` during their MANUAL teardown
 * FIRST). Never route a manual teardown advance through here — it would no-op
 * and stall the pump (`busy` stuck true → zero read-back).
 */
function completeHead(id: number): void {
  if (id !== currentHeadId) return;
  const finished = head;
  head = null;
  busy = false;
  currentHeadId = null;
  startedPlayback = false;
  currentCanceller = null;
  deferredHead = null;
  clientDiagnostic('tts_queue_complete', { id });
  try {
    finished?.onEnd?.();
  } catch {
    /* swallow */
  }
  pumpIfIdle();
}

/**
 * Re-check the gate and, if clear, play the deferred head's ALREADY-PREPARED
 * audio (no re-fetch). Nulls `deferredHead` BEFORE playing (iOS
 * AlertManager.swift:1874) so a double-invocation of a resume site can't
 * double-play. MUST be wired into every inspector-stopped-speaking site or a
 * deferred confirmation head is stranded forever (a Symptom-2b clone).
 */
export function resumeIfDeferred(): void {
  if (!deferredHead) return;
  if (shouldDeferPlayback()) return; // still deferring
  const { prepared } = deferredHead;
  deferredHead = null; // null BEFORE playing — double-resume safety
  clientDiagnostic('tts_queue_resume', { id: currentHeadId });
  prepared.play(); // fires onStart → startedPlayback, then onEnd → completeHead
}

/**
 * Tear down the CURRENT head manually + unguarded (NOT via `completeHead`,
 * which would no-op and stall). Fires `onDiscarded` FIRST when the head never
 * started playing (`startedPlayback === false`) — a mid-fetch OR
 * prepared-but-deferred head was never heard. Nulls all head state, THEN
 * cancels: a deferred/prepared head is `discard()`ed (no hard audio cancel —
 * nothing plays); a mid-fetch/playing head is hard-cancelled via the
 * registered canceller. Returns whether it discarded (for preempt accounting).
 */
function tearDownCurrentHeadManually(): { discarded: boolean } {
  if (!head) return { discarded: false };
  const wasStarted = startedPlayback;
  const isDeferred = deferredHead != null && deferredHead.item.id === currentHeadId;
  let discarded = false;
  if (!wasStarted) {
    fireDiscarded(head);
    discarded = true;
    if (!isDeferred) {
      clientDiagnostic('tts_queue_discarded_prefetch', { id: currentHeadId });
    }
  }
  const canceller = currentCanceller;
  const prepared = deferredHead?.prepared ?? null;
  head = null;
  busy = false;
  currentHeadId = null;
  startedPlayback = false;
  currentCanceller = null;
  deferredHead = null;
  if (isDeferred && prepared) {
    try {
      prepared.discard();
    } catch {
      /* swallow */
    }
  } else if (canceller) {
    try {
      canceller();
    } catch {
      /* swallow */
    }
  }
  return { discarded };
}

/**
 * Remove queued items whose `cancelKey` matches `prefix` (firing `onDiscarded`
 * for each never-played one), and tear down the current head if it matches.
 * Then `pumpIfIdle()` (non-matching items may remain). Dormant today —
 * confirmations set no `cancelKey`; wired for future fast-path TTS
 * (`cancel_pending_tts`).
 */
export function purge(prefix: string): void {
  let purgedCount = 0;
  const kept: QueueHead[] = [];
  for (const q of queue) {
    if (q.cancelKey && q.cancelKey.startsWith(prefix)) {
      purgedCount++;
      fireDiscarded(q);
    } else {
      kept.push(q);
    }
  }
  queue = kept;
  if (head && head.cancelKey && head.cancelKey.startsWith(prefix)) {
    tearDownCurrentHeadManually();
    purgedCount++;
  }
  if (purgedCount > 0) {
    clientDiagnostic('tts_queue_purged', { prefix, purgedCount });
  }
  pumpIfIdle();
}

/**
 * The `speak()`-preempt primitive (distinct from `reset` and `purge`). Used
 * mid-session when a direct `speak()` question/alert takes the audio channel
 * from a playing confirmation. Ordering is load-bearing:
 *   (1) EMPTY the queue FIRST — `onDiscarded` every still-queued item;
 *   (2) tear down the current head MANUALLY + UNGUARDED;
 *   (3) do NOT `pumpIfIdle()` (queue is empty, nothing restarts behind the
 *       question).
 * MUST NOT touch `shouldDeferPlayback` / `onDiscarded` — the session is still
 * live (the key difference from `reset()`). Returns the count of never-played
 * confirmations flushed, for the `tts_speak_preempted_confirmation` diagnostic.
 */
export function preemptFlush(): number {
  let discardedCount = 0;
  for (const q of queue) {
    fireDiscarded(q); // every queued item is never-played
    discardedCount++;
  }
  queue = [];
  if (head) {
    const r = tearDownCurrentHeadManually();
    if (r.discarded) discardedCount++;
  }
  clientDiagnostic('tts_queue_preempt_flush', { discardedCount });
  return discardedCount;
}

/**
 * Hard flush — teardown / session stop / tour step-change. Discards every
 * never-played item (queued AND a mid-fetch/deferred current head), advances
 * synchronously (no waiting on an aborted head's callback), then RESTORES the
 * `shouldDeferPlayback` default and CLEARS `onDiscarded` so a later tour (no
 * session) runs against the defaults, not a stale session closure.
 */
export function reset(): void {
  let discarded = 0;
  for (const q of queue) {
    fireDiscarded(q);
    discarded++;
  }
  queue = [];
  if (head) tearDownCurrentHeadManually();
  clientDiagnostic('tts_queue_reset', { discardedQueued: discarded });
  shouldDeferPlayback = () => false;
  onDiscarded = null;
}

/** Test-only — wipe ALL module state including the id counter + wiring. */
export function __resetForTests(): void {
  queue = [];
  head = null;
  currentHeadId = null;
  busy = false;
  startedPlayback = false;
  deferredHead = null;
  currentCanceller = null;
  idCounter = 0;
  shouldDeferPlayback = () => false;
  onDiscarded = null;
}

/** Read-only introspection for diagnostics / tests. */
export function __queueDepthForTests(): number {
  return queue.length;
}
export function __isBusyForTests(): boolean {
  return busy;
}
export function __hasDeferredHeadForTests(): boolean {
  return deferredHead != null;
}
