/**
 * PLAN-D D4 — the voice-pause cut on the loss ledger (Acceptance 8, the
 * three settled ledger sub-cases, pure-module half).
 *
 * During a voice pause the tap and the socket stay live, so `captureActive`
 * is genuinely true. Capture at or after the cut is ineligible for every
 * loss source; unresolved evidence before the cut stays accountable.
 */
import { describe, expect, it } from 'vitest';
import {
  UplinkLossLedger,
  type LossSourceId,
  type UplinkLossTelemetryEvent,
} from '@/lib/recording/uplink-loss-ledger';
import type { ConnectionEpoch, EpochScope } from '@/lib/recording/uplink-scope-allocator';
import { MATERIAL_VOICED_DEBOUNCE_SAMPLES } from '@/lib/recording/voiced-activity';

const E = (n: number) => n as ConnectionEpoch;
const epoch = (n: number): EpochScope => ({ kind: 'epoch', id: E(n) });

function voicedPcm(len = 4800): Int16Array {
  const s = new Int16Array(len);
  for (let i = 0; i < len; i++) s[i] = i % 2 === 0 ? 6000 : -6000;
  return s;
}

function harness() {
  const events: UplinkLossTelemetryEvent[] = [];
  const disclosed: LossSourceId[][] = [];
  const ledger = new UplinkLossLedger({
    recordingSessionId: 'sess-D',
    onDisclosureReady: (ids) => disclosed.push(ids),
    telemetry: (event) => events.push(event),
  });
  return { ledger, events, disclosed };
}

const ACTIVE = { owned: false, captureActive: true };

