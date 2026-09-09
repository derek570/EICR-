/**
 * A02D RegexFreshOccurrenceV1 — module-level contracts not covered by the
 * shared fixture runner: the admitted buffer's session-monotonic positions
 * and front-trim, source-map ambiguity, the evaluation ORDER, bounded
 * eviction across N reconnects, destination labels/diffs, and the A01B
 * producer-table join.
 */
import { describe, expect, it } from 'vitest';
import {
  ADMITTED_BUFFER_KEEP_CHARS,
  ADMITTED_BUFFER_TRIM_THRESHOLD,
  AdmittedBuffer,
  OccurrenceFreshnessStore,
  applyOccurrenceFreshness,
  canonicalDestinationKey,
  describeDestination,
  diffRegexDestinations,
  producerJoinKey,
  readRegexDestinationValue,
  type OccurrenceCandidate,
} from '@/lib/recording/regex-fresh-occurrence';
import { buildSourceMap } from '@/lib/recording/normalisation-source-map';
import { buildFinalWindow, type FinalWindowV1 } from '@/lib/recording/final-window';
import { TranscriptFieldMatcher } from '@/lib/recording/transcript-field-matcher';
import type { ConnectionEpoch } from '@/lib/recording/uplink-scope-allocator';
import type { JobDetail } from '@/lib/types';

const E = (n: number) => n as ConnectionEpoch;

function final(
  seq: number,
  epoch = 1,
  speechStart: number | null = seq * 1000,
  windowEnd: number | null = seq * 1000 + 500
): FinalWindowV1 {
  return buildFinalWindow({
    recordingSessionId: 'S',
    epoch: E(epoch),
    finalSequence: seq,
    speechStart,
    windowEnd,
  });
}

function job(): JobDetail {
  return {
    id: 'j',
    job_id: 'j',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: 'a',
    created_date: '',
    last_modified: '',
    circuits: [
      { id: 'row4', circuit_ref: '4', circuit_designation: 'Cooker' },
      { id: 'row3', circuit_ref: '3', circuit_designation: 'Kitchen ring' },
    ],
    supply_characteristics: { ze: '0.35' },
    board_info: {},
    installation_details: {},
  } as unknown as JobDetail;
}

describe('AdmittedBuffer — positions are session-monotonic', () => {
  it('append/reset/trim never reuse an absolute position', () => {
    const b = new AdmittedBuffer();
    const f1 = b.append('one', [final(1)], E(1));
    const f2 = b.append('two', [final(2)], E(1));
    expect(f1.rawStart).toBe(0);
    expect(f1.rawEnd).toBe(3);
    expect(f2.rawStart).toBe(4); // one space separator
    expect(b.text).toBe('one two');
    const headBefore = b.head;
    b.resetText();
    expect(b.text).toBe('');
    expect(b.baseOffset).toBe(headBefore);
    const f3 = b.append('three', [final(3)], E(2));
    expect(f3.rawStart).toBe(headBefore);
    expect(b.fragmentsIn(0, 3)).toEqual([]); // evicted text is unreachable
    expect(b.fragmentsIn(headBefore, headBefore + 1).map((f) => f.id)).toEqual([f3.id]);
  });

  it('front-trims at a fragment boundary once over the threshold and keeps the tail', () => {
    const b = new AdmittedBuffer();
    const chunk = 'x'.repeat(100);
    let seq = 0;
    while (b.text.length <= ADMITTED_BUFFER_TRIM_THRESHOLD) b.append(chunk, [final(++seq)], E(1));
    const before = b.head;
    const cut = b.trimIfNeeded();
    expect(cut).toBeGreaterThan(0);
    expect(b.head).toBe(before); // absolute head unchanged
    expect(b.text.length).toBeGreaterThanOrEqual(ADMITTED_BUFFER_KEEP_CHARS);
    expect(b.text.length).toBeLessThan(ADMITTED_BUFFER_TRIM_THRESHOLD);
    expect(b.fragments[0].rawStart).toBe(b.baseOffset);
    expect(b.trimIfNeeded()).toBe(0);
  });
});

