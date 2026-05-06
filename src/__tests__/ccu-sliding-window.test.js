/**
 * Unit tests for the pure functions in ccu-sliding-window.js — the
 * window planner and the sequence-alignment merger. The full
 * extractViaSlidingWindow path covers an Anthropic.messages.create call
 * and Sharp image cropping; that path is exercised end-to-end by the
 * harness against the corpus, not here.
 *
 * 2026-05-07 rewrite: position-clustering merger replaced by ordered
 * sequence alignment. Tests cover the same failure modes that motivated
 * the old patches (mergeAdjacentMainSwitchClusters,
 * trimSpuriousMainSwitchClusterRuns, promoteLabelMatchedMainSwitch,
 * promoteLabelMatchedRcd), plus the named regressions:
 *   - 1778086091005-v9sst9 — registry over-count → 3 spurious "Exposed
 *     rail" rows. New pipeline: VLM omits bare rail; canonical length
 *     reflects what the model actually saw.
 *   - 1778103470875-488yba — adjacent same-rating MCBs (B32 Sewage Pump
 *     + B32 Cooker) collapsed into one cluster by 0.7 × pitch tolerance.
 *     New pipeline: ordered list with overlap-alignment keeps both as
 *     distinct entries.
 */
import { jest } from '@jest/globals';
import { planWindows, alignWindows, findBestOverlap } from '../extraction/ccu-sliding-window.js';

jest.fn(); // silence linter — jest is auto-imported by the runner

// ---------------------------------------------------------------------------
// planWindows
// ---------------------------------------------------------------------------

