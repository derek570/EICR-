/**
 * Pure dispatch-buffer helpers — `BurstBuffer` and `NamingBuffer`.
 *
 * Why these exist (and why they're NOT yet wired through
 * `recording-context.tsx`): the production buffers live inline inside the
 * provider with timer refs + diagnostic emits + a closure capture of
 * `dispatchFinal`. Refactoring them out requires touching live recording
 * code that's been pinned by field incidents (sess_mp4jg2mt_231n for the
 * burst buffer, sess_mp19b6tf_i5xc for the naming buffer). The risk-
 * reward says: keep the provider exactly as it is, ship pure equivalents
 * here for the parity-test harness, JSDoc the parity contract on both
 * sides, and merge them later when there's a quiet window.
 *
 * Behavioural contract (mirrored from `web/src/lib/recording-context.tsx`):
 *
 *   BurstBuffer (500ms window) — holds every transcript final for
 *   `windowMs` ms. If a second final arrives inside the window, the two
 *   are concatenated with ` ... ` (verbatim port of the server's legacy
 *   `eicr-extraction-session.js:1440 _processUtteranceBatch` separator)
 *   and dispatched as one turn. Confidence collapses to `Math.min` of
 *   the two values — pessimistic, matches what a single Deepgram final
 *   would carry. Three or more rapid finals would only ever dispatch as
 *   pairs (the provider chose this trade-off deliberately to bound
 *   worst-case latency to 500ms).
 *
 *   NamingBuffer (3000ms window + trailing-pattern gate) — when a final
 *   ends with "Circuit N is" (or "Circuit number two is", etc.) AND
 *   doesn't continue past "is", the buffer holds it for `windowMs` ms
 *   awaiting completion. The next final (regardless of content) gets
 *   concatenated and dispatched as a single Sonnet turn so Sonnet
 *   correctly routes "downstairs sockets" → circuit 2 instead of
 *   mis-routing via description matching. Timeout flushes the buffered
 *   final alone.
 *
 * Both classes accept an injectable scheduler so unit tests can drive
 * the timers without sleeping. iOS-parity reference: the burst buffer
 * is intentionally web-only (added 2026-05-13 to compensate for a
 * Deepgram split that iOS doesn't see the same way — CLAUDE.md
 * "backend immutable" rule kept it out of the server batcher). The
 * naming buffer mirrors iOS exactly.
 */

export type ScheduleFn = (cb: () => void, ms: number) => unknown;
export type ClearScheduleFn = (handle: unknown) => void;

export interface DispatchBuffersDeps {
  scheduler?: ScheduleFn;
  clearScheduler?: ClearScheduleFn;
  /** Injectable clock for diagnostics (`armedAt` / `heldMs`). */
  now?: () => number;
}

const DEFAULT_BURST_WINDOW_MS = 500;
const DEFAULT_NAMING_WINDOW_MS = 3000;

/**
 * Verbatim port of `recording-context.tsx:240-241`. Anchored to end-of-
 * string — does NOT match if the utterance continues past "is".
 */