describe('source map — ambiguity and identity', () => {
  it('anchored tokens map 1:1 with identity inside the token', () => {
    const sm = buildSourceMap('Circuit 4 Zs is 0.35.', 'Circuit 4 Zs is 0.35.');
    const idx = sm.normalised.indexOf('0.35');
    const m = sm.mapSpan(idx, idx + 4);
    expect(m).toEqual({ rawStart: idx, rawEnd: idx + 4, ambiguous: false });
  });
  it('a pure insertion (no raw tokens) is ambiguous', () => {
    const sm = buildSourceMap('Zs is', 'Zs is 0.35');
    const idx = sm.normalised.indexOf('0.35');
    expect(sm.mapSpan(idx, idx + 4).ambiguous).toBe(true);
  });
  it('an empty or whitespace-only span is ambiguous', () => {
    const sm = buildSourceMap('a b', 'a b');
    expect(sm.mapSpan(1, 2).ambiguous).toBe(true);
    expect(sm.mapSpan(2, 2).ambiguous).toBe(true);
  });
  it('a changed run maps to the raw run between the same anchors', () => {
    const raw = 'Zs is nought point three five ohms';
    const norm = 'Zs is 0.35 ohms';
    const sm = buildSourceMap(raw, norm);
    const m = sm.mapSpan(norm.indexOf('0.35'), norm.indexOf('0.35') + 4);
    expect(raw.slice(m.rawStart, m.rawEnd)).toBe('nought point three five');
    expect(m.ambiguous).toBe(false);
  });
});

describe('OccurrenceFreshnessStore — evaluation order', () => {
  const cand = (over: Partial<OccurrenceCandidate> = {}): OccurrenceCandidate => ({
    destination: 'circuit.row4.measured_zs_ohm',
    rawStart: 0,
    rawEnd: 10,
    fragmentIds: ['frag_1'],
    epoch: E(1),
    maxFinalSequence: 1,
    ambiguous: false,
    finals: [final(1)],
    ...over,
  });

  it('ambiguous → unbounded → old overlap → settled → buffer cutoff → stream cutoff → fresh', () => {
    const s = new OccurrenceFreshnessStore();
    expect(s.evaluate(cand({ ambiguous: true }), 1)).toBe('ambiguous');
    expect(s.evaluate(cand({ finals: [final(1, 1, null)] }), 1)).toBe('ineligible_unbounded');
    expect(s.evaluate(cand(), 2)).toBe('settled'); // old overlap: maxSeq 1 < current 2
    expect(s.evaluate(cand(), 1)).toBe('fresh');
    s.settle(cand());
    expect(s.evaluate(cand(), 1)).toBe('settled');
    // A NEW fragment with a higher sequence overlapping the settled span is
    // not settled by it (a cross-final completion) …
    expect(
      s.evaluate(
        cand({
          rawStart: 5,
          rawEnd: 20,
          maxFinalSequence: 2,
          finals: [final(1), final(2)],
          fragmentIds: ['frag_1', 'frag_2'],
        }),
        2
      )
    ).toBe('fresh');
    // … but a buffer cutoff at or above its sequence makes it stale.
    s.recordUtteranceCutoff('circuit.row4.measured_zs_ohm', 2);
    expect(
      s.evaluate(
        cand({
          rawStart: 5,
          rawEnd: 20,
          maxFinalSequence: 2,
          finals: [final(2)],
          fragmentIds: ['frag_2'],
        }),
        2
      )
    ).toBe('stale_buffer');
    expect(
      s.evaluate(
        cand({
          rawStart: 30,
          rawEnd: 40,
          maxFinalSequence: 3,
          finals: [final(3)],
          fragmentIds: ['frag_3'],
        }),
        3
      )
    ).toBe('fresh');
    // A cross-final completion with ANY constituent at or below the buffer
    // cutoff is stale even though its max sequence is above it (the anchor
    // arrived before the causative clear; the value fragment after it).
    expect(
      s.evaluate(
        cand({
          rawStart: 5,
          rawEnd: 40,
          maxFinalSequence: 3,
          finals: [final(1), final(3)],
          fragmentIds: ['frag_1', 'frag_3'],
        }),
        3
      )
    ).toBe('stale_buffer');
    // Manual stream cutoff on the fragment's epoch: onset below the tap → stale_stream.
    s.recordManualCutoff('circuit.row4.measured_zs_ohm', 'circuit 4 Zs', {
      epoch: E(1),
      dispatchedOffset: 4500,
      bufferOffset: 40,
      bufferFinalSequence: 3,
    });
    expect(
      s.evaluate(
        cand({
          rawStart: 50,
          rawEnd: 60,
          maxFinalSequence: 4,
          finals: [final(4, 1, 4000)],
          fragmentIds: ['frag_4'],
        }),
        4
      )
    ).toBe('stale_stream');
    expect(
      s.evaluate(
        cand({
          rawStart: 50,
          rawEnd: 60,
          maxFinalSequence: 4,
          finals: [final(4, 1, 4500)],
          fragmentIds: ['frag_4'],
        }),
        4
      )
    ).toBe('fresh');
  });

  it('an identity-less utterance boundary settles nothing new and never advances the cutoff', () => {
    const s = new OccurrenceFreshnessStore();
    s.recordUtteranceCutoff('supply.ze', null);
    expect(s.bufferCutoffFor('supply.ze')).toBeNull();
    s.recordUtteranceCutoff('supply.ze', 3);
    s.recordUtteranceCutoff('supply.ze', 2); // never moves backwards
    expect(s.bufferCutoffFor('supply.ze')).toBe(3);
  });

  it("hold decision: applies only to cutoffs recorded since the epoch's last accepted final; unbounded held; equality fresh; other epochs unaffected", () => {
    const s = new OccurrenceFreshnessStore();
    s.noteAccepted([final(1)]);
    s.recordManualCutoff('supply.ze', 'Ze', {
      epoch: E(1),
      dispatchedOffset: 8000,
      bufferOffset: 0,
      bufferFinalSequence: 1,
    });
    expect(s.holdDecision([final(2, 1, 6720)])).toEqual({ held: true, destinations: ['Ze'] });
    expect(s.holdDecision([final(2, 1, null)])).toEqual({ held: true, destinations: ['Ze'] });
    expect(s.holdDecision([final(2, 2, 10)]).held).toBe(false); // a different epoch
    expect(s.holdDecision([final(2, 1, 8000)]).held).toBe(false); // equality is fresh
    s.noteAccepted([final(2, 1, 8000)]);
    expect(s.holdDecision([final(3, 1, null)]).held).toBe(false); // no longer applies
    expect(s.heldFinalCount).toBe(2);
  });

  it('a concatenated dispatch is held whole when ANY constituent is pre-cutoff', () => {
    const s = new OccurrenceFreshnessStore();
    s.recordManualCutoff('supply.ze', 'Ze', {
      epoch: E(1),
      dispatchedOffset: 8000,
      bufferOffset: 0,
      bufferFinalSequence: null,
    });
    expect(s.holdDecision([final(1, 1, 7000), final(2, 1, 9000)]).held).toBe(true);
    expect(s.holdDecision([final(1, 1, 8000), final(2, 1, 9000)]).held).toBe(false);
  });
});

