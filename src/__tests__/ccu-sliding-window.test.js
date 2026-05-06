/**
 * Unit tests for the pure functions in ccu-sliding-window.js — the
 * window planner and the position-clustering merger. These don't need
 * VLM mocking. The full extractViaSlidingWindow path covers an
 * Anthropic.messages.create call and Sharp image cropping; that's
 * tested end-to-end by spawning the harness against the corpus, not
 * here.
 */
import { jest } from '@jest/globals';
import {
  planWindows,
  clusterReads,
  mergeAdjacentMainSwitchClusters,
} from '../extraction/ccu-sliding-window.js';

// Silence the linter — jest is auto-imported by the test runner.
jest.fn(); // noop

describe('planWindows', () => {
  test('15-way Elucian (rail width 1500 px, pitch 100 px) → 6 windows of 5 modules wide, stride 2', () => {
    const windows = planWindows(0, 1500, 100, 5, 2, 1600);
    // 6 windows expected: [0..500], [200..700], [400..900], [600..1100], [800..1300], [1000..1500]
    expect(windows).toHaveLength(6);
    expect(windows[0]).toEqual({ x0: 0, x1: 500 });
    expect(windows[1]).toEqual({ x0: 200, x1: 700 });
    expect(windows[5]).toEqual({ x0: 1000, x1: 1500 });
    // Each interior slot is covered by 3 windows (stride 2, window 5)
    // — the redundancy that lets the merger vote on labels and absorb
    // single-window misreads.
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].x0 - windows[i - 1].x0).toBe(200);
    }
  });

  test('Anchors a final right-edge window when the natural stride under-covers', () => {
    // 13-way board: railWidth=1300, pitch=100, window=5 (500px), stride=2 (200px).
    // Natural windows: [0..500], [200..700], [400..900], [600..1100], [800..1300]
    // The last natural window's x1 == railRight, so no extra anchor.
    const w13 = planWindows(0, 1300, 100, 5, 2, 1600);
    expect(w13).toHaveLength(5);
    expect(w13[4]).toEqual({ x0: 800, x1: 1300 });

    // 14-way board: railWidth=1400. Natural windows end at x1=1300
    // (slot 13's right edge isn't covered). Right-anchored window
    // [900..1400] should be added to cover the rightmost slot.
    const w14 = planWindows(0, 1400, 100, 5, 2, 1600);
    expect(w14[w14.length - 1].x1).toBe(1400);
  });

  test('Dedupes the right-anchor when it matches the last natural window', () => {
    // railWidth=1500: stride lands the last natural window exactly on
    // the right edge (x0=1000, x1=1500). The right-anchor candidate
    // (x0=1000, x1=1500) is identical and must be deduped.
    const windows = planWindows(0, 1500, 100, 5, 2, 1600);
    const x0s = windows.map((w) => w.x0);
    const uniqueX0s = new Set(x0s);
    expect(x0s.length).toBe(uniqueX0s.size);
  });

  test('Clamps to the image right edge', () => {
    // Rail extends past the image (shouldn't happen, but defensively).
    const windows = planWindows(0, 2000, 100, 5, 2, 1600);
    for (const w of windows) {
      expect(w.x1).toBeLessThanOrEqual(1600);
    }
  });
});