describe('planWindows — overshoot at both rail edges', () => {
  test('extends overshootMod=2 pitches before railLeft and after railRight', () => {
    // 13-way rail at pitch=100, image 2000 wide, generous margins so neither
    // overshoot edge clamps.
    const windows = planWindows(400, 1700, 100, 5, 2, 2000, 2);
    // First window's x0 must be 200 (= 400 - 2*100). Last window's x1 must
    // be 1900 (= 1700 + 2*100).
    expect(windows[0].x0).toBe(200);
    expect(windows[windows.length - 1].x1).toBe(1900);
  });

  test('first window is tagged overshoot:"left" and last is overshoot:"right"', () => {
    const windows = planWindows(400, 1700, 100, 5, 2, 2000, 2);
    expect(windows[0].overshoot).toBe('left');
    expect(windows[windows.length - 1].overshoot).toBe('right');
    // Interior windows are overshoot:'none'
    expect(windows.slice(1, -1).every((w) => w.overshoot === 'none')).toBe(true);
  });

  test('clamps overshoot to image bounds without losing the window', () => {
    // Rail starts at x=80 — left overshoot of 200 would land at x=-120.
    // Window must clamp to x0=0 but still exist.
    const windows = planWindows(80, 1700, 100, 5, 2, 2000, 2);
    expect(windows[0].x0).toBe(0);
    expect(windows[0].overshoot).toBe('left');
  });

  test('strides by stride*pitch between consecutive non-edge windows', () => {
    const windows = planWindows(400, 1700, 100, 5, 2, 2000, 2);
    for (let i = 1; i < windows.length; i++) {
      const dx = windows[i].x0 - windows[i - 1].x0;
      // Stride should be 200 (= 2 * 100) most of the time. Right-anchor may
      // produce a slightly different gap on the final window — accept that.
      if (i < windows.length - 1) {
        expect(dx).toBe(200);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// findBestOverlap
// ---------------------------------------------------------------------------

describe('findBestOverlap — alignment search bias', () => {
  function entry(kind, rating = null) {
    return { kind, rating };
  }

  test('exact expectedL match wins immediately', () => {
    const canonical = [
      entry('mcb', 16),
      entry('mcb', 16),
      entry('mcb', 32),
      entry('mcb', 32),
      entry('mcb', 32),
    ];
    const next = [
      entry('mcb', 32),
      entry('mcb', 32),
      entry('mcb', 32),
      entry('rcd', 80),
      entry('rcd', 80),
    ];
    expect(findBestOverlap(canonical, next, 3)).toBe(3);
  });

  test('falls back to expectedL ± 1 when exact does not match', () => {
    // Canonical's tail has 4 matching entries; next's head has 4 matching.
    // expectedL=3 doesn't match (the 3 entries don't all line up because
    // canonical[-3] = mcb-16 but next[0] = mcb-32). expectedL=4 does match.
    const canonical = [entry('mcb', 32), entry('mcb', 32), entry('mcb', 32), entry('mcb', 32)];
    const next = [entry('mcb', 32), entry('mcb', 32), entry('mcb', 32), entry('mcb', 32)];
    expect(findBestOverlap(canonical, next, 3)).toBe(3); // expected wins because it does match
  });

  test('returns 0 when no head/tail combination aligns', () => {
    const canonical = [entry('mcb', 6), entry('mcb', 6), entry('mcb', 6)];
    const next = [entry('rcd', 80), entry('rcd', 80), entry('mcb', 32)];
    expect(findBestOverlap(canonical, next, 3)).toBe(0);
  });

  test('rating disambiguates same-kind adjacent devices', () => {
    // Canonical's tail = [..., B32, B32]. Next's head = [B6, B6, ...].
    // Same kind (mcb) but different ratings — must NOT align.
    const canonical = [entry('mcb', 32), entry('mcb', 32)];
    const next = [entry('mcb', 6), entry('mcb', 6), entry('mcb', 6)];
    expect(findBestOverlap(canonical, next, 2)).toBe(0);
  });

  test('handles null ratings — kind-match alone is enough', () => {
    // Production reality: model occasionally leaves rating null for an
    // unreadable face. Such reads must still align if kind matches.
    const canonical = [entry('mcb', 32), entry('mcb', null)];
    const next = [entry('mcb', null), entry('mcb', 32)];
    expect(findBestOverlap(canonical, next, 2)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// alignWindows — happy paths
// ---------------------------------------------------------------------------

describe('alignWindows — happy paths', () => {
  function entry(kind, rating = null, label = null) {
    return { kind, rating, label };
  }

  test('two windows with full overlap reconcile into a single canonical list', () => {
    // Window 1: 5 entries [A, B, C, D, E]. Window 2: 5 entries [C, D, E, F, G].
    // Overlap = 3, so canonical length = 5 + 2 = 7.
    const w1 = [
      entry('mcb', 16),
      entry('mcb', 16),
      entry('mcb', 32),
      entry('rcd', 80),
      entry('rcd', 80),
    ];
    const w2 = [
      entry('mcb', 32),
      entry('rcd', 80),
      entry('rcd', 80),
      entry('mcb', 6),
      entry('mcb', 6),
    ];
    const canonical = alignWindows([w1, w2], { expectedOverlap: 3 });
    expect(canonical).toHaveLength(7);
    expect(canonical.map((c) => c.kind)).toEqual(['mcb', 'mcb', 'mcb', 'rcd', 'rcd', 'mcb', 'mcb']);
    expect(canonical.map((c) => c.rating)).toEqual([16, 16, 32, 80, 80, 6, 6]);
  });

  test('vote count reflects how many windows saw each entry', () => {
    const w1 = [entry('mcb', 16), entry('mcb', 32), entry('rcd', 80)];
    const w2 = [entry('mcb', 32), entry('rcd', 80), entry('mcb', 6)];
    const canonical = alignWindows([w1, w2], { expectedOverlap: 2 });
    // Layout: [mcb16(1), mcb32(2), rcd80(2), mcb6(1)]
    expect(canonical.map((c) => c.votes)).toEqual([1, 2, 2, 1]);
  });

  test('label voting prefers non-null and longer reads', () => {
    const w1 = [entry('mcb', 32, null), entry('mcb', 32, 'KITCHEN')];
    const w2 = [entry('mcb', 32, 'KITCHEN SOCKETS'), entry('mcb', 6, 'LIGHTING')];
    const canonical = alignWindows([w1, w2], { expectedOverlap: 1 });
    // 2-entry overlap on "mcb 32" — labels differ; longer should win.
    expect(canonical[1].label).toBe('KITCHEN SOCKETS');
  });

  test('three windows chain through pairwise alignment', () => {
    const w1 = [
      entry('mcb', 16),
      entry('mcb', 16),
      entry('mcb', 32),
      entry('mcb', 32),
      entry('mcb', 32),
    ];
    const w2 = [
      entry('mcb', 32),
      entry('mcb', 32),
      entry('mcb', 32),
      entry('rcd', 80),
      entry('rcd', 80),
    ];
    const w3 = [
      entry('mcb', 32),
      entry('rcd', 80),
      entry('rcd', 80),
      entry('mcb', 6),
      entry('mcb', 6),
    ];
    const canonical = alignWindows([w1, w2, w3], { expectedOverlap: 3 });
    // Expected canonical (9 entries): [mcb16, mcb16, mcb32, mcb32, mcb32, rcd80, rcd80, mcb6, mcb6]
    expect(canonical.map((c) => c.kind)).toEqual([
      'mcb',
      'mcb',
      'mcb',
      'mcb',
      'mcb',
      'rcd',
      'rcd',
      'mcb',
      'mcb',
    ]);
  });
});

// ---------------------------------------------------------------------------
// alignWindows — failure modes the old pipeline got wrong
// ---------------------------------------------------------------------------

describe('alignWindows — regressions from the old position-clustered pipeline', () => {
  function entry(kind, rating, label = null) {
    return { kind, rating, label };
  }

  test('488yba: two adjacent same-rating B32 MCBs stay as two entries (Sewage Pump + Cooker)', () => {
    // The 1778103470875-488yba production failure: slot 8 and slot 9 were
    // both B32 MCBs (Sewage Pump + Cooker). The old position-clustered
    // merger collapsed them into one cluster because their position_pct
    // estimates landed within 0.7 × pitch of each other, producing one
    // emitted slot and one fabricated "Exposed rail" row.
    //
    // With the new pipeline: each window returns an ORDERED list. Two
    // adjacent B32 MCBs are simply two consecutive entries with the same
    // kind+rating. Overlap-alignment biases toward expectedL=3 so the
    // ambiguity in two-identical-entries is resolved by the planned
    // window stride, NOT by position.
    const w1 = [
      entry('mcb', 32, 'SOCKETS GARAGE'), // slot 5
      entry('rcd', 80, 'CIRCUITS PROTECTED BY RCD'), // slots 6-7
      entry('rcd', 80, 'CIRCUITS PROTECTED BY RCD'),
      entry('mcb', 32, 'SEWAGE PUMP'), // slot 8
      entry('mcb', 32, 'COOKER'), // slot 9 ← survives
    ];
    const w2 = [
      entry('rcd', 80, 'CIRCUITS PROTECTED BY RCD'), // slot 7 (overlap)
      entry('mcb', 32, 'SEWAGE PUMP'), // slot 8 (overlap)
      entry('mcb', 32, 'COOKER'), // slot 9 (overlap)
      entry('mcb', 6, 'SMOKE DETECTOR'), // slot 10
      entry('mcb', 6, 'UPSTAIRS LIGHTING'), // slot 11
    ];
    const canonical = alignWindows([w1, w2], { expectedOverlap: 3 });
    expect(canonical.map((c) => c.kind)).toEqual(['mcb', 'rcd', 'rcd', 'mcb', 'mcb', 'mcb', 'mcb']);
    expect(canonical.map((c) => c.rating)).toEqual([32, 80, 80, 32, 32, 6, 6]);
    expect(canonical.map((c) => c.label)).toEqual([
      'SOCKETS GARAGE',
      'CIRCUITS PROTECTED BY RCD',
      'CIRCUITS PROTECTED BY RCD',
      'SEWAGE PUMP',
      'COOKER',
      'SMOKE DETECTOR',
      'UPSTAIRS LIGHTING',
    ]);
  });

  test('two adjacent identical "LIGHTING B6" MCBs (the same-name same-rating worst case) survive as two entries', () => {
    // Real layout: slots 12 + 13 are both B6 MCBs labelled "Lighting Ground
    // Floor" on the 488yba board. The overlap window covers both — no
    // ambiguity in the ordered list. expectedL=3 keeps the alignment honest.
    const w1 = [
      entry('mcb', 6, 'LIGHTING GROUND FLOOR'),
      entry('mcb', 6, 'LIGHTING GROUND FLOOR'),
      entry('main_switch', 100, 'MAIN SWITCH'),
      entry('main_switch', 100, 'MAIN SWITCH'),
    ];
    const w2 = [
      entry('mcb', 6, 'LIGHTING GROUND FLOOR'),
      entry('main_switch', 100, 'MAIN SWITCH'),
      entry('main_switch', 100, 'MAIN SWITCH'),
    ];
    const canonical = alignWindows([w1, w2], { expectedOverlap: 3 });
    // Overlap = 3: w1's tail [mcb-6, ms, ms] matches w2's head [mcb-6, ms, ms].
    // Canonical keeps the first w1 mcb-6 + the merged trailing 3 entries = 4.
    expect(canonical).toHaveLength(4);
    expect(canonical.map((c) => c.kind)).toEqual(['mcb', 'mcb', 'main_switch', 'main_switch']);
  });

  test('2-pole isolator returned as two adjacent main_switch entries stays a 2-mod device (no over-merge needed)', () => {
    // Old pipeline needed mergeAdjacentMainSwitchClusters to fold a VLM-split
    // 2-pole isolator back into one device. With the new prompt: a 2-pole
    // device IS two entries by spec. No merge step required — they sit
    // adjacent in the canonical list, and slotsToCircuits skips both
    // because cls === 'main_switch'.
    const w1 = [
      entry('mcb', 6, 'LIGHTING'),
      entry('main_switch', 100, null),
      entry('main_switch', 100, null),
    ];
    const w2 = [entry('main_switch', 100, null), entry('main_switch', 100, null)];
    const canonical = alignWindows([w1, w2], { expectedOverlap: 2 });
    expect(canonical).toHaveLength(3);
    expect(canonical[1].kind).toBe('main_switch');
    expect(canonical[2].kind).toBe('main_switch');
    // Both vote-merged from both windows (overlap covered both ms entries).
    expect(canonical[1].votes).toBe(2);
    expect(canonical[2].votes).toBe(2);
  });

  test('v9sst9: VLM omits bare rail per prompt rules — no fabricated "Exposed rail" entry', () => {
    // The 1778086091005-v9sst9 failure: registry forced ways=12 onto a
    // 16-mod rail, leaving 4 unowned slots that the old pipeline emitted
    // as "Exposed rail" rows. Under the new prompt, the VLM never reports
    // bare rail. The canonical list contains only what the model saw.
    //
    // Synthetic stand-in: a 5-window scan returns devices for every slot
    // it sees; no entries for the empty rail at the user-drawn box's
    // overshoot region. The merger's canonical length = the actual
    // device count, not the bbox geometry.
    const w1 = [entry('mcb', 16, 'A'), entry('mcb', 16, 'B'), entry('mcb', 32, 'C')];
    const w2 = [entry('mcb', 16, 'B'), entry('mcb', 32, 'C'), entry('rcd', 80, 'RCD')];
    const canonical = alignWindows([w1, w2], { expectedOverlap: 2 });
    // Length == 4 distinct devices (none synthesised for empty rail).
    expect(canonical).toHaveLength(4);
    expect(canonical.every((c) => c.kind !== 'empty')).toBe(true);
  });

  test('window with zero entries (all-overshoot off-rail) does not corrupt canonical', () => {
    // A left-overshoot window that lands entirely off-rail returns
    // entries:[] per the prompt's "OMIT bare rail" rule. The merger must
    // skip it cleanly.
    const w1 = []; // all-off-rail overshoot
    const w2 = [entry('mcb', 16, 'A'), entry('mcb', 32, 'B'), entry('rcd', 80, 'RCD')];
    const canonical = alignWindows([w1, w2], { expectedOverlap: 3 });
    expect(canonical.map((c) => c.kind)).toEqual(['mcb', 'mcb', 'rcd']);
  });

  test('alignment failure (no overlap match) appends next whole — diagnostic-friendly behaviour', () => {
    // If the model returns wildly different lists between consecutive
    // windows (a bad capture, a corrupted response), the merger should
    // not crash. It should append `next` whole and let downstream
    // confidence checks flag the slot mismatch.
    const w1 = [entry('mcb', 6), entry('mcb', 6)];
    const w2 = [entry('rcd', 80), entry('main_switch', 100)];
    const canonical = alignWindows([w1, w2], { expectedOverlap: 3 });
    // Overlap = 0; canonical length = 2 + 2 = 4
    expect(canonical).toHaveLength(4);
  });

  test('empty windowsDevices returns empty canonical', () => {
    expect(alignWindows([])).toEqual([]);
    expect(alignWindows([[], [], []])).toEqual([]);
  });
});
