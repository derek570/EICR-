/**
 * PLAN-E2 — the loss-ledger state matrix (tests 2, 2b, 2c, 2h, 2j, 2k on
 * the pure module). Episodes, pre-open windows, staged loss, ownership,
 * watermark retirement in the DISPATCHED domain, the three counters, and
 * the hold API.
 */
import { describe, expect, it } from 'vitest';
import {
  UplinkLossLedger,
  lossSourceIdKey,
  type LossSourceId,
  type UplinkLossTelemetryEvent,
} from '@/lib/recording/uplink-loss-ledger';
import type {
  CaptureAttemptId,
  ConnectionEpoch,
  EpochScope,
} from '@/lib/recording/uplink-scope-allocator';

const E = (n: number) => n as ConnectionEpoch;
const epoch = (n: number): EpochScope => ({ kind: 'epoch', id: E(n) });
const preOpen = (attempt: number): EpochScope => ({
  kind: 'preOpen',
  captureAttemptId: attempt as CaptureAttemptId,
});

function voicedPcm(len = 1280): Int16Array {
  const s = new Int16Array(len);
  for (let i = 0; i < len; i++) s[i] = i % 2 === 0 ? 6000 : -6000;
  return s;
}
function silentPcm(len = 1280): Int16Array {
  return new Int16Array(len);
}

function harness() {
  const events: Array<{ event: UplinkLossTelemetryEvent; source: string }> = [];
  const disclosed: LossSourceId[][] = [];
  const ledger = new UplinkLossLedger({
    recordingSessionId: 'sess-A',
    onDisclosureReady: (ids) => disclosed.push(ids),
    telemetry: (event, payload) => events.push({ event, source: String(payload.source) }),
  });
  const count = (e: UplinkLossTelemetryEvent) => events.filter((x) => x.event === e).length;
  return { ledger, events, disclosed, count };
}

const ACTIVE = { owned: false, captureActive: true };
const INACTIVE = { owned: false, captureActive: false };
const OWNED = { owned: true, captureActive: true };

