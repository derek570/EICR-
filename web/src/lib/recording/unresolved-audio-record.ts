/**
 * PLAN-E-TERM (T2) — the post-session unresolved-audio RECORD.
 *
 * Whatever loss PLAN-E2 counted as MATERIAL but never spoke — an episode
 * still open when the inspector pressed Stop, a disclosure clip Stop cut
 * off mid-playback, a pre-open window that never met its open — becomes a
 * PERSISTED, VISIBLE record instead of a spoken one. Nothing here speaks;
 * `stop()`, `performStopCleanup()` and `cancelSpeech` are untouched.
 *
 * Lifecycle (the state matrix — one row per material `LossSourceId`):
 *
 *   event                                    | resolved_via written
 *   -----------------------------------------|--------------------------
 *   material accrual (first debounced run)   | row UPSERTED, null
 *   evidence changes while still unresolved  | window/duration updated
 *   disclosure token NATURAL completion      | `completion`
 *   E2 `uplink_loss_episode_retired_immaterial`| `retired_immaterial`
 *   banner dismissed                         | `dismissed`
 *   PDF success, session NOT active          | `certificate_cleared`
 *   PDF success, session STILL active        | (row survives untouched)
 *   Stop / owned close / app kill            | (nothing — row stays open)
 *   account sign-out                         | row DELETED (sole purge)
 *
 * `resolved_via` is the ONE terminal field; a non-null value is never
 * overwritten (first terminal wins). Presentation booleans are derived,
 * never stored. Rows are tombstones — nothing but the purge deletes.
 *
 * Reconciliation (tests 6/6a/6b):
 *   stored_rows  == material                                   (pre-purge)
 *   open_records == material − disclosure_completed − retired_immaterial
 *                   − dismissed − certificate_cleared
 *
 * This module is pure (no IDB, no React) so the matrix is unit-testable;
 * `unresolved-audio-store.ts` is the IDB port. Swift twin:
 * `UnresolvedAudioStore.swift` (binder + store in one file).
 */

import type { CaptureWallClock } from './capture-wall-clock';
import {
  lossSourceIdKey,
  type LossSourceEvidence,
  type LossSourceId,
  type UplinkLossTelemetryEvent,
} from './uplink-loss-ledger';
import { UPLINK_SAMPLE_RATE_HZ } from './sample-offset';

export type UnresolvedAudioResolvedVia =
  | 'completion'
  | 'retired_immaterial'
  | 'dismissed'
  | 'certificate_cleared';

export const UNRESOLVED_AUDIO_RESOLVED_VIA: readonly UnresolvedAudioResolvedVia[] = [
  'completion',
  'retired_immaterial',
  'dismissed',
  'certificate_cleared',
];

