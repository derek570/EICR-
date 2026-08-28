/**
 * PLAN-E-TERM tests 1 / 3 / 4 (tombstone rule) / 5a / 5b / 6 / 6a / 6b —
 * the durable record's state matrix, driven through the REAL PLAN-E2
 * ledgers (`UplinkLossLedger` + `UplinkLossDisclosureLedger`) into an
 * in-memory port that obeys the same merge/resolve rules as the IDB port.
 *
 * Reconciliation (6/6a/6b) runs on COMPLETION, not mint:
 *   stored_rows  == material
 *   open_records == material − disclosure_completed − retired_immaterial
 *                   − dismissed − certificate_cleared
 */
import { describe, expect, it } from 'vitest';
import {
  UplinkLossLedger,
  lossSourceIdKey,
  summariseSourceEvidence,
  type LedgerEntry,
  type LossSourceId,
  type UplinkLossTelemetryEvent,
} from '@/lib/recording/uplink-loss-ledger';
import { UplinkLossDisclosureLedger } from '@/lib/recording/uplink-loss-disclosure';
import { CaptureWallClock } from '@/lib/recording/capture-wall-clock';
import {
  UnresolvedAudioBinder,
  formatUnresolvedAudioBannerText,
  isUnresolvedAudioVisible,
  mergeUnresolvedAudioRecord,
  reconcileUnresolvedAudio,
  resolveUnresolvedAudioRecord,
  selectCertificateClearable,
  unresolvedAudioKey,
  type UnresolvedAudioPort,
  type UnresolvedAudioRecord,
  type UnresolvedAudioResolvedVia,
} from '@/lib/recording/unresolved-audio-record';
import type {
  ConnectionEpoch,
  EpochScope,
  CaptureAttemptId,
} from '@/lib/recording/uplink-scope-allocator';

const E = (n: number) => n as ConnectionEpoch;
const epoch = (n: number): EpochScope => ({ kind: 'epoch', id: E(n) });
const preOpen = (attempt: number): EpochScope => ({
  kind: 'preOpen',
  captureAttemptId: attempt as CaptureAttemptId,
});
const ACTIVE = { owned: false, captureActive: true };

function voicedPcm(len = 4800): Int16Array {
  const s = new Int16Array(len);
  for (let i = 0; i < len; i++) s[i] = i % 2 === 0 ? 6000 : -6000;
  return s;
}
function silentPcm(len = 4800): Int16Array {
  return new Int16Array(len);
}

const T0 = 1_700_000_000_000;

/** In-memory port with the IDB port's exact merge/resolve semantics. */
class MemoryPort implements UnresolvedAudioPort {
  readonly rows = new Map<string, UnresolvedAudioRecord>();
  now = T0;
  upsert(record: UnresolvedAudioRecord): void {
    this.rows.set(
      record.key,
      mergeUnresolvedAudioRecord(this.rows.get(record.key) ?? null, record)
    );
  }
  resolve(key: string, via: UnresolvedAudioResolvedVia): void {
    const existing = this.rows.get(key);
    if (!existing) return;
    this.rows.set(key, resolveUnresolvedAudioRecord(existing, via, this.now));
  }
  /** Purge = the SOLE deletion. */
  purge(): void {
    this.rows.clear();
  }
  all(): UnresolvedAudioRecord[] {
    return [...this.rows.values()];
  }
}

