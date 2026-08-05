/**
 * Plan 00B-4 C4 — the ONE rule deciding what a corpus-gap deferral may target.
 *
 * Two independent consumers ask the same question and MUST agree, or the system
 * mints events it then rejects: the CLI (`decide-corpus-gap`, refusing at mint
 * time) and the fold (admitting/invalidating a published decision). Before C4
 * the CLI and the fold each carried their own hand-rolled copy of a
 * strata-only rule; widening the vocabulary to per-fixture classification in
 * two places would have been a drift hazard by construction, so the rule lives
 * here once and both import it.
 *
 * THE RULE: a target is deferrable IFF the attested expectation manifest
 * EXPLICITLY carries it with `safety_critical === false` — either as a named
 * gap stratum (`strata_named_gaps[]`) or as an attested vendor-lane fixture
 * (`vendor_live_expectations.fixtures[]`). Everything else — absent, `true`, or
 * any non-boolean — is UNCLASSIFIED and therefore SAFETY-CRITICAL, and cannot
 * be deferred. Fail-closed in every direction: a fixture added without review
 * becomes non-deferrable, never silently waivable.
 *
 * The classification is read from the manifest the cohort is BOUND to, so it is
 * covered by `vendor_live_sha256`/`combined_sha256`: re-classifying a fixture
 * invalidates every prior attestation rather than quietly widening what may be
 * deferred under one.
 */

/** True only for an explicitly-reviewed non-safety record. */
function isExplicitlyNonSafety(record) {
  return record != null && record.safety_critical === false;
}

/**
 * The complete set of target ids this manifest permits a deferral for.
 * @param {object|null|undefined} expectationManifest
 * @returns {Set<string>}
 */
export function collectNonSafetyDeferralTargets(expectationManifest) {
  const targets = new Set();
  for (const g of expectationManifest?.strata_named_gaps ?? []) {
    if (isExplicitlyNonSafety(g) && typeof g.stratum === 'string') targets.add(g.stratum);
  }
  for (const f of expectationManifest?.vendor_live_expectations?.fixtures ?? []) {
    if (isExplicitlyNonSafety(f) && typeof f.corpus_id === 'string') targets.add(f.corpus_id);
  }
  return targets;
}

/**
 * Classify ONE target against the manifest.
 *
 * `known` says whether the manifest carries the id at all (used to distinguish
 * "no such thing" from "exists but is safety-critical" in CLI diagnostics);
 * `deferrable` is the only thing either gate acts on.
 *
 * @param {object|null|undefined} expectationManifest
 * @param {string} target
 * @returns {{known: boolean, kind: 'stratum'|'fixture'|null, deferrable: boolean}}
 */
export function resolveDeferralTarget(expectationManifest, target) {
  const stratum = (expectationManifest?.strata_named_gaps ?? []).find(
    (g) => g?.stratum === target
  );
  const fixture = (expectationManifest?.vendor_live_expectations?.fixtures ?? []).find(
    (f) => f?.corpus_id === target
  );
  const record = stratum ?? fixture ?? null;
  return {
    known: record != null,
    kind: stratum != null ? 'stratum' : fixture != null ? 'fixture' : null,
    deferrable: isExplicitlyNonSafety(record),
  };
}
