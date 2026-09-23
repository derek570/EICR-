/**
 * apply-regex-match — adapter that takes a `RegexMatchResult` produced by
 * TranscriptFieldMatcher, gates each write through a `FieldSourceTracker`,
 * and produces `{patch, changedKeys}` matching the existing
 * `applyExtractionToJob` contract from `apply-extraction.ts`.
 *
 * The tracker enforces the iOS-canonical 3-tier write priority:
 *   - regex never overwrites Sonnet OR pre-existing
 *   - regex may overwrite a previous regex write (last-hit-wins inside a
 *     single regex pass)
 *
 * **Scope of this commit (5 of 7 in the parity port):** the adapter
 * applies supply / board / installation / circuit-cell updates only.
 * `new_circuits` and `board_switch` from the matcher are intentionally
 * NOT applied here — Sonnet's `circuit_updates` path already covers
 * circuit creation and the multi-board switching surface is owned
 * server-side. Both result fields are still emitted by the matcher
 * (so iOS-wire-shape tests can verify them), they just don't drive
 * local state mutations from the regex layer.
 */

import {
  canonicaliseClosedEnumValue,
  canonicaliseOcpdStandard,
  isGuardedClosedEnumField,
  type GuardedClosedEnumField,
} from '@certmate/shared-utils';

import type { JobDetail, CircuitRow } from '@/lib/types';
import type { FieldSourceTracker } from './field-source-tracker';
import type { CircuitUpdates, RegexMatchResult } from './regex-match-result';
import { pipelineLog } from '@/lib/diagnostics/pipeline-log';
import {
  aliasFamily,
  indexCircuitRowsByRef,
  readEffectiveSectionValue,
  routeSectionField,
} from './regex-destination-routing';

// MARK: — Field-name → JobDetail-section routing
//
// Mirrors the `CIRCUIT_0_SECTION` map in apply-extraction.ts (which is
// keyed by Sonnet's field names). The matcher uses the same names, so we
// route by the same map.

export interface RegexApplyOutput {
  patch: Partial<JobDetail>;
  /** Field-source-tracker keys that flipped this turn — also fed into
   *  liveFill.markUpdated() for the brand-blue flash. */
  changedKeys: string[];
}

// MARK: — A3 freshness gate (sess_mrbnds2d_jczh, 2026-07-08)
//
// The matcher deliberately re-scans a CUMULATIVE transcript window
// (cross-utterance carryover), so an old match re-fires on every later
// utterance. Pre-fix the apply layer had no value-equality check, so a
// re-hit of "Customer is Michael Payden" masqueraded as a fresh write on
// pure chitchat ("What do you mean?"), passed the TranscriptGate, played
// the sent-for-processing chime, and reset the backend chitchat pause
// counter. iOS freshness canon: `applyRegexValue`'s
// `newValue != currentValue` check (DeepgramRecordingViewModel.swift:
// 7577-7595) feeds `thisTurnRegexWrites` → the gate's `hasRegexHit`.
// The pure helper below ports that mechanism for BOTH env paths
// (hints-ON compares against job state — the write happens; hints-OFF
// compares against a per-session shadow map because the value is never
// written to the job there).

/** One tracker-approved candidate write from a regex pass. */
export interface RegexWriteCandidate {
  trackerKey: string;
  target: 'supply_characteristics' | 'board_info' | 'installation_details' | 'circuit';
  fieldKey: string;
  value: unknown;
  /** circuit-target only */
  circuitIdx?: number;
  /** PLAN-C Codex cycle 3 — the closed-enum guard refused this value, so
   *  it must NOT be patched into the job or claimed as regex-owned. It
   *  stays in the candidate list only so its match still counts as gate
   *  evidence and still goes out as a `regexResults` hint (see
   *  `FieldSourceTracker.recordRegexHintOnly`). */
  suppressed?: boolean;
}

/** Reads the value a candidate would overwrite. Injected so hints-ON can
 *  baseline on the job while hints-OFF baselines on the freshness shadow. */
export type BaselineReader = (candidate: RegexWriteCandidate) => unknown;

