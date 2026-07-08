/**
 * Pending-readings buffer — port of iOS
 * `TranscriptProcessor.swift:52-287` (`pendingReadings`,
 * `pendingReadingsTimer`, `bufferPendingReading`,
 * `startPendingReadingsTimer`, `clearResolvedPendingReadings`,
 * `removeResolvedReadings`, `suppressSelfRetry`).
 *
 * Purpose: when Sonnet returns a reading with no circuit attribution
 * (orphan — inspector said "Zs is 0.3" without naming a circuit), the
 * buffer holds it for `timeoutMs` ms. On timeout the consumer asks
 * "Which circuit was that <field> <value> for?" — restoring the
 * conversational flow iOS provides.
 *
 * Cross-system hooks:
 *  - `removeResolved(readings)` — drops pending entries when a later
 *    Sonnet extraction returns the same reading with a resolved
 *    circuit (the inspector either re-stated with a circuit ref or
 *    Sonnet figured it out from context).
 *  - `suppressSelfRetry(field)` — cancels the timer when the SERVER
 *    has already asked an equivalent disambiguation question. iOS
 *    sess_80723FDE (2026-04-21) — without this, iOS asked
 *    "Which circuit was that 0.3 reading for?" 12 s after Sonnet
 *    already asked "Which circuit is that Zs 0.3 for?", playing two
 *    TTS prompts back-to-back where the second cancelled the first.
 *  - `snapshotForQuestion()` — freezes the current set into a separate
 *    slot so the answering inspector's reply can apply the buffered
 *    readings to the named circuit (consumer-side wiring).
 *
 * The buffer is intentionally schema-agnostic — it stores a
 * `PendingReading` value type. The caller is responsible for sourcing
 * the reading shape from whatever extraction envelope Sonnet returned.
 *
 * iOS canon `pendingReadingsTimeout = 2.0` seconds. Same default here.
 */

import type { ScheduleFn, ClearScheduleFn } from './dispatch-buffers';

export interface PendingReading {
  /** Sonnet field key (e.g. `measured_zs_ohm`, `r1_r2_ohm`). */
  field: string;
  /** Value as the inspector said it (stringified — matches iOS
   *  `ExtractedReading.value.stringValue`). */
  value: string;
}

export interface PendingReadingsBufferDeps {
  scheduler?: ScheduleFn;
  clearScheduler?: ClearScheduleFn;
}

export const DEFAULT_PENDING_READINGS_TIMEOUT_MS = 2_000;

export type PendingReadingsTimeoutCallback = (readings: PendingReading[]) => void;

export class PendingReadingsBuffer {
  private buffer: PendingReading[] = [];
  private timerHandle: unknown | null = null;
  private snapshot: PendingReading[] = [];
  private readonly schedule: ScheduleFn;
  private readonly clearTimer: ClearScheduleFn;

