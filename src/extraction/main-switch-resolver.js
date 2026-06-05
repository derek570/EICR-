/**
 * Main-switch side resolver — picks which end of the rail BS 7671 circuit
 * numbering scans FROM. Circuit 1 is the device nearest the main switch, so
 * getting this wrong inverts the entire numbering AND can cascade into wrong
 * RCD-protection assignment (the merger sweeps slots in scan order, picking
 * up whatever RCD it last passed).
 *
 * Three independent stages produce evidence:
 *
 *   Stage 3 (gpt-5.5 per-slot)   — slots tagged `classification: "main_switch"`.
 *                                  Highest priority, but can have FALSE
 *                                  POSITIVES on 2-pole RCDs that look like
 *                                  isolators (no test button visible in the
 *                                  crop, similar handle colour, etc.).
 *
 *   Stage 2 (rewireable pipeline) — `mainSwitchOffset: "left-edge"|"right-edge"`,
 *                                  only set on inline-mains rewireable boards.
 *                                  Authoritative when present.
 *
 *   Stage 1 (Sonnet 4.6 classifier) — `mainSwitchPosition: "left"|"right"|"none"`.
 *                                  Whole-board view, but coarser. Used as a
 *                                  fallback AND as a tie-breaker when Stage 3
 *                                  finds multiple `main_switch` clusters.
 *
 * Resolution rules in priority order:
 *
 *   1. Stage 3 candidates exist:
 *      a. Group adjacent main_switch slots into CLUSTERS — one cluster = one
 *         physical isolator (modern main switches are 2-module / 2-pole, so
 *         slots N and N+1 both tagged `main_switch` are the same device).
 *      b. If exactly one cluster:
 *         (i)  Sanity escape — if Stage 1 confidence ≥ 0.80 AND Stage 1
 *              disagrees with the cluster's side AND the cluster sits
 *              INTERIOR to the rail (more than 2 slots from either edge),
 *              prefer Stage 1. Real domestic main switches sit at one END;
 *              an interior single cluster against a confident whole-board
 *              read is almost always a 2-pole-RCD false positive whose
 *              schedule-strip OCR happened to include "mains" / "isolator".
 *         (ii) Otherwise → use the single cluster.
 *      c. If multiple clusters → disambiguate:
 *         (i)  prefer clusters whose Stage 4 label contains "main switch"-ish
 *              text (the model literally READ the words off the device face).
 *              Beats clusters with no label or with a label that doesn't
 *              mention the main switch.
 *         (ii) if still tied → break the tie with Stage 1's left/right vote
 *              (pick whichever cluster sits on the side Sonnet says).
 *         (iii) if still tied → fall back to the first cluster (preserves
 *              the original .find() behaviour for bug-compat).
 *      d. Cluster's slot side is computed from the cluster's MID-INDEX, not
 *         its first-slot index — a 2-slot cluster straddling the halfway
 *         point should be classified by where its centre sits.
 *
 *   2. No Stage 3 candidates → Stage 2 mainSwitchOffset (rewireable only).
 *
 *   3. No Stage 2 → Stage 1 classifier.
 *
 *   4. Nothing usable → "none" (BS 7671 numbering then defaults to
 *      left-to-right inside slotsToCircuits).
 *
 * Background — 2026-05-08 Protek field-test failure (multi-cluster):
 *   gpt-5.5 tagged TWO main_switch clusters on the same board: slots 0-1
 *   (no label, false positive — actually the leftmost 80A RCD) and slots
 *   11-12 (correctly labelled "Main Switch / Total load not to exceed").
 *   The previous resolver did `slots.find(s => s.classification === 'main_switch')`
 *   which returns the FIRST match (slot 0) → mainSwitchSide='left', and
 *   Sonnet's correct "right" vote was never consulted because Stage 3 outranks
 *   Stage 1. The labelled-candidate rule fixes this case at zero cost — slot
 *   11-12 has a real label ("Main Switch...") and slot 0-1 doesn't.
 *
 * Background — 2026-05-09 Hager field-test failure (single-cluster):
 *   gpt-5.5 tagged a SINGLE main_switch cluster at slots [6, 7] on a 16-slot
 *   Hager board (extractionIds 1778332395970-t2bf7x and 1778322305752-sk8ho4).
 *   Stage 4 OCR'd a label there matching the keyword regex (likely "Mains"
 *   off the schedule strip), so the cluster looked authoritative. The Protek
 *   fix only helps when there are MULTIPLE clusters to choose between — with
 *   one cluster, the resolver short-circuited via the `single-cluster` rule
 *   and never consulted Stage 1, which had said "right" at 0.88 confidence.
 *   The interior-cluster sanity escape (rule b.i above) closes the gap by
 *   demoting suspicious mid-rail clusters when Stage 1 is confident and
 *   disagrees. Edge-positioned single clusters still win unconditionally —
 *   that is by far the common case and the place Stage 3 is most reliable.
 *
 * Returns a self-describing object that the route handler logs straight to
 * CloudWatch — every field on `diagnostic` is intentionally part of the
 * triage trail.
 */