function harness(sessionId = 'sess-A', userId = 'u1', jobId = 'j1') {
  const port = new MemoryPort();
  const clock = new CaptureWallClock();
  clock.observe(0, T0); // session start anchor
  const binder = new UnresolvedAudioBinder({
    userId,
    jobId,
    recordingSessionId: sessionId,
    clock,
    port,
    now: () => port.now,
  });
  const counters = { material: 0, disclosureCompleted: 0, retiredImmaterial: 0 };
  const disclosureLedger = new UplinkLossDisclosureLedger({
    onMint: () => {},
    telemetry: (event, payload) => {
      if (event === 'uplink_loss_episode_disclosure_completed') counters.disclosureCompleted += 1;
      void payload;
    },
    onCompleted: (token) =>
      binder.onDisclosureCompleted(token.sessionId, token.coveredLossSourceIds),
  });
  const ledger = new UplinkLossLedger({
    recordingSessionId: sessionId,
    onDisclosureReady: (ids) => disclosureLedger.request(sessionId, ids),
    telemetry: (event: UplinkLossTelemetryEvent, payload) => {
      if (event === 'uplink_loss_episode_material') counters.material += 1;
      if (event === 'uplink_loss_episode_retired_immaterial') counters.retiredImmaterial += 1;
      binder.onLedgerTelemetry(event, payload);
    },
    onSourceEvidence: (id, ev) => binder.onSourceEvidence(id, ev),
  });
  const reconcile = () => reconcileUnresolvedAudio(port.all(), counters);
  const key = (id: LossSourceId) =>
    unresolvedAudioKey(userId, jobId, sessionId, lossSourceIdKey(id));
  return { port, clock, binder, ledger, disclosureLedger, counters, reconcile, key };
}

/** A material outage: open, close unowned, voiced capture during the episode. */
function materialEpisode(h: ReturnType<typeof harness>, range = { start: 16000, end: 24000 }) {
  h.ledger.onSocketOpened(E(1));
  h.ledger.onSocketClosed(E(1), ACTIVE);
  h.ledger.recordDropped({
    epochScope: preOpen(1),
    captureSampleRange: range,
    samples: voicedPcm(range.end - range.start),
  });
  return h.ledger.openEpisodeSourceId!;
}