describe('clusterReads', () => {
  function read(window, xImage, kind, rating, label) {
    return {
      window,
      xImage,
      widthMod: 1,
      kind,
      rating,
      curve: 'B',
      bs_en: 'BS EN 61009-1',
      rcd_type: 'A',
      rcd_rating_ma: 30,
      body_colour: null,
      label,
    };
  }

  test('Three reads of the same device (across 3 windows) cluster into one entry', () => {
    const pitchPx = 100;
    const reads = [
      read(1, 530, 'rcbo', 32, 'KITCHEN SOCKETS'),
      read(2, 535, 'rcbo', 32, 'KITCHEN SOCKETS'),
      read(3, 540, 'rcbo', 32, 'KITCHEN SOCKETS'),
    ];
    const clusters = clusterReads(reads, pitchPx);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].reads).toHaveLength(3);
  });

  test('Two adjacent same-name circuits one full pitch apart stay as TWO clusters', () => {
    // 0.7 × pitch = 70 px tolerance; two reads at 1000 and 1100 differ
    // by 100 px > 70 → separate clusters even when labels match. This
    // is the same-name-adjacent case (two LIGHTING circuits on a
    // schedule) — position MUST disambiguate.
    const pitchPx = 100;
    const reads = [read(1, 1000, 'rcbo', 6, 'LIGHTING'), read(2, 1100, 'rcbo', 6, 'LIGHTING')];
    const clusters = clusterReads(reads, pitchPx);
    expect(clusters).toHaveLength(2);
  });

  test('Reads with different kinds at similar positions stay separate (incompatible fingerprint)', () => {
    // A 2-pole main_switch and a 1-pole MCB at similar X but different
    // kinds are NOT the same physical device — the cluster predicate
    // rejects the merge.
    const pitchPx = 100;
    const reads = [
      read(1, 1500, 'mcb', 32, 'OVENS'),
      read(2, 1500, 'main_switch', 100, 'MAINS SWITCH'),
    ];
    const clusters = clusterReads(reads, pitchPx);
    expect(clusters).toHaveLength(2);
  });

  test('Within-tolerance reads cluster even when labels disagree (HOB ↔ OVENS VLM misread)', () => {
    // The 2026-05-05 prod failure mode: window 5 reads "HOB" at slot 11,
    // window 6 reads "OVENS" at the same physical position. Position +
    // kind agree → cluster. Voting decides the final label, NOT the
    // cluster predicate.
    const pitchPx = 100;
    const reads = [read(1, 1100, 'rcbo', 32, 'HOB'), read(2, 1110, 'rcbo', 32, 'OVENS')];
    const clusters = clusterReads(reads, pitchPx);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].reads).toHaveLength(2);
  });
});