// Sanity-escape thresholds for the single-cluster path (rule b.i above).
// Tuned against the 2026-05-09 Hager failures: cluster mid-index 6.5 in a
// 16-slot board sits 6.5 slots from the nearer edge, well past the
// 2-slot threshold; Stage 1 confidence 0.88 clears 0.80.
const STAGE1_OVERRIDE_MIN_CONFIDENCE = 0.8;
const STAGE1_OVERRIDE_MIN_INTERIOR_SLOTS = 2;

/**
 * Group a sorted list of slots into clusters of contiguous slot indices.
 * Each cluster represents one physical multi-module device.
 *
 * @param {Array<{slotIndex:number}>} slots
 * @returns {Array<Array<{slotIndex:number}>>}
 */
function groupAdjacentSlots(slots) {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  const sorted = [...slots].sort((a, b) => a.slotIndex - b.slotIndex);
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.slotIndex - prev.slotIndex === 1) {
      clusters[clusters.length - 1].push(cur);
    } else {
      clusters.push([cur]);
    }
  }
  return clusters;
}

/**
 * Centre-index of a cluster — used to decide left vs right relative to the
 * rail's mid-point. We use the centre rather than the first slot because a
 * 2-slot cluster straddling the halfway point should classify by where its
 * body sits, not by which end touches first.
 */
function clusterMidIndex(cluster) {
  const indices = cluster.map((s) => s.slotIndex);
  return (Math.min(...indices) + Math.max(...indices)) / 2;
}

/**
 * Does any slot in the cluster carry a Stage-4 label that explicitly
 * mentions the main switch / isolator? This is the strongest signal that
 * gpt-5.5's `main_switch` classification was correct rather than a 2-pole
 * RCD false positive.
 *
 * Match is case-insensitive substring on common UK ways inspectors print
 * the label: "Main Switch", "Main Isolator", "Isolator", "Mains".
 */
function clusterHasMainSwitchLabel(cluster) {
  const RX = /\b(main\s*switch|main\s*isolator|isolator|mains)\b/i;
  return cluster.some(
    (s) => typeof s?.label === 'string' && s.label.trim().length > 0 && RX.test(s.label)
  );
}

/**
 * Cluster carries SOME label text (may or may not reference the main switch).
 * Used as a weaker preference than `clusterHasMainSwitchLabel` — a labelled
 * cluster was at least seen clearly enough by Stage 4 to read text from, so
 * is more trustworthy than an unlabelled cluster of the same classification.
 */
function clusterHasAnyLabel(cluster) {
  return cluster.some((s) => typeof s?.label === 'string' && s.label.trim().length > 0);
}