describe('PLAN-D — pauseCutAt on the loss ledger', () => {
  it('pre-pause voiced tail plus an unowned failure during the pause stays accountable', () => {
    const { ledger, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    // Voiced audio dispatched BEFORE the pause, never retired by a watermark.
    ledger.recordDispatched({
      dispatchEpoch: E(1),
      epochScope: epoch(1),
      captureSampleRange: { start: 0, end: 9600 },
      dispatchedSampleRange: { start: 0, end: 9600 },
      voiced: true,
    });
    ledger.setPauseCut(9600);
    // Voiced audio after the cut — ineligible.
    ledger.recordDispatched({
      dispatchEpoch: E(1),
      epochScope: epoch(1),
      captureSampleRange: { start: 9600, end: 19200 },
      dispatchedSampleRange: { start: 9600, end: 19200 },
      voiced: true,
    });
    ledger.onSocketClosed(E(1), ACTIVE);
    expect(ledger.isEpisodeOpen).toBe(true);
    expect(ledger.unresolvedEntryCount).toBe(1);
    ledger.onSocketOpened(E(2));
    expect(disclosed).toHaveLength(1);
  });

  it('audio wholly after the cut plus a failure opens no episode and discloses nothing', () => {
    const { ledger, disclosed, events } = harness();
    ledger.onSocketOpened(E(1));
    ledger.setPauseCut(0);
    ledger.recordDispatched({
      dispatchEpoch: E(1),
      epochScope: epoch(1),
      captureSampleRange: { start: 0, end: 9600 },
      dispatchedSampleRange: { start: 0, end: 9600 },
      voiced: true,
    });
    ledger.onSocketClosed(E(1), ACTIVE);
    // Voice keeps arriving at the tap while the socket is down.
    ledger.recordDropped({
      epochScope: epoch(1),
      captureSampleRange: { start: 9600, end: 19200 },
      samples: voicedPcm(9600),
    });
    ledger.recordDropped({
      epochScope: { kind: 'preOpen', captureAttemptId: 2 } as EpochScope,
      captureSampleRange: { start: 19200, end: 28800 },
      samples: voicedPcm(9600),
    });
    expect(ledger.isEpisodeOpen).toBe(false);
    expect(ledger.unresolvedEntryCount).toBe(0);
    ledger.onSocketOpened(E(2));
    expect(disclosed).toHaveLength(0);
    expect(events).not.toContain('uplink_loss_episode_material');
  });

  it('the same failure while recording (no cut) keeps the existing disclosure', () => {
    const { ledger, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.recordDispatched({
      dispatchEpoch: E(1),
      epochScope: epoch(1),
      captureSampleRange: { start: 0, end: 9600 },
      dispatchedSampleRange: { start: 0, end: 9600 },
      voiced: true,
    });
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.recordDropped({
      epochScope: epoch(1),
      captureSampleRange: { start: 9600, end: 19200 },
      samples: voicedPcm(9600),
    });
    ledger.onSocketOpened(E(2));
    expect(disclosed).toHaveLength(1);
  });

  it('a block straddling the cut keeps only its pre-cut part', () => {
    const { ledger } = harness();
    ledger.onSocketOpened(E(1));
    ledger.setPauseCut(4000);
    ledger.recordDispatched({
      dispatchEpoch: E(1),
      epochScope: epoch(1),
      captureSampleRange: { start: 3000, end: 5000 },
      dispatchedSampleRange: { start: 3000, end: 5000 },
      voiced: true,
      samples: voicedPcm(2000),
    });
    expect(ledger.unresolvedEntryCount).toBe(1);
    // A watermark covering only the pre-cut part retires the clipped entry.
    ledger.advanceWatermark(E(1), 4000);
    expect(ledger.unresolvedEntryCount).toBe(0);
  });

  it('a frame straddling the cut is classified on its pre-cut part: post-cut speech cannot make a short tail material', () => {
    // The reviewer's scenario: a pre-cut voiced tail just short of the
    // disclosure debounce, then one Flux frame whose pre-cut part is SILENT
    // and whose post-cut part is speech. The whole frame classifies voiced.
    const { ledger, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    const tail = MATERIAL_VOICED_DEBOUNCE_SAMPLES - 400;
    ledger.recordDispatched({
      dispatchEpoch: E(1),
      epochScope: epoch(1),
      captureSampleRange: { start: 0, end: tail },
      dispatchedSampleRange: { start: 0, end: tail },
      voiced: true,
      samples: voicedPcm(tail),
    });
    const cut = tail + 640;
    ledger.setPauseCut(cut);
    const frame = new Int16Array(1280);
    frame.set(voicedPcm(640), 640); // silent pre-cut half, loud post-cut half
    ledger.recordDispatched({
      dispatchEpoch: E(1),
      epochScope: epoch(1),
      captureSampleRange: { start: tail, end: tail + 1280 },
      dispatchedSampleRange: { start: tail, end: tail + 1280 },
      voiced: true, // the whole-frame verdict the sender computed
      samples: frame,
    });
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.onSocketOpened(E(2));
    expect(disclosed).toHaveLength(0);
  });

  it('a straddling frame whose pre-cut part IS speech keeps that part accountable', () => {
    const { ledger } = harness();
    ledger.onSocketOpened(E(1));
    ledger.setPauseCut(640);
    const frame = new Int16Array(1280);
    frame.set(voicedPcm(640), 0); // loud pre-cut half, silent post-cut half
    ledger.recordDispatched({
      dispatchEpoch: E(1),
      epochScope: epoch(1),
      captureSampleRange: { start: 0, end: 1280 },
      dispatchedSampleRange: { start: 0, end: 1280 },
      voiced: false, // the whole frame may read quieter than its pre-cut part
      samples: frame,
    });
    ledger.onSocketClosed(E(1), ACTIVE);
    expect(ledger.unresolvedEntryCount).toBe(1);
  });

  it('clearing the cut on resume makes new capture accountable again', () => {
    const { ledger, disclosed } = harness();
    ledger.onSocketOpened(E(1));
    ledger.setPauseCut(0);
    expect(ledger.pauseCut).toBe(0);
    ledger.clearPauseCut();
    expect(ledger.pauseCut).toBeNull();
    ledger.onSocketClosed(E(1), ACTIVE);
    ledger.recordDropped({
      epochScope: epoch(1),
      captureSampleRange: { start: 0, end: 9600 },
      samples: voicedPcm(9600),
    });
    ledger.onSocketOpened(E(2));
    expect(disclosed).toHaveLength(1);
  });
});
