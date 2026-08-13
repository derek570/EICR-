/**
 * Apply a postcodes.io lookup result to the session's stateSnapshot
 * circuits[0] (where address/postcode/town/county live, per the
 * extraction prompt's "circuit 0 = supply/installation" convention).
 *
 * Policy locked 2026-06-01 (Derek): lookup wins on empty OR on
 * Sonnet-drift (existing value matches a UK ITL1 region rather than
 * an administrative town/county). Manual user edits — values that
 * aren't a region — are preserved. The intent is symmetric with the
 * iOS-side analogue in InstallationTab.swift (fills empties only)
 * but adds the region-drift catch for the common Sonnet failure
 * mode: ITL1 strings have been the dominant garbage value in the
 * last two field tests (2026-05-31 sessions B95B2EE1 + D68ACD24
 * both stored county="South East" for RG1 5QA, valid lookup
 * available the whole time).
 *
 * Side-effect free if:
 *  - lookup is null / not valid
 *  - lookup has no town/county
 *  - snapshot is missing / not an object
 *
 * Logs an override at info level so CloudWatch retains evidence the
 * lookup was applied (matching the existing
 * 'Session X Postcode lookup' info line shape).
 */

import logger from '../logger.js';
// Plan 00B §B2 — postcode-derived locality writes are semantic direct
// writes and must route through the canonical board-reading atom (with a
// silent_deterministic origin frame naming the postcode write as parent).
import { applyBoardReadingToSnapshot } from './stage6-snapshot-mutators.js';
import { MUTATION_OBSERVER } from './plan00-semantic-capture.js';

/**
 * UK ITL1 regions + a few common Deepgram mishearings that Sonnet has
 * been observed to write into the county field. Match is
 * case-insensitive on a trimmed comparison; the actual stored value
 * stays as-is until we replace it.
 *
 * NOT exhaustive — we deliberately keep this tight so a real
 * administrative county that happens to start with "North" / "East"
 * doesn't get accidentally overridden. Add to it ONLY when a
 * concrete drift value is observed in production.
 */
const UK_REGION_DRIFT = new Set(
  [
    'east of england',
    'east midlands',
    'london',
    'greater london',
    'north east',
    'north east england',
    'north west',
    'north west england',
    'northern ireland',
    'scotland',
    'south east',
    'south east england',
    'south west',
    'south west england',
    'wales',
    'west midlands',
    'yorkshire and the humber',
    'yorkshire',
    'the south east',
    'the south west',
    'the north east',
    'the north west',
  ].map((s) => s.toLowerCase())
);

/**
 * Plan E (feedback id 125, E4) — read the EFFECTIVE post-apply site/client
 * town+county from the snapshot for folding into the postcode confirmation
 * read-back. Deliberately NOT the raw lookup output: an E1-seeded (or
 * otherwise pre-existing) non-empty value survives `shouldOverride` above
 * and must speak AS STORED, which can differ from what this turn's lookup
 * itself returned (e.g. lookup says "Earley", the stored/preserved value
 * stays "Lower Earley"). Returns null when both fields are empty (or both
 * excluded) so the caller appends nothing (postcode-only utterance stays
 * postcode-only).
 *
 * `options.skipTown`/`skipCounty` (Codex per-fix mini-review, cycle 1) —
 * when a component ALSO has its own confirmable reading this turn (a
 * directly-dictated, non-derived town/county), that reading already speaks
 * it; excluding ONLY that component from the tail — not the whole tail —
 * keeps the OTHER component (e.g. a derived county) audible instead of
 * going silent just because its sibling happened to be dictated too.
 */
export function resolveEffectiveLocalityTail(snapshot, family, options = {}) {
  const circ0 = snapshot?.circuits?.[0];
  if (!circ0 || typeof circ0 !== 'object') return null;
  const townField = family === 'client' ? 'client_town' : 'town';
  const countyField = family === 'client' ? 'client_county' : 'county';
  const town =
    !options.skipTown && typeof circ0[townField] === 'string' ? circ0[townField].trim() : '';
  const county =
    !options.skipCounty && typeof circ0[countyField] === 'string' ? circ0[countyField].trim() : '';
  const parts = [];
  if (town) parts.push(town);
  if (county) parts.push(county);
  return parts.length > 0 ? parts.join(', ') : null;
}