export interface UnresolvedAudioRecord {
  /** `${recordingSessionId}|${lossSourceKey}` — the IDB keyPath. */
  readonly key: string;
  readonly userId: string;
  readonly jobId: string;
  readonly recordingSessionId: string;
  /** `lossSourceIdKey(sourceId)` — `episode:1` / `preOpenWindow:1` / `stagedLoss:1`. */
  readonly lossSourceKey: string;
  /** CAPTURE-time wall-clock window (epoch ms), never write-time. */
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  /** Voiced evidence duration in ms (sum of the source's voiced ranges). */
  readonly voicedDurationMs: number;
  /** The single terminal field. `null` = still open. */
  readonly resolvedVia: UnresolvedAudioResolvedVia | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function unresolvedAudioKey(recordingSessionId: string, lossSourceKey: string): string {
  return `${recordingSessionId}|${lossSourceKey}`;
}

/** Persistence port the binder writes through. Both ops are serialised by
 *  the port; the binder never awaits them (loss-event paths are sync). */
export interface UnresolvedAudioPort {
  upsert(record: UnresolvedAudioRecord): void;
  resolve(key: string, via: UnresolvedAudioResolvedVia): void;
}

/**
 * Merge an incoming upsert onto an existing row: identity + createdAt are
 * kept, evidence fields refresh, and a NON-NULL `resolvedVia` is never
 * overwritten (tombstone rule). Shared by the IDB port and the in-memory
 * test port so both obey the same matrix.
 */
export function mergeUnresolvedAudioRecord(
  existing: UnresolvedAudioRecord | null,
  incoming: UnresolvedAudioRecord
): UnresolvedAudioRecord {
  if (!existing) return incoming;
  return {
    ...existing,
    windowStartMs: incoming.windowStartMs,
    windowEndMs: incoming.windowEndMs,
    voicedDurationMs: incoming.voicedDurationMs,
    updatedAt: incoming.updatedAt,
    resolvedVia: existing.resolvedVia ?? incoming.resolvedVia,
  };
}

export function resolveUnresolvedAudioRecord(
  existing: UnresolvedAudioRecord,
  via: UnresolvedAudioResolvedVia,
  now: number
): UnresolvedAudioRecord {
  if (existing.resolvedVia !== null) return existing; // first terminal wins
  return { ...existing, resolvedVia: via, updatedAt: now };
}

export interface UnresolvedAudioBinderOptions {
  readonly userId: string;
  readonly jobId: string;
  readonly recordingSessionId: string;
  readonly clock: CaptureWallClock;
  readonly port: UnresolvedAudioPort;
  readonly now?: () => number;
}

/**
 * Binds ONE recording session's loss ledger + disclosure ledger events to
 * the durable store. Identity is INJECTED at session start (the recording
 * layer holds user + job there); the ledgers never look identity up.
 */
export class UnresolvedAudioBinder {
  private readonly now: () => number;
  private readonly createdAt = new Map<string, number>();