describe('mergeAdjacentMainSwitchClusters', () => {
  function read(window, xImage, kind, widthMod = 1, label = null) {
    return {
      window,
      xImage,
      widthMod,
      kind,
      rating: 100,
      curve: null,
      bs_en: 'BS EN 60947-3',
      rcd_type: null,
      rcd_rating_ma: null,
      body_colour: null,
      label,
    };
  }

  test('Two adjacent widthMod=1 main_switch clusters ~1 pitch apart merge into one', () => {
    // Repro of extraction 1778043419386-zmidoj: VLM split a 2-pole isolator
    // into two single-module main_switch reads at module 12 and module 13
    // centres. clusterReads correctly kept them apart (>0.7 × pitch); the
    // merge step folds them back into one device with mergedSpan=2.
    const pitchPx = 384;
    const clusters = [
      { reads: [read(3, 4900, 'main_switch'), read(4, 4920, 'main_switch')] },
      { reads: [read(4, 5290, 'main_switch'), read(5, 5310, 'main_switch')] },
    ];
    const merged = mergeAdjacentMainSwitchClusters(clusters, pitchPx);
    expect(merged).toHaveLength(1);
    expect(merged[0].mergedSpan).toBe(2);
    expect(merged[0].reads).toHaveLength(4);
  });

  test('Three adjacent main_switch clusters merge into one widthMod=3 device (commercial 3-pole)', () => {
    const pitchPx = 100;
    const clusters = [
      { reads: [read(1, 1000, 'main_switch')] },
      { reads: [read(2, 1100, 'main_switch')] },
      { reads: [read(3, 1200, 'main_switch')] },
    ];
    const merged = mergeAdjacentMainSwitchClusters(clusters, pitchPx);
    expect(merged).toHaveLength(1);
    expect(merged[0].mergedSpan).toBe(3);
  });

  test('main_switch cluster next to mcb cluster does NOT merge (kind incompatible)', () => {
    const pitchPx = 100;
    const clusters = [{ reads: [read(1, 1000, 'main_switch')] }, { reads: [read(2, 1100, 'mcb')] }];
    const merged = mergeAdjacentMainSwitchClusters(clusters, pitchPx);
    expect(merged).toHaveLength(2);
    expect(merged[0].mergedSpan).toBe(1);
    expect(merged[1].mergedSpan).toBe(1);
  });

  test('main_switch clusters >1.5 pitch apart do NOT merge (legitimately separate isolators)', () => {
    const pitchPx = 100;
    const clusters = [
      { reads: [read(1, 1000, 'main_switch')] },
      // 250 px apart > 1.5 × 100 — could only happen if a board really
      // does have two physically distinct isolators with a gap between.
      { reads: [read(2, 1250, 'main_switch')] },
    ];
    const merged = mergeAdjacentMainSwitchClusters(clusters, pitchPx);
    expect(merged).toHaveLength(2);
  });

  test('Adjacent rcd clusters do NOT merge (split-load boards have separate RCDs)', () => {
    // Bedroom RCD next to kitchen RCD on a split-load board. The downstream
    // gap-fill in slotsToCircuits handles 2-module RCDs correctly without
    // needing a merge step here — and merging would wrongly collapse the
    // two physically distinct RCDs into one.
    const pitchPx = 100;
    const clusters = [{ reads: [read(1, 1000, 'rcd')] }, { reads: [read(2, 1100, 'rcd')] }];
    const merged = mergeAdjacentMainSwitchClusters(clusters, pitchPx);
    expect(merged).toHaveLength(2);
  });

  test('main_switch cluster with circuit-name label does NOT merge with main_switch cluster (RCBO mis-classified safety)', () => {
    // Stage 3's documented failure mode (trimSpuriousMainSwitchClusterRuns
    // in extraction.js): the VLM occasionally tags an adjacent RCBO as
    // main_switch when red-shroud bleed crosses the slot boundary. Without
    // this guard the merge would fold the real RCBO into the isolator and
    // the inspector would see one fewer circuit on the schedule.
    const pitchPx = 100;
    const clusters = [
      { reads: [read(1, 1000, 'main_switch', 1, 'Ovens')] }, // mis-tagged RCBO
      { reads: [read(2, 1100, 'main_switch', 1, 'MAINS SWITCH')] }, // real isolator
    ];
    const merged = mergeAdjacentMainSwitchClusters(clusters, pitchPx);
    expect(merged).toHaveLength(2);
  });

  test('main_switch + main_switch merge proceeds when labels are both null (handwritten / illegible strip)', () => {
    const pitchPx = 100;
    const clusters = [
      { reads: [read(1, 1000, 'main_switch', 1, null)] },
      { reads: [read(2, 1100, 'main_switch', 1, null)] },
    ];
    const merged = mergeAdjacentMainSwitchClusters(clusters, pitchPx);
    expect(merged).toHaveLength(1);
    expect(merged[0].mergedSpan).toBe(2);
  });

  test('main_switch + main_switch merge proceeds when one label is null and the other is main-switch-shaped', () => {
    const pitchPx = 100;
    const clusters = [
      { reads: [read(1, 1000, 'main_switch', 1, null)] },
      { reads: [read(2, 1100, 'main_switch', 1, 'MAINS SWITCH')] },
    ];
    const merged = mergeAdjacentMainSwitchClusters(clusters, pitchPx);
    expect(merged).toHaveLength(1);
    expect(merged[0].mergedSpan).toBe(2);
  });

  test('Empty / single-cluster input passes through unchanged', () => {
    expect(mergeAdjacentMainSwitchClusters([], 100)).toEqual([]);
    const single = [{ reads: [read(1, 1000, 'main_switch')] }];
    const out = mergeAdjacentMainSwitchClusters(single, 100);
    expect(out).toHaveLength(1);
    expect(out[0].mergedSpan).toBe(1);
  });
});
