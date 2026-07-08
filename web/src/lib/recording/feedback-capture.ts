/**
 * A4 — voice feedback marker capture (pwa-replay-harness Wave 6).
 *
 * Literal port of iOS `TranscriptProcessor.swift` **HEAD** behaviour
 * (canon pin, plan §4 A4 — verified 2026-07-08):
 *   - entry: sentence-opener `^\s*(?:feedback|debug)\b` (:233-234 — the
 *     anchor is load-bearing; a bare \b..\b matched mid-sentence prose
 *     like "the feedback on circuit 3 is ok")
 *   - exit: `(end|stop|finish|done) (feedback|debug)` anywhere, OR the
 *     garble-tolerant `(and|an|in) (feedback|debug)` ONLY utterance-final
 *     (:205 — session 15B88D6B: Deepgram garbled "end feedback" into
 *     "and feedback" and capture mode swallowed the next dictation; a
 *     legit mid-sentence "…and feedback was lost" must NOT close)
 *   - single-utterance form: entry + exit in one final
 *   - 30s / 20-entry rolling final-transcript buffer, snapshotted at
 *     trigger time and attached to the upload (Workstream G)
 *   - session-stop auto-close (`performStopCleanup`,
 *     DeepgramRecordingViewModel.swift:1854-1870)
 *   - NO inactivity timeout — that exists only on the unmerged iOS PR
 *     #17 (fc68448); do NOT invent one here (parity divergence + risks
 *     uploading partial feedback mid-pause). Ledger row
 *     `recording/voice-feedback-capture` carries the dated follow-up.
 *
 * The class is framework-free (injectable clock) so the state machine +
 * buffer are unit-testable and replay-harness-visible.
 */

export type FeedbackCommandResult =
  | { kind: 'normal'; text: string }
  | { kind: 'capture_started' }
  | { kind: 'capture_continuing' }
  | { kind: 'issue_complete'; issue: string; singleUtterance: boolean };

export interface TranscriptWindowEntry {
  ts: string; // ISO8601
  text: string;
}

/** iOS canon: `^\s*(?:feedback|debug)\b` (TranscriptProcessor.swift:233).
 *  "debug" is the legacy alias kept in iOS for a TestFlight cycle. */
const ENTRY_RE = /^\s*(?:feedback|debug)\b/i;
/** iOS canon exit (TranscriptProcessor.swift:205 region). */
const EXIT_RE =
  /(?:\b(?:end|stop|finish|done)\s+(?:feedback|debug)\b|\b(?:and|an|in)\s+(?:feedback|debug)[.!?]?\s*$)/i;

const ROLLING_WINDOW_MS = 30_000;
const ROLLING_MAX_ENTRIES = 20;

export class FeedbackCapture {
  private buffer = '';
  private capturing = false;
  private rollingFinals: Array<{ ts: number; text: string }> = [];
  private readonly now: () => number;

  constructor(deps: { now?: () => number } = {}) {
    this.now = deps.now ?? (() => Date.now());
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  /**
   * Process a normalised final for feedback command markers. Mirrors
   * `processDebugCommand` — the caller routes anything non-`normal` away
   * from the rest of the pipeline (no cumulative append, no regex, no
   * gate, no chime, no Sonnet send).
   */
  processCommand(normalised: string): FeedbackCommandResult {
    // A. Currently capturing — look for the exit marker.
    if (this.capturing) {
      const exitMatch = EXIT_RE.exec(normalised);
      if (exitMatch) {
        const beforeExit = normalised.slice(0, exitMatch.index).trim();
        if (beforeExit) {
          this.buffer += (this.buffer ? ' ' : '') + beforeExit;
        }
        const issue = this.buffer.trim();
        this.buffer = '';
        this.capturing = false;
        if (issue) {
          return { kind: 'issue_complete', issue, singleUtterance: false };
        }
        return { kind: 'capture_started' };
      }
      this.buffer += (this.buffer ? ' ' : '') + normalised;
      return { kind: 'capture_continuing' };
    }

    // B. Not capturing — check for the entry marker.
    const entryMatch = ENTRY_RE.exec(normalised);
    if (entryMatch) {
      const afterEntry = normalised.slice(entryMatch.index + entryMatch[0].length).trim();
      // Single-utterance form: entry + exit in the same final.
      const exitMatch = EXIT_RE.exec(afterEntry);
      if (exitMatch) {
        const issueText = afterEntry.slice(0, exitMatch.index).trim();
        if (issueText) {
          return { kind: 'issue_complete', issue: issueText, singleUtterance: true };
        }
      } else {
        this.buffer = afterEntry;
        this.capturing = true;
      }
      return { kind: 'capture_started' };
    }

    // C. Normal flow.
    return { kind: 'normal', text: normalised };
  }

  /** Session-stop auto-close (`closeDebugCapture` + performStopCleanup).
   *  Returns the issue text when an open capture held content. */
  closeCapture(): string | null {
    if (!this.capturing) return null;
    const issue = this.buffer.trim();
    this.buffer = '';
    this.capturing = false;
    return issue || null;
  }

  // ── rolling pre-trigger window (Workstream G) ──

  appendRollingFinal(text: string, atMs?: number): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ts = atMs ?? this.now();
    this.rollingFinals.push({ ts, text: trimmed });
    this.evict(ts);
  }

  snapshotRollingFinals(): TranscriptWindowEntry[] {
    return this.rollingFinals.map((e) => ({ ts: new Date(e.ts).toISOString(), text: e.text }));
  }

  resetRollingFinals(): void {
    this.rollingFinals = [];
  }

  /** Full reset — session teardown (cross-session leakage impossible). */
  reset(): void {
    this.buffer = '';
    this.capturing = false;
    this.rollingFinals = [];
  }

  private evict(nowMs: number): void {
    const cutoff = nowMs - ROLLING_WINDOW_MS;
    this.rollingFinals = this.rollingFinals.filter((e) => e.ts >= cutoff);
    if (this.rollingFinals.length > ROLLING_MAX_ENTRIES) {
      this.rollingFinals = this.rollingFinals.slice(
        this.rollingFinals.length - ROLLING_MAX_ENTRIES
      );
    }
  }
}