describe('bounded retention across N reconnects', () => {
  it('twenty reconnects with long finals: the buffer front-trims and the store evicts settled epochs', () => {
    const j = job();
    const matcher = new TranscriptFieldMatcher();
    const buffer = new AdmittedBuffer();
    const store = new OccurrenceFreshnessStore();
    let seq = 0;
    let maxRecords = 0;
    for (let epoch = 1; epoch <= 20; epoch++) {
      for (let k = 0; k < 6; k++) {
        const w = final(++seq, epoch, seq * 100, seq * 100 + 50);
        store.recordFinal(w);
        store.noteAccepted([w]);
        // A manual cutoff on every epoch keeps the per-epoch lists non-empty.
        if (k === 0) {
          store.recordManualCutoff('circuit.row4.measured_zs_ohm', 'circuit 4 Zs', {
            epoch: E(epoch),
            dispatchedOffset: seq * 100,
            bufferOffset: buffer.head,
            bufferFinalSequence: seq - 1 || null,
          });
        }
        const text = `Circuit 4 Zs is 0.${(seq % 9) + 1}5. The weather on the ${seq}th visit was ordinary and unremarkable.`;
        const fragment = buffer.append(text, [w], E(epoch));
        const raw = matcher.match(buffer.text, j);
        applyOccurrenceFreshness(raw, buffer, fragment, j, store);
        const trimmed = buffer.trimIfNeeded();
        if (trimmed > 0) {
          matcher.shiftProcessedOffset(trimmed);
          const retained = buffer.fragments;
          store.evict(
            buffer.baseOffset,
            Math.min(...retained.map((f) => f.finalSequence)),
            new Set<ConnectionEpoch>([...retained.map((f) => f.epoch), E(epoch)])
          );
        }
        maxRecords = Math.max(maxRecords, store.retainedRecordCount);
      }
    }
    expect(seq).toBe(120);
    expect(buffer.text.length).toBeLessThanOrEqual(ADMITTED_BUFFER_TRIM_THRESHOLD);
    expect(buffer.fragments.length).toBeLessThan(40);
    // Bounded: far fewer records than finals seen, and the LAST epoch's
    // cutoff still holds while the earliest ones are gone.
    expect(store.retainedRecordCount).toBeLessThan(60);
    expect(maxRecords).toBeLessThan(80);
    expect(store.getFinal(1)).toBeUndefined();
    expect(store.getFinal(120)).toBeDefined();
    expect(store.holdDecision([final(121, 20, 0)]).held).toBe(false); // epoch 20's last accepted moved on
  });
});