describe('T2 — material accrual writes the durable entry mid-session (tests 1, 3)', () => {
  it('a material episode upserts ONE row at accrual time with a CAPTURE-time window; silence-only writes nothing', () => {
    const h = harness();
    const id = materialEpisode(h, { start: 16000, end: 24000 });
    expect(h.port.rows.size).toBe(1);
    const row = h.port.rows.get(h.key(id))!;
    expect(row.resolvedVia).toBeNull();
    expect(row.windowStartMs).toBe(T0 + 1000);
    expect(row.windowEndMs).toBe(T0 + 1500);
    expect(row.voicedDurationMs).toBe(500);
    expect(row.lossSourceKey).toBe('episode:1');

    const s = harness();
    s.ledger.onSocketOpened(E(1));
    s.ledger.onSocketClosed(E(1), ACTIVE);
    s.ledger.recordDropped({
      epochScope: preOpen(1),
      captureSampleRange: { start: 0, end: 4800 },
      samples: silentPcm(),
    });
    expect(s.port.rows.size).toBe(0);
    expect(s.counters.material).toBe(0);
  });

  it('confirmed-dead close (unowned 1000, never reopens) → NO speech, entry exists, equation holds at session end (test 1)', () => {
    const h = harness();
    materialEpisode(h);
    // Session ends with the episode still open: Stop's owned discard.
    h.ledger.onOwnedDisconnect(null);
    expect(h.disclosureLedger.outstandingToken).toBeNull(); // nothing spoken
    expect(h.port.rows.size).toBe(1);
    const r = h.reconcile();
    expect(r.openRecords).toBe(1);
    expect(r.storedRowsHold).toBe(true);
    expect(r.openRecordsHold).toBe(true);
  });

  it('a LATER successful open in the same session discloses normally and NATURAL completion resolves the entry `completion`', () => {
    const h = harness();
    const id = materialEpisode(h);
    h.ledger.onSocketOpened(E(2)); // the disclosure moment
    const token = h.disclosureLedger.outstandingToken!;
    expect(token.coveredLossSourceIds.map(lossSourceIdKey)).toEqual([lossSourceIdKey(id)]);
    h.disclosureLedger.onPlaybackStarted(token.id);
    h.disclosureLedger.onNaturalCompletion(token.id);
    expect(h.port.rows.get(h.key(id))!.resolvedVia).toBe('completion');
    expect(h.counters.disclosureCompleted).toBe(1);
    const r = h.reconcile();
    expect(r.openRecords).toBe(0);
    expect(r.openRecordsHold).toBe(true);
  });

  it('Stop mid-playback (abandon, non-natural) leaves the entry OPEN and completed unincremented — pinned (test 3 / 6)', () => {
    const h = harness();
    const id = materialEpisode(h);
    h.ledger.onSocketOpened(E(2));
    const token = h.disclosureLedger.outstandingToken!;
    h.disclosureLedger.onPlaybackStarted(token.id);
    h.disclosureLedger.abandonForSessionTeardown(); // Stop cut the clip
    expect(h.port.rows.get(h.key(id))!.resolvedVia).toBeNull();
    expect(h.counters.disclosureCompleted).toBe(0);
    expect(h.port.rows.size).toBe(1); // no double entry
    const r = h.reconcile();
    expect(r.openRecords).toBe(1);
    expect(r.openRecordsHold).toBe(true);
  });

  it('two material episodes covered by ONE token → one natural completion → completed increments by 2, both resolve', () => {
    const h = harness();
    const a = materialEpisode(h, { start: 16000, end: 24000 });
    // Episode 1 discloses at open 2 — but a token that is PENDING joins.
    // Build a second material source that reaches the SAME moment: a pre-open
    // window accrued before open 2.
    h.ledger.recordDropped({
      epochScope: preOpen(2),
      captureSampleRange: { start: 40000, end: 48000 },
      samples: voicedPcm(8000),
    });
    // The pre-open capture during an open episode JOINS it — so to get TWO
    // sources use a staged loss instead.
    const staged = h.ledger.recordStagedLoss({
      epochScope: preOpen(2),
      captureSampleRange: { start: 60000, end: 68000 },
      voiced: true,
    })!;
    h.ledger.onSocketOpened(E(2));
    const token = h.disclosureLedger.outstandingToken!;
    expect(token.coveredLossSourceIds.length).toBe(2);
    h.disclosureLedger.onPlaybackStarted(token.id);
    h.disclosureLedger.onNaturalCompletion(token.id);
    expect(h.counters.disclosureCompleted).toBe(2);
    expect(h.port.rows.get(h.key(a))!.resolvedVia).toBe('completion');
    expect(h.port.rows.get(h.key(staged))!.resolvedVia).toBe('completion');
    expect(h.reconcile().openRecordsHold).toBe(true);
  });

  it('E2 `retired_immaterial` (material, then fully watermark-retired before its open) resolves the row — the round-4 case', () => {
    const h = harness();
    h.ledger.onSocketOpened(E(1));
    // Dispatched voiced tail, then an unowned close carries it into an episode.
    h.ledger.recordDispatched({
      dispatchEpoch: E(1),
      epochScope: epoch(1),
      captureSampleRange: { start: 0, end: 8000 },
      dispatchedSampleRange: { start: 0, end: 8000 },
      voiced: true,
    });
    h.ledger.onSocketClosed(E(1), ACTIVE);
    const id = h.ledger.openEpisodeSourceId!;
    expect(h.port.rows.get(h.key(id))!.resolvedVia).toBeNull();
    // The vendor's late watermark retires everything.
    h.ledger.advanceWatermark(E(1), 8000);
    h.ledger.onSocketOpened(E(2));
    expect(h.counters.retiredImmaterial).toBe(1);
    expect(h.port.rows.get(h.key(id))!.resolvedVia).toBe('retired_immaterial');
    expect(h.disclosureLedger.outstandingToken).toBeNull(); // no speech
    const r = h.reconcile();
    expect(r.openRecords).toBe(0);
    expect(r.openRecordsHold).toBe(true);
  });

  it('a partial watermark retirement REFRESHES the window/duration (evidence change), never resolves', () => {
    const h = harness();
    h.ledger.onSocketOpened(E(1));
    h.ledger.recordDispatched({
      dispatchEpoch: E(1),
      epochScope: epoch(1),
      captureSampleRange: { start: 0, end: 8000 },
      dispatchedSampleRange: { start: 0, end: 8000 },
      voiced: true,
    });
    h.ledger.recordDispatched({
      dispatchEpoch: E(1),
      epochScope: epoch(1),
      captureSampleRange: { start: 8000, end: 16000 },
      dispatchedSampleRange: { start: 8000, end: 16000 },
      voiced: true,
    });
    h.ledger.onSocketClosed(E(1), ACTIVE);
    const id = h.ledger.openEpisodeSourceId!;
    expect(h.port.rows.get(h.key(id))!.voicedDurationMs).toBe(1000);
    h.ledger.advanceWatermark(E(1), 8000);
    const row = h.port.rows.get(h.key(id))!;
    expect(row.voicedDurationMs).toBe(500);
    expect(row.windowStartMs).toBe(T0 + 500);
    expect(row.resolvedVia).toBeNull();
  });
});

