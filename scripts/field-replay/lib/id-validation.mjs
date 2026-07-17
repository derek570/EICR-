/**
 * id-validation.mjs — validation for opaque public references and admissible
 * fix references (plan Item 1 + Item 2 gate_state metadata).
 *
 * Corpus IDs are OPAQUE AND RANDOM (`frc_<32 lowercase hex>`). A production
 * session UUID is a correlatable identifier linking a sanitized fixture back
 * to raw CloudWatch/S3 data, and a date/marker-encoded id like
 * `field-2026-07-16-f1` trivially links to the incident — so the validator
 * REJECTS UUID-shaped ids and ids containing dates, F-number markers,
 * session/job prefixes, or any manifest-listed raw fragment.
 */

import { OPAQUE_REF_CLASSES } from './identity-constants.mjs';

const UUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
// ISO-ish or compact dates: 2026-07-16, 20260716, 2026_07_16.
const DATE_RE = /20\d{2}[-_]?[01]\d[-_]?[0-3]\d/;
// Field-marker identifiers: F1..F99 / marker-1 style tokens.
const MARKER_RE = /(?:^|[^a-z0-9])(?:f|marker[-_]?)\d{1,2}(?:[^a-z0-9]|$)/i;
// Raw production identifier prefixes (session/job/user/harness).
const RAW_PREFIX_RE = /(?:sess|job|user|harness)_/i;

/** Reasons an id fails validation (bounded set — tests pin them). */
export const ID_REJECT_REASONS = Object.freeze({
  NOT_STRING: 'not_string',
  UUID_SHAPED: 'uuid_shaped',
  CONTAINS_DATE: 'contains_date',
  CONTAINS_MARKER: 'contains_marker',
  RAW_PREFIX: 'raw_identifier_prefix',
  MANIFEST_FRAGMENT: 'manifest_listed_fragment',
  BAD_FORMAT: 'bad_format',
});

/**
 * Validate an opaque public reference of a given class ('corpus' | 'fix').
 * `manifestFragments` (optional, acceptance-time only — CI never has it) is
 * a list of raw string fragments the private manifest bans.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function validateOpaqueRef(className, id, manifestFragments = []) {
  const cls = OPAQUE_REF_CLASSES[className];
  if (!cls) throw new Error(`validateOpaqueRef: unknown class "${className}"`);
  if (typeof id !== 'string') return { ok: false, reason: ID_REJECT_REASONS.NOT_STRING };
  if (UUID_RE.test(id)) return { ok: false, reason: ID_REJECT_REASONS.UUID_SHAPED };
  if (DATE_RE.test(id)) return { ok: false, reason: ID_REJECT_REASONS.CONTAINS_DATE };
  if (MARKER_RE.test(id)) return { ok: false, reason: ID_REJECT_REASONS.CONTAINS_MARKER };
  // The class's own prefix is not a raw prefix; test the remainder.
  const rest = id.startsWith(cls.prefix) ? id.slice(cls.prefix.length) : id;
  if (RAW_PREFIX_RE.test(rest)) return { ok: false, reason: ID_REJECT_REASONS.RAW_PREFIX };
  for (const frag of manifestFragments) {
    if (frag && id.includes(frag)) {
      return { ok: false, reason: ID_REJECT_REASONS.MANIFEST_FRAGMENT };
    }
  }
  if (!cls.pattern.test(id)) return { ok: false, reason: ID_REJECT_REASONS.BAD_FORMAT };
  return { ok: true };
}

/**
 * Admissible `fix_reference` values (plan Item 2 gate_state metadata): either
 * a PUBLIC GitHub issue/PR reference in this repo's namespace, or an opaque
 * random `fix_<32hex>` reference (private mapping lives only in the
 * restricted manifest). Private handoff paths and date/marker-derived
 * references are inadmissible.
 */
export function validateFixReference(ref) {
  if (typeof ref !== 'string' || ref.length === 0) {
    return { ok: false, reason: ID_REJECT_REASONS.NOT_STRING };
  }
  // Public GitHub reference: URL or #<n> shorthand.
  const githubUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+$/;
  const shortRef = /^#\d+$/;
  if (githubUrl.test(ref) || shortRef.test(ref)) return { ok: true, kind: 'github' };
  // Anything path-like (private handoff paths) is inadmissible.
  if (ref.includes('/') || ref.includes('\\') || ref.includes('~')) {
    return { ok: false, reason: ID_REJECT_REASONS.BAD_FORMAT };
  }
  const opaque = validateOpaqueRef('fix', ref);
  return opaque.ok ? { ok: true, kind: 'opaque' } : opaque;
}

/**
 * Cheap entropy sanity check for the RANDOM-ONLY guarantee (test support —
 * catches a "deterministically derived but hex-shaped" implementation
 * regression): the 32 hex chars should use a healthy spread of symbols.
 * A digest-derived value passes this too, so tests ALSO assert two mints of
 * the same logical inputs differ — this check only rejects degenerate
 * constants like all-zeros.
 */
export function hasPlausibleEntropy(id) {
  const m = /_([0-9a-f]{32})$/.exec(String(id));
  if (!m) return false;
  const distinct = new Set(m[1].split(''));
  return distinct.size >= 6;
}
