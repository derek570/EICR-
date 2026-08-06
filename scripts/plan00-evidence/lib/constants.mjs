/**
 * Plan 00C §C1 — the closed vocabularies of the version-audited append-only
 * evidence stream. Operator-side (never shipped in the backend image).
 */

export const EVIDENCE_BUCKET = process.env.PLAN00_EVIDENCE_BUCKET || 'eicr-files-production';
export const EVIDENCE_PREFIX = 'plan00-evidence';
export const MANIFEST_PREFIX = 'plan00-session-manifests';
export const STAGE_A_COHORT = '_stage-a';
export const EVIDENCE_SCHEMA_VERSION = 1;

/** Fold states (plan §C5). */
export const FOLD_STATES = Object.freeze([
  'NOT_STARTED',
  'STAGE_A_IMPLEMENTED',
  'HOLD_EVIDENCE',
  'BLOCKED',
  'DONE',
]);

/**
 * Namespace → event-kind allowlists (plan §C1). A wrong-kind/wrong-namespace
 * event is INVALID and cannot advance the fold. `dialogue_hearing_attestation`
 * is in the CLOSED Derek allowlist per the 2026-08-04 00B-2 amendment.
 */
export const MACHINE_EVENT_KINDS = Object.freeze([
  'stage_a_deployed',
  'attempt_terminal',
  'production_session_bound',
  'cohort_blocked',
]);

export const DEREK_EVENT_KINDS = Object.freeze([
  'expectations_attested',
  'manual_attestation',
  'dialogue_hearing_attestation',
  'non_safety_decision',
  'corpus_gap_decision',
  'cohort_initialized',
]);

/** Only stage_a_deployed may live under the _stage-a cohort. */
export const STAGE_A_EVENT_KINDS = Object.freeze(['stage_a_deployed']);

/** Reservation lanes (plan §C1): logical new-work ordinals + per-attempt
 *  generation PENDING objects. */
export const RESERVATION_LANES = Object.freeze([
  'ir-repetition',
  'corpus-run-haiku',
  'corpus-run-luna',
  'attempts',
]);

/** Terminal verdicts. */
export const TERMINAL_VERDICTS = Object.freeze(['PASS', 'FAIL', 'INVALID']);

/**
 * The CLOSED semantic-mismatch discriminator vocabulary (00B-4 §C1a),
 * re-exported from its single source beside the judge that emits it. It is
 * declared THERE so a vocabulary edit sits next to the emission sites it
 * describes, and re-exported HERE so the evidence layer keeps one import
 * surface for every closed vocabulary it validates against. The re-export is
 * deliberately not a copy: two lists would drift silently, and the drift would
 * only ever surface as a rejected mint on a live lane run.
 */
export { SEMANTIC_MISMATCH_KINDS as MISMATCH_KINDS } from '../../model-ab/lib/mismatch-kinds.mjs';

/** Requirement classes a terminal may satisfy. Safety-critical classes
 *  (structurally valid FAIL ⇒ irreversible BLOCKED) are marked below. */
export const REQUIREMENT_CLASSES = Object.freeze([
  'pinned_ir',
  'vendor_corpus',
  'safety_certificate_mutation',
]);
export const SAFETY_BLOCKING_CLASSES = Object.freeze([
  'pinned_ir',
  'safety_certificate_mutation',
]);

/** round_usage billable kinds that count as ACCEPTED inspector rounds for
 *  the Luna-Fast ordinary-reading gate (00B-2 §C2 counting rule). Keepalive
 *  and orphan-review rows are pinned NEGATIVES. */
export const INSPECTOR_ROUND_BILLABLE_KINDS = Object.freeze([
  // The live Stage-6 loop stamps 'inspector_live' (stage6-shadow-harness);
  // 'inspector_extraction' is the CostTracker default for direct ingest.
  'inspector_live',
  'inspector_extraction',
]);
export const NON_INSPECTOR_BILLABLE_KINDS = Object.freeze([
  'cache_keepalive',
  'orphan_review',
  'inspector_legacy',
]);

/** Expected live routes (Stage-B gates read ACTUAL executed evidence). */
export const LUNA_MODEL_FAMILY = 'gpt-5.6-luna';
export const TERRA_MODEL_FAMILY = 'gpt-5.6-terra';
// Returned Fast `priority` is equivalent to requested Fast (Plan 00A
// attribution); billing_tier carries the RAW returned label.
export const FAST_TIERS = Object.freeze(['fast', 'priority']);
export const STANDARD_TIERS = Object.freeze(['standard', 'default']);

/** The gate day zone — calendar membership is Europe/London of the earliest
 *  valid S3 LastModified among byte-identical versions. */
export const DAY_ZONE = 'Europe/London';

/** Per-day minimum pinned-IR repetitions. */
export const IR_REPS_PER_DAY = 5;

/** How many ACCEPTED days the cohort needs before it can reach DONE.
 *
 *  Was 3 (2026-08-03 plan 00C); dropped to 1 on 2026-08-06 (Derek) — the
 *  calendar-day spread was the wrong axis. A "day" is not a bucket of turns,
 *  it is the full ~10-requirement COVERAGE bundle (pinned IR × IR_REPS_PER_DAY,
 *  both corpus lanes, a genuinely bound field session, a Luna fast round, a
 *  Terra observation round, explicit cache evidence, the dialogue-script and
 *  address-mirror families, and Derek's heard-it attestation) all landing
 *  inside one Europe/London day. Requiring that bundle THREE times bought
 *  repetition, not coverage, at the cost of freezing the backend for three
 *  calendar days (any relevant source deploy voids the cohort and restarts
 *  the count). Derek is the sole user and has accepted the flake risk that
 *  repetition would have covered; coverage — the part that actually decides
 *  whether the comparison is trustworthy — is unchanged and still enforced
 *  per day, and evidence keeps accruing after DONE.
 *
 *  MUST be >= 1. At 0 the fold's `acceptedDays.length >= REQUIRED_DAYS` test
 *  is vacuously true, so a cohort would reach DONE the instant it initialised
 *  with ZERO evidence — certifying the model comparison on no data at all.
 *  Asserted at module load so that mistake can never ship silently. */
export const REQUIRED_DAYS = 1;

if (!Number.isInteger(REQUIRED_DAYS) || REQUIRED_DAYS < 1) {
  throw new Error(
    `REQUIRED_DAYS must be an integer >= 1 (got ${REQUIRED_DAYS}); ` +
      'at 0 the cohort reaches DONE with no evidence.'
  );
}

/** Format an ISO timestamp / epoch-ms as a Europe/London YYYY-MM-DD day. */
export function londonDayOf(instant) {
  const ms = typeof instant === 'number' ? instant : Date.parse(instant);
  if (Number.isNaN(ms)) throw new Error(`londonDayOf: unparseable instant ${instant}`);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: DAY_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(ms));
}
