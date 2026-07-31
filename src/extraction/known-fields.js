/**
 * Canonical list of field names the iOS app's wire decoder understands
 * WITHOUT needing the `FIELD_CORRECTIONS` rewrite. Side-effect-free —
 * import to read the Set, nothing else happens at module load.
 *
 * Source of truth: this used to be a private `const` inside
 * `sonnet-stream.js` (its only consumer was `validateAndCorrectFields`).
 * Extracted 2026-06-03 so the session optimizer's analyzer-side
 * `canonical_name_leak_to_ios` signature detector (Cluster 3 Item 7
 * of the optimizer rewrite — see
 * `.planning/optimizer-rewrite-plan-2026-06-03-final.md`) can import
 * `KNOWN_FIELDS` to check whether a Sonnet-emitted field name landed
 * on iOS unmapped. The detector cannot `require('sonnet-stream.js')`
 * directly — that file has WebSocket bootstrapping side effects at
 * module load and would crash the optimizer.
 *
 * `IOS_DUAL_ALIAS_ALLOWLIST` is the companion set: canonical field
 * names iOS accepts NATIVELY (without a `FIELD_CORRECTIONS` rewrite)
 * thanks to recent dual-alias decoders. The comment in
 * `field-name-corrections.js` ("iOS happens to accept both today")
 * suggests this set is non-empty in practice, but the canonical truth
 * lives in iOS code (DeepgramRecordingViewModel.swift `applySonnetReadings`
 * switch as of Build 282+). Populating this conservatively here keeps
 * the detector from false-positiving on names iOS quietly decodes;
 * the alternative is duplicating the iOS-side decoder map by hand,
 * which would silently drift.
 *
 * The detector treats a field as "leaked" iff:
 *   !KNOWN_FIELDS.has(field)
 *   && !(field in FIELD_CORRECTIONS)
 *   && !IOS_DUAL_ALIAS_ALLOWLIST.has(field)
 *
 * `KNOWN_FIELDS` is `sonnet-stream.js`'s pre-extraction snapshot —
 * keep them in lockstep until the import is wired both ways. The
 * `re-export` shim at the bottom of sonnet-stream.js (post-extraction)
 * imports from THIS module and re-exposes `KNOWN_FIELDS` under the
 * same name so existing call sites stay byte-identical.
 */

import { CLIENT_ROUTABLE_READING_FIELDS } from './client-routable-reading-fields.js';

// PLAN-2D: one authoritative manifest. A field is "known" only after its
// destination is committed and pinned on both clients.
export const KNOWN_FIELDS = new Set(CLIENT_ROUTABLE_READING_FIELDS);

/**
 * Canonical field names iOS accepts natively WITHOUT requiring a
 * `FIELD_CORRECTIONS` rewrite, thanks to dual-alias decoders added in
 * Build 282+. Populated conservatively — the optimizer's leak detector
 * uses this as a filter to avoid false-positives on canonical names
 * iOS quietly decodes.
 *
 * SAFE-TO-POPULATE CRITERIA: only add a canonical name here when iOS
 * code has been verified (DeepgramRecordingViewModel.swift
 * `applySonnetReadings` switch / decoder map) to handle it directly.
 * The cost of a wrongly-included entry is a missed leak detection;
 * the cost of a wrongly-excluded entry is a noisy false-positive.
 * Lean toward exclusion when unverified.
 *
 * Starts empty; populate as confidence accrues. The detector still
 * has two earlier filters (`KNOWN_FIELDS.has` and `FIELD_CORRECTIONS`
 * membership) before falling through to this one.
 */
export const IOS_DUAL_ALIAS_ALLOWLIST = new Set([
  // Intentionally empty until iOS-side decoder map is audited and
  // canonical-accepted names are verified one-by-one. See module
  // docstring for the safe-to-populate criteria.
]);