/** String-compare after trim (the matcher emits trimmed strings; job values
 *  may be numbers/booleans/null). null/undefined fold to '' so an unset
 *  field never equals a real value. */
export function valuesEqualAfterTrim(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v == null ? '' : String(v).trim());
  return norm(a) === norm(b);
}

/** Baseline reader for the hints-ON path: the current job value at the
 *  location the patch would write. */
export function jobBaselineReader(job: JobDetail): BaselineReader {
  return (c) => {
    if (c.target === 'circuit') {
      const row = (job.circuits ?? [])[c.circuitIdx ?? -1] as Record<string, unknown> | undefined;
      return row?.[c.fieldKey];
    }
    // Section destinations compare against the EFFECTIVE alias family (a
    // page-cleared visible alias reads as empty — `regex-destination-routing`).
    const section = job[c.target] as Record<string, unknown> | null | undefined;
    return readEffectiveSectionValue(section, c.target, c.fieldKey);
  };
}

/** Baseline reader for the hints-OFF path: a per-session shadow of the last
 *  gate-passed candidate values (the job is never patched in that mode, so
 *  job state would leave every re-hit looking fresh forever). */
export function shadowBaselineReader(shadow: ReadonlyMap<string, unknown>): BaselineReader {
  return (c) => shadow.get(c.trackerKey);
}

/**
 * PLAN-C (feedback id 129) — the closed-enum guard at the REGEX ingress.
 *
 * The instant-fill regex layer writes into the same six schema-enumerated
 * columns the voice appliers guard, from raw Flux text, with no validation
 * of its own. That is how a device CLASS lands in a device-STANDARD column:
 * "the breaker on circuit 3 is an MCB" matched `ocpd_type`, and "MCB" is
 * not one of B/C/D/gG/gM/aM/HRC/Rew/N/A.
 *
 * Two behaviours, and deliberately only two:
 *   - a VALID alias is canonicalised ("60898" → "BS EN 60898"), so the
 *     ~40ms instant fill and Sonnet's later write agree on one string
 *     instead of racing between two spellings of the same value;
 *   - an INVALID value is SUPPRESSED — it never writes, never counts as a
 *     changedKey, and never marks the field as regex-owned (which would
 *     block the correct value later). Codex cycle 3: suppression stops at
 *     the WRITE. The match still counts as gate evidence and still goes
 *     out as a `regexResults` hint, because dropping it outright changed
 *     the WS frame (iOS sends the hint) and could flip a short utterance
 *     to gate-REJECT — silence, the exact failure this plan prevents.
 *
 * No re-ask here, by design. This layer is silent by construction: it has
 * no speech path at all, it is superseded by Sonnet 1–2s later, and the
 * same utterance's `voice_command_response` already carries ONE re-ask
 * through the appliers. A second one would double-speak the same mistake
 * (Audio-First §1 — exactly once, not twice).
 */
function guardClosedEnumCandidate(candidate: RegexWriteCandidate): RegexWriteCandidate | null {
  // PLAN-CC — `ocpd_bs_en` left the closed-enum guard but keeps the FIRST of
  // the two behaviours above: a valid form is canonicalised so the ~40ms
  // instant fill and Sonnet's later write agree on one string.
  //
  // It cannot take the second. The detectors at this ingress capture exactly
  // three literals — `BS_EN_STANDARD_PATTERN` and `OCPD_COMPOSITE_PATTERN` are
  // `/\b(60898|61009|60909)\b/gi` — and the canonicaliser consumes all three,
  // so a MISS is unreachable here. Suppression is left unwritten rather than
  // written speculatively: a rule for a case no code path can produce is a
  // rule nothing can test, and whoever widens the detector owns raising it.
  if (candidate.fieldKey === 'ocpd_bs_en') {
    const canonical = canonicaliseOcpdStandard(candidate.value);
    if (canonical == null) {
      pipelineLog('apply_regex_ocpd_standard_suppressed', { field: candidate.fieldKey });
      return null;
    }
    if (canonical === candidate.value) return candidate;
    pipelineLog('apply_regex_closed_enum_canonicalised', {
      field: candidate.fieldKey,
      canonical,
    });
    return { ...candidate, value: canonical };
  }
  if (!isGuardedClosedEnumField(candidate.fieldKey)) return candidate;
  const outcome = canonicaliseClosedEnumValue(
    candidate.fieldKey as GuardedClosedEnumField,
    candidate.value
  );
  if (outcome.kind !== 'valid') {
    pipelineLog('apply_regex_closed_enum_suppressed', {
      field: candidate.fieldKey,
      outcome: outcome.kind,
    });
    return null;
  }
  if (outcome.value === candidate.value) return candidate;
  pipelineLog('apply_regex_closed_enum_canonicalised', {
    field: candidate.fieldKey,
    canonical: outcome.value,
  });
  return { ...candidate, value: outcome.value };
}

