/**
 * PLAN-E2 — the recording-session ledger of UNRESOLVED VOICED AUDIO.
 *
 * ONE ledger, ONE question: is there voiced audio this client accepted from
 * the tap and cannot account for? The answer decides whether the single
 * cause-agnostic disclosure line is spoken after the next successful
 * socket open. Nothing here retains PCM, measures a duration, or picks a
 * wording — the round-22 collapse deleted all of that.
 *
 * Entries (all VOICED by construction — a silent range never enters):
 *  - `undispatched`  — accepted from the tap, never handed to a socket
 *                      (the AUDIO_DROPPED branch / a caught send failure).
 *  - `dispatched`    — handed to the socket, not yet PROVEN processed by the
 *                      vendor's audio-progress watermark. Retires when the
 *                      SAME epoch's watermark passes its dispatched range.
 *  - `encoderResidue`— PLAN-E1's `onUndispatchedLoss` seam (variant d).
 *  - `staged`        — staged/replay audio a staging owner discarded or
 *                      overflowed (variants c/e). Never dispatched, so it
 *                      retires only via disclosure.
 *
 * Loss SOURCES (`LossSourceId`): an `episode` (first unowned transport
 * failure → first successful open), a `preOpenWindow` (capture before any
 * socket exists for the current capture attempt), or a `stagedLoss` (one
 * per staged report). Every counter and every disclosure token keys on
 * `LossSourceId`, so staged loss reconciles exactly like an episode.
 *
 * Close OWNERSHIP answers only "is this an outage?": an owned close
 * (`disconnect()`) opens no episode and DISCARDS every unresolved entry —
 * graceful-close accounting is the named "graceful-stop end-to-end drain"
 * follow-up, deliberately not this plan.
 *
 * Counters (each fires at most once per `LossSourceId`):
 *  - `uplink_loss_episode_material`            — first material accrual.
 *  - `uplink_loss_episode_retired_immaterial`  — an `episode` whose evidence
 *    ALL retired through the watermark before its disclosure moment (only
 *    an episode can — nothing else ever dispatched).
 *  - `uplink_loss_episode_disclosed` is emitted by the DELIVERY ledger at
 *    token association (`uplink-loss-disclosure.ts`), not here.
 *
 * The Swift twin is `Sources/Services/UplinkLossLedger.swift`; keep the
 * state matrix identical.
 */

import type { ConnectionEpoch, EpochScope } from './uplink-scope-allocator';
import type { CaptureSampleRange } from './tagged-pcm-segment';
import type { UndispatchedLossReport } from './uplink-loss-report';
import { MATERIAL_VOICED_DEBOUNCE_SAMPLES, classifyPcmEnergy } from './voiced-activity';

export type LossSourceId =
  | { readonly kind: 'episode'; readonly id: number }
  | { readonly kind: 'preOpenWindow'; readonly id: number }
  | { readonly kind: 'stagedLoss'; readonly id: number };

export function lossSourceIdKey(id: LossSourceId): string {
  return `${id.kind}:${id.id}`;
}

function mergeSourceIds(base: LossSourceId[], extra: readonly LossSourceId[]): LossSourceId[] {
  const seen = new Set(base.map(lossSourceIdKey));
  for (const id of extra) {
    const key = lossSourceIdKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    base.push(id);
  }
  return base;
}

export type LedgerEntryVariant = 'undispatched' | 'dispatched' | 'encoderResidue' | 'staged';

export interface LedgerEntry {
  readonly variant: LedgerEntryVariant;
  readonly recordingSessionId: string;
  readonly epochScope: EpochScope;
  readonly captureSampleRange: CaptureSampleRange;
  /** Half-open ABSOLUTE dispatched-stream sample range `[start, end)` —
   *  present ONLY for `dispatched` entries. The two domains (capture vs
   *  dispatched) are never compared with each other. */
  readonly dispatchedSampleRange: CaptureSampleRange | null;
  /** The socket epoch the entry was DISPATCHED on (not its capture scope —
   *  a preOpen-captured replay dispatches on a later epoch). Only
   *  `dispatched` entries carry one; only that epoch's watermark retires it. */
  readonly dispatchEpoch: ConnectionEpoch | null;
}

