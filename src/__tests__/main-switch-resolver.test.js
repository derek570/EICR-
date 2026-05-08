import { resolveMainSwitchSide, __test } from '../extraction/main-switch-resolver.js';

const {
  groupAdjacentSlots,
  clusterMidIndex,
  clusterHasMainSwitchLabel,
  clusterHasAnyLabel,
  sideForCluster,
} = __test;

// Convenience: build a slot stub. Defaults to an unlabelled main_switch.
const ms = (slotIndex, label = '') => ({
  slotIndex,
  classification: 'main_switch',
  label,
});
const mcb = (slotIndex, label = '') => ({
  slotIndex,
  classification: 'mcb',
  label,
});

describe('groupAdjacentSlots', () => {
  test('empty input → empty array', () => {
    expect(groupAdjacentSlots([])).toEqual([]);
    expect(groupAdjacentSlots(null)).toEqual([]);
    expect(groupAdjacentSlots(undefined)).toEqual([]);
  });

  test('single slot → one cluster', () => {
    const out = groupAdjacentSlots([ms(5)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(1);
    expect(out[0][0].slotIndex).toBe(5);
  });

  test('two adjacent slots → one cluster (one physical 2-pole device)', () => {
    const out = groupAdjacentSlots([ms(0), ms(1)]);
    expect(out).toHaveLength(1);
    expect(out[0].map((s) => s.slotIndex)).toEqual([0, 1]);
  });

  test('two non-adjacent slots → two clusters', () => {
    const out = groupAdjacentSlots([ms(0), ms(11)]);
    expect(out).toHaveLength(2);
    expect(out[0].map((s) => s.slotIndex)).toEqual([0]);
    expect(out[1].map((s) => s.slotIndex)).toEqual([11]);
  });

  test('Protek dual-cluster case (slots 0,1 + 11,12) → two clusters of two', () => {
    const out = groupAdjacentSlots([ms(0), ms(1), ms(11), ms(12)]);
    expect(out).toHaveLength(2);
    expect(out[0].map((s) => s.slotIndex)).toEqual([0, 1]);
    expect(out[1].map((s) => s.slotIndex)).toEqual([11, 12]);
  });

  test('out-of-order input is sorted before grouping', () => {
    const out = groupAdjacentSlots([ms(12), ms(0), ms(11), ms(1)]);
    expect(out).toHaveLength(2);
    expect(out[0].map((s) => s.slotIndex)).toEqual([0, 1]);
    expect(out[1].map((s) => s.slotIndex)).toEqual([11, 12]);
  });
});

describe('clusterMidIndex / sideForCluster', () => {
  test('single-slot cluster mid is the slot itself', () => {
    expect(clusterMidIndex([ms(5)])).toBe(5);
  });

  test('two-slot cluster mid is the average', () => {
    expect(clusterMidIndex([ms(11), ms(12)])).toBe(11.5);
  });

  test('left side when mid < halfway', () => {
    // 22 slots → halfway 10.5. Cluster centred at 0.5 → left.
    expect(sideForCluster([ms(0), ms(1)], 22)).toBe('left');
  });

  test('right side when mid >= halfway (Protek 11/12 case)', () => {
    // 22 slots → halfway 10.5. Cluster centred at 11.5 → right.
    expect(sideForCluster([ms(11), ms(12)], 22)).toBe('right');
  });

  test('mid exactly at halfway → "right" (>= boundary preserves prior behaviour)', () => {
    // 21 slots → halfway 10. Single-slot cluster at 10 → right (>=).
    expect(sideForCluster([ms(10)], 21)).toBe('right');
  });
});

describe('clusterHasMainSwitchLabel / clusterHasAnyLabel', () => {
  test('label "Main Switch" matches', () => {
    expect(clusterHasMainSwitchLabel([ms(5, 'Main Switch')])).toBe(true);
  });

  test('label "MAIN SWITCH" matches (case insensitive)', () => {
    expect(clusterHasMainSwitchLabel([ms(5, 'MAIN SWITCH')])).toBe(true);
  });

  test('label "Main Switch / Total load not to exceed" matches (Protek text)', () => {
    expect(clusterHasMainSwitchLabel([ms(5, 'Main Switch / Total load not to exceed')])).toBe(true);
  });

  test('label "Isolator" matches', () => {
    expect(clusterHasMainSwitchLabel([ms(5, 'Isolator')])).toBe(true);
  });

  test('label "RCD Protected" does NOT match', () => {
    expect(clusterHasMainSwitchLabel([ms(5, 'RCD Protected')])).toBe(false);
  });

  test('empty / whitespace label does not match', () => {
    expect(clusterHasMainSwitchLabel([ms(5, '')])).toBe(false);
    expect(clusterHasMainSwitchLabel([ms(5, '   ')])).toBe(false);
  });

  test('any-slot-in-cluster match works (Protek 2-slot cluster, label only on first slot)', () => {
    expect(clusterHasMainSwitchLabel([ms(11, 'Main Switch'), ms(12, '')])).toBe(true);
  });

  test('clusterHasAnyLabel — true when any slot has any non-empty label', () => {
    expect(clusterHasAnyLabel([ms(5, 'Cooker')])).toBe(true);
    expect(clusterHasAnyLabel([ms(5, '')])).toBe(false);
    expect(clusterHasAnyLabel([ms(5, '   ')])).toBe(false);
  });
});

describe('resolveMainSwitchSide — Stage 3 path', () => {
  test('no slots → none', () => {
    const out = resolveMainSwitchSide({
      slots: [],
      slotCount: 0,
      stage1Position: null,
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('none');
    expect(out.mainSwitchSideSource).toBe('none');
    expect(out.diagnostic.stage3ClusterCount).toBe(0);
    expect(out.diagnostic.stage3DisambiguationRule).toBe(null);
  });

  test('single Stage 3 cluster, left side → uses it (rule: single-cluster)', () => {
    const out = resolveMainSwitchSide({
      slots: [ms(0), ms(1), mcb(2), mcb(3)],
      slotCount: 12,
      stage1Position: 'right', // ignored — Stage 3 wins on single cluster
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('left');
    expect(out.mainSwitchSideSource).toBe('stage3');
    expect(out.diagnostic.stage3DisambiguationRule).toBe('single-cluster');
    expect(out.diagnostic.agreementWithStage1).toBe(false);
  });

  test('single Stage 3 cluster, right side → uses it', () => {
    const out = resolveMainSwitchSide({
      slots: [mcb(0), mcb(1), ms(10), ms(11)],
      slotCount: 12,
      stage1Position: null,
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('right');
    expect(out.mainSwitchSideSource).toBe('stage3');
    expect(out.diagnostic.stage3DisambiguationRule).toBe('single-cluster');
  });

  test('Protek case — two clusters, only slot-11 cluster has main-switch label → picks slot 11 (rule: label-keyword-match)', () => {
    const out = resolveMainSwitchSide({
      slots: [
        ms(0), // unlabelled false-positive
        ms(1),
        mcb(2),
        mcb(3),
        mcb(4),
        mcb(5),
        mcb(6),
        mcb(7),
        mcb(8),
        mcb(9),
        mcb(10),
        ms(11, 'Main Switch / Total load not to exceed'),
        ms(12),
        mcb(13),
        mcb(14),
        mcb(15),
        mcb(16),
        mcb(17),
        mcb(18),
        mcb(19),
        mcb(20),
        mcb(21),
      ],
      slotCount: 22,
      stage1Position: 'right',
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('right');
    expect(out.mainSwitchSideSource).toBe('stage3');
    expect(out.diagnostic.stage3DisambiguationRule).toBe('label-keyword-match');
    expect(out.diagnostic.stage3ClusterCount).toBe(2);
    expect(out.diagnostic.stage3Clusters).toEqual([
      {
        slotIndices: [0, 1],
        side: 'left',
        hasLabel: false,
        hasMainSwitchLabel: false,
      },
      {
        slotIndices: [11, 12],
        side: 'right',
        hasLabel: true,
        hasMainSwitchLabel: true,
      },
    ]);
    expect(out.diagnostic.agreementWithStage1).toBe(true);
  });

  test('two clusters, both labelled with main-switch-keyword → break tie with Sonnet', () => {
    const out = resolveMainSwitchSide({
      slots: [ms(0, 'Main Switch'), ms(1), mcb(2), mcb(3), ms(4, 'Isolator'), ms(5)],
      slotCount: 6,
      stage1Position: 'right',
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('right');
    expect(out.mainSwitchSideSource).toBe('stage3');
    expect(out.diagnostic.stage3DisambiguationRule).toBe('stage1-tie-break');
  });

  test('two clusters, both labelled, Stage 1 silent → falls back to first cluster', () => {
    const out = resolveMainSwitchSide({
      slots: [ms(0, 'Main Switch'), ms(1), mcb(2), mcb(3), ms(4, 'Isolator'), ms(5)],
      slotCount: 6,
      stage1Position: 'none',
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('left'); // first cluster
    expect(out.mainSwitchSideSource).toBe('stage3');
    expect(out.diagnostic.stage3DisambiguationRule).toBe('first-cluster-fallback');
  });

  test('two clusters, neither labelled, Stage 1 says "right" → picks the right-side cluster', () => {
    const out = resolveMainSwitchSide({
      slots: [ms(0), ms(1), mcb(2), mcb(3), ms(10), ms(11)],
      slotCount: 12,
      stage1Position: 'right',
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('right');
    expect(out.mainSwitchSideSource).toBe('stage3');
    expect(out.diagnostic.stage3DisambiguationRule).toBe('stage1-tie-break');
  });

  test('two clusters, neither labelled, no Sonnet → falls back to first cluster', () => {
    const out = resolveMainSwitchSide({
      slots: [ms(0), ms(1), mcb(2), mcb(3), ms(10), ms(11)],
      slotCount: 12,
      stage1Position: 'none',
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('left');
    expect(out.mainSwitchSideSource).toBe('stage3');
    expect(out.diagnostic.stage3DisambiguationRule).toBe('first-cluster-fallback');
  });

  test('two clusters, one with non-keyword label, one without → prefers the labelled one (rule: has-any-label)', () => {
    // Tests that a labelled cluster (any text) beats an unlabelled cluster
    // even when neither carries a main-switch keyword. Reflects the heuristic
    // that Stage 4 reading SOME text from the device face means the crop was
    // sharp enough to trust the Stage 3 classification on that cluster.
    const out = resolveMainSwitchSide({
      slots: [ms(0), ms(1), mcb(2), ms(10, 'Some Label'), ms(11)],
      slotCount: 12,
      stage1Position: null,
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('right');
    expect(out.mainSwitchSideSource).toBe('stage3');
    expect(out.diagnostic.stage3DisambiguationRule).toBe('has-any-label');
  });
});

describe('resolveMainSwitchSide — Stage 2 fallback', () => {
  test('no Stage 3 candidates, stage2Offset="right-edge" → right via stage2-rewireable', () => {
    const out = resolveMainSwitchSide({
      slots: [mcb(0), mcb(1)],
      slotCount: 2,
      stage1Position: 'left', // ignored — Stage 2 wins
      stage2Offset: 'right-edge',
    });
    expect(out.mainSwitchSide).toBe('right');
    expect(out.mainSwitchSideSource).toBe('stage2-rewireable');
    expect(out.diagnostic.agreementWithStage1).toBe(false);
  });

  test('no Stage 3 candidates, stage2Offset="left-edge" → left via stage2-rewireable', () => {
    const out = resolveMainSwitchSide({
      slots: [mcb(0), mcb(1)],
      slotCount: 2,
      stage1Position: null,
      stage2Offset: 'left-edge',
    });
    expect(out.mainSwitchSide).toBe('left');
    expect(out.mainSwitchSideSource).toBe('stage2-rewireable');
  });
});

describe('resolveMainSwitchSide — Stage 1 fallback', () => {
  test('no Stage 3, no Stage 2, stage1Position="left" → left via classifier', () => {
    const out = resolveMainSwitchSide({
      slots: [mcb(0)],
      slotCount: 1,
      stage1Position: 'left',
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('left');
    expect(out.mainSwitchSideSource).toBe('stage1-classifier');
  });

  test('no Stage 3, no Stage 2, stage1Position="none" → none', () => {
    const out = resolveMainSwitchSide({
      slots: [mcb(0)],
      slotCount: 1,
      stage1Position: 'none',
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('none');
    expect(out.mainSwitchSideSource).toBe('none');
    expect(out.diagnostic.agreementWithStage1).toBe(null);
  });

  test('all sources null/empty → none with all diagnostic fields populated', () => {
    const out = resolveMainSwitchSide({
      slots: [],
      slotCount: 0,
      stage1Position: null,
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('none');
    expect(out.mainSwitchSideSource).toBe('none');
    expect(out.diagnostic).toEqual({
      stage3CandidateCount: 0,
      stage3ClusterCount: 0,
      stage3Clusters: [],
      stage3DisambiguationRule: null,
      stage1Position: null,
      stage2Offset: null,
      agreementWithStage1: null,
    });
  });
});

describe('resolveMainSwitchSide — diagnostic field correctness', () => {
  test('agreementWithStage1 is true when sides match', () => {
    const out = resolveMainSwitchSide({
      slots: [ms(10), ms(11)],
      slotCount: 12,
      stage1Position: 'right',
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('right');
    expect(out.diagnostic.agreementWithStage1).toBe(true);
  });

  test('agreementWithStage1 is false when sides differ', () => {
    const out = resolveMainSwitchSide({
      slots: [ms(0), ms(1)],
      slotCount: 12,
      stage1Position: 'right',
      stage2Offset: null,
    });
    expect(out.mainSwitchSide).toBe('left');
    expect(out.diagnostic.agreementWithStage1).toBe(false);
  });

  test('agreementWithStage1 is null when Stage 1 silent', () => {
    const out = resolveMainSwitchSide({
      slots: [ms(0), ms(1)],
      slotCount: 4,
      stage1Position: null,
      stage2Offset: null,
    });
    expect(out.diagnostic.agreementWithStage1).toBe(null);
  });

  test('stage3Clusters array is populated even when result comes from later stages — empty when no Stage 3 input', () => {
    const out = resolveMainSwitchSide({
      slots: [],
      slotCount: 0,
      stage1Position: 'left',
      stage2Offset: null,
    });
    expect(out.diagnostic.stage3Clusters).toEqual([]);
    expect(out.mainSwitchSideSource).toBe('stage1-classifier');
  });
});
