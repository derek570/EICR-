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

/** PLAN-E-TERM — a MATERIAL source's current voiced evidence, in the
 *  CAPTURE sample domain: the hull of its unretired ranges plus their
 *  merged voiced length. No wall-clock, no PCM — the durable record derives
 *  its window through the session's piecewise capture→wall map. */
export interface LossSourceEvidence {
  readonly captureSampleRange: CaptureSampleRange;
  readonly voicedSamples: number;
}

export function summariseSourceEvidence(
  entries: readonly LedgerEntry[]
): LossSourceEvidence | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort(
    (a, b) => a.captureSampleRange.start - b.captureSampleRange.start
  );
  let voiced = 0;
  let runStart = sorted[0].captureSampleRange.start;
  let runEnd = sorted[0].captureSampleRange.end;
  let hullEnd = runEnd;
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i].captureSampleRange;
    if (r.end > hullEnd) hullEnd = r.end;
    if (r.start <= runEnd) {
      if (r.end > runEnd) runEnd = r.end;
    } else {
      voiced += runEnd - runStart;
      runStart = r.start;
      runEnd = r.end;
    }
  }
  voiced += runEnd - runStart;
  return {
    captureSampleRange: { start: sorted[0].captureSampleRange.start, end: hullEnd },
    voicedSamples: voiced,
  };
}

export interface UplinkLossLedgerOptions {
  readonly recordingSessionId: string;
  /** Fires ONCE per successful open that has ≥1 material pending source,
   *  after every hold has released. The delivery ledger mints/joins a
   *  token from these ids. */
  readonly onDisclosureReady: (sourceIds: LossSourceId[]) => void;
  readonly telemetry?: (event: UplinkLossTelemetryEvent, payload: Record<string, unknown>) => void;
  /** PLAN-E-TERM — fired when a source FIRST goes material (the same
   *  instant as `uplink_loss_episode_material`) and again whenever a
   *  material source's unretired evidence changes while still unresolved.
   *  Additive: E2's behaviour is byte-for-byte unchanged without it. */
  readonly onSourceEvidence?: (sourceId: LossSourceId, evidence: LossSourceEvidence) => void;
}

interface Episode {
  readonly sourceId: LossSourceId;
  entries: LedgerEntry[];
  /** The epochs whose UNOWNED close/failure opened or joined THIS episode.
   *  An epoch-scoped report may only join an episode it belongs to — Codex
   *  E2 cycle-3: without this, an old epoch's late report leaked into a
   *  later, unrelated outage episode (a false / double disclosure). */
  readonly failedEpochs: Set<ConnectionEpoch>;
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
  const sorted = [...entries].sort(
    (a, b) => a.captureSampleRange.start - b.captureSampleRange.start
  );
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
  private readonly onSourceEvidence: UplinkLossLedgerOptions['onSourceEvidence'];

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
  /** Epochs whose episode was MATERIAL and disclosed. A late report for such
   *  an epoch is ABSORBED (the inspector already heard the cause-agnostic
   *  prompt) — Codex E2 cycle-4. A closed epoch NOT here still has undisclosed
   *  loss, so its late report discloses at the next open. */
  private readonly disclosedEpochs = new Set<ConnectionEpoch>();

  private holds = 0;
  private pendingRelease: LossSourceId[] | null = null;
  /** An open observed WHILE a hold was outstanding is a disclosure MOMENT
   *  regardless of whether material existed at that instant — a late
   *  staged/pre-open report landing before the hold releases must join it.
   *  Codex E2 cycle-3: a staged-only late report was otherwise stranded
   *  until an unrelated later open. */
  private heldOpenPending = false;