describe('destinations — labels, diffs, canonical keys, producer table', () => {
  it('describeDestination speaks the stored ref as displayed and the board only on multi-board jobs', () => {
    const j = job();
    expect(describeDestination('circuit.row4.measured_zs_ohm', j)).toBe('circuit 4 Zs');
    expect(describeDestination('supply.ze', j)).toBe('Ze');
    expect(describeDestination('install.client_name', j)).toBe('client name');
    expect(describeDestination('circuit.nope.measured_zs_ohm', j)).toBeNull();
    expect(describeDestination('circuit.row4.not_a_field', j)).toBeNull();
    const multi = {
      ...j,
      boards: [
        { id: 'b_main', designation: 'main' },
        { id: 'b_garage', designation: 'garage' },
      ],
      circuits: [
        {
          id: 'r1a',
          circuit_ref: '1a',
          circuit_designation: 'Garage lights',
          board_id: 'b_garage',
        },
      ],
    } as unknown as JobDetail;
    expect(describeDestination('circuit.r1a.r1_r2_ohm', multi)).toBe(
      'circuit 1a R1 plus R2 on the garage board'
    );
  });

  it('diffRegexDestinations reports cleared and replaced regex destinations only, by stable row id', () => {
    const before = job();
    const after = {
      ...before,
      supply_characteristics: { ze: '' },
      circuits: [
        { id: 'row4', circuit_ref: '4', circuit_designation: 'Cooker', measured_zs_ohm: '0.5' },
        { id: 'row3', circuit_ref: '3', circuit_designation: 'Kitchen ring renamed' },
      ],
    } as unknown as JobDetail;
    expect(diffRegexDestinations(before, after)).toEqual([
      { key: 'supply.ze', cleared: true },
      { key: 'circuit.row4.measured_zs_ohm', cleared: false },
    ]);
    expect(diffRegexDestinations(before, before)).toEqual([]);
    expect(readRegexDestinationValue(after, 'circuit.row4.measured_zs_ohm')).toBe('0.5');
    expect(readRegexDestinationValue(after, 'supply.ze')).toBeNull();
  });

  it('canonicalDestinationKey translates matcher refs to row ids and rejects unknown refs/fields', () => {
    const j = job();
    expect(canonicalDestinationKey('circuit.4.measured_zs_ohm', j)).toBe(
      'circuit.row4.measured_zs_ohm'
    );
    expect(canonicalDestinationKey('circuit.9.measured_zs_ohm', j)).toBeNull();
    expect(canonicalDestinationKey('supply.ze', j)).toBe('supply.ze');
    expect(canonicalDestinationKey('supply.unknown', j)).toBeNull();
  });

  it('[invariant] producer table: keyed ONLY by an A01B {session_epoch, mutation_id}; dormant otherwise; evicted with its epoch and counted as retained state', () => {
    const s = new OccurrenceFreshnessStore();
    expect(s.producerCount).toBe(0);
    const key = s.recordProducer(7, 'm-1', { kind: 'utterance', utteranceId: 'u-1' });
    expect(key).toBe(producerJoinKey(7, 'm-1'));
    expect(s.resolveProducer(7, 'm-1')).toEqual({ kind: 'utterance', utteranceId: 'u-1' });
    expect(s.resolveProducer(8, 'm-1')).toBeNull();
    s.recordProducer(8, 'm-2', {
      kind: 'manual',
      snapshot: { epoch: E(8), dispatchedOffset: 10, bufferOffset: 0, bufferFinalSequence: null },
    });
    expect(s.producerCount).toBe(2);
    expect(s.retainedRecordCount).toBe(2);
    // Epoch 7 leaves the retained window: its producer goes with it.
    s.evict(0, null, new Set<ConnectionEpoch>([E(8)]));
    expect(s.resolveProducer(7, 'm-1')).toBeNull();
    expect(s.resolveProducer(8, 'm-2')).not.toBeNull();
    expect(s.producerCount).toBe(1);
  });
});
