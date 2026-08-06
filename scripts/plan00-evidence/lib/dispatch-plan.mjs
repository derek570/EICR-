/**
 * Plan 00B-4 §C1d — the dispatch DECISION layer.
 *
 * `computeFold`'s public return is deliberately narrow (state/progress/holds/
 * day evaluations); it says whether a cohort is acceptable, not what a
 * coordinator should do next. Driving dispatch off it is impossible, and
 * driving dispatch off nothing is how you get duplicate provider calls. This
 * module derives, from the SAME raw records the fold consumes, exactly the two
 * indexes a coordinator needs:
 *
 *   - ordinal reservations by (lane, ordinal) — so an existing logical run can
 *     be ADOPTED with its real allocation VersionId rather than re-allocated
 *     as a sibling;
 *   - attempt state by requirement key — so a completed requirement is a
 *     no-op, an INVALID terminal earns generation N+1 under the SAME key and
 *     allocation, and an orphan PENDING HOLDS.
 *
 * The rules here mirror `fold.mjs`'s per-requirement resolution one-for-one and
 * are deliberately CONSERVATIVE: every shape the fold would treat as an
 * integrity problem (broken generation chain, duplicate terminals, a
 * replacement after a valid terminal) decides HOLD here rather than dispatch.
 * Dispatching into a shape the fold will later reject would burn a real vendor
 * call to produce evidence that can never count.
 *
 * NOTE this module decides nothing about exclusivity. The ordinal is a naming
 * device; exclusivity is enforced one level down by 00C's conditional-create
 * PENDING reservation per (requirement key, attempt generation). Two
 * coordinators may legitimately adopt the same ordinal and derive the same
 * plan — at most one of them wins each reservation, and only the winner
 * dispatches.
 */

/** Key regexes — the same classification the fold applies. */
const ATTEMPT_KEY_RE = /\/reservations\/[^/]+\/attempts\/[0-9a-f]{64}\/gen-\d+\.json$/;
const ORDINAL_KEY_RE = /\/reservations\/[^/]+\/[^/]+\/ordinal-\d+\.json$/;

export const DISPATCH_DECISIONS = Object.freeze({
  DISPATCH: 'dispatch',
  NOOP: 'noop',
  HOLD: 'hold',
});

/** The canonical requirement key for one fixture inside one model-lane run. */
export function vendorCorpusRequirementKey({ modelLane, corpusRunOrdinal, fixtureId }) {
  if (typeof modelLane !== 'string' || !modelLane.length) {
    throw new Error('vendorCorpusRequirementKey: modelLane required');
  }
  if (!Number.isInteger(corpusRunOrdinal) || corpusRunOrdinal < 1) {
    throw new Error(`vendorCorpusRequirementKey: bad corpus run ordinal ${corpusRunOrdinal}`);
  }
  if (typeof fixtureId !== 'string' || !fixtureId.length) {
    throw new Error('vendorCorpusRequirementKey: fixtureId required');
  }
  return `vendor_corpus:${modelLane}:run:${corpusRunOrdinal}:${fixtureId}`;
}

/**
 * The allocation LANE name for a model-lane corpus run.
 *
 * This is not cosmetic and it is not free to choose: `fold.mjs` recomputes the
 * expected lane for every terminal as `corpus-run-${model_lane}` and rejects a
 * mismatch as `terminal_allocation_ordinal_mismatch`. Allocating under any other
 * spelling produces evidence that is well-formed, paid for, and worthless. One
 * exported helper so the coordinator and its tests cannot drift apart.
 */
export function vendorCorpusLane(modelLane) {
  if (typeof modelLane !== 'string' || !modelLane.length) {
    throw new Error('vendorCorpusLane: modelLane required');
  }
  return `corpus-run-${modelLane}`;
}

/** `${lane}#${ordinal}` — the ordinal index key. */
export function ordinalIndexKey(lane, ordinal) {
  return `${lane}#${ordinal}`;
}

/**
 * Derive the dispatch state from the raw cohort records.
 *
 * @param {{reservationRecords: Array, cohortRecords: Array}} input
 * @returns {{ordinals: Map, requirements: Map, problems: Array}}
 */
