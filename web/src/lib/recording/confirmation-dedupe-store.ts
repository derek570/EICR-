/**
 * Confirmation-dedupe store — web twin of the iOS A1(b) three-store
 * design (field-feedback-2026-07-14; canon: DeepgramRecordingViewModel
 * `isConfirmationKeyLive` / `reserveConfirmationKey` /
 * `confirmationKeyPlaybackDidStart` / `forgetConfirmationKey` /
 * `resetConfirmationDedupeStores`).
 *
 * WHY: field session 6B6FE011 (F7/F10) — the confirmation dedupe set was
 * session-lifetime with no TTL, so a field-nil apology ("Sorry, I'm not
 * sure where that reading goes…") spoken once at 06:10 silently swallowed
 * the SAME apology at 06:21 and 06:27 — beep-then-silence, an audio-first
 * invariant #1 violation. Derek-decided fix: 30 s TTL for field-nil
 * confirmations (apologies / system prompts), permanent Set semantics
 * kept for field read-backs.
 *
 * THREE stores (reservation ≠ TTL entry — plan §A1(b) round-24):
 *   - `permanent`  — field read-back keys, session-lifetime (unchanged
 *     semantics). Inserted at RESERVE time so the pre-existing
 *     insert-at-enqueue behaviour (and any cross-match against the set)
 *     is preserved.
 *   - `ttl`        — field-nil keys → timestamp of audible playback
 *     START. Live for 30 s from being HEARD; an identical apology
 *     re-speaks after that (F7/F10's swallowed apologies were 11+ min
 *     apart — both would have played).
 *   - `reserved`   — keys queued in the TTS FIFO but not yet played.
 *     AGELESS: an apology deferred past 30 s in the queue must NOT
 *     expire unheard and let a replay enqueue a duplicate. Converts to
 *     the TTL stamp (field-nil) at playback start; removed entirely on
 *     any pre-play discard.
 *
 * Framework-free + injected clock so vitest pins the TTL boundary
 * exactly (same recipe as tts-queue.ts).
 */

/** iOS `fieldNilConfirmationTTL` — 30 s, Derek-decided 2026-07-14. */
export const FIELD_NIL_CONFIRMATION_TTL_MS = 30_000;

export class ConfirmationDedupeStore {
  private readonly permanent = new Set<string>();
  /** key → playback-start epoch ms (field-nil keys only). */
  private readonly ttl = new Map<string, number>();
  /** key → fieldIsNil, recorded at reserve time so playback-start knows
   *  which store the reservation converts into. */
  private readonly reserved = new Map<string, boolean>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Would speaking this confirmation be a duplicate right now?
   *  Reserved keys are live regardless of age; field-nil keys live for
   *  30 s from playback start (expired stamps are dropped so the map
   *  stays bounded); field keys are session-permanent. */
  isLive(key: string, fieldIsNil: boolean): boolean {
    if (this.reserved.has(key)) return true;
    if (fieldIsNil) {
      const ts = this.ttl.get(key);
      if (ts == null) return false;
      if (this.now() - ts < FIELD_NIL_CONFIRMATION_TTL_MS) return true;
      this.ttl.delete(key);
      return false;
    }
    return this.permanent.has(key);
  }

  /** RESERVE at enqueue time (before FIFO playback). Field keys also
   *  enter the permanent set immediately (iOS-canon insert-at-enqueue);
   *  field-nil keys get the reservation ONLY — the 30 s stamp is written
   *  at playback start, never here (reservation ≠ TTL entry). */
  reserve(key: string, fieldIsNil: boolean): void {
    this.reserved.set(key, fieldIsNil);
    if (!fieldIsNil) this.permanent.add(key);
  }

  /** Audible playback STARTED — the reservation converts. Field-nil keys
   *  start their 30 s TTL now; field keys are already permanent. */
  markPlaybackStarted(key: string): void {
    const fieldIsNil = this.reserved.get(key);
    this.reserved.delete(key);
    if (fieldIsNil === true) this.ttl.set(key, this.now());
  }

  /** Single un-record helper — a queued confirmation was discarded
   *  BEFORE playback (overflow / preempt / purge / reset / deferred-head
   *  teardown). Clears ALL stores so an immediate re-emit speaks instead
   *  of being suppressed. Wired into the TTS FIFO's `onDiscarded`. */
  forget(key: string): void {
    this.reserved.delete(key);
    this.permanent.delete(key);
    this.ttl.delete(key);
  }

  /** Session-boundary reset for ALL stores together — a TTL stamp or
   *  reservation surviving into the next session would suppress its
   *  first apology/read-backs (iOS `resetConfirmationDedupeStores`). */
  reset(): void {
    this.permanent.clear();
    this.ttl.clear();
    this.reserved.clear();
  }
}