export type UplinkLossTelemetryEvent =
  | 'uplink_loss_episode_material'
  | 'uplink_loss_episode_retired_immaterial';

export interface HoldToken {
  release(): void;
}

export interface UplinkLossLedgerOptions {
  readonly recordingSessionId: string;
  /** Fires ONCE per successful open that has ≥1 material pending source,
   *  after every hold has released. The delivery ledger mints/joins a
   *  token from these ids. */
  readonly onDisclosureReady: (sourceIds: LossSourceId[]) => void;
  readonly telemetry?: (event: UplinkLossTelemetryEvent, payload: Record<string, unknown>) => void;
}

interface Episode {
  readonly sourceId: LossSourceId;
  entries: LedgerEntry[];
}

interface PreOpenWindow {
  readonly sourceId: LossSourceId;
  entries: LedgerEntry[];
}

interface StagedSource {
  readonly sourceId: LossSourceId;
  /** One staged report = one source; contiguous per-segment reports of
   *  the SAME discarded window coalesce into it (the staging owner may
   *  report a queue segment by segment). */
  entries: LedgerEntry[];
}

/** The plan's ONE materiality primitive: a source is MATERIAL iff its
 *  unretired voiced entries contain a CONTIGUOUS (capture-domain) run of
 *  at least `MATERIAL_VOICED_DEBOUNCE_SAMPLES`. Entries are voiced by
 *  construction (silent frames never enter), so contiguity of entries IS
 *  the debounced voiced segment. No duration is stored or spoken. */
export function hasDebouncedVoicedRun(entries: readonly LedgerEntry[]): boolean {
  if (entries.length === 0) return false;
  const sorted = [...entries].sort((a, b) => a.captureSampleRange.start - b.captureSampleRange.start);
  let runStart = sorted[0].captureSampleRange.start;
  let runEnd = sorted[0].captureSampleRange.end;
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i].captureSampleRange;
    if (r.start <= runEnd) {
      if (r.end > runEnd) runEnd = r.end;
    } else {
      if (runEnd - runStart >= MATERIAL_VOICED_DEBOUNCE_SAMPLES) return true;
      runStart = r.start;
      runEnd = r.end;
    }
  }
  return runEnd - runStart >= MATERIAL_VOICED_DEBOUNCE_SAMPLES;
}

export class UplinkLossLedger {
  private readonly recordingSessionId: string;
  private readonly onDisclosureReady: (sourceIds: LossSourceId[]) => void;
  private readonly telemetry: UplinkLossLedgerOptions['telemetry'];

  private nextEpisodeId = 1;
  private nextStagedId = 1;

  /** The most recently OPENED socket epoch (set only on a successful open). */
  private liveEpoch: ConnectionEpoch | null = null;
  /** Every epoch that reached a successful open. A drop stamped with an
   *  epoch NOT in this set happened during that socket's handshake — web
   *  mints the epoch at socket CONSTRUCTION, so "capture before open" can
   *  carry either a `preOpen` scope or a not-yet-opened `epoch` scope. */
  private readonly openedEpochs = new Set<ConnectionEpoch>();
  /** Epochs whose close has been classified (owned or not). A failure
   *  signal for one of these is stale and ignored. */
  private readonly closedEpochs = new Set<ConnectionEpoch>();
  /** Epochs closed by `disconnect()` — reports stamped with one are dropped. */
  private readonly ownedEpochs = new Set<ConnectionEpoch>();
  private openEpisode: Episode | null = null;
  /** The ONE pending capture-before-open window (session start → first
   *  open, pause→resume → reopen, any capture-before-open generation).
   *  Every such range pending at one open coalesces into one source. */
  private preOpenWindow: PreOpenWindow | null = null;
  private nextWindowId = 1;
  private readonly stagedSources: StagedSource[] = [];
  /** Per-epoch UNRESOLVED voiced entries with no source yet: the
   *  dispatched-but-unretired tail plus any mid-connection drops. Carried
   *  into the episode an unowned close opens; discarded by an owned one. */
  private readonly dispatchedByEpoch = new Map<ConnectionEpoch, LedgerEntry[]>();
  private readonly materialEmitted = new Set<string>();
  private readonly retiredImmaterialEmitted = new Set<string>();