describe('UplinkLossLedger — episode open/join/close (test 2, 2b)', () => {
  it('an unowned close while capture is active opens ONE episode; later failures join it', () => {
    const { ledger } = harness();
    ledger.onSocketOpened(E(1));
    ledger.onSocketClosed(E(1), ACTIVE);
    expect(ledger.isEpisodeOpen).toBe(true);
    const first = ledger.openEpisodeSourceId;
    // Two failed reconnect attempts (epochs minted, never opened)
    ledger.onSocketClosed(E(2), ACTIVE);
    ledger.onSocketFailure(E(3), ACTIVE);
    ledger.onSocketClosed(E(3), ACTIVE);
    expect(ledger.openEpisodeSourceId).toEqual(first);
  });

  it('an unowned 1000/1005-class close (no reconnect today) still opens the episode — it is COUNTED, never spoken without a reopen', () => {
    const { ledger, count, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.recordDropped({ epochScope: epoch(1), captureSampleRange: { start: 0, end: 1280 }, samples: voicedPcm() });
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.recordDropped({ epochScope: preOpen(2), captureSampleRange: { start: 1280, end: 2560 }, samples: voicedPcm() });
    expect(ledger.isEpisodeOpen).toBe(true);
    expect(count('uplink_loss_episode_material')).toBe(1);
    expect(disclosed).toHaveLength(0);
  });

  it('an OWNED close opens no episode and discards every unresolved entry', () => {
    const { ledger, count } = harness();
    ledger.onSocketOpened(E(1));
    ledger.recordDispatched({ dispatchEpoch: E(1), epochScope: epoch(1), captureSampleRange: { start: 0, end: 1280 }, dispatchedSampleRange: { start: 0, end: 1280 }, voiced: true });
    expect(ledger.unresolvedEntryCount).toBe(1);
    ledger.onSocketClosed(E(1), OWNED);
    expect(ledger.isEpisodeOpen).toBe(false);
    expect(ledger.unresolvedEntryCount).toBe(0);
    expect(count('uplink_loss_episode_material')).toBe(0);
  });

  it('disconnect() with no live socket (owned, no close event) also discards + abandons', () => {
    const { ledger, disclosed } = harness();
    ledger.recordDropped({ epochScope: preOpen(1), captureSampleRange: { start: 0, end: 1280 }, samples: voicedPcm() });
    expect(ledger.pendingPreOpenWindowCount).toBe(1);
    ledger.onOwnedDisconnect(null);
    expect(ledger.pendingPreOpenWindowCount).toBe(0);
    ledger.onSocketOpened(E(1));
    expect(disclosed).toHaveLength(0);
  });

  it('capture-INACTIVE unowned close (interruption/user-pause window) opens no episode, drops the tail', () => {
    const { ledger } = harness();
    ledger.onSocketOpened(E(1));
    ledger.recordDispatched({ dispatchEpoch: E(1), epochScope: epoch(1), captureSampleRange: { start: 0, end: 1280 }, dispatchedSampleRange: { start: 0, end: 1280 }, voiced: true });
    ledger.onSocketClosed(E(1), INACTIVE);
    expect(ledger.isEpisodeOpen).toBe(false);
    expect(ledger.unresolvedEntryCount).toBe(0);
  });

  it('a late close/error callback from a SUPERSEDED epoch opens no phantom episode', () => {
    const { ledger, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.onSocketOpened(E(2)); // episode 1 closes (immaterial — no entries)
    expect(ledger.isEpisodeOpen).toBe(false);
    ledger.onSocketFailure(E(1), ACTIVE); // stale
    ledger.onSocketClosed(E(1), ACTIVE); // stale (already classified)
    expect(ledger.isEpisodeOpen).toBe(false);
    expect(disclosed).toHaveLength(0);
  });

  it('a failure signal for an epoch already closed by an owned disconnect is ignored', () => {
    const { ledger } = harness();
    ledger.onSocketOpened(E(1));
    ledger.onOwnedDisconnect(E(1));
    ledger.onSocketFailure(E(1), ACTIVE);
    expect(ledger.isEpisodeOpen).toBe(false);
  });
});

describe('UplinkLossLedger — materiality at DISCLOSURE time (test 2c)', () => {
  it('dropped voiced samples mid-outage → ONE disclosure at the reopen', () => {
    const { ledger, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.recordDropped({ epochScope: preOpen(2), captureSampleRange: { start: 0, end: 1280 }, samples: voicedPcm() });
    ledger.onSocketOpened(E(2));
    expect(disclosed).toHaveLength(1);
    expect(disclosed[0].map(lossSourceIdKey)).toEqual(['episode:1']);
  });

  it('an unretired voiced DISPATCHED tail at failure → ONE disclosure', () => {
    const { ledger, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.recordDispatched({ dispatchEpoch: E(1), epochScope: epoch(1), captureSampleRange: { start: 0, end: 1280 }, dispatchedSampleRange: { start: 0, end: 1280 }, voiced: true });
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.onSocketOpened(E(2));
    expect(disclosed).toHaveLength(1);
  });

  it('BOTH a dropped frame and an unretired tail in one episode → still exactly ONE disclosure', () => {
    const { ledger, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.recordDispatched({ dispatchEpoch: E(1), epochScope: epoch(1), captureSampleRange: { start: 0, end: 1280 }, dispatchedSampleRange: { start: 0, end: 1280 }, voiced: true });
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.recordDropped({ epochScope: preOpen(2), captureSampleRange: { start: 1280, end: 2560 }, samples: voicedPcm() });
    ledger.onSocketOpened(E(2));
    expect(disclosed).toHaveLength(1);
    expect(disclosed[0]).toHaveLength(1);
  });

  it('voiced audio FULLY retired by the watermark before disclosure time → NO disclosure', () => {
    const { ledger, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.recordDispatched({ dispatchEpoch: E(1), epochScope: epoch(1), captureSampleRange: { start: 0, end: 1280 }, dispatchedSampleRange: { start: 0, end: 1280 }, voiced: true });
    ledger.advanceWatermark(E(1), 1280);
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.onSocketOpened(E(2));
    expect(disclosed).toHaveLength(0);
  });

  it('silence-only and noise-only episodes of any length → NO disclosure, NO counters', () => {
    const { ledger, disclosed, events } = harness();
    ledger.onSocketOpened(E(1));
    for (let i = 0; i < 200; i++) {
      ledger.recordDispatched({ dispatchEpoch: E(1), epochScope: epoch(1), captureSampleRange: { start: i * 1280, end: (i + 1) * 1280 }, dispatchedSampleRange: { start: i * 1280, end: (i + 1) * 1280 }, voiced: false });
    }
    ledger.onSocketClosed(E(1), ACTIVE);
    for (let i = 0; i < 200; i++) {
      ledger.recordDropped({ epochScope: preOpen(2), captureSampleRange: { start: 0, end: 1280 }, samples: silentPcm() });
    }
    ledger.onSocketOpened(E(2));
    expect(disclosed).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('pre-open/initial-connect material loss → ONE disclosure at the FIRST open; a fast open speaks none', () => {
    const { ledger, disclosed } = harness();
    ledger.recordDropped({ epochScope: preOpen(1), captureSampleRange: { start: 0, end: 800 }, samples: voicedPcm(800) });
    ledger.onSocketOpened(E(1));
    expect(disclosed).toHaveLength(1);
    expect(disclosed[0].map(lossSourceIdKey)).toEqual(['preOpenWindow:1']);

    const fast = harness();
    fast.ledger.onSocketOpened(E(1));
    expect(fast.disclosed).toHaveLength(0);
  });

  it('a sub-2s complete reading (~0.5s voiced) dropped pre-open IS material (no duration gate)', () => {
    const { ledger, disclosed } = harness();
    ledger.recordDropped({ epochScope: preOpen(1), captureSampleRange: { start: 0, end: 8000 }, samples: voicedPcm(8000) });
    ledger.onSocketOpened(E(1));
    expect(disclosed).toHaveLength(1);
  });
});

describe('UplinkLossLedger — watermark (two timebases)', () => {
  it('a frame DROPPED mid-stream is never retired by a watermark that passes its capture range', () => {
    const { ledger, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.recordDispatched({ dispatchEpoch: E(1), epochScope: epoch(1), captureSampleRange: { start: 0, end: 1280 }, dispatchedSampleRange: { start: 0, end: 1280 }, voiced: true });
    // dropped frame: capture [1280, 2560), never dispatched
    ledger.recordDropped({ epochScope: epoch(1), captureSampleRange: { start: 1280, end: 2560 }, samples: voicedPcm() });
    ledger.recordDispatched({ dispatchEpoch: E(1), epochScope: epoch(1), captureSampleRange: { start: 2560, end: 3840 }, dispatchedSampleRange: { start: 1280, end: 2560 }, voiced: true });
    // Watermark passes 2560 in the DISPATCHED domain — retires both dispatched frames…
    ledger.advanceWatermark(E(1), 2560);
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.onSocketOpened(E(2));
    // …but the dropped frame is STILL unresolved → exactly one disclosure.
    expect(disclosed).toHaveLength(1);
  });

  it('a successor epoch watermark never retires a predecessor epoch entry', () => {
    const { ledger, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.recordDispatched({ dispatchEpoch: E(1), epochScope: epoch(1), captureSampleRange: { start: 0, end: 1280 }, dispatchedSampleRange: { start: 0, end: 1280 }, voiced: true });
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.advanceWatermark(E(2), 999_999); // wrong epoch
    ledger.onSocketOpened(E(2));
    expect(disclosed).toHaveLength(1);
  });

  it('cross-codec equality (2k): two packetisations of the same PCM with the same dispatched ranges retire identically', () => {
    const run = (ranges: Array<[number, number]>) => {
      const h = harness();
      h.ledger.onSocketOpened(E(1));
      for (const [s, e] of ranges) {
        h.ledger.recordDispatched({ dispatchEpoch: E(1), epochScope: epoch(1), captureSampleRange: { start: s, end: e }, dispatchedSampleRange: { start: s, end: e }, voiced: true });
      }
      h.ledger.advanceWatermark(E(1), 1280);
      return h.ledger.unresolvedEntryCount;
    };
    // linear16: one 1280 frame; opus-style: the same 1280 samples as 4×320
    expect(run([[0, 1280], [1280, 2560]])).toBe(1);
    expect(run([[0, 320], [320, 640], [640, 960], [960, 1280], [1280, 2560]])).toBe(1);
  });
});

describe('UplinkLossLedger — three counters (test 2h)', () => {
  it('material accrued and still unretired at the reopen → material + (delivery) disclosed; residue 0', () => {
    const { ledger, count, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.recordDropped({ epochScope: preOpen(2), captureSampleRange: { start: 0, end: 1280 }, samples: voicedPcm() });
    ledger.onSocketOpened(E(2));
    expect(count('uplink_loss_episode_material')).toBe(1);
    expect(count('uplink_loss_episode_retired_immaterial')).toBe(0);
    expect(disclosed).toHaveLength(1);
  });

  it('the SAME episode whose evidence retired before the open → material + retired_immaterial, speaks nothing', () => {
    const { ledger, count, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.recordDispatched({ dispatchEpoch: E(1), epochScope: epoch(1), captureSampleRange: { start: 0, end: 1280 }, dispatchedSampleRange: { start: 0, end: 1280 }, voiced: true });
    // receive failure opens the episode while the socket is still nominally open…
    ledger.onSocketFailure(E(1), ACTIVE);
    expect(count('uplink_loss_episode_material')).toBe(1);
    // …then a late same-epoch watermark retires the carried tail before the close lands.
    ledger.advanceWatermark(E(1), 1280);
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.onSocketOpened(E(2));
    expect(count('uplink_loss_episode_retired_immaterial')).toBe(1);
    expect(disclosed).toHaveLength(0);
  });

  it('an episode still open at session end, and a 1000-close episode never retried, emit material ONLY (residue 1)', () => {
    const { ledger, count, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.onSocketClosed(E(1), ACTIVE); // e.g. unsolicited 1000 — no reconnect today
    ledger.recordDropped({ epochScope: preOpen(2), captureSampleRange: { start: 0, end: 1280 }, samples: voicedPcm() });
    // session ends: no open ever follows
    expect(count('uplink_loss_episode_material')).toBe(1);
    expect(count('uplink_loss_episode_retired_immaterial')).toBe(0);
    expect(disclosed).toHaveLength(0);
  });

  it('a silence-only episode emits NOTHING AT ALL, at any point in its life (red proof: emitting at open would fail this)', () => {
    const { ledger, events } = harness();
    ledger.onSocketOpened(E(1));
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.recordDropped({ epochScope: preOpen(2), captureSampleRange: { start: 0, end: 1280 }, samples: silentPcm() });
    ledger.onSocketOpened(E(2));
    expect(events).toHaveLength(0);
  });

  it('a material PRE-OPEN window counts exactly like an episode; material fires once per source', () => {
    const { ledger, count } = harness();
    ledger.recordDropped({ epochScope: preOpen(1), captureSampleRange: { start: 0, end: 1280 }, samples: voicedPcm() });
    ledger.recordDropped({ epochScope: preOpen(1), captureSampleRange: { start: 1280, end: 2560 }, samples: voicedPcm() });
    expect(count('uplink_loss_episode_material')).toBe(1);
  });
});

describe('UplinkLossLedger — staged loss (2i/2j) and coalescing', () => {
  it('a staged discard mints its own stagedLoss id, counts material, discloses at the next open, opens NO phantom episode', () => {
    const { ledger, count, disclosed } = harness();
    const id = ledger.recordStagedLoss({ epochScope: preOpen(1), captureSampleRange: { start: 0, end: 4000 }, voiced: true });
    expect(id).toEqual({ kind: 'stagedLoss', id: 1 });
    expect(ledger.isEpisodeOpen).toBe(false);
    expect(count('uplink_loss_episode_material')).toBe(1);
    ledger.onSocketOpened(E(1));
    expect(disclosed[0].map(lossSourceIdKey)).toEqual(['stagedLoss:1']);
  });

  it('a silence-only staged report mints nothing', () => {
    const { ledger, events } = harness();
    expect(ledger.recordStagedLoss({ epochScope: preOpen(1), captureSampleRange: { start: 0, end: 4000 }, voiced: false })).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('a pre-open window AND a just-closed episode pending at one open → ONE disclosure moment carrying BOTH ids', () => {
    const { ledger, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.recordDropped({ epochScope: preOpen(2), captureSampleRange: { start: 0, end: 1280 }, samples: voicedPcm() });
    ledger.recordStagedLoss({ epochScope: preOpen(2), captureSampleRange: { start: 1280, end: 2560 }, voiced: true });
    ledger.onSocketOpened(E(2));
    expect(disclosed).toHaveLength(1);
    expect(disclosed[0].map(lossSourceIdKey).sort()).toEqual(['episode:1', 'stagedLoss:1']);
  });

  it('encoder-residue reports (variant d) attribute to the episode the close opened and cannot watermark-retire', () => {
    const { ledger, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.recordUndispatchedLoss({ samples: voicedPcm(), recordingSessionId: 'sess-A', epoch: E(1), captureSampleRange: { start: 0, end: 1280 } });
    ledger.advanceWatermark(E(1), 999_999);
    ledger.onSocketOpened(E(2));
    expect(disclosed).toHaveLength(1);
  });

  it('a report for another recording session is ignored', () => {
    const { ledger, events } = harness();
    ledger.onSocketOpened(E(1));
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.recordUndispatchedLoss({ samples: voicedPcm(), recordingSessionId: 'sess-B', epoch: E(1), captureSampleRange: { start: 0, end: 1280 } });
    expect(events).toHaveLength(0);
  });
});

describe('UplinkLossLedger — hold API (E-WAKE barrier, dormant)', () => {
  it('a hold registered before the open PARKS the release until released; release is immediate with no holds', () => {
    const { ledger, disclosed } = harness();
    ledger.recordDropped({ epochScope: preOpen(1), captureSampleRange: { start: 0, end: 1280 }, samples: voicedPcm() });
    const hold = ledger.holdDisclosureRelease();
    ledger.onSocketOpened(E(1));
    expect(disclosed).toHaveLength(0);
    expect(ledger.isReleaseParked).toBe(true);
    // A late staged report lands BEFORE the release — it joins the same moment.
    ledger.recordStagedLoss({ epochScope: preOpen(1), captureSampleRange: { start: 1280, end: 2560 }, voiced: true });
    hold.release();
    hold.release(); // idempotent
    expect(disclosed).toHaveLength(1);
    expect(ledger.outstandingHoldCount).toBe(0);
  });
});
