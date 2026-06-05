/**
 * In-flight TTS question tracker — the PWA equivalent of iOS's
 * `inFlightQuestion` slot + `pendingInFlightQuestions` FIFO + the
 * `transcriptConsumesInFlight` / `takeInResponseToPayload` pair on
 * `DeepgramRecordingViewModel`. Single source of truth for the
 * `in_response_to` payload that gets attached to outbound transcript
 * frames.
 *
 * Why this lives here and not inline in recording-context.tsx:
 *  - Pure state machine, no React, no DOM. Unit-testable in isolation
 *    against a fake clock (`now` injectable).
 *  - The provider currently has ~3300 lines and ~25 refs; adding the
 *    FIFO + slot + stale-window math inline would push it harder to
 *    follow. The provider keeps a single ref to a tracker instance and
 *    wires the four call-sites (enqueue / onTtsStart / onTtsEnd /
 *    takePayload) into the existing onQuestion / TTS lifecycle / dispatch
 *    paths.
 *
 * iOS canon: `Sources/Recording/DeepgramRecordingViewModel.swift:2474-
 * 2900` (the InFlightQuestion struct, the FIFO, the stale window, the
 * substantive-burn gate). Every behavioural choice mirrors that file.
 */

export interface InFlightQuestion {
  /** Question type (`observation_confirmation`, `unclear`, `orphaned`, …).
   *  Becomes `in_response_to.type` on the wire. */
  type: string;
  /** Question text as the inspector heard it. Becomes
   *  `in_response_to.question`. */
  question: string;
  /** Optional field hint — narrows Sonnet's interpretation of the reply. */
  field?: string | null;
  /** Optional circuit ref — narrows Sonnet's interpretation. */
  circuit?: number | null;
  /** Stage 6 tool_call_id, when the question originated from
   *  `ask_user_started`. Travels through so the consumer can correlate
   *  later, but the slot mechanism itself is tool_call_id-agnostic. */
  toolCallId?: string | null;
}

/** Shape attached to the outbound `transcript` frame as `in_response_to`.
 *  Mirrors iOS `ServerWebSocketService.swift:498-518` payload shape. */
export interface InFlightPayload {
  type: string;
  question: string;
  field?: string;
  circuit?: number;
}

/**
 * iOS canon: `DeepgramRecordingViewModel.swift:2695-2699`. Verbatim port.
 * Single-word/short-phrase replies that should ALWAYS burn the in-flight
 * slot even though they fail the 10-char/3-token gates.
 */
const SHORT_REPLY_WHITELIST = new Set<string>([
  'yes',
  'yeah',
  'yep',
  'no',
  'nope',
  'nah',
  'skip',
  'go on',
  'repeat',
  'fi',
  'c1',
  'c2',
  'c3',
  'c 1',
  'c 2',
  'c 3',
  'code 1',
  'code 2',
  'code 3',
  'ok',
  'okay',
]);

/**
 * iOS canon: `DeepgramRecordingViewModel.swift:2804-2807`. Matches short
 * circuit-reference replies that should consume the slot ("circuit 1",
 * "second one", bare "5", etc.).
 */