  private holds = 0;
  private pendingRelease: LossSourceId[] | null = null;

  constructor(options: UplinkLossLedgerOptions) {
    this.recordingSessionId = options.recordingSessionId;
    this.onDisclosureReady = options.onDisclosureReady;
    this.telemetry = options.telemetry;
  }

  // ── Sender-facing inputs ─────────────────────────────────────────────

  /** A VOICED-or-not frame handed to the socket. Silent frames are dropped
   *  here; voiced ones wait for the same epoch's watermark. */
  recordDispatched(input: {
    readonly dispatchEpoch: ConnectionEpoch;
    readonly epochScope: EpochScope;
    readonly captureSampleRange: CaptureSampleRange;
    readonly dispatchedSampleRange: CaptureSampleRange;
    readonly voiced: boolean;
  }): void {
    if (!input.voiced) return;
    if (this.closedEpochs.has(input.dispatchEpoch)) return;
    const entry: LedgerEntry = {
      variant: 'dispatched',
      recordingSessionId: this.recordingSessionId,
      epochScope: input.epochScope,
      captureSampleRange: input.captureSampleRange,
      dispatchedSampleRange: input.dispatchedSampleRange,
      dispatchEpoch: input.dispatchEpoch,
    };
    const list = this.dispatchedByEpoch.get(input.dispatchEpoch);
    if (list) list.push(entry);
    else this.dispatchedByEpoch.set(input.dispatchEpoch, [entry]);
  }

  /** Accepted from the tap, never handed to any socket (variant a). The
   *  snapshot is classified here and NOT retained. */
  recordDropped(input: {
    readonly epochScope: EpochScope;
    readonly captureSampleRange: CaptureSampleRange;
    readonly samples: Int16Array;
  }): void {
    if (!classifyPcmEnergy(input.samples)) return;
    this.attribute({
      variant: 'undispatched',
      recordingSessionId: this.recordingSessionId,
      epochScope: input.epochScope,
      captureSampleRange: input.captureSampleRange,
      dispatchedSampleRange: null,
      dispatchEpoch: null,
    });
  }

  /** PLAN-E1's `onUndispatchedLoss` seam, bound here (variant d). */
  recordUndispatchedLoss(report: UndispatchedLossReport): void {
    if (report.recordingSessionId !== this.recordingSessionId) return;
    if (this.closedEpochs.has(report.epoch) && this.ownedEpochs.has(report.epoch)) return;
    // A LATE failed-send completion from a superseded socket (an epoch
    // older than the one that has since opened) is stale: its loss was
    // settled at that epoch's close. Close-time residue itself arrives
    // while the closing epoch is still the live one, so it is accepted.
    if (this.liveEpoch !== null && report.epoch < this.liveEpoch) return;
    if (!classifyPcmEnergy(report.samples)) return;
    this.attribute({
      variant: 'encoderResidue',
      recordingSessionId: this.recordingSessionId,
      epochScope: { kind: 'epoch', id: report.epoch },
      captureSampleRange: report.captureSampleRange,
      dispatchedSampleRange: null,
      dispatchEpoch: null,
    });
  }

