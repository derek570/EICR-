/**
 * FinalWindowV1 (A02D, 2026-09-09) — one thin record per admitted Deepgram
 * final, kept in the emitting socket's DISPATCHED-STREAM domain:
 *
 *   { recording_session_id, epoch, final_sequence, speech_start, window_end }
 *
 * `speech_start` is the client's OWN voiced-activity onset — the PLAN-E1
 * `VoicedActivityDetector` run that most recently preceded the turn's
 * StartOfTurn — recorded at the onset frame's send as that epoch's
 * `dispatchedSampleOffset`. It counts ONLY under the per-onset confirmation
 * rule below: within `ONSET_CONFIRMATION_WINDOW_MS` of the onset transition
 * Deepgram must emit a StartOfTurn or a NON-EMPTY interim; if neither
 * arrives before that deadline, or before the run's next silence
 * transition, the onset never qualifies for any final in its run. A
 * noise-held run that started long before a manual tap therefore never
 * becomes an onset. It is never Flux's `audio_window_start` (which reaches
 * back into pre-speech context) and never the StartOfTurn's
 * `audio_window_end` (a processed watermark that trails the first word).
 *
 * `window_end` is the EndOfTurn's `audio_window_end` converted through
 * `audioWindowEndToSampleOffset` plus that epoch's dispatch origin, exactly
 * as PLAN-E2 converts it for watermark retirement. Both values are
 * source-sample positions of ONE epoch and are codec-independent; no
 * capture-range mapping or cross-domain interval arithmetic exists here.
 *
 * A final with no confirmed onset, or a malformed window, is `unbounded`:
 * client-regex-ineligible, judged by forwarding rule 3 (forward unless a
 * manual cutoff applies, in which case it is held).
 *
 * The plan's canonical prose: A02D `PLAN-final.md` § FinalWindowV1.
 */
import type { ConnectionEpoch } from './uplink-scope-allocator';
import { audioWindowEndToSampleOffset } from './sample-offset';

/** Reuses PLAN-E's 2.5 s constant (`VAD_LOCAL_SPEAKING_GATE_WINDOW_MS`)
 *  by VALUE only — this is a distinct per-onset confirmation rule, not
 *  the `isLocalSpeakingWithin` TTS gate. */
export const ONSET_CONFIRMATION_WINDOW_MS = 2500;

export interface FinalWindowV1 {
  readonly recordingSessionId: string;
  readonly epoch: ConnectionEpoch;
  /** Session-scoped, monotonic across epochs and service instances. */
  readonly finalSequence: number;
  /** Absolute dispatched-stream sample offset of the confirmed onset, or
   *  null when no onset qualified. */
  readonly speechStart: number | null;
  /** Absolute dispatched-stream sample offset of the EndOfTurn window end,
   *  or null when malformed. */
  readonly windowEnd: number | null;
  /** `speechStart === null || windowEnd === null`. */
  readonly unbounded: boolean;
}

/** What the transport hands the provider with every final — the pieces
 *  of the record the SERVICE alone can see (its epoch, its sends, its
 *  onset confirmations). The provider mints `finalSequence` and adds the
 *  session identity. `admissible` is the service half of A02D's admission
 *  predicate: the emitting socket's epoch is the service's CURRENT epoch
 *  and `disconnect()` has not run on this instance. */
export interface FinalTranscriptMeta {
  readonly epoch: ConnectionEpoch | null;
  readonly admissible: boolean;
  readonly speechStart: number | null;
  readonly windowEnd: number | null;
}

/**
 * Per-onset confirmation state for ONE `DeepgramService` instance. Fed by
 * the session VAD's transitions (the provider forwards them) and by the
 * transport's own StartOfTurn / non-empty interim events.
 *
 * Confirmation rule (plan § FinalWindowV1): an onset is CONFIRMED iff
 * provider speech evidence arrives at most `ONSET_CONFIRMATION_WINDOW_MS`
 * after the onset AND before the run's silence transition. A confirmed
 * onset stays the current `speech_start` until a later onset is
 * confirmed (a confirmed run serves every turn it precedes); an
 * unconfirmed onset is discarded at its deadline or silence and never
 * rebases anything.
 */
export class SpeechOnsetTracker {
  private pending: { dispatchedOffset: number; atMs: number } | null = null;
  private confirmed: number | null = null;

  /** The session VAD's debounced onset, with the epoch's dispatched offset
   *  at the onset frame's send. */
  onOnset(dispatchedOffset: number, atMs: number): void {
    this.pending = { dispatchedOffset, atMs };
  }

  /** The session VAD's debounced silence transition: an unconfirmed onset
   *  is discarded; a confirmed one is unaffected. */
  onSilence(): void {
    this.pending = null;
  }

  /** StartOfTurn, or a NON-EMPTY interim (callers must not pass empty
   *  interims). Confirms the pending onset iff within the window. */
  onProviderSpeechEvidence(atMs: number): void {
    const p = this.pending;
    if (!p) return;
    if (atMs - p.atMs <= ONSET_CONFIRMATION_WINDOW_MS) {
      this.confirmed = p.dispatchedOffset;
    }
    // Confirmed or expired: either way this onset is resolved.
    this.pending = null;
  }

  /** The `speech_start` a final emitted NOW would carry. Evaluated lazily
   *  so an onset whose deadline passed without evidence never counts. */
  currentSpeechStart(atMs: number): number | null {
    const p = this.pending;
    if (p && atMs - p.atMs > ONSET_CONFIRMATION_WINDOW_MS) this.pending = null;
    return this.confirmed;
  }

  /** Session boundary only — never on an epoch rotation (a run that
   *  straddles a reconnect keeps its confirmation; the offsets are in one
   *  session-monotonic dispatched domain). */
  reset(): void {
    this.pending = null;
    this.confirmed = null;
  }
}

/** Convert a provider `audio_window_end` (seconds since the socket's stream
 *  began) into the absolute dispatched-sample domain of `epochDispatchOrigin`.
 *  Returns null for a malformed value (non-finite or negative). */
export function resolveWindowEnd(
  rawWindowEnd: unknown,
  epochDispatchOrigin: number
): number | null {
  if (typeof rawWindowEnd !== 'number' || !Number.isFinite(rawWindowEnd) || rawWindowEnd < 0) {
    return null;
  }
  return epochDispatchOrigin + audioWindowEndToSampleOffset(rawWindowEnd);
}

export function buildFinalWindow(input: {
  recordingSessionId: string;
  epoch: ConnectionEpoch;
  finalSequence: number;
  speechStart: number | null;
  windowEnd: number | null;
}): FinalWindowV1 {
  const speechStart =
    typeof input.speechStart === 'number' &&
    Number.isFinite(input.speechStart) &&
    input.speechStart >= 0
      ? input.speechStart
      : null;
  const windowEnd =
    typeof input.windowEnd === 'number' && Number.isFinite(input.windowEnd) && input.windowEnd >= 0
      ? input.windowEnd
      : null;
  return {
    recordingSessionId: input.recordingSessionId,
    epoch: input.epoch,
    finalSequence: input.finalSequence,
    speechStart,
    windowEnd,
    unbounded: speechStart === null || windowEnd === null,
  };
}

/** Stable identity of a final for the held-fragment clarification token:
 *  `{session, epoch, final_sequence}`. Duplicate callbacks of the same final
 *  dedupe to one token through this key. */
export function finalWindowKey(w: FinalWindowV1): string {
  return `${w.recordingSessionId}|${w.epoch}|${w.finalSequence}`;
}