describe('5a — E2→TERM seam: the window is CAPTURE time through the piecewise map', () => {
  it('a staged reconnect DISCARD reported after a ten-minute pause displays the post-pause window', () => {
    const h = harness();
    // 2 s of capture, then a ten-minute pause (capture clock stalls).
    let sample = 0;
    let wall = T0;
    for (let i = 0; i < 8; i++) {
      h.clock.observe(sample, wall);
      sample += 4000;
      wall += 250;
    }
    const PAUSE = 10 * 60 * 1000;
    wall += PAUSE;
    const resumeSample = sample;
    const resumeWall = wall;
    for (let i = 0; i < 8; i++) {
      h.clock.observe(sample, wall);
      sample += 4000;
      wall += 250;
    }
    // The staging owner reports the discard MUCH later (report time is irrelevant).
    h.port.now = resumeWall + 90_000;
    const id = h.ledger.recordStagedLoss({
      epochScope: preOpen(2),
      captureSampleRange: { start: resumeSample + 16000, end: resumeSample + 32000 },
      voiced: true,
    })!;
    const row = h.port.rows.get(h.key(id))!;
    expect(row.windowStartMs).toBe(resumeWall + 1000);
    expect(row.windowEndMs).toBe(resumeWall + 2000);
    expect(row.windowStartMs).not.toBe(h.port.now);
  });

  it('an 80k-cap OVERFLOW staged loss (successful reconnect) still maps to its original capture window', () => {
    const h = harness();
    for (let i = 0; i < 20; i++) h.clock.observe(i * 4000, T0 + i * 250);
    h.port.now = T0 + 60_000;
    const id = h.ledger.recordStagedLoss({
      epochScope: epoch(2),
      captureSampleRange: { start: 32000, end: 48000 },
      voiced: true,
    })!;
    const row = h.port.rows.get(h.key(id))!;
    expect(row.windowStartMs).toBe(T0 + 2000);
    expect(row.windowEndMs).toBe(T0 + 3000);
  });

  it('summariseSourceEvidence: hull + merged voiced length over overlapping ranges', () => {
    const e = (start: number, end: number): LedgerEntry => ({
      variant: 'undispatched',
      recordingSessionId: 's',
      epochScope: preOpen(1),
      captureSampleRange: { start, end },
      dispatchedSampleRange: null,
      dispatchEpoch: null,
    });
    expect(summariseSourceEvidence([])).toBeNull();
    expect(summariseSourceEvidence([e(0, 100), e(50, 150), e(300, 400)])).toEqual({
      captureSampleRange: { start: 0, end: 400 },
      voicedSamples: 250,
    });
  });
});