/**
 * Map a cluster mid-index to "left" or "right" relative to rail halfway.
 */
function sideForCluster(cluster, slotCount) {
  const halfwayIdx = (slotCount - 1) / 2;
  return clusterMidIndex(cluster) >= halfwayIdx ? 'right' : 'left';
}

/**
 * Pick the best cluster from N>=2 candidates. Returns the chosen cluster
 * and the rule that selected it (for diagnostic logging).
 */
function disambiguateClusters(clusters, slotCount, stage1Position) {
  // Rule (i): prefer clusters with a "main switch"-ish label.
  const labelMatches = clusters.filter(clusterHasMainSwitchLabel);
  if (labelMatches.length === 1) {
    return { cluster: labelMatches[0], rule: 'label-keyword-match' };
  }
  const candidatesAfterLabel = labelMatches.length > 0 ? labelMatches : clusters;

  // Rule (ii): prefer clusters that have *some* label over none.
  if (candidatesAfterLabel.length > 1) {
    const anyLabel = candidatesAfterLabel.filter(clusterHasAnyLabel);
    if (anyLabel.length === 1) {
      return { cluster: anyLabel[0], rule: 'has-any-label' };
    }
    if (anyLabel.length > 0) {
      // Carry forward the labelled subset for the Sonnet tie-break.
      return tieBreakWithStage1(anyLabel, slotCount, stage1Position);
    }
  }

  // Rule (iii): tie-break with Sonnet's left/right vote.
  return tieBreakWithStage1(candidatesAfterLabel, slotCount, stage1Position);
}

function tieBreakWithStage1(candidates, slotCount, stage1Position) {
  if (candidates.length === 1) {
    return { cluster: candidates[0], rule: 'single-candidate' };
  }
  if (stage1Position === 'left' || stage1Position === 'right') {
    const onSonnetSide = candidates.filter((c) => sideForCluster(c, slotCount) === stage1Position);
    if (onSonnetSide.length >= 1) {
      return { cluster: onSonnetSide[0], rule: 'stage1-tie-break' };
    }
  }
  // Last resort — preserves the historical .find() behaviour (first match
  // by slotIndex) so this rule can't make any previously-correct case worse.
  return { cluster: candidates[0], rule: 'first-cluster-fallback' };
}

/**
 * Resolve mainSwitchSide from the three available evidence sources.
 *
 * @param {Object} args
 * @param {Array<{slotIndex:number, classification:string, label?:string}>} args.slots
 *        Stage 3 per-slot output. Empty array if Stage 3 didn't run.
 * @param {number} args.slotCount
 *        Total slot count on the rail (used for the halfway-index calc).
 * @param {('left'|'right'|'none'|null|undefined)} args.stage1Position
 *        boardClassification.mainSwitchPosition.
 * @param {(number|null|undefined)} args.stage1Confidence
 *        boardClassification.confidence — used to gate the single-cluster
 *        sanity escape (only override Stage 3 if Stage 1 is genuinely
 *        confident; ignore unreliable low-confidence votes).
 * @param {(string|null|undefined)} args.stage2Offset
 *        geometricResult.mainSwitchOffset — "left-edge" / "right-edge" / null.
 * @returns {{
 *   mainSwitchSide: 'left'|'right'|'none',
 *   mainSwitchSideSource: 'stage3'|'stage2-rewireable'|'stage1-classifier'|'none',
 *   diagnostic: {
 *     stage3CandidateCount: number,
 *     stage3ClusterCount: number,
 *     stage3Clusters: Array<{slotIndices:number[], side:'left'|'right', hasLabel:boolean, hasMainSwitchLabel:boolean}>,
 *     stage3DisambiguationRule: (string|null),
 *     stage1Position: (string|null),
 *     stage1Confidence: (number|null),
 *     stage2Offset: (string|null),
 *     agreementWithStage1: (boolean|null)
 *   }
 * }}
 */