export function deriveDispatchState({ reservationRecords = [], cohortRecords = [] } = {}) {
  const ordinals = new Map();
  const requirements = new Map();
  const problems = [];

  const requirementFor = (key) => {
    let entry = requirements.get(key);
    if (!entry) {
      entry = { requirementKey: key, generations: new Map() };
      requirements.set(key, entry);
    }
    return entry;
  };
  const generationFor = (entry, generation) => {
    let gen = entry.generations.get(generation);
    if (!gen) {
      gen = { generation, pending: null, terminals: [] };
      entry.generations.set(generation, gen);
    }
    return gen;
  };

  for (const rec of reservationRecords) {
    const payload = rec?.payload;
    if (ORDINAL_KEY_RE.test(rec.key)) {
      if (payload?.reservation_kind !== 'logical_ordinal') {
        problems.push({ code: 'ordinal_reservation_kind_mismatch', key: rec.key });
        continue;
      }
      const lane = payload.lane;
      const ordinal = payload.ordinal;
      if (typeof lane !== 'string' || !lane.length || !Number.isInteger(ordinal) || ordinal < 1) {
        problems.push({ code: 'ordinal_reservation_body_invalid', key: rec.key });
        continue;
      }
      const versionIds = Array.isArray(rec.version_ids) ? rec.version_ids : [];
      ordinals.set(ordinalIndexKey(lane, ordinal), {
        lane,
        ordinal,
        key: rec.key,
        versionIds,
        // Unambiguous only when the key holds exactly one version. With more
        // than one, the terminal echo decides (see resolveAllocationVersionId).
        versionId: versionIds.length === 1 ? versionIds[0] : null,
      });
      continue;
    }
    if (ATTEMPT_KEY_RE.test(rec.key)) {
      if (payload?.reservation_kind !== 'attempt_pending') {
        problems.push({ code: 'attempt_reservation_kind_mismatch', key: rec.key });
        continue;
      }
      const requirementKey = payload.requirement_key;
      const generation = payload.attempt_generation;
      if (
        typeof requirementKey !== 'string' ||
        !requirementKey.length ||
        !Number.isInteger(generation) ||
        generation < 1
      ) {
        problems.push({ code: 'attempt_reservation_body_invalid', key: rec.key });
        continue;
      }
      const gen = generationFor(requirementFor(requirementKey), generation);
      if (gen.pending) {
        problems.push({ code: 'duplicate_pending_for_generation', key: rec.key });
        continue;
      }
      gen.pending = payload;
      continue;
    }
    problems.push({ code: 'reservation_key_unclassifiable', key: rec.key });
  }

  for (const rec of cohortRecords) {
    const payload = rec?.payload;
    if (payload?.kind !== 'attempt_terminal') continue;
    const requirementKey = payload.requirement_key;
    const generation = payload.attempt_generation;
    if (
      typeof requirementKey !== 'string' ||
      !requirementKey.length ||
      !Number.isInteger(generation) ||
      generation < 1
    ) {
      problems.push({ code: 'terminal_identity_invalid', key: rec.key });
      continue;
    }
    generationFor(requirementFor(requirementKey), generation).terminals.push(payload);
  }

  return { ordinals, requirements, problems };
}

/**
 * Resolve the allocation VersionId to reuse when adopting an existing ordinal.
 * Prefers an unambiguous single-version reservation; otherwise requires the
 * terminals already published under this run to agree on one. Ambiguity HOLDS
 * — binding the wrong VersionId would trip the fold's allocation single-use
 * invariant after the vendor call had already been paid for.
 */
export function resolveAllocationVersionId(ordinalEntry, echoedVersionIds = []) {
  if (!ordinalEntry) return { versionId: null, hold: { code: 'ordinal_reservation_absent' } };
  if (ordinalEntry.versionId) return { versionId: ordinalEntry.versionId, hold: null };
  const echoed = [...new Set(echoedVersionIds.filter((v) => typeof v === 'string' && v.length))];
  if (echoed.length === 1 && ordinalEntry.versionIds.includes(echoed[0])) {
    return { versionId: echoed[0], hold: null };
  }
  return {
    versionId: null,
    hold: {
      code: 'ordinal_reservation_version_ambiguous',
      lane: ordinalEntry.lane,
      ordinal: ordinalEntry.ordinal,
      versions: ordinalEntry.versionIds.length,
    },
  };
}

