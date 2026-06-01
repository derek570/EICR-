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

export function applyPostcodeLookupToSnapshot(snapshot, lookup, sessionId) {
  if (!snapshot || typeof snapshot !== 'object') return;
  if (!lookup || lookup.valid !== true) return;
  if (!lookup.town && !lookup.county) return;

  if (!snapshot.circuits || typeof snapshot.circuits !== 'object') {
    snapshot.circuits = {};
  }
  const circ0 = snapshot.circuits[0] || (snapshot.circuits[0] = {});

  const before = { town: circ0.town, county: circ0.county };
  const changes = [];

  if (lookup.town && shouldOverride(circ0.town)) {
    circ0.town = lookup.town;
    changes.push(`town: "${before.town ?? ''}" → "${lookup.town}"`);
  }
  if (lookup.county && shouldOverride(circ0.county)) {
    circ0.county = lookup.county;
    changes.push(`county: "${before.county ?? ''}" → "${lookup.county}"`);
  }

  if (changes.length > 0) {
    logger.info(`Session ${sessionId} Postcode lookup applied to snapshot — ${changes.join(', ')}`);
  }
}