/**
 * Pure candidate computation — the four write loops (supply / board /
 * installation / circuit) with the tracker's 3-tier gating and the A3
 * value-equality freshness gate, but NO state commits: no
 * `tracker.recordRegexWrite`, no patch. Candidates whose value string-equals
 * the baseline are NOT fresh and are dropped (no changedKey, no chime, no
 * Sonnet send, no chitchat-counter reset). A changed value for a
 * previously-set field is still fresh (legit cumulative carryover).
 */
export function computeFreshRegexWrites(
  job: JobDetail,
  result: RegexMatchResult,
  tracker: FieldSourceTracker,
  baseline: BaselineReader,
  /** A02D — the active board (`current_board_changed`), so a duplicate
   *  circuit ref resolves to the SAME row the freshness gate evaluated
   *  (`regex-destination-routing.ts`). */
  activeBoardId: string | null = null
): RegexWriteCandidate[] {
  const fresh: RegexWriteCandidate[] = [];
  const consider = (raw: RegexWriteCandidate) => {
    const candidate = guardClosedEnumCandidate(raw);
    if (!candidate) {
      // Closed-enum reject. The WRITE is suppressed; the MATCH is not.
      // Same gates as a real write so the outbound hint stream is
      // unchanged in shape and cadence — ownership first, then freshness
      // against the suppression shadow (the job can't be the baseline
      // here: nothing is ever written, so every cumulative re-hit would
      // look fresh forever).
      const asString = String(raw.value);
      if (!tracker.canRegexWrite(raw.trackerKey)) return;
      if (tracker.isRepeatSuppressedRegexValue(raw.trackerKey, asString)) return;
      tracker.noteSuppressedRegexValue(raw.trackerKey, asString);
      fresh.push({ ...raw, suppressed: true });
      return;
    }
    if (!tracker.canRegexWrite(candidate.trackerKey)) return;
    if (valuesEqualAfterTrim(candidate.value, baseline(candidate))) return; // re-hit, not fresh
    fresh.push(candidate);
  };

  // Sections — ONE routing rule shared with the freshness gate (A02D):
  // some "supply" matcher fields live on board_info (main_switch_* / spd_*)
  // and one installation field is renamed at the store.
  const sections = [
    ['supply', result.supply_updates],
    ['board', result.board_updates],
    ['install', result.installation_updates],
  ] as const;
  for (const [scope, updates] of sections) {
    for (const [matcherField, value] of Object.entries(updates ?? {})) {
      if (value === undefined) continue;
      const route = routeSectionField(scope, matcherField);
      consider({
        trackerKey: route.trackerKey,
        target: route.target,
        fieldKey: route.fieldKey,
        value,
      });
    }
  }

  // Per-circuit. Translate matcher's `circuit_ref` keys to row UUIDs so
  // the tracker key uses the stable id; duplicate refs resolve by board
  // (never by array order) through the shared index.
  if (Object.keys(result.circuit_updates).length > 0) {
    const circuits = job.circuits ?? [];
    const indexByRef = indexCircuitRowsByRef(job, activeBoardId);
    for (const [ref, updates] of Object.entries(result.circuit_updates)) {
      const idx = indexByRef.get(ref);
      if (idx === undefined) continue; // ref without a row — out of scope
      const id = circuits[idx].id;
      for (const [field, value] of Object.entries(updates as CircuitUpdates)) {
        if (value === undefined) continue;
        consider({
          trackerKey: `circuit.${id}.${field}`,
          target: 'circuit',
          fieldKey: field,
          value,
          circuitIdx: idx,
        });
      }
    }
  }

  return fresh;
}