  /** Staged audio a staging owner discarded or overwrote (variants c/e).
   *  Mints its OWN `stagedLoss` source; a silent report mints nothing. */
  recordStagedLoss(input: {
    readonly epochScope: EpochScope;
    readonly captureSampleRange: CaptureSampleRange;
    readonly voiced: boolean;
  }): LossSourceId | null {
    if (!input.voiced) return null;
    const entry: LedgerEntry = {
      variant: 'staged',
      recordingSessionId: this.recordingSessionId,
      epochScope: input.epochScope,
      captureSampleRange: input.captureSampleRange,
      dispatchedSampleRange: null,
      dispatchEpoch: null,
    };
    const sourceId: LossSourceId = { kind: 'stagedLoss', id: this.nextStagedId };
    // Contiguous with the most recent still-pending staged source (the
    // same discarded window reported segment by segment) → SAME source.
    const last = this.stagedSources[this.stagedSources.length - 1];
    if (last) {
      const lastEnd = Math.max(...last.entries.map((e) => e.captureSampleRange.end));
      if (input.captureSampleRange.start <= lastEnd) {
        last.entries.push(entry);
        this.emitMaterialIfDebounced(last.sourceId, last.entries);
        return last.sourceId;
      }
    }
    this.nextStagedId += 1;
    this.stagedSources.push({ sourceId, entries: [entry] });
    this.emitMaterialIfDebounced(sourceId, [entry]);
    return sourceId;
  }

  /** The vendor's audio-progress watermark for `epoch`, already converted
   *  to the ABSOLUTE dispatched-sample domain. Retires every `dispatched`
   *  entry of the SAME epoch whose range ends at or before it — wherever
   *  that entry now lives (still pending, or carried into an episode). A
   *  successor epoch's watermark never touches a predecessor's entries. */
  advanceWatermark(epoch: ConnectionEpoch, absoluteDispatchedSampleOffset: number): void {
    const retire = (entries: LedgerEntry[]): LedgerEntry[] =>
      entries.filter(
        (e) =>
          !(
            e.variant === 'dispatched' &&
            e.dispatchEpoch === epoch &&
            e.dispatchedSampleRange !== null &&
            e.dispatchedSampleRange.end <= absoluteDispatchedSampleOffset
          )
      );
    const pending = this.dispatchedByEpoch.get(epoch);
    if (pending) this.dispatchedByEpoch.set(epoch, retire(pending));
    if (this.openEpisode) this.openEpisode.entries = retire(this.openEpisode.entries);
  }

  // ── Close / failure / open classification ────────────────────────────

  /** `disconnect()` — a DELIBERATE end/suspend of the session's socket.
   *  Opens no episode; every unresolved entry is discarded; an open
   *  episode or pending window is abandoned unspoken (counted only). */
  onOwnedDisconnect(epoch: ConnectionEpoch | null): void {
    if (epoch !== null) {
      this.ownedEpochs.add(epoch);
      this.closedEpochs.add(epoch);
    }
    this.discardAllUnresolved();
  }

  /** The socket for `epoch` closed. `owned` comes from the ownership
   *  marker `disconnect()` set; `captureActive` from the tap owner's push. */
  onSocketClosed(
    epoch: ConnectionEpoch,
    input: { readonly owned: boolean; readonly captureActive: boolean }
  ): void {
    // Already classified (an error+close pair, or `disconnect()` already
    // marked this epoch owned and discarded): a LATE close callback must
    // not discard again — a successor socket's pre-open window may have
    // accrued in the meantime.
    if (this.closedEpochs.has(epoch)) return;
    if (input.owned) {
      this.onOwnedDisconnect(epoch);
      return;
    }
    // A late unowned close from a socket OLDER than the one that has
    // since opened is stale — never an outage on the live one.
    if (this.liveEpoch !== null && epoch < this.liveEpoch) return;
    this.closedEpochs.add(epoch);
    this.classifyUnownedFailure(epoch, input.captureActive);
  }

