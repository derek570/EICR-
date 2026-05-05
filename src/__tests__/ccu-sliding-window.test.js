/**
 * Unit tests for the pure functions in ccu-sliding-window.js — the
 * window planner and the position-clustering merger. These don't need
 * VLM mocking. The full extractViaSlidingWindow path covers an
 * Anthropic.messages.create call and Sharp image cropping; that's
 * tested end-to-end by spawning the harness against the corpus, not
 * here.
 */
import { jest } from '@jest/globals';
import { planWindows, clusterReads } from '../extraction/ccu-sliding-window.js';

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