/**
 * Apply a RegexMatchResult onto a JobDetail. Returns null if no fields
 * actually wrote (so the caller can skip a needless updateJob cycle).
 *
 * Each candidate write is gated through `tracker.canRegexWrite(key)` —
 * if Sonnet or a pre-existing value already owns the field, the regex
 * write is silently dropped and the key does NOT appear in changedKeys
 * or the next regexResults wire payload. Since A3 (2026-07-08) each
 * candidate is ALSO freshness-gated against the current job value —
 * cumulative-window re-hits of an unchanged value no longer write,
 * count as changedKeys, or reach the tracker's turn-writes (so they no
 * longer flip the TranscriptGate's hasRegexHit).
 */
export function applyRegexMatchToJob(
  job: JobDetail,
  result: RegexMatchResult,
  tracker: FieldSourceTracker,
  activeBoardId: string | null = null
): RegexApplyOutput | null {
  pipelineLog('apply_regex_entry', {
    supply: Object.keys(result.supply_updates ?? {}).length,
    board: Object.keys(result.board_updates ?? {}).length,
    installation: Object.keys(result.installation_updates ?? {}).length,
    circuit_updates_refs: Object.keys(result.circuit_updates ?? {}).length,
  });
  const patch: Partial<JobDetail> = {};
  const changedKeys: string[] = [];

  const freshWrites = computeFreshRegexWrites(
    job,
    result,
    tracker,
    jobBaselineReader(job),
    activeBoardId
  );

  // Section buckets — accumulated and folded into the patch at the end so
  // multiple section writes don't smear across each other.
  const supplyPatch: Record<string, unknown> = {};
  const boardPatch: Record<string, unknown> = {};
  const installPatch: Record<string, unknown> = {};
  let circuits: CircuitRow[] | null = null;

  for (const c of freshWrites) {
    if (c.suppressed) {
      // Guard-refused: no patch, no changedKey (so no chime, no blue
      // flash, no `job_state_update`), and no regex ownership — but the
      // hint still crosses the wire and still holds the forward-gate
      // open, so the server sees the transcript and re-asks.
      tracker.recordRegexHintOnly(c.trackerKey);
      continue;
    }
    if (c.target === 'circuit') {
      if (circuits === null) circuits = [...(job.circuits ?? [])];
      const idx = c.circuitIdx ?? -1;
      const row = circuits[idx];
      if (!row) continue;
      circuits[idx] = { ...row, [c.fieldKey]: c.value };
    } else {
      // Every stored alias of the destination receives the value (wire key
      // + PWA-column key), so the page the inspector edits and the wire
      // snapshot never disagree after a regex write.
      const bucket =
        c.target === 'board_info'
          ? boardPatch
          : c.target === 'installation_details'
            ? installPatch
            : supplyPatch;
      for (const key of aliasFamily(c.target, c.fieldKey)) bucket[key] = c.value;
    }
    tracker.recordRegexWrite(c.trackerKey);
    changedKeys.push(c.trackerKey);
  }

  // Fold section patches into JobDetail patch (preserving other keys
  // already on the section).
  if (Object.keys(supplyPatch).length > 0) {
    patch.supply_characteristics = {
      ...(job.supply_characteristics ?? {}),
      ...supplyPatch,
    };
  }
  if (Object.keys(boardPatch).length > 0) {
    patch.board_info = {
      ...(job.board_info ?? {}),
      ...boardPatch,
    };
  }
  if (Object.keys(installPatch).length > 0) {
    patch.installation_details = {
      ...(job.installation_details ?? {}),
      ...installPatch,
    };
  }
  if (circuits !== null) {
    patch.circuits = circuits;
  }

  if (changedKeys.length === 0) {
    pipelineLog('apply_regex_exit_no_changes', {});
    return null;
  }
  pipelineLog('apply_regex_exit', {
    changed_keys: changedKeys.length,
    patch_sections: Object.keys(patch),
  });
  return { patch, changedKeys };
}