  /** A receive/transport failure signal for `epoch` (the socket may still
   *  be nominally open). Idempotent with `onSocketClosed`. */
  onSocketFailure(
    epoch: ConnectionEpoch,
    input: { readonly owned: boolean; readonly captureActive: boolean }
  ): void {
    if (input.owned || this.ownedEpochs.has(epoch)) return;
    if (this.closedEpochs.has(epoch)) return; // stale — a superseded socket
    if (this.liveEpoch !== null && epoch < this.liveEpoch) return; // late old-socket error
    this.classifyUnownedFailure(epoch, input.captureActive);
  }

  private classifyUnownedFailure(epoch: ConnectionEpoch, captureActive: boolean): void {
    const carried = this.dispatchedByEpoch.get(epoch) ?? [];
    this.dispatchedByEpoch.delete(epoch);
    if (!captureActive) {
      // Capture-INACTIVE close: no episode, and the epoch's unretired tail
      // has no source to belong to — it is dropped (2b: interruption/user
      // pause window → no episode, no disclosure).
      return;
    }
    if (!this.openEpisode) {
      this.openEpisode = {
        sourceId: { kind: 'episode', id: this.nextEpisodeId++ },
        entries: [],
      };
    }
    // Several failed attempts can precede one reopen — later failures join
    // the SAME episode; only a genuinely dispatched tail is carried.
    if (carried.length > 0) {
      this.openEpisode.entries.push(...carried);
      this.emitMaterialIfDebounced(this.openEpisode.sourceId, this.openEpisode.entries);
    }
  }

  /** A SUCCESSFUL open of `epoch` — the ONE disclosure moment. Closes the
   *  open episode and every pending window/staged source, evaluates
   *  materiality on what is still UNRETIRED, and (after holds) hands the
   *  material ids to the delivery ledger. */
  onSocketOpened(epoch: ConnectionEpoch): void {
    // Idempotent per epoch: a duplicate 'connected' observation for a
    // socket already counted as opened must not re-run the moment.
    if (this.openedEpochs.has(epoch)) return;
    this.liveEpoch = epoch;
    this.openedEpochs.add(epoch);
    const material: LossSourceId[] = [];

    if (this.openEpisode) {
      const episode = this.openEpisode;
      this.openEpisode = null;
      const key = lossSourceIdKey(episode.sourceId);
      if (hasDebouncedVoicedRun(episode.entries)) {
        material.push(episode.sourceId);
      } else if (this.materialEmitted.has(key) && !this.retiredImmaterialEmitted.has(key)) {
        this.retiredImmaterialEmitted.add(key);
        this.telemetry?.('uplink_loss_episode_retired_immaterial', { source: key });
      }
    }
    if (this.preOpenWindow) {
      if (hasDebouncedVoicedRun(this.preOpenWindow.entries)) {
        material.push(this.preOpenWindow.sourceId);
      }
      this.preOpenWindow = null;
    }
    for (const staged of this.stagedSources.splice(0)) {
      if (hasDebouncedVoicedRun(staged.entries)) material.push(staged.sourceId);
    }
    if (material.length === 0) return;
    // A moment already PARKED behind a hold is JOINED, never overwritten:
    // two material opens under one outstanding hold release together.
    this.pendingRelease = mergeSourceIds(this.pendingRelease ?? [], material);
    this.releaseIfUnheld();
  }

