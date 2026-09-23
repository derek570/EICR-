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

/** Why a never-played item was discarded. `onDiscarded` callers (PLAN-D's
 *  mode-status re-park mechanism) branch on this: `overflow`/`preempt`/
 *  `purge`/`reset`/`not_queued` are queue-LIFECYCLE events — the channel
 *  itself is fine, just occupied or torn down, so retrying (re-parking) is
 *  safe. `playback_error` is a genuine terminal failure (native AND
 *  ElevenLabs both failed before any audio played) — re-parking that would
 *  retry indefinitely against a persistently broken synth backend, so
 *  callers must retire tracking instead. */
export type DiscardReason =
  | 'overflow'
  | 'preempt'
  | 'purge'
  | 'reset'
  | 'playback_error'
  | 'not_queued';

export interface ConfirmationQueueItem {
  text: string;
  /** Prefix key for `cancel_pending_tts` purge. Confirmations set NONE today,
   *  so `purge`'s head-match branch is dormant until fast-path TTS lands. */
  cancelKey?: string;
  /** Confirmation dedupe key. Un-recorded via `onDiscarded` iff the item is
   *  discarded before ever starting playback. */
  dedupeKey?: string;
  /** Exempt this item from `MAX_QUEUE_DEPTH` overflow eviction — drop-oldest
   *  looks for the oldest NON-protected item instead. For items whose loss
   *  must never be silent (PLAN-D mode-status cues): overflow eviction has
   *  no natural pacing (unlike `preemptFlush()`, which fires once per ask),
   *  so a protected item repeatedly re-parked only to be evicted again by
   *  the NEXT overflow-triggering enqueue can thrash. If every queued item
   *  is protected, the queue is allowed to exceed `MAX_QUEUE_DEPTH` by one
   *  rather than silently drop one. */
  protected?: boolean;
  play: ConfirmationPlayFn;
  /** Optional per-item NATURAL-completion hook. Fires ONLY when the head
   *  ended without failure; never after a post-start failure (see
   *  `onPlaybackFailed`). */
  onEnd?: () => void;
  /** PLAN-E2 — fires when a head that HAD started playback terminates with
   *  a failure (`onError` after `onStart`). MUTUALLY EXCLUSIVE with `onEnd`:
   *  a started failure invokes ONLY this; `onEnd` fires ONLY on natural
   *  completion. Before this hook a post-start `onError` was
   *  indistinguishable from natural completion and would have RETIRED a
   *  disclosure the inspector never finished hearing. Only the disclosure
   *  item supplies it; every other item is unaffected. */
  onPlaybackFailed?: () => void;
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
let onDiscarded: ((dedupeKey: string, reason: DiscardReason) => void) | null = null;
/** Playback-start hook (§A1b, field-feedback-2026-07-14). Fired once per
 *  head, at the moment real audio begins, with the head's dedupeKey —
 *  recording-context converts the key's RESERVATION into its heard state
 *  (permanent for field read-backs, 30 s TTL stamp for field-nil
 *  apologies). Same lifecycle as `onDiscarded`: null until registered,
 *  cleared by `reset()`. */
let onPlaybackStarted: ((dedupeKey: string) => void) | null = null;
/**
 * PLAN-E1 E3 — fired when a PLAYING head (already `wasStarted`) is
 * manually torn down (`preemptFlush()` / `reset()` / a direct/critical
 * preemption). `onDiscarded` deliberately does NOT fire for this case
 * (see `tearDownCurrentHeadManually` — it only fires for a
 * never-started head), so a caller whose coalescing key must be
 * released on EITHER a pre-start discard OR a started-then-preempted
 * head needs both hooks. The poor-signal advisory (E3) is the first
 * consumer: a STARTED-then-preempted advisory head must release its
 * coalescing key too, or it latches forever after that exact sequence
 * and suppresses every later legitimate arm. Same lifecycle as
 * `onDiscarded`/`onPlaybackStarted`: null until registered, cleared by
 * `reset()`. */
let onStartedHeadTornDown: ((dedupeKey: string, reason: DiscardReason) => void) | null = null;

/**
 * PLAN-D D5 — per-head playback observer. Fired with `'start'` at the moment
 * real audio begins for EVERY head (keyed or not), and with `'end'` when a
 * STARTED head reaches any terminal: natural end, a post-start error, or a
 * manual teardown. Carries the head's text so the recording session can emit
 * `voice_pause_speech_spoken` at playback start (never at enqueue) and can
 * disarm the resume matcher while a cue containing the resume phrase plays.
 * Purely observational — it cannot defer, drop or reorder anything. Same
 * lifecycle as the other hooks: null until registered, cleared by `reset()`.
 */
export type HeadPlaybackEvent = 'start' | 'end';
let headPlaybackObserver:
  | ((event: HeadPlaybackEvent, item: { text: string; dedupeKey?: string }) => void)
  | null = null;

export function setHeadPlaybackObserver(
  fn: ((event: HeadPlaybackEvent, item: { text: string; dedupeKey?: string }) => void) | null
): void {
  headPlaybackObserver = fn;
}

function notifyHeadPlayback(event: HeadPlaybackEvent, item: QueueHead | null): void {
  if (!item || !headPlaybackObserver) return;
  try {
    headPlaybackObserver(event, { text: item.text, dedupeKey: item.dedupeKey });
  } catch {
    /* swallow — an observer must never wedge the queue */
  }
}

export function setShouldDeferPlayback(fn: () => boolean): void {
  shouldDeferPlayback = fn;
}

export function setOnDiscarded(fn: (dedupeKey: string, reason: DiscardReason) => void): void {
  onDiscarded = fn;
}

export function setOnPlaybackStarted(fn: (dedupeKey: string) => void): void {
  onPlaybackStarted = fn;
}

/** PLAN-E2 widened the hook with the teardown `reason` (additive — existing
 *  one-arg consumers ignore it): a disclosure token torn down by a session
 *  `reset()` is ABANDONED, while one torn down by `preempt`/`purge` re-parks. */
export function setOnStartedHeadTornDown(
  fn: (dedupeKey: string, reason: DiscardReason) => void
): void {
  onStartedHeadTornDown = fn;
}

/** Fire the un-record hook synchronously for a never-played item. No-op when
 *  the item has no dedupeKey or no hook is registered (tour path). */
function fireDiscarded(item: { dedupeKey?: string }, reason: DiscardReason): void {
  if (item.dedupeKey && onDiscarded) {
    try {
      onDiscarded(item.dedupeKey, reason);
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
    // Oldest NON-protected item — see `protected` on ConfirmationQueueItem.
    // If every queued item is protected, skip the drop entirely (the queue
    // exceeds MAX_QUEUE_DEPTH by one for this push, rather than silently
    // dropping something that must never go silent).
    const dropIndex = queue.findIndex((q) => !q.protected);
    if (dropIndex !== -1) {
      const [dropped] = queue.splice(dropIndex, 1);
      discardedCount = 1;
      fireDiscarded(dropped, 'overflow'); // never played
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
      // §A1b — convert the head's dedupe-key reservation to its heard
      // state (30 s TTL for field-nil apologies). Fired exactly once per
      // head: startedPlayback guards every later discard path from
      // un-recording a heard key, and this hook is its mirror image.
      if (next.dedupeKey && onPlaybackStarted) {
        try {
          onPlaybackStarted(next.dedupeKey);
        } catch {
          /* swallow — a bad consumer must not wedge the queue */
        }
      }
      notifyHeadPlayback('start', next);
    },
    onEnd: () => completeHead(myId),
    // Synthesis/native playback can fail before `onStart`. In that case the
    // inspector heard nothing, so release the caller's reservation before
    // advancing. A post-start error remains heard and keeps its key.
    onError: () => completeHead(myId, true),
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
function completeHead(id: number, failed = false): void {
  if (id !== currentHeadId) return;
  const finished = head;
  const hadStarted = startedPlayback;
  if (failed && !hadStarted && finished) {
    fireDiscarded(finished, 'playback_error');
  }
  head = null;
  busy = false;
  currentHeadId = null;
  startedPlayback = false;
  currentCanceller = null;
  deferredHead = null;
  clientDiagnostic('tts_queue_complete', { id, failed, hadStarted });
  if (hadStarted) notifyHeadPlayback('end', finished);
  try {
    // PLAN-E2 — a STARTED head that failed is NOT a natural completion:
    // route it to `onPlaybackFailed` only, never `onEnd`. A never-started
    // failure already fired `onDiscarded` above and gets neither.
    if (failed && hadStarted) {
      finished?.onPlaybackFailed?.();
    } else if (!failed) {
      finished?.onEnd?.();
    }
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
function tearDownCurrentHeadManually(reason: DiscardReason): { discarded: boolean } {
  if (!head) return { discarded: false };
  const wasStarted = startedPlayback;
  const isDeferred = deferredHead != null && deferredHead.item.id === currentHeadId;
  let discarded = false;
  if (!wasStarted) {
    fireDiscarded(head, reason);
    discarded = true;
    if (!isDeferred) {
      clientDiagnostic('tts_queue_discarded_prefetch', { id: currentHeadId });
    }
  } else if (head.dedupeKey && onStartedHeadTornDown) {
    // A PLAYING head manually torn down — `onDiscarded` does not cover
    // this case (it only fires for a never-started item). See
    // `onStartedHeadTornDown`'s docblock.
    try {
      onStartedHeadTornDown(head.dedupeKey, reason);
    } catch {
      /* swallow — a caller's hook must never break queue teardown */
    }
  }
  const canceller = currentCanceller;
  const prepared = deferredHead?.prepared ?? null;
  const tornDownHead = head;
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
  if (wasStarted) notifyHeadPlayback('end', tornDownHead);
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
      fireDiscarded(q, 'purge');
    } else {
      kept.push(q);
    }
  }
  queue = kept;
  if (head && head.cancelKey && head.cancelKey.startsWith(prefix)) {
    tearDownCurrentHeadManually('purge');
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
 *   (1) Tear down the CURRENT head MANUALLY + UNGUARDED FIRST, THEN empty the
 *       queue — `onDiscarded` fires for the head before any still-queued item.
 *       Codex diff-review r6 BLOCKER: `onDiscarded` for a mode-status cue
 *       (`handleModeStatusCueDiscard`) re-parks via a MICROTASK, and
 *       microtasks run in the order they were SCHEDULED — so firing order
 *       here determines re-park (and therefore eventual playback) order.
 *       The head is chronologically the OLDEST pending cue (it was dequeued
 *       first); firing it before the queue's newer items preserves that
 *       chronological order across a preempt-then-re-park round trip. The
 *       old queue-first ordering reversed a rapid off→then→on sequence into
 *       on→then→off once both were re-parked, leaving the inspector hearing
 *       the WRONG final toggle state — id-122/124 exists specifically to
 *       make the audible state trustworthy, so this correctness matters.
 *   (2) do NOT `pumpIfIdle()` (queue is empty, nothing restarts behind the
 *       question).
 * MUST NOT touch `shouldDeferPlayback` / `onDiscarded` — the session is still
 * live (the key difference from `reset()`). Returns the count of never-played
 * confirmations flushed, for the `tts_speak_preempted_confirmation` diagnostic.
 */
export function preemptFlush(): number {
  let discardedCount = 0;
  if (head) {
    const r = tearDownCurrentHeadManually('preempt');
    if (r.discarded) discardedCount++;
  }
  for (const q of queue) {
    fireDiscarded(q, 'preempt'); // every queued item is never-played
    discardedCount++;
  }
  queue = [];
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
    fireDiscarded(q, 'reset');
    discarded++;
  }
  queue = [];
  if (head) tearDownCurrentHeadManually('reset');
  clientDiagnostic('tts_queue_reset', { discardedQueued: discarded });
  shouldDeferPlayback = () => false;
  onDiscarded = null;
  onPlaybackStarted = null;
  onStartedHeadTornDown = null;
  headPlaybackObserver = null;
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
  onPlaybackStarted = null;
  onStartedHeadTornDown = null;
  headPlaybackObserver = null;
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