describe('4 / 6a — tombstones: every non-purge transition writes ONLY resolved_via; first terminal wins', () => {
  it('dismissal → `dismissed`; PDF success → `certificate_cleared`; rows are RETAINED and hidden', () => {
    const h = harness();
    const id = materialEpisode(h);
    h.ledger.onOwnedDisconnect(null);
    h.port.resolve(h.key(id), 'dismissed');
    expect(h.port.rows.size).toBe(1);
    expect(h.port.rows.get(h.key(id))!.resolvedVia).toBe('dismissed');
    expect(
      isUnresolvedAudioVisible(h.port.rows.get(h.key(id))!, {
        userId: 'u1',
        jobId: 'j1',
        activeSessionIds: new Set(),
      })
    ).toBe(false);
    const r = h.reconcile();
    expect(r.dismissed).toBe(1);
    expect(r.openRecords).toBe(0);
    expect(r.openRecordsHold).toBe(true);
    expect(r.storedRowsHold).toBe(true);

    const g = harness('sess-B');
    const gid = materialEpisode(g);
    g.ledger.onOwnedDisconnect(null);
    const clearable = selectCertificateClearable(g.port.all(), {
      userId: 'u1',
      jobId: 'j1',
      activeSessionIds: new Set(),
    });
    for (const row of clearable) g.port.resolve(row.key, 'certificate_cleared');
    expect(g.port.rows.get(g.key(gid))!.resolvedVia).toBe('certificate_cleared');
    const gr = g.reconcile();
    expect(gr.certificateCleared).toBe(1);
    expect(gr.openRecordsHold).toBe(true);
  });

  it('a non-null resolved_via is never overwritten (dismissed row does not later become certificate_cleared or completion)', () => {
    const h = harness();
    const id = materialEpisode(h);
    h.port.resolve(h.key(id), 'dismissed');
    h.port.resolve(h.key(id), 'certificate_cleared');
    expect(h.port.rows.get(h.key(id))!.resolvedVia).toBe('dismissed');
    // A later upsert (evidence refresh) keeps the tombstone too.
    h.port.upsert({ ...h.port.rows.get(h.key(id))!, resolvedVia: null, voicedDurationMs: 999 });
    expect(h.port.rows.get(h.key(id))!.resolvedVia).toBe('dismissed');
    expect(h.port.rows.get(h.key(id))!.voicedDurationMs).toBe(999);
  });

  it('account purge is the SOLE deletion — it deliberately breaks the equation, which the harness re-scopes to pre-purge', () => {
    const h = harness();
    materialEpisode(h);
    const before = h.reconcile();
    expect(before.storedRowsHold).toBe(true);
    h.port.purge();
    const after = h.reconcile();
    expect(after.storedRows).toBe(0);
    expect(after.storedRowsHold).toBe(false); // material still 1 — by design
  });
});

describe('5b — PDF success while a material episode is STILL ACTIVE on the same job', () => {
  it('only inactive-session rows terminalize; the active row survives, then continued loss / disclosure / Stop behave normally', () => {
    const old = harness('sess-OLD');
    const oldId = materialEpisode(old);
    old.ledger.onOwnedDisconnect(null);
    const live = harness('sess-LIVE');
    const liveId = materialEpisode(live);
    const rows = [...old.port.all(), ...live.port.all()];
    const clearable = selectCertificateClearable(rows, {
      userId: 'u1',
      jobId: 'j1',
      activeSessionIds: new Set(['sess-LIVE']),
    });
    expect(clearable.map((r) => r.key)).toEqual([old.key(oldId)]);
    old.port.resolve(old.key(oldId), 'certificate_cleared');
    // The live row survives, hidden while active, visible after Stop.
    const liveRow = () => live.port.rows.get(live.key(liveId))!;
    expect(liveRow().resolvedVia).toBeNull();
    expect(
      isUnresolvedAudioVisible(liveRow(), {
        userId: 'u1',
        jobId: 'j1',
        activeSessionIds: new Set(['sess-LIVE']),
      })
    ).toBe(false);
    // Continued loss refreshes the same row.
    live.ledger.recordDropped({
      epochScope: preOpen(1),
      captureSampleRange: { start: 24000, end: 40000 },
      samples: voicedPcm(16000),
    });
    expect(live.port.rows.size).toBe(1);
    expect(liveRow().voicedDurationMs).toBe(1500);
    // Eventual Stop → visible.
    live.ledger.onOwnedDisconnect(null);
    expect(
      isUnresolvedAudioVisible(liveRow(), {
        userId: 'u1',
        jobId: 'j1',
        activeSessionIds: new Set(),
      })
    ).toBe(true);
    expect(live.reconcile().openRecordsHold).toBe(true);
  });
});