  constructor(options: UplinkLossLedgerOptions) {
    this.recordingSessionId = options.recordingSessionId;
    this.onDisclosureReady = options.onDisclosureReady;
    this.telemetry = options.telemetry;
    this.onSourceEvidence = options.onSourceEvidence;
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
    // Only an OWNED (deliberate) close drops the report — a deliberate
    // stop/pause is not an outage. An UNOWNED older epoch's residue IS
    // real evidence: `attribute()` routes it into that epoch's open
    // episode, or holds it inert against a dead epoch that never reopens
    // (never re-disclosed). Codex E2 cycle-2 reverted the cycle-1
    // `report.epoch < liveEpoch` guard, which wrongly dropped a genuine
    // late failed-send whose unowned close had opened an episode.
    if (this.ownedEpochs.has(report.epoch)) return;
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
    if (this.openEpisode) {
      const before = this.openEpisode.entries.length;
      this.openEpisode.entries = retire(this.openEpisode.entries);
      // PLAN-E-TERM — a material episode whose evidence shrank refreshes
      // its durable record (window/duration); emptied entirely, it stays
      // as-is until the next open resolves it `retired_immaterial`.
      if (
        this.openEpisode.entries.length !== before &&
        this.materialEmitted.has(lossSourceIdKey(this.openEpisode.sourceId))
      ) {
        this.publishEvidence(this.openEpisode.sourceId, this.openEpisode.entries);
      }
    }
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
        failedEpochs: new Set<ConnectionEpoch>(),
      };
    }
    this.openEpisode.failedEpochs.add(epoch);
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
        // This episode WILL disclose — mark its epochs so a late report for
        // any of them is absorbed, not re-disclosed.
        for (const fe of episode.failedEpochs) this.disclosedEpochs.add(fe);
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
    if (material.length === 0 && this.holds === 0) return;
    // A moment already PARKED behind a hold is JOINED, never overwritten:
    // two material opens under one outstanding hold release together.
    if (material.length > 0) {
      this.pendingRelease = mergeSourceIds(this.pendingRelease ?? [], material);
    }
    if (this.holds > 0) {
      // Parked: even an empty-material open under a hold is a moment, so a
      // late staged/pre-open report joins it when the hold releases.
      this.heldOpenPending = true;
      return;
    }
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
    if (this.holds > 0) return;
    if (!this.heldOpenPending && !this.pendingRelease) return;
    this.heldOpenPending = false;
    const ids = this.pendingRelease ?? [];
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
    const all = mergeSourceIds(ids, late);
    // Only an actual non-empty moment speaks (an empty held-open moment that
    // accrued nothing simply closes silently).
    if (all.length > 0) this.onDisclosureReady(all);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private attribute(entry: LedgerEntry): void {
    if (entry.epochScope.kind === 'epoch') {
      const e = entry.epochScope.id;
      if (this.ownedEpochs.has(e)) return; // deliberate close — drop
      // An epoch-scoped report joins the open episode ONLY if that epoch
      // is a member of it (Codex E2 cycle-3). Otherwise it belongs to its
      // own epoch's future episode.
      if (this.openEpisode?.failedEpochs.has(e)) {
        this.openEpisode.entries.push(entry);
        this.emitMaterialIfDebounced(this.openEpisode.sourceId, this.openEpisode.entries);
        return;
      }
      if (this.closedEpochs.has(e)) {
        // e already CLOSED (unowned — owned returned above) and its episode
        // is gone. If that episode disclosed, absorb (already told the
        // inspector). Otherwise this is genuine UNdisclosed late loss on a
        // dead epoch → the pre-open window discloses it at the next open,
        // rather than stranding it in a bucket its epoch never drains
        // (Codex E2 cycle-4).
        if (this.disclosedEpochs.has(e)) return;
        // fall through to the pre-open window below.
      } else if (this.openedEpochs.has(e)) {
        // opened, still open (mid-connection): waits for its own close.
        const list = this.dispatchedByEpoch.get(e);
        if (list) list.push(entry);
        else this.dispatchedByEpoch.set(e, [entry]);
        return;
      }
      // e not opened yet (handshake), or closed-undisclosed → pre-open below.
    } else if (this.openEpisode) {
      // A pre-open-scoped capture during an outage joins the open episode.
      this.openEpisode.entries.push(entry);
      this.emitMaterialIfDebounced(this.openEpisode.sourceId, this.openEpisode.entries);
      return;
    }
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
    const key = lossSourceIdKey(sourceId);
    if (this.materialEmitted.has(key)) {
      // PLAN-E-TERM — already material: evidence changed (a later entry
      // joined). The durable record refreshes its window from it.
      this.publishEvidence(sourceId, entries);
      return;
    }
    if (!hasDebouncedVoicedRun(entries)) return;
    this.materialEmitted.add(key);
    this.telemetry?.('uplink_loss_episode_material', { source: key });
    this.publishEvidence(sourceId, entries);
  }

  /** PLAN-E-TERM — hand a MATERIAL source's current evidence hull to the
   *  durable-record binder. Skipped when nothing remains unretired (that
   *  case resolves through `retired_immaterial` at the next open). */
  private publishEvidence(sourceId: LossSourceId, entries: readonly LedgerEntry[]): void {
    if (!this.onSourceEvidence) return;
    const evidence = summariseSourceEvidence(entries);
    if (evidence) this.onSourceEvidence(sourceId, evidence);
  }

  private discardAllUnresolved(): void {
    this.dispatchedByEpoch.clear();
    this.openEpisode = null;
    this.preOpenWindow = null;
    this.stagedSources.length = 0;
    this.pendingRelease = null;
    // Codex E2 cycle-4 — a stale held-open moment must not survive an owned
    // discard: material accrued afterward would otherwise release when the
    // OLD hold ends, before its own successful open.
    this.heldOpenPending = false;
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
    return this.pendingRelease !== null || this.heldOpenPending;
  }
}