function isDriftValue(value) {
  if (typeof value !== 'string') return false;
  const norm = value.trim().toLowerCase();
  if (norm.length === 0) return false;
  return UK_REGION_DRIFT.has(norm);
}

function shouldOverride(existing) {
  if (existing === undefined || existing === null) return true;
  if (typeof existing !== 'string') return true;
  const trimmed = existing.trim();
  if (trimmed.length === 0) return true;
  return isDriftValue(trimmed);
}

export function applyPostcodeLookupToSnapshot(snapshot, lookup, sessionId, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  if (!lookup || lookup.valid !== true) return [];
  if (!lookup.town && !lookup.county) return [];

  if (!snapshot.circuits || typeof snapshot.circuits !== 'object') {
    snapshot.circuits = {};
  }
  const circ0 = snapshot.circuits[0] || (snapshot.circuits[0] = {});

  const family = options.family === 'client' ? 'client' : 'site';
  const townField = family === 'client' ? 'client_town' : 'town';
  const countyField = family === 'client' ? 'client_county' : 'county';
  const before = { town: circ0[townField], county: circ0[countyField] };
  const changes = [];

  // `town` and `county` are designed-silent computed consequences of the
  // inspector's postcode write (Audio-First exception), not separately
  // dictated readings. Keep this helper snapshot-only: it must never stage
  // either field into perTurnWrites or synthesize a second confirmation.
  // Plan 00B §B2 — the storage write itself now flows through the canonical
  // board-reading atom (same circuits[0] slot, byte-identical state) so the
  // evaluation observer sees a silent_deterministic commit parented to the
  // postcode write that triggered it.
  const parentField = options.parentField ?? (family === 'client' ? 'client_postcode' : 'postcode');
  const observer = snapshot[MUTATION_OBSERVER] ?? null;
  const writeDerived = (field, value) => {
    if (observer) {
      observer.setOriginFrame({
        origin: 'silent_deterministic',
        derivation_kind: 'postcode_locality',
        parent_slot: { field: parentField, circuit: null },
        source_slot: { field: parentField, circuit: null },
        meta: { family },
      });
    }
    try {
      applyBoardReadingToSnapshot(snapshot, { field, value });
    } finally {
      if (observer) observer.clearOriginFrame();
    }
  };
  // Plan E — a blank-value drift-clear capability (write an empty county
  // through to clear a stored "South East") was tried in an earlier review
  // cycle and REVERTED: `_mergeIncomingJobStateIntoSnapshot`'s fill-empty-
  // only merge for the 8 address-family keys means a client whose own
  // local cache still shows the pre-clear value (its apply-gate rejects an
  // incoming empty-string "clear" the same way — `hasValue(existing)`
  // wins) will silently resurrect the drift on its very next
  // `job_state_update` push, structurally guaranteed, not just a rare
  // reconnect race. This also exceeds the plan's own explicit non-goal:
  // "No retroactive repair of already-written 'Hawkedon'/'South East'
  // values in stored jobs (Derek corrects by voice; the source-level
  // mapping fix stops recurrence)." E3 already stops NEW drift from ever
  // being written (`region` is never read by the mapping); an
  // already-stored value from before that fix shipped is out of scope
  // here, exactly as the plan says. Both fields keep their original
  // truthy-gated guard — a NON-empty new value still replaces a
  // drift-flagged town/county, unchanged from before this plan.
  if (lookup.town && shouldOverride(circ0[townField])) {
    writeDerived(townField, lookup.town);
    changes.push({ field: townField, value: lookup.town });
  }
  if (lookup.county && shouldOverride(circ0[countyField])) {
    writeDerived(countyField, lookup.county);
    changes.push({ field: countyField, value: lookup.county });
  }

  if (changes.length > 0) {
    logger.info('postcode_hint.snapshot_enriched', {
      sessionId,
      family,
      changed_fields: changes.map((change) => change.field),
      replaced_existing: {
        town: before.town != null && String(before.town).trim() !== '',
        county: before.county != null && String(before.county).trim() !== '',
      },
    });
  }
  return changes;
}