  constructor(private readonly options: UnresolvedAudioBinderOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get recordingSessionId(): string {
    return this.options.recordingSessionId;
  }

  /** The loss ledger's `onSourceEvidence` — fired at material accrual and
   *  on every later evidence change of a material source. The window is
   *  derived from the CAPTURE sample range through the session's piecewise
   *  wall-clock, never from `Date.now()` at write time. */
  onSourceEvidence(sourceId: LossSourceId, evidence: LossSourceEvidence): void {
    const window = this.options.clock.windowOf(evidence.captureSampleRange);
    if (!window) return; // no anchor yet — nothing captured, cannot happen post-start
    const lossSourceKey = lossSourceIdKey(sourceId);
    const key = unresolvedAudioKey(this.options.recordingSessionId, lossSourceKey);
    const now = this.now();
    const createdAt = this.createdAt.get(key) ?? now;
    this.createdAt.set(key, createdAt);
    this.options.port.upsert({
      key,
      userId: this.options.userId,
      jobId: this.options.jobId,
      recordingSessionId: this.options.recordingSessionId,
      lossSourceKey,
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
      voicedDurationMs: (evidence.voicedSamples * 1000) / UPLINK_SAMPLE_RATE_HZ,
      resolvedVia: null,
      createdAt,
      updatedAt: now,
    });
  }

  /** The loss ledger's telemetry stream — ONLY `retired_immaterial` is a
   *  TERM terminal (split-round-22: TERM never infers retirement itself). */
  onLedgerTelemetry(event: UplinkLossTelemetryEvent, payload: Record<string, unknown>): void {
    if (event !== 'uplink_loss_episode_retired_immaterial') return;
    const source = payload.source;
    if (typeof source !== 'string') return;
    this.options.port.resolve(
      unresolvedAudioKey(this.options.recordingSessionId, source),
      'retired_immaterial'
    );
  }

  /** The disclosure ledger's NATURAL completion of a token: every covered
   *  loss source resolves `completion` (source-cardinal). Session-fenced —
   *  a token from another session never resolves this session's rows. */
  onDisclosureCompleted(sessionId: string, coveredLossSourceIds: readonly LossSourceId[]): void {
    if (sessionId !== this.options.recordingSessionId) return;
    for (const id of coveredLossSourceIds) {
      this.options.port.resolve(
        unresolvedAudioKey(this.options.recordingSessionId, lossSourceIdKey(id)),
        'completion'
      );
    }
  }
}

// ── Visibility + presentation ──────────────────────────────────────────

export interface UnresolvedAudioVisibilityContext {
  readonly userId: string | null;
  readonly jobId: string | null;
  /** Recording sessions currently ACTIVE on this client. */
  readonly activeSessionIds: ReadonlySet<string>;
}

/** The pinned predicate: unresolved AND (not dismissed — a tombstone
 *  state) AND current user+job AND its recording session is NO LONGER
 *  active. An entry is written during active recovery, so raw rows would
 *  surface a recoverable episode prematurely. */
export function isUnresolvedAudioVisible(
  record: UnresolvedAudioRecord,
  ctx: UnresolvedAudioVisibilityContext
): boolean {
  if (record.resolvedVia !== null) return false;
  if (ctx.userId === null || record.userId !== ctx.userId) return false;
  if (ctx.jobId === null || record.jobId !== ctx.jobId) return false;
  if (ctx.activeSessionIds.has(record.recordingSessionId)) return false;
  return true;
}

/** Certificate completion terminalizes ONLY rows whose recording session
 *  is NOT in the client's active-session set at the success instant. */
export function selectCertificateClearable(
  records: readonly UnresolvedAudioRecord[],
  ctx: {
    readonly userId: string;
    readonly jobId: string;
    readonly activeSessionIds: ReadonlySet<string>;
  }
): UnresolvedAudioRecord[] {
  return records.filter(
    (r) =>
      r.resolvedVia === null &&
      r.userId === ctx.userId &&
      r.jobId === ctx.jobId &&
      !ctx.activeSessionIds.has(r.recordingSessionId)
  );
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatUnresolvedAudioClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * The visual line. CAUSE-NEUTRAL and UNCERTAINTY-PRESERVING: dispatched-
 * but-unwatermarked audio is UNRESOLVED, not confirmed lost — it may
 * already be in the certificate — so the text never says "was lost" or
 * "couldn't be transcribed". Distinct from every SPOKEN family (it is
 * never spoken; PLAN-C's distinctness fixture covers spoken strings only).
 */
export function formatUnresolvedAudioBannerText(record: UnresolvedAudioRecord): string {
  const seconds = Math.max(1, Math.round(record.voicedDurationMs / 1000));
  const clock = formatUnresolvedAudioClock(record.windowStartMs);
  return `Some dictation during this session (~${seconds}s around ${clock}) may not have been transcribed — check that window and repeat only readings that are missing.`;
}

// ── Reconciliation (tests 6 / 6a / 6b) ─────────────────────────────────

export interface UnresolvedAudioCounters {
  readonly material: number;
  readonly disclosureCompleted: number;
  readonly retiredImmaterial: number;
}

export interface UnresolvedAudioReconciliation {
  readonly storedRows: number;
  readonly openRecords: number;
  readonly dismissed: number;
  readonly certificateCleared: number;
  readonly completion: number;
  readonly retiredImmaterial: number;
  /** `stored_rows == material` (pre-purge). */
  readonly storedRowsHold: boolean;
  /** `open_records == material − completed − retired_immaterial − dismissed − certificate_cleared`. */
  readonly openRecordsHold: boolean;
}

export function reconcileUnresolvedAudio(
  records: readonly UnresolvedAudioRecord[],
  counters: UnresolvedAudioCounters
): UnresolvedAudioReconciliation {
  const byVia = (via: UnresolvedAudioResolvedVia): number =>
    records.filter((r) => r.resolvedVia === via).length;
  const openRecords = records.filter((r) => r.resolvedVia === null).length;
  const dismissed = byVia('dismissed');
  const certificateCleared = byVia('certificate_cleared');
  const expectedOpen =
    counters.material -
    counters.disclosureCompleted -
    counters.retiredImmaterial -
    dismissed -
    certificateCleared;
  return {
    storedRows: records.length,
    openRecords,
    dismissed,
    certificateCleared,
    completion: byVia('completion'),
    retiredImmaterial: byVia('retired_immaterial'),
    storedRowsHold: records.length === counters.material,
    openRecordsHold: openRecords === expectedOpen,
  };
}