describe('composite key — (userId, jobId, session, source) are ALL part of the identity', () => {
  it('identical session/source ids under two users and two jobs are four independent rows', () => {
    const port = new MemoryPort();
    for (const [u, j] of [
      ['u1', 'j1'],
      ['u1', 'j2'],
      ['u2', 'j1'],
      ['u2', 'j2'],
    ]) {
      const clock = new CaptureWallClock();
      clock.observe(0, T0);
      const binder = new UnresolvedAudioBinder({
        userId: u,
        jobId: j,
        recordingSessionId: 'SAME',
        clock,
        port,
        now: () => T0,
      });
      binder.onSourceEvidence(
        { kind: 'episode', id: 1 },
        { captureSampleRange: { start: 0, end: 8000 }, voicedSamples: 8000 }
      );
    }
    expect(port.rows.size).toBe(4);
    expect([...port.rows.keys()].sort()).toEqual([
      'u1|j1|SAME|episode:1',
      'u1|j2|SAME|episode:1',
      'u2|j1|SAME|episode:1',
      'u2|j2|SAME|episode:1',
    ]);
  });
});

describe('a completion that never PLAYED does not resolve the record (Codex cycle-1)', () => {
  it('onEnd reaching a still-pending token: E2 completes it, TERM neither counts nor resolves', () => {
    const h = harness();
    const id = materialEpisode(h);
    h.ledger.onSocketOpened(E(2));
    const token = h.disclosureLedger.outstandingToken!;
    // No onPlaybackStarted — an entry-cancel onEnd before audio.
    h.disclosureLedger.onNaturalCompletion(token.id);
    expect(h.disclosureLedger.naturalCompletionCount).toBe(1); // E2 unchanged
    expect(h.counters.disclosureCompleted).toBe(0);
    expect(h.port.rows.get(h.key(id))!.resolvedVia).toBeNull();
    expect(h.reconcile().openRecordsHold).toBe(true);
  });
});

describe('late report on a DISCLOSED epoch refreshes the record (Codex cycle-1)', () => {
  it('absorbed (never re-disclosed) but the row window/duration grow', () => {
    const h = harness();
    h.ledger.onSocketOpened(E(1));
    h.ledger.recordDispatched({
      dispatchEpoch: E(1),
      epochScope: epoch(1),
      captureSampleRange: { start: 0, end: 8000 },
      dispatchedSampleRange: { start: 0, end: 8000 },
      voiced: true,
    });
    h.ledger.onSocketClosed(E(1), ACTIVE);
    const id = h.ledger.openEpisodeSourceId!;
    h.ledger.onSocketOpened(E(2)); // discloses; epoch 1 marked disclosed
    const before = h.port.rows.get(h.key(id))!.voicedDurationMs;
    h.ledger.recordUndispatchedLoss({
      recordingSessionId: 'sess-A',
      epoch: E(1),
      captureSampleRange: { start: 8000, end: 16000 },
      samples: voicedPcm(8000),
    });
    expect(h.port.rows.get(h.key(id))!.voicedDurationMs).toBeGreaterThan(before);
    expect(h.disclosureLedger.outstandingToken!.coveredLossSourceIds.length).toBe(1); // no re-disclosure
  });
});