export const TRAILING_CIRCUIT_NAMING_PATTERN =
  /\bcircuit\s+(?:number\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+is\s*\.?\s*$/i;

export function isTrailingCircuitNamingPattern(text: string): boolean {
  return TRAILING_CIRCUIT_NAMING_PATTERN.test(text);
}

interface BufferedFinal {
  text: string;
  confidence: number;
  timerHandle: unknown;
  armedAt: number;
}

/** Dispatch sink — receives the (possibly merged) final ready for the
 *  downstream pipeline. */
export type DispatchFn = (text: string, confidence: number) => void;

/**
 * Burst-merge consecutive Deepgram finals that land within `windowMs`.
 * Single-slot, last-wins on the merge side (a third final inside the
 * window dispatches the previously-armed pair and starts a new buffer).
 *
 * Usage:
 *   const buffer = new BurstBuffer(dispatch);
 *   buffer.feed(text, confidence);
 */
export class BurstBuffer {
  private slot: BufferedFinal | null = null;
  private readonly schedule: ScheduleFn;
  private readonly clearTimer: ClearScheduleFn;
  private readonly now: () => number;
  /** Last-merged-pair diagnostic (for test introspection). */
  lastDiagnostic: { kind: 'armed' | 'concat' | 'timeout' | 'flushed'; preview: string } | null =
    null;

  constructor(
    private readonly dispatch: DispatchFn,
    private readonly windowMs: number = DEFAULT_BURST_WINDOW_MS,
    deps: DispatchBuffersDeps = {}
  ) {
    this.schedule = deps.scheduler ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer =
      deps.clearScheduler ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = deps.now ?? (() => Date.now());
  }

  /** Feed a final into the buffer. Either merges with a pending entry
   *  and dispatches immediately, or arms a new entry. */
  feed(text: string, confidence: number): void {
    const pending = this.slot;
    if (pending) {
      this.clearTimer(pending.timerHandle);
      this.slot = null;
      const combinedText = `${pending.text} ... ${text}`;
      const combinedConfidence = Math.min(pending.confidence, confidence);
      this.lastDiagnostic = { kind: 'concat', preview: combinedText.slice(0, 80) };
      this.dispatch(combinedText, combinedConfidence);
      return;
    }
    const timerHandle = this.schedule(() => {
      const buffered = this.slot;
      // Defensive: if a fresher entry has armed in the meantime or
      // teardown cleared the slot, drop the stale fire.
      if (!buffered || buffered.timerHandle !== timerHandle) return;
      this.slot = null;
      this.lastDiagnostic = { kind: 'timeout', preview: buffered.text.slice(0, 80) };
      this.dispatch(buffered.text, buffered.confidence);
    }, this.windowMs);
    this.slot = { text, confidence, timerHandle, armedAt: this.now() };
    this.lastDiagnostic = { kind: 'armed', preview: text.slice(0, 80) };
  }

  /** Force-dispatch any pending entry and clear the slot. Use on session
   *  teardown so a buffered final isn't silently dropped. */
  flush(): void {
    const pending = this.slot;
    if (!pending) return;
    this.clearTimer(pending.timerHandle);
    this.slot = null;
    this.lastDiagnostic = { kind: 'flushed', preview: pending.text.slice(0, 80) };
    this.dispatch(pending.text, pending.confidence);
  }

  /** Drop the pending entry without dispatching. Use during teardown
   *  flows that explicitly want to discard buffered audio. */
  clear(): void {
    if (this.slot) {
      this.clearTimer(this.slot.timerHandle);
      this.slot = null;
    }
  }

  get hasPending(): boolean {
    return this.slot !== null;
  }
}

/**
 * Detect-and-hold a trailing "Circuit N is" preface. On feed:
 *  - If a pending preface exists, concat with the new final and dispatch
 *    once (the lower confidence wins).
 *  - If the (concatenated) text itself ends in the trailing-naming
 *    pattern (rare: e.g. "Circuit 2 is" + "Circuit 3 is" — user backed
 *    out), buffer again for `windowMs`.
 *  - Otherwise dispatch immediately.
 *
 * Time-out flush dispatches the buffered final alone.
 */
export class NamingBuffer {
  private slot: BufferedFinal | null = null;
  private readonly schedule: ScheduleFn;
  private readonly clearTimer: ClearScheduleFn;
  private readonly now: () => number;
  lastDiagnostic: {
    kind: 'armed' | 'concat' | 'timeout' | 'flushed';
    preview: string;
    heldMs?: number;
  } | null = null;

  constructor(
    private readonly dispatch: DispatchFn,
    private readonly windowMs: number = DEFAULT_NAMING_WINDOW_MS,
    deps: DispatchBuffersDeps = {}
  ) {
    this.schedule = deps.scheduler ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer =
      deps.clearScheduler ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = deps.now ?? (() => Date.now());
  }

  feed(text: string, confidence: number): void {
    let effectiveText = text;
    let effectiveConfidence = confidence;

    const pending = this.slot;
    if (pending) {
      this.clearTimer(pending.timerHandle);
      this.slot = null;
      effectiveText = `${pending.text} ${text}`.trim();
      effectiveConfidence = Math.min(pending.confidence, confidence);
      this.lastDiagnostic = {
        kind: 'concat',
        preview: effectiveText.slice(0, 80),
      };
    }

    if (isTrailingCircuitNamingPattern(effectiveText)) {
      const armedAt = this.now();
      const timerHandle = this.schedule(() => {
        const buffered = this.slot;
        if (!buffered || buffered.timerHandle !== timerHandle) return;
        this.slot = null;
        this.lastDiagnostic = {
          kind: 'timeout',
          preview: buffered.text.slice(0, 80),
          heldMs: this.now() - buffered.armedAt,
        };
        this.dispatch(buffered.text, buffered.confidence);
      }, this.windowMs);
      this.slot = {
        text: effectiveText,
        confidence: effectiveConfidence,
        timerHandle,
        armedAt,
      };
      // Don't clobber an earlier `concat` diagnostic with `armed` —
      // the concat is the more informative signal for that turn. Only
      // emit `armed` when nothing was pending.
      if (!pending) {
        this.lastDiagnostic = { kind: 'armed', preview: effectiveText.slice(0, 80) };
      }
      return;
    }

    this.dispatch(effectiveText, effectiveConfidence);
  }

  flush(): void {
    const pending = this.slot;
    if (!pending) return;
    this.clearTimer(pending.timerHandle);
    this.slot = null;
    this.lastDiagnostic = { kind: 'flushed', preview: pending.text.slice(0, 80) };
    this.dispatch(pending.text, pending.confidence);
  }

  clear(): void {
    if (this.slot) {
      this.clearTimer(this.slot.timerHandle);
      this.slot = null;
    }
  }

  get hasPending(): boolean {
    return this.slot !== null;
  }
}