  constructor(
    private readonly onTimeout: PendingReadingsTimeoutCallback,
    private readonly timeoutMs: number = DEFAULT_PENDING_READINGS_TIMEOUT_MS,
    deps: PendingReadingsBufferDeps = {}
  ) {
    this.schedule = deps.scheduler ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer =
      deps.clearScheduler ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Add an orphan reading to the buffer + (re)start the timer. iOS
   *  canon `bufferPendingReading` (`TranscriptProcessor.swift:213`). */
  add(reading: PendingReading): void {
    this.buffer.push(reading);
    this.restartTimer();
  }

  /** Bulk add — sometimes a single extraction envelope returns several
   *  orphans in one shot. Single timer covers them all. */
  addAll(readings: PendingReading[]): void {
    if (readings.length === 0) return;
    for (const r of readings) this.buffer.push(r);
    this.restartTimer();
  }

  /** Snapshot the buffer for the about-to-be-fired question. The caller
   *  later passes the inspector's "circuit N" reply alongside this
   *  snapshot to apply the buffered readings to the named circuit. */
  snapshotForQuestion(): PendingReading[] {
    this.snapshot = [...this.buffer];
    return [...this.snapshot];
  }

  /**
   * Drop pending entries that the inspector's reply resolved. Match on
   * field AND value (string-equal) — same shape iOS uses at
   * `TranscriptProcessor.swift:229-235`.
   */
  clearResolved(resolved: PendingReading[]): void {
    this.snapshot = [];
    this.buffer = this.buffer.filter(
      (pending) => !resolved.some((r) => r.field === pending.field && r.value === pending.value)
    );
    if (this.buffer.length === 0) {
      this.cancelTimer();
    }
  }

  /**
   * Drop pending entries that a later Sonnet extraction returned with
   * a resolved circuit (>= 1). iOS canon `removeResolvedReadings`
   * (`TranscriptProcessor.swift:266-276`). The caller filters Sonnet's
   * extracted readings to only those with a real circuit, then passes
   * the {field, value} pairs.
   */
  removeResolved(resolved: PendingReading[]): void {
    if (resolved.length === 0 || this.buffer.length === 0) return;
    this.buffer = this.buffer.filter(
      (pending) => !resolved.some((r) => r.field === pending.field && r.value === pending.value)
    );
    if (this.buffer.length === 0) {
      this.cancelTimer();
    }
  }

  /**
   * Cancel the self-retry timer when the server has already asked an
   * equivalent disambiguation question. iOS canon `suppressSelfRetry`
   * (`TranscriptProcessor.swift:259-263`). Pending entries STAY in the
   * buffer so the server's question answer (or a later resolved Sonnet
   * extraction) can still clear them.
   */
  suppressSelfRetry(field: string): void {
    if (!this.buffer.some((p) => p.field === field)) return;
    this.cancelTimer();
  }

  /** Drop everything. Use on session reset / teardown. */
  reset(): void {
    this.buffer = [];
    this.snapshot = [];
    this.cancelTimer();
  }

  get size(): number {
    return this.buffer.length;
  }

  get hasTimer(): boolean {
    return this.timerHandle !== null;
  }

  /** Snapshot the live buffer — only for diagnostics / tests; do not
   *  mutate the returned array. */
  peek(): readonly PendingReading[] {
    return [...this.buffer];
  }

  /** Most recent snapshot taken via `snapshotForQuestion`. */
  lastSnapshot(): readonly PendingReading[] {
    return [...this.snapshot];
  }

  private restartTimer(): void {
    this.cancelTimer();
    const handle = this.schedule(() => {
      // Defensive — buffer may have drained during the wait.
      if (this.buffer.length === 0) {
        this.timerHandle = null;
        return;
      }
      // Idempotency — null the handle before invoking the callback so
      // a re-entrant `add()` inside the callback can arm a fresh timer.
      this.timerHandle = null;
      this.onTimeout([...this.buffer]);
    }, this.timeoutMs);
    this.timerHandle = handle;
  }

  private cancelTimer(): void {
    if (this.timerHandle !== null) {
      this.clearTimer(this.timerHandle);
      this.timerHandle = null;
    }
  }
}

/**
 * Map Sonnet field name → user-friendly spoken form. iOS canon
 * `TranscriptProcessor.swift:friendlyFieldName` (~line 289+). Verbatim
 * port — keep these in sync.
 *
 * Used to format the "Which circuit was that <NAME> <VALUE> for?"
 * question. The unmapped fallback is the field key itself, which keeps
 * the prompt understandable even when a new field arrives before this
 * map is updated.
 */
export function friendlyFieldName(field: string): string {
  switch (field) {
    case 'measured_zs_ohm':
    case 'zs':
      return 'Zs';
    case 'r1_r2_ohm':
    case 'r1_r2':
      return 'R1 plus R2';
    case 'ring_r1_ohm':
      return 'ring R1';
    case 'ring_rn_ohm':
      return 'ring RN';
    case 'ring_r2_ohm':
      return 'ring R2';
    case 'ir_live_earth_mohm':
      return 'insulation resistance live to earth';
    case 'ir_live_live_mohm':
      return 'insulation resistance live to live';
    case 'rcd_time_ms':
      return 'RCD trip time';
    case 'polarity_confirmed':
      return 'polarity';
    case 'ocpd_rating_a':
      return 'OCPD rating';
    default:
      return field;
  }
}

/** Minimal reading shape the classifier needs (subset of the wire
 *  `ExtractionResult.readings[]` entry). */
export interface ClassifiableReading {
  field?: unknown;
  value?: unknown;
  circuit?: unknown;
}

export interface ClassifiedReadings {
  /** Circuit-attributed readings — resolve matching buffered orphans. */
  resolved: PendingReading[];
  /** Circuit-less circuit readings — enter the 2s disambiguation buffer. */
  orphans: PendingReading[];
  /** Circuit-less SECTION readings (A2 rescue) — already applied by
   *  `applyExtraction`; must NEVER enter the buffer (iOS `supplyFields`
   *  rescue, DeepgramRecordingViewModel.swift:5430). */
  rescued: PendingReading[];
}

/**
 * Orphan classifier for the pending-readings buffer — the decision that was
 * inline in recording-context `onExtraction` (extracted 2026-07-08 with the
 * A2 fix; behaviour identical apart from the new rescue branch).
 *
 * iOS canon: readings with `circuit == -1` buffer UNLESS the field is in the
 * `supplyFields` rescue set (section-level fields need no circuit and were
 * already applied). Pre-fix the web classifier buffered EVERY `circuit < 1`
 * reading, so a dictated client name produced a false "Which circuit was
 * that client_name reading for?" ask (sess_mrbnds2d_jczh, A2).
 */
export function classifyReadingsForBuffer(
  readings: readonly ClassifiableReading[],
  isNonCircuit: (field: string) => boolean
): ClassifiedReadings {
  const resolved: PendingReading[] = [];
  const orphans: PendingReading[] = [];
  const rescued: PendingReading[] = [];
  for (const r of readings) {
    if (!r || typeof r.field !== 'string' || r.field.length === 0) continue;
    const value =
      typeof r.value === 'string' ? r.value : r.value == null ? '' : String(r.value as unknown);
    if (typeof r.circuit === 'number' && r.circuit >= 1) {
      resolved.push({ field: r.field, value });
    } else if (isNonCircuit(r.field)) {
      rescued.push({ field: r.field, value });
    } else {
      orphans.push({ field: r.field, value });
    }
  }
  return { resolved, orphans, rescued };
}

/**
 * Build the conversational disambiguation question that the timer
 * callback speaks. Mirrors iOS canon `askAboutPendingReadings`
 * (`DeepgramRecordingViewModel.swift:5422-5426`).
 */
export function buildPendingReadingsQuestion(readings: readonly PendingReading[]): string {
  if (readings.length === 0) return '';
  const valuesText = readings.map((r) => `${friendlyFieldName(r.field)} ${r.value}`).join(', ');
  return readings.length === 1
    ? `Which circuit was that ${valuesText} reading for?`
    : `Which circuit were those readings for? ${valuesText}`;
}