describe('visibility predicate + wording', () => {
  it('shows only unresolved rows of the current user+job whose session is inactive', () => {
    const h = harness();
    const id = materialEpisode(h);
    const row = h.port.rows.get(h.key(id))!;
    expect(
      isUnresolvedAudioVisible(row, {
        userId: 'u1',
        jobId: 'j1',
        activeSessionIds: new Set(['sess-A']),
      })
    ).toBe(false);
    expect(
      isUnresolvedAudioVisible(row, { userId: 'u2', jobId: 'j1', activeSessionIds: new Set() })
    ).toBe(false);
    expect(
      isUnresolvedAudioVisible(row, { userId: 'u1', jobId: 'j9', activeSessionIds: new Set() })
    ).toBe(false);
    expect(
      isUnresolvedAudioVisible(row, { userId: null, jobId: 'j1', activeSessionIds: new Set() })
    ).toBe(false);
    expect(
      isUnresolvedAudioVisible(row, { userId: 'u1', jobId: 'j1', activeSessionIds: new Set() })
    ).toBe(true);
  });

  it('the visual text never claims confirmed loss (dispatched-but-unwatermarked fixture) and is distinct from the spoken line', () => {
    const h = harness();
    h.ledger.onSocketOpened(E(1));
    h.ledger.recordDispatched({
      dispatchEpoch: E(1),
      epochScope: epoch(1),
      captureSampleRange: { start: 16000, end: 32000 },
      dispatchedSampleRange: { start: 16000, end: 32000 },
      voiced: true,
    });
    h.ledger.onSocketClosed(E(1), ACTIVE);
    const row = h.port.all()[0];
    const text = formatUnresolvedAudioBannerText(row);
    expect(text).toContain('may not have been transcribed');
    expect(text).toContain('~1s');
    expect(text).toMatch(/around \d{2}:\d{2}/);
    expect(text.toLowerCase()).not.toContain('was lost');
    expect(text.toLowerCase()).not.toContain("couldn't be transcribed");
    expect(text.toLowerCase()).not.toContain('network');
    expect(text).not.toBe(
      "Some recent audio may not have been transcribed. Check your recent readings and repeat only anything that's missing."
    );
  });

  it("the completion observer is session-fenced — a token from another session never resolves this session's rows", () => {
    const h = harness('sess-A');
    const id = materialEpisode(h);
    h.binder.onDisclosureCompleted('sess-OTHER', [id]);
    expect(h.port.rows.get(h.key(id))!.resolvedVia).toBeNull();
  });
});

describe('6 / 6b — counters: disclosed ≥ completed; equality once every token completes naturally', () => {
  it('disclosed is source-cardinal at association; completed only at natural completion', () => {
    const h = harness();
    const id = materialEpisode(h);
    let disclosed = 0;
    const dl = new UplinkLossDisclosureLedger({
      onMint: () => {},
      telemetry: (event) => {
        if (event === 'uplink_loss_episode_disclosed') disclosed += 1;
        if (event === 'uplink_loss_episode_disclosure_completed')
          h.counters.disclosureCompleted += 1;
      },
      onCompleted: (t) => h.binder.onDisclosureCompleted(t.sessionId, t.coveredLossSourceIds),
    });
    dl.request('sess-A', [id]);
    expect(disclosed).toBe(1);
    expect(h.counters.disclosureCompleted).toBe(0);
    expect(disclosed).toBeGreaterThanOrEqual(h.counters.disclosureCompleted);
    expect(h.reconcile().openRecords).toBe(1); // minted ≠ heard
    dl.onPlaybackStarted(1);
    dl.onNaturalCompletion(1);
    expect(h.counters.disclosureCompleted).toBe(1);
    expect(disclosed).toBe(h.counters.disclosureCompleted);
    expect(h.reconcile().openRecordsHold).toBe(true);
    // Idempotent per session|source: a second completion never double-counts.
    dl.onNaturalCompletion(1);
    expect(h.counters.disclosureCompleted).toBe(1);
  });
});