const CIRCUIT_REPLY_SHAPE =
  /^(?:circuit\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s*$|^(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*$/i;

/**
 * Decide whether `transcript` is substantive enough to BURN the in-flight
 * question slot. iOS canon at `DeepgramRecordingViewModel.swift:2714-2798`.
 *
 * The gate is split from "attach context": context is attached whenever a
 * slot is alive within the stale window, but the slot is only cleared on
 * substantive replies so a stutter ("uh") doesn't drop the real answer.
 */
export function transcriptConsumesInFlight(transcript: string): boolean {
  const trimmed = transcript
    .toLowerCase()
    .trim()
    .replace(/[.?!,]+$/g, '')
    .trim();
  if (trimmed.length === 0) return false;
  if (SHORT_REPLY_WHITELIST.has(trimmed)) return true;
  if (trimmed.length >= 10) return true;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length >= 3) return true;
  if (CIRCUIT_REPLY_SHAPE.test(trimmed)) return true;
  // Single-token ≥4-char reply — covers UK domestic designation vocabulary
  // ("cooker", "shower", "lights", "sockets", "oven", "boiler"). iOS at
  // line 2793-2795 with the AC1948BE rationale.
  if (tokens.length === 1 && trimmed.length >= 4) return true;
  return false;
}

interface PendingEntry extends InFlightQuestion {
  enqueuedAt: number;
}
interface ActiveSlot extends InFlightQuestion {
  askedAt: number;
}

/**
 * Stale window in ms — iOS uses 10 s
 * (`DeepgramRecordingViewModel.swift:2532`). Measured from TTS-end so a
 * slow ElevenLabs round-trip doesn't burn the budget before the
 * inspector hears the question.
 */
export const DEFAULT_STALE_WINDOW_MS = 10_000;

/** Hard cap on the pending FIFO — bounded by ask cadence. */
export const PENDING_FIFO_MAX = 8;

/**
 * Single-slot in-flight-question tracker with a small pending FIFO for the
 * gap between `onQuestion` (Sonnet emits the question) and TTS-start
 * (ElevenLabs actually plays it). Match-by-text — iOS uses the same
 * shape (alert.message == question text).
 */
export class InFlightQuestionTracker {
  private slot: ActiveSlot | null = null;
  private pending: PendingEntry[] = [];

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly staleWindowMs: number = DEFAULT_STALE_WINDOW_MS
  ) {}

  /** Called when `onQuestion` fires (Sonnet emitted, TTS hasn't started yet). */
  enqueue(q: InFlightQuestion): void {
    this.pending.push({ ...q, enqueuedAt: this.now() });
    if (this.pending.length > PENDING_FIFO_MAX) {
      this.pending.splice(0, this.pending.length - PENDING_FIFO_MAX);
    }
  }

  /**
   * TTS playback started. Pop the matching pending entry into the active
   * slot and stamp `askedAt = now` so the stale window starts from when
   * the inspector could actually hear the question. iOS canon
   * `handleAlertTTSStarted` line 2572.
   *
   * Returns true when a pending entry matched, false otherwise (the
   * caller can log a miss).
   */
  onTtsStart(questionText: string): boolean {
    const idx = this.pending.findIndex((p) => p.question === questionText);
    if (idx < 0) return false;
    const [entry] = this.pending.splice(idx, 1);
    this.slot = {
      type: entry.type,
      question: entry.question,
      field: entry.field,
      circuit: entry.circuit,
      toolCallId: entry.toolCallId,
      askedAt: this.now(),
    };
    // Purge stale pending entries so they can't shadow a future match.
    // iOS purges with staleWindow*2 — generous because TTS queues can
    // stack briefly. Mirror that.
    const cutoff = this.now() - this.staleWindowMs * 2;
    this.pending = this.pending.filter((p) => p.enqueuedAt >= cutoff);
    return true;
  }

  /**
   * TTS playback ended. Re-anchor `askedAt` to TTS-end. iOS canon
   * `handleAlertTTSFinished` line 2655 — the 10 s stale window is
   * measured from the earliest moment the inspector could physically
   * reply, not from when Sonnet emitted the question.
   */
  onTtsEnd(questionText: string): void {
    if (!this.slot || this.slot.question !== questionText) return;
    this.slot = { ...this.slot, askedAt: this.now() };
  }

  /**
   * Compute the `in_response_to` payload for an outbound transcript and
   * conditionally burn the slot. iOS canon `takeInResponseToPayload`
   * line 2840.
   *
   * Returns null when no slot is alive, the slot is past the stale
   * window, or the slot was already burned. Otherwise returns the wire
   * payload. Burns the slot iff `transcriptConsumesInFlight(transcript)`.
   */
  takePayload(transcript: string): InFlightPayload | null {
    if (!this.slot) return null;
    const age = this.now() - this.slot.askedAt;
    if (age > this.staleWindowMs) {
      this.slot = null;
      return null;
    }
    const payload: InFlightPayload = {
      type: this.slot.type,
      question: this.slot.question,
    };
    if (this.slot.field != null) payload.field = this.slot.field;
    if (this.slot.circuit != null) payload.circuit = this.slot.circuit;
    if (transcriptConsumesInFlight(transcript)) {
      this.slot = null;
    }
    return payload;
  }

  /**
   * Force-clear the slot. Used after a Stage 6 `ask_user_answered` wire
   * emit — the answer is canonical via the wire path so the slot
   * shouldn't mis-attach to the next unrelated transcript. iOS canon
   * `DeepgramRecordingViewModel.swift:2066` — `inFlightQuestion = nil`
   * inside the stage6Substantive branch.
   */
  clear(): void {
    this.slot = null;
  }

  /** Read-only introspection for diagnostics. */
  get hasActiveSlot(): boolean {
    return this.slot !== null;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Snapshot — only for tests / diagnostics; do NOT mutate the returned
   *  object. */
  peekSlot(): Readonly<ActiveSlot> | null {
    return this.slot;
  }
}
