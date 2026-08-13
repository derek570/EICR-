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
  // Plan E (feedback id 125) — a valid lookup can legitimately return an
  // EMPTY town/county string (E3: blank-on-unknown for a unitary authority's
  // county). `!lookup.town` treats that empty string identically to "the
  // lookup carries no locality info at all", so a genuinely present-but-
  // blank field must be distinguished by key presence, not truthiness —
  // otherwise a stored drift value ("South East") can never be cleared for
  // the exact ~40%-of-England case this plan exists to fix.
  if (typeof lookup.town !== 'string' && typeof lookup.county !== 'string') return [];

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
  // Plan E — Codex diff-review finding: `lookup.county && ...` treated a
  // valid-but-blank lookup value identically to "no lookup data", so a
  // stored drift value could never be cleared when the (now-correct)
  // mapping legitimately returns blank for a unitary authority (E3's
  // confirmed real-world regression). Gate on the value actually being a
  // string for the drift-clear case, but only write an empty value when
  // there's something to clear (`isDriftValue`) — an empty-to-empty write
  // would be a harmless but noisy no-op (spurious derived board-reading +
  // log line) on every lookup against an already-empty field.
  //
  // COUNTY ONLY (cycle-2 re-review finding): town is deliberately NOT
  // symmetric here. UK_REGION_DRIFT includes values that can also be
  // legitimate real TOWN names (e.g. "london"), so extending blank-clear
  // to town risks erasing a correct manually-set/dictated town that merely
  // happens to collide with a region name — a materially different, more
  // destructive outcome than the confirmed county regression this fix
  // targets. Town's original truthy-gated behaviour (a NON-empty new value
  // can still replace town drift, as before) is unchanged; only an empty
  // lookup county gets this new drift-clear-to-blank capability.
  if (lookup.town && shouldOverride(circ0[townField])) {
    writeDerived(townField, lookup.town);
    changes.push({ field: townField, value: lookup.town });
  }
  if (
    typeof lookup.county === 'string' &&
    shouldOverride(circ0[countyField]) &&
    (lookup.county || isDriftValue(circ0[countyField]))
  ) {
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