/**
 * Decide what to do about ONE requirement key.
 *
 * @returns {{decision: string, generation: number|null,
 *            allocationVersionId: string|null, reason: string|null}}
 */
export function decideRequirement(state, requirementKey) {
  const entry = state.requirements.get(requirementKey);
  if (!entry || entry.generations.size === 0) {
    return {
      decision: DISPATCH_DECISIONS.DISPATCH,
      generation: 1,
      allocationVersionId: null,
      reason: 'no_prior_attempt',
    };
  }
  const generations = [...entry.generations.keys()].sort((a, b) => a - b);
  const maxGeneration = generations[generations.length - 1];
  // The fold requires a contiguous 1..N chain; a gap means this requirement is
  // already unresolvable and must never receive another vendor call.
  for (let i = 0; i < generations.length; i += 1) {
    if (generations[i] !== i + 1) {
      return hold(requirementKey, 'attempt_generation_chain_broken');
    }
  }
  for (const generation of generations) {
    const gen = entry.generations.get(generation);
    if (gen.terminals.length > 1) return hold(requirementKey, 'duplicate_terminals_for_generation');
    if (generation < maxGeneration && gen.terminals.length === 0) {
      return hold(requirementKey, 'orphan_pending');
    }
    if (generation < maxGeneration && gen.terminals[0]?.verdict !== 'INVALID') {
      // Only an INVALID terminal may be replaced.
      return hold(requirementKey, 'replacement_after_valid_terminal');
    }
  }
  const latest = entry.generations.get(maxGeneration);
  if (latest.terminals.length === 0) {
    // Reserved but never terminated: another coordinator may still be
    // in-flight, or one died mid-dispatch. Either way this generation is not
    // ours to re-run — the fold calls it an orphan PENDING and so do we.
    return hold(requirementKey, 'orphan_pending');
  }
  const terminal = latest.terminals[0];
  if (terminal.verdict !== 'INVALID') {
    return {
      decision: DISPATCH_DECISIONS.NOOP,
      generation: maxGeneration,
      allocationVersionId: terminal.allocation_version_id ?? null,
      reason: 'requirement_complete',
    };
  }
  return {
    decision: DISPATCH_DECISIONS.DISPATCH,
    generation: maxGeneration + 1,
    // Metadata must be byte-identical across generations (the fold's
    // replacement_metadata_drift rule), so the replacement REUSES the
    // predecessor's allocation rather than binding a fresh one.
    allocationVersionId: terminal.allocation_version_id ?? null,
    reason: 'replacing_invalid_terminal',
  };
}

function hold(requirementKey, code) {
  return {
    decision: DISPATCH_DECISIONS.HOLD,
    generation: null,
    allocationVersionId: null,
    reason: code,
    requirementKey,
  };
}

/**
 * Summarise a whole logical run (an IR repetition, or every fixture of one
 * model-lane corpus run).
 *
 * @returns {{complete: boolean, hold: object|null, dispatch: Array,
 *            echoedVersionIds: Array<string>}}
 */
export function summariseRun(state, requirementKeys) {
  const dispatch = [];
  const echoedVersionIds = [];
  for (const requirementKey of requirementKeys) {
    const entry = state.requirements.get(requirementKey);
    if (entry) {
      for (const gen of entry.generations.values()) {
        for (const terminal of gen.terminals) {
          if (typeof terminal.allocation_version_id === 'string') {
            echoedVersionIds.push(terminal.allocation_version_id);
          }
        }
      }
    }
    const decision = decideRequirement(state, requirementKey);
    if (decision.decision === DISPATCH_DECISIONS.HOLD) {
      return {
        complete: false,
        hold: { ...decision, requirementKey },
        dispatch: [],
        echoedVersionIds,
      };
    }
    if (decision.decision === DISPATCH_DECISIONS.DISPATCH) {
      dispatch.push({ requirementKey, ...decision });
    }
  }
  return { complete: dispatch.length === 0, hold: null, dispatch, echoedVersionIds };
}

/** Existing ordinals for a lane, ascending. */
export function laneOrdinals(state, lane) {
  const out = [];
  for (const entry of state.ordinals.values()) {
    if (entry.lane === lane) out.push(entry);
  }
  return out.sort((a, b) => a.ordinal - b.ordinal);
}