  /** Register a hold: the successful-open disclosure release PARKS while
   *  any hold is outstanding (E-WAKE binds this; dormant until then). */
  holdDisclosureRelease(): HoldToken {
    this.holds += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.holds -= 1;
        this.releaseIfUnheld();
      },
    };
  }

  private releaseIfUnheld(): void {
    if (this.holds > 0 || !this.pendingRelease) return;
    const ids = this.pendingRelease;
    this.pendingRelease = null;
    // A hold exists precisely so a LATE report (E-WAKE's staged ring loss,
    // reported from the `awaitOpen` continuation AFTER `onopen` fired)
    // lands BEFORE the release — anything that accrued while parked
    // joins this same moment rather than waiting for the next open.
    const late: LossSourceId[] = [];
    if (this.preOpenWindow) {
      if (hasDebouncedVoicedRun(this.preOpenWindow.entries)) late.push(this.preOpenWindow.sourceId);
      this.preOpenWindow = null;
    }
    for (const staged of this.stagedSources.splice(0)) {
      if (hasDebouncedVoicedRun(staged.entries)) late.push(staged.sourceId);
    }
    this.onDisclosureReady(mergeSourceIds(ids, late));
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private attribute(entry: LedgerEntry): void {
    if (this.openEpisode) {
      this.openEpisode.entries.push(entry);
      this.emitMaterialIfDebounced(this.openEpisode.sourceId, this.openEpisode.entries);
      return;
    }
    // Epoch-scoped loss on a socket that HAS opened, with no episode open
    // yet (a caught send failure, a mid-stream drop): hold it against that
    // epoch alongside the dispatched tail. It can never watermark-retire
    // (no dispatched range) and is carried into the episode an unowned
    // close opens — or discarded by an owned one.
    if (entry.epochScope.kind === 'epoch' && this.openedEpochs.has(entry.epochScope.id)) {
      const e = entry.epochScope.id;
      if (this.ownedEpochs.has(e)) return;
      const list = this.dispatchedByEpoch.get(e);
      if (list) list.push(entry);
      else this.dispatchedByEpoch.set(e, [entry]);
      return;
    }
    if (entry.epochScope.kind === 'epoch' && this.ownedEpochs.has(entry.epochScope.id)) return;
    // Capture BEFORE any open (a `preOpen` scope, or a handshake-window
    // `epoch` scope whose socket has not opened yet): the pending
    // pre-open window, disclosed once at the next successful open.
    if (!this.preOpenWindow) {
      this.preOpenWindow = {
        sourceId: { kind: 'preOpenWindow', id: this.nextWindowId++ },
        entries: [],
      };
    }
    this.preOpenWindow.entries.push(entry);
    this.emitMaterialIfDebounced(this.preOpenWindow.sourceId, this.preOpenWindow.entries);
  }

  /** `uplink_loss_episode_material` — ONCE per source, at the moment its
   *  unretired evidence first passes the debounced-voiced-run test. */
  private emitMaterialIfDebounced(sourceId: LossSourceId, entries: readonly LedgerEntry[]): void {
    if (!hasDebouncedVoicedRun(entries)) return;
    const key = lossSourceIdKey(sourceId);
    if (this.materialEmitted.has(key)) return;
    this.materialEmitted.add(key);
    this.telemetry?.('uplink_loss_episode_material', { source: key });
  }

  private discardAllUnresolved(): void {
    this.dispatchedByEpoch.clear();
    this.openEpisode = null;
    this.preOpenWindow = null;
    this.stagedSources.length = 0;
    this.pendingRelease = null;
  }

  // ── Introspection (tests / diagnostics) ───────────────────────────────

  get isEpisodeOpen(): boolean {
    return this.openEpisode !== null;
  }

  get openEpisodeSourceId(): LossSourceId | null {
    return this.openEpisode?.sourceId ?? null;
  }

  get unresolvedEntryCount(): number {
    let n = this.openEpisode?.entries.length ?? 0;
    for (const list of this.dispatchedByEpoch.values()) n += list.length;
    n += this.preOpenWindow?.entries.length ?? 0;
    for (const staged of this.stagedSources) n += staged.entries.length;
    return n;
  }

  get pendingPreOpenWindowCount(): number {
    return this.preOpenWindow ? 1 : 0;
  }

  get outstandingHoldCount(): number {
    return this.holds;
  }

  get isReleaseParked(): boolean {
    return this.pendingRelease !== null;
  }
}