export function resolveMainSwitchSide({
  slots = [],
  slotCount = 0,
  stage1Position = null,
  stage1Confidence = null,
  stage2Offset = null,
}) {
  const stage3Candidates = (slots || []).filter((s) => s?.classification === 'main_switch');
  const stage3Clusters = groupAdjacentSlots(stage3Candidates);

  let mainSwitchSide = 'none';
  let mainSwitchSideSource = 'none';
  let stage3DisambiguationRule = null;

  if (stage3Clusters.length === 1) {
    const cluster = stage3Clusters[0];
    const clusterSide = sideForCluster(cluster, slotCount);
    const midIdx = clusterMidIndex(cluster);
    // Edge distance: how far the cluster centre sits from the NEAREST rail
    // end. < threshold → at-edge → trust Stage 3 unconditionally (the common
    // case). > threshold → interior → only trust if Stage 1 doesn't push back.
    const edgeDistance = Math.min(midIdx, slotCount - 1 - midIdx);
    const interior = edgeDistance > STAGE1_OVERRIDE_MIN_INTERIOR_SLOTS;
    const stage1Disagrees =
      (stage1Position === 'left' || stage1Position === 'right') && stage1Position !== clusterSide;
    const stage1Confident =
      typeof stage1Confidence === 'number' && stage1Confidence >= STAGE1_OVERRIDE_MIN_CONFIDENCE;

    if (interior && stage1Disagrees && stage1Confident) {
      // 2026-05-09 Hager case: cluster mid-rail with a misleading "Mains"
      // OCR, Stage 1 confident on the opposite end. Demote Stage 3.
      mainSwitchSide = stage1Position;
      mainSwitchSideSource = 'stage1-classifier';
      stage3DisambiguationRule = 'stage1-override-interior-cluster';
    } else {
      mainSwitchSide = clusterSide;
      mainSwitchSideSource = 'stage3';
      stage3DisambiguationRule = 'single-cluster';
    }
  } else if (stage3Clusters.length > 1) {
    const { cluster, rule } = disambiguateClusters(stage3Clusters, slotCount, stage1Position);
    mainSwitchSide = sideForCluster(cluster, slotCount);
    mainSwitchSideSource = 'stage3';
    stage3DisambiguationRule = rule;
  } else if (stage2Offset === 'right-edge') {
    mainSwitchSide = 'right';
    mainSwitchSideSource = 'stage2-rewireable';
  } else if (stage2Offset === 'left-edge') {
    mainSwitchSide = 'left';
    mainSwitchSideSource = 'stage2-rewireable';
  } else if (stage1Position === 'left' || stage1Position === 'right') {
    mainSwitchSide = stage1Position;
    mainSwitchSideSource = 'stage1-classifier';
  }

  const agreementWithStage1 =
    stage1Position === 'left' || stage1Position === 'right'
      ? stage1Position === mainSwitchSide
      : null;

  return {
    mainSwitchSide,
    mainSwitchSideSource,
    diagnostic: {
      stage3CandidateCount: stage3Candidates.length,
      stage3ClusterCount: stage3Clusters.length,
      stage3Clusters: stage3Clusters.map((c) => ({
        slotIndices: c.map((s) => s.slotIndex),
        side: sideForCluster(c, slotCount),
        hasLabel: clusterHasAnyLabel(c),
        hasMainSwitchLabel: clusterHasMainSwitchLabel(c),
      })),
      stage3DisambiguationRule,
      stage1Position: stage1Position || null,
      stage1Confidence: typeof stage1Confidence === 'number' ? stage1Confidence : null,
      stage2Offset: stage2Offset || null,
      agreementWithStage1,
    },
  };
}

// Test-only exports.
export const __test = {
  groupAdjacentSlots,
  clusterMidIndex,
  clusterHasMainSwitchLabel,
  clusterHasAnyLabel,
  sideForCluster,
  disambiguateClusters,
};
