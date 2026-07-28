/**
 * Stage 6 Phase 3 Plan 03-04 — classifyOvertake.
 *
 * Pure classifier. Given a new user utterance (text + regex-extracted field
 * results) and the per-session pending-asks registry, returns a verdict the
 * Plan 03-08 handleTranscript caller acts on. No side effects, no imports,
 * no registry mutation — the caller does resolve()/rejectAll() based on the
 * returned {kind}.
 *
 * Decision tree (ordered; first match wins):
 *   1. Empty registry            → {kind: 'no_pending_asks'}
 *   2. Any regex hit whose (field, circuit) matches a pending ask's
 *      (contextField, contextCircuit) → {kind: 'answers', toolCallId, userText}
 *   3. Any regex hit that does NOT fully match any pending ask — i.e. a
 *      different field OR same field but different circuit → {kind: 'user_moved_on'}
 *   4. No regex hits — shape-aware (Plan 03-11 Task 2):
 *      4a. Pending ask with expectedAnswerShape === 'yes_no' AND the text
 *          matches the yes/no vocabulary → {kind: 'answers', ...}
 *      4b. Pending ask with expectedAnswerShape === 'circuit_ref' AND
 *          extractCircuitRef parses the text to a 1..200 integer (single-
 *          number guard, decimal-rejection guard) → {kind: 'answers', ...}
 *      4c. Otherwise → {kind: 'user_moved_on'} (fail-safe default)
 *
 * Open Question #4 resolution: when the utterance produces no regex hits, the
 * DEFAULT fail-safe is 'user_moved_on', NOT 'answers-to-oldest'. Letting the
 * user restate is strictly safer than incorrectly attributing an unrelated
 * utterance ("let me think" / "hmm") as the answer to whatever ask happens
 * to be at the front of the registry. A wrongly-attributed answer poisons
 * the slot map and triggers a cascade of downstream corrections; a rejectAll
 * just means the user hears the question again on the next turn.
 *
 * Plan 03-11 Task 2 refinement (STG r3 MAJOR): number / circuit_ref asks
 * still fall through to user_moved_on on no-regex (same rationale — wrong
 * numeric attribution is the harder failure mode to detect). But yes_no
 * asks are *inherently* non-regex: the answer to "Is this reading above 1
 * ohm?" ("yes") will never produce a field regex hit. Without shape-
 * awareness the classifier would reject every such answer flowing through
 * the transcript channel (pre-Phase-4 iOS or the legacy path), forcing
 * the inspector to restate. Shape-aware short-circuit closes that gap
 * while keeping the conservative default wherever false-attribution cost
 * is high.
 *
 * Plan 03-12 STG r6 MAJOR revision: the earlier free_text branch (which
 * accepted any non-empty trimmed text as an answer) is REMOVED. That
 * heuristic misclassified filler speech — "hold on a second", "let me
 * check", "hmm" — as answers to any pending free_text ask, corrupting
 * the ask flow. No-regex speech against a free_text ask now falls
 * through to user_moved_on (conservative default). Phase 4's iOS
 * contract routes free_text answers via the direct ask_user_answered
 * channel with consumed_utterance_id — the transcript-overtake path
 * is not the authoritative route for free_text.
 *
 * 2026-04-29 — circuit_ref branch added. Field-test session 17C4135E lost
 * an IR live-to-earth reading because the disambiguation ask
 * ("I've got two circuits both called Upstairs Sockets — circuit 1 or
 * circuit 2?") had expectedAnswerShape='circuit_ref', and the user's
 * "circuit 2." reply produced no value-regex hit, so step 4 fell
 * through to user_moved_on. The transcript channel's rejectAll fired
 * before iOS's explicit ask_user_answered could resolve the same
 * tool_call_id, dropping the answer. circuit_ref is now shape-aware in
 * step 3 using extractCircuitRef from stage6-answer-resolver, which
 * already enforces the safety rails Open Question #4 cares about:
 * single-number guard rejects "circuit 2 ze 0.34" (a value statement),
 * decimal guard rejects "0.4" (a value, not a circuit ref), 1..200
 * range guard rejects "circuit 250". `number`-shaped asks remain
 * conservative — bare "2" is genuinely ambiguous between value and
 * circuit ref when the question is about a numeric reading.
 *
 * Duck-typed pendingAsks: the parameter only needs .size and .entries().
 * Both the real PendingAsksRegistry (Plan 03-01) and a plain Map work —
 * keeps this module unit-testable without the full registry stood up.
 *
 * Requirement: STA-04.
 */

import { extractCircuitRef } from './stage6-answer-resolver.js';
import { RECORDABLE_READING_FIELDS } from './recordable-reading-fields.js';
// §A4 (field-feedback-2026-07-14, F8) — typed structurally-complete-reading
// detector. Pure import; guards the pendingValue free-text acceptance below
// so a complete fresh reading ("earthing arrangement is TT", "customer name
// is David" — zero regex hits) is classified as an OVERTAKE, never consumed
// as the ask's answer (audio-first invariant 2).
import { detectStructuredReading } from './stage6-pending-value.js';

// Plan 03-11 Task 2 — yes/no vocabulary. Lowercased, trailing punctuation
// stripped by the caller before matching. Kept inline (not a config export)
// because the set is small, the meaning is language-universal within the
// English inspection domain, and a config lookup would buy nothing except
// another hot-reload surface. Add variants here if the inspector pool
// grows regional dialect coverage.
// Plan 03-12 r11 MINOR remediation — restore multi-word variants that
// were dropped from the planned vocabulary. "not really" is the canonical
// example surfaced by r11 review: an inspector replying "not really" to
// "Is this circuit still in service?" falls through the user_moved_on
// branch today because no single-word token matches, and the next turn
// forces a re-ask. Also adding "of course" (yes-sided) + "no way"
// (no-sided) which were in the Plan 03-11 Task 2 research notes but
// never landed. normaliseForYesNo() preserves internal whitespace — it
// only trims leading/trailing whitespace + punctuation — so multi-word
// phrases remain as literal Set keys.
const YES_NO_VOCABULARY = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'affirmative',
  'correct',
  'confirmed',
  'of course',
  'no',
  'nope',
  'nah',
  'negative',
  'incorrect',
  'wrong',
  'not really',
  'no way',
]);

function normaliseForYesNo(text) {
  if (typeof text !== 'string') return '';
  return text
    .trim()
    .toLowerCase()
    .replace(/^[\s"'`.,;:!?(){}[\]-]+/, '')
    .replace(/[\s"'`.,;:!?(){}[\]-]+$/, '');
}

// ─── Plan E §4b piece 3 (2026-07-28) — shared semantic-slot identity ────────
//
// ONE helper family used by BOTH ask-answer ingresses (this classifier's
// transcript-first pre-queue path AND sonnet-stream's direct
// ask_user_answered handler) so the two channels cannot disagree about
// whether a reply targets the SAME slot as a pending ask. Current clients
// send the transcript BEFORE ask_user_answered, so the production decision
// is THIS module's path — a direct-handler-only fix would pass its tests
// while the real ingress still false-overtook same-field aliases.
//
// Field identity is ALIAS-NORMALISED: the regex layer + older asks spell
// fields with legacy wire aliases (ze / zs / pfc / r1_plus_r2 /
// rcd_trip_time) while the typed detector returns canonical schema keys —
// `earth_loop_impedance_ze` ≡ `ze`. Without normalisation a "Ze is 0.35"
// reply to a ze-spelled ask classifies user_moved_on (false overtake).
const READING_FIELD_IDENTITY_ALIASES = new Map([
  ['ze', 'earth_loop_impedance_ze'],
  ['zs', 'measured_zs_ohm'],
  ['pfc', 'prospective_fault_current'],
  ['r1_plus_r2', 'r1_r2_ohm'],
  ['rcd_trip_time', 'rcd_time_ms'],
]);

export function canonicalReadingFieldIdentity(field) {
  if (typeof field !== 'string' || field.length === 0) return null;
  const lower = field.toLowerCase();
  return READING_FIELD_IDENTITY_ALIASES.get(lower) ?? lower;
}

function escapeReSlot(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Reply-side circuit-SET parse (round-6: the typed detector parses only the
// FIRST `circuit N` number — pending-side metadata alone cannot reveal that
// the reply changed the circuit set). Continuations ride comma / "and" / "&"
// separators plus bare-space INTEGER tokens; a bare-space token followed by
// a decimal point is rejected so "circuit 4 0.3" cannot misparse as
// circuits [4, 0].
function parseReplyCircuitSet(text) {
  if (typeof text !== 'string') return null;
  const m = text
    .toLowerCase()
    .match(/\bcircuits?\s+(\d{1,3}(?:(?:\s*(?:,|and|&)\s*|\s+)\d{1,3}(?!\.))*)/);
  if (!m) return null;
  const nums = m[1].match(/\d{1,3}/g);
  if (!nums || nums.length === 0) return null;
  return [...new Set(nums.map((n) => Number.parseInt(n, 10)))];
}

// Reply-side board projection (round-6: the direct handler calls the
// classifier with empty regex results and the detector knows nothing about
// boards — only the session snapshot can reveal that the reply re-scoped to
// a different board). CONSERVATIVE: a board is projected ONLY when the
// reply carries a board-context cue word (board / DB / distribution /
// consumer unit / sub-main) AND a known board DESIGNATION matches on a word
// boundary. Matching bare designations without the cue would false-project
// on vocabulary collisions — a board designated "Main" must not match the
// "main" in "main earth is 16". Board IDs are server-internal (e.g.
// 'main') and are deliberately NOT matched. Longest designation wins so
// "DB-1" cannot shadow "DB-12".
const BOARD_CONTEXT_CUE_RE = /\b(?:board|db|distribution|consumer\s+unit|sub[-\s]?main)\b/i;

export function projectReplyBoardId(text, boards) {
  if (typeof text !== 'string' || !Array.isArray(boards) || boards.length === 0) return null;
  if (!BOARD_CONTEXT_CUE_RE.test(text)) return null;
  const lower = text.toLowerCase();
  let best = null;
  for (const b of boards) {
    if (!b || typeof b !== 'object') continue;
    const designation = typeof b.designation === 'string' ? b.designation.trim() : '';
    if (designation.length < 2) continue;
    const re = new RegExp(`\\b${escapeReSlot(designation.toLowerCase())}\\b`, 'i');
    if (re.test(lower) && (best === null || designation.length > best.len)) {
      best = { id: b.id, len: designation.length };
    }
  }
  return best && best.id != null ? best.id : null;
}

/**
 * Build the reply's semantic slot from a detector result + the raw reply
 * text (+ optional session boards for board-scope projection).
 *
 * @param {string} text - the (canonical) reply text
 * @param {{fieldKey: string, circuit: number|null}|null} detected - detectStructuredReading output
 * @param {Array<{id: string, designation?: string}>|null} boards - session snapshot boards
 * @returns {{fieldKey: string|null, circuits: number[]|null, boardId: string|null}}
 */
export function buildReplySlot(text, detected, boards) {
  const circuits =
    parseReplyCircuitSet(text) ??
    (detected && detected.circuit != null ? [detected.circuit] : null);
  return {
    fieldKey: canonicalReadingFieldIdentity(detected ? detected.fieldKey : null),
    circuits,
    boardId: projectReplyBoardId(text, boards ?? null),
  };
}

// Ask-side circuit scope: the dispatcher stores BOTH contextCircuit (single)
// and contextCircuits (multi) on registry entries (stage6-dispatcher-ask
// buildResolvedBody threading) — round-7: the storage half already exists;
// this is the comparison half.
function askCircuitSet(entry) {
  if (Array.isArray(entry?.contextCircuits) && entry.contextCircuits.length > 0) {
    return entry.contextCircuits
      .map((c) => (typeof c === 'number' ? c : Number.parseInt(c, 10)))
      .filter((c) => Number.isFinite(c));
  }
  if (entry?.contextCircuit != null) {
    const c =
      typeof entry.contextCircuit === 'number'
        ? entry.contextCircuit
        : Number.parseInt(entry.contextCircuit, 10);
    return Number.isFinite(c) ? [c] : null;
  }
  return null;
}

/**
 * SAME-slot verdict between a pending ask entry and a reply slot.
 *
 * Rules (plan E rounds 3-7):
 *   - fields compare ALIAS-NORMALISED; different canonical field ⇒ different.
 *   - circuits: ask scope from contextCircuits/contextCircuit. A reply with
 *     NO explicit circuit matches only a scope-less ask (preserves the
 *     pre-plan-E exact-equality semantics, incl. null===null). A reply with
 *     explicit circuit(s) against a scope-LESS ask is a NEWLY-EXPLICIT
 *     re-scope ⇒ different ("which circuit?" Zs ask answered "Zs circuit 4
 *     is 0.30" must overtake and write circuit 4, never consume against the
 *     old scope). Both explicit ⇒ same iff the reply set ⊆ the ask set.
 *   - board: a reply that names NO board is compatible with any ask; a
 *     reply that projects a board must equal the ask's contextBoardId (a
 *     newly-explicit board, or a different one, is a re-scope ⇒ different).
 *
 * @returns {boolean} true when the reply targets the SAME semantic slot.
 */
export function isSameSemanticSlot(askEntry, replySlot) {
  if (!askEntry || !replySlot) return false;
  const askField = canonicalReadingFieldIdentity(askEntry.contextField);
  if (askField == null || replySlot.fieldKey == null) return false;
  if (askField !== replySlot.fieldKey) return false;

  const askSet = askCircuitSet(askEntry);
  const replySet =
    Array.isArray(replySlot.circuits) && replySlot.circuits.length > 0 ? replySlot.circuits : null;
  if (replySet == null) {
    if (askSet != null) return false; // bare reply vs circuit-scoped ask — pre-E semantics
  } else if (askSet == null) {
    return false; // newly-explicit circuit scope ⇒ re-scope
  } else if (!replySet.every((c) => askSet.includes(c))) {
    return false; // outside the ask's circuit set ⇒ re-scope
  }

  const askBoard = askEntry.contextBoardId ?? null;
  const replyBoard = replySlot.boardId ?? null;
  if (replyBoard != null && replyBoard !== askBoard) return false; // board re-scope
  return true;
}
// ─── end plan E slot identity ───────────────────────────────────────────────

export function classifyOvertake(newText, regexResults, pendingAsks, options = {}) {
  if (!pendingAsks || pendingAsks.size === 0) {
    return { kind: 'no_pending_asks' };
  }

  const regex = Array.isArray(regexResults) ? regexResults : [];
  const text = typeof newText === 'string' ? newText : '';

  // 1. Same-SLOT match wins — iterate regex hits in order, then pending asks
  //    in insertion order. First full match returns immediately.
  //    Plan E §4b piece 3: the comparison is the shared SEMANTIC-SLOT verdict
  //    (alias-normalised field + circuit-SET + board compatibility), not the
  //    old exact (field, circuit) equality — a "Ze is 0.35" reply to an ask
  //    whose contextField is spelled with the legacy wire alias `ze` is the
  //    SAME field (no false overtake), while an explicitly re-scoped
  //    same-field reply (different circuit set / different board) is NOT.
  for (const r of regex) {
    const slot = buildReplySlot(
      text,
      { fieldKey: r.field, circuit: r.circuit ?? null },
      options.boards
    );
    for (const [id, entry] of pendingAsks.entries()) {
      if (isSameSemanticSlot(entry, slot)) {
        return { kind: 'answers', toolCallId: id, userText: newText };
      }
    }
  }

  // 1.5 observation_clarify asks accept free-form prose replies including
  //     those that produce non-recordable regex hits like a bare circuit
  //     reference ("circuit 3, and it is a permanent fitting" — regex hits
  //     with a circuit but no field/value). Field-shape-aware steps 1-3
  //     cannot match because observation_clarify is not a schema field
  //     and never appears in regex results. Route by ask-type ONLY when
  //     the reply does not encode a genuine topic-change. A "topic-change"
  //     here is a regex hit with BOTH a real reading field AND a value
  //     present — that's a fresh record_reading, not an answer to a
  //     pending observation. A bare circuit reference, a bare field name
  //     with no value, or no regex hits at all are all compatible with
  //     an observation_clarify answer.
  //
  //     Position: runs AFTER step 1 so an exact (field, circuit) match
  //     against a normal pending ask still wins, and BEFORE step 2's
  //     fail-safe (which would mis-attribute the bare-circuit reply to
  //     user_moved_on). If multiple observation_clarify asks are pending
  //     (rare) the oldest in insertion order wins.
  //
  //     Predicate uses RECORDABLE_READING_FIELDS (shared module) NOT
  //     regex.length === 0 — the D7D01509 repro reply "circuit 3, and it
  //     is a permanent fitting." produces a regex hit for circuit 3 but
  //     with no field and no value, so it's a continuation, NOT a
  //     reading. A regex.length === 0 guard would defeat the fix.
  //     Conversely "Actually, Zs on circuit 3 is 0.18" (field + circuit
  //     + value) IS a topic-change and falls through to step 2. Legacy
  //     wire aliases (zs / pfc / r1_plus_r2 / rcd_trip_time) are in the
  //     shared set so a legacy-shape topic-change is not stolen here.
  //
  //     Source: session D7D01509 (2026-06-03 11:50 UTC). Q2 had
  //     contextField='observation_clarify', expectedAnswerShape='free_text',
  //     and the user's "circuit 3, and it is a permanent fitting." reply
  //     was rejected because the regex hit for circuit 3 short-circuited
  //     step 2 before step 3 could see the free_text shape. Bug 1a's
  //     prompt rule (ONE INTERROGATIVE PER ASK) is the upstream
  //     prevention; this branch is defence-in-depth.
  //
  //     TODO (2026-06-03 follow-up — re-grep context_field=none/null):
  //     the plan called for a CloudWatch Logs Insights correlation
  //     between stage6.ask_user (context_field absent / "none" / null)
  //     and stage6.ask_user_answered_unresolved with the same
  //     (sessionId, tool_call_id). The query (per
  //     .planning/plan-observation-bugs-2026-06-03-final.md) is:
  //       log group: /ecs/eicr/eicr-backend
  //       filter (message="stage6.ask_user" and (context_field="none"
  //                or isblank(context_field)))
  //           or message="stage6.ask_user_answered_unresolved"
  //       | fields @timestamp, message, sessionId, tool_call_id,
  //                context_field, utterance_id, reason
  //       | sort sessionId, tool_call_id, @timestamp asc
  //     The pre-step ALSO requires inspecting one recent
  //     stage6.ask_user row to confirm whether absent context_field
  //     renders as "none" (literal), JSON null, or omitted entirely
  //     (CloudWatch JSON filters distinguish these). If >=3 distinct
  //     sessions show the correlated pattern AND the unresolved row's
  //     utterance_id corresponds to a user transcript that semantically
  //     answers the ask, extend this branch to cover context_field IN
  //     ("observation_clarify", "none", null/absent). For now the
  //     narrow observation_clarify-only branch is shipped because AWS
  //     access was not exercised in the executing session.
  const hasRecordableRegex = regex.some(
    (r) =>
      r && typeof r.field === 'string' && RECORDABLE_READING_FIELDS.has(r.field) && r.value != null
  );
  // Codex r2-#3 — the typed-detector guard runs BEFORE the
  // observation_clarify continuation AND before the step-3 shape branches:
  // a structurally complete fresh reading is an OVERTAKE no matter which
  // pending ask shape might otherwise claim it (a detector-complete
  // utterance consumed as a circuit_ref/free-text answer loses the reading).
  //
  // Plan E refinement: "no matter which pending ask" was too blunt — a
  // complete reading whose semantic slot MATCHES a pending concrete-field
  // ask is that ask's ANSWER ("Ze is 0.35" answering a ze-spelled ask must
  // not false-overtake; alias-normalised). A pendingValue-class ask
  // (contextField none/null) has no concrete field, so it can never
  // slot-match and the round-13 overtake guard is preserved byte-for-byte
  // for that class. A DIFFERENT slot (field, newly-explicit/outside circuit
  // set, or board re-scope) still overtakes.
  const structuredEarly = !hasRecordableRegex ? detectStructuredReading(text) : null;
  if (structuredEarly && structuredEarly.complete === true) {
    const replySlot = buildReplySlot(text, structuredEarly, options.boards);
    for (const [id, entry] of pendingAsks.entries()) {
      if (isSameSemanticSlot(entry, replySlot)) {
        return { kind: 'answers', toolCallId: id, userText: newText };
      }
    }
    return { kind: 'user_moved_on' };
  }

  if (!hasRecordableRegex) {
    for (const [id, entry] of pendingAsks.entries()) {
      if (
        entry.contextField === 'observation_clarify' &&
        typeof newText === 'string' &&
        newText.trim().length > 0
      ) {
        return { kind: 'answers', toolCallId: id, userText: newText };
      }
    }

    // §A4 (field-feedback-2026-07-14, F8) — pendingValue continuation branch.
    // The INVERTED ask shape (`context_field:"none"` + a captured
    // pendingValue + free_text): the expected reply is a FIELD NAME ("RCD
    // trip time."), which never produces a recordable regex hit, so without
    // this branch the transcript channel classifies it `user_moved_on` and
    // the ask dies before the direct ask_user_answered frame can resolve it
    // (the F8 silence). Mirrors the observation_clarify continuation above.
    //
    // Round-13 typed-detector guard: regex ABSENCE is not evidence of an
    // answer — a structurally complete NO-regex reading ("earthing
    // arrangement is TT", "customer name is David") arriving transcript-
    // first must be an OVERTAKE (fall through to user_moved_on so the
    // fresh reading is processed normally), never consumed as the field
    // answer with the stale pendingValue joined to it.
    // (Detector-complete utterances already returned user_moved_on above.)
    for (const [id, entry] of pendingAsks.entries()) {
      if (
        // Codex r4-#2 — the ask schema treats a null/absent context_field
        // as equivalent to the literal 'none' (isPendingValueAsk accepts
        // both), so a null-context inverted ask must also match here or
        // its transcript-only field-name reply dies as user_moved_on.
        (entry.contextField == null || entry.contextField === 'none') &&
        entry.pendingValue != null &&
        entry.expectedAnswerShape === 'free_text' &&
        typeof newText === 'string' &&
        newText.trim().length > 0
      ) {
        return { kind: 'answers', toolCallId: id, userText: newText };
      }
    }

    // §A4 round-10 — brokered pvr-* VALUE asks (concrete context_field,
    // numeric/sentinel reply expected). classifyOvertake only accepted
    // yes/no + circuit-ref no-regex shapes, so a transcript-first numeric
    // reply ("26 milliseconds") to a pvr value ask would be classified
    // user_moved_on and delete the registry entry BEFORE the duplicate
    // direct ask_user_answered frame arrived — beep-then-no-write again.
    // Narrowly scoped: only pvr-* ids (server-brokered), only a concrete
    // context_field, only a numeric or sentinel-shaped reply.
    const trimmed = typeof newText === 'string' ? newText.trim() : '';
    // P3 (2026-07-23): widened lim|limitation → the full four forms
    // lim|limb|limp|limitation so a supported limb/limp value reply isn't
    // mis-classified as user_moved_on (which would delete the pending entry and
    // LOSE the answer — beep-then-no-write).
    const looksLikeValue =
      /\d/.test(trimmed) ||
      /\b(?:lim|limb|limp|limitation|discontinuous|open circuit|infinity)\b/i.test(trimmed);
    if (trimmed && looksLikeValue) {
      for (const [id, entry] of pendingAsks.entries()) {
        if (
          typeof id === 'string' &&
          id.startsWith('pvr-') &&
          typeof entry.contextField === 'string' &&
          entry.contextField !== 'none' &&
          entry.contextField !== 'observation_clarify'
        ) {
          return { kind: 'answers', toolCallId: id, userText: newText };
        }
      }
    }
  }

  // 2. Any regex hit that did not fully match a pending ask signals the user
  //    has moved on. Covers BOTH different-field AND same-field-different-
  //    circuit (e.g. pending (ze,5) + regex (ze,3) — step 1 didn't match, so
  //    we land here). Defers to the rejectAll path; user will restate.
  //    Plan E: mirrors step 1's shared slot verdict so the two passes can
  //    never disagree about what "fully match" means.
  for (const r of regex) {
    const slot = buildReplySlot(
      text,
      { fieldKey: r.field, circuit: r.circuit ?? null },
      options.boards
    );
    let hadFullMatch = false;
    for (const [, entry] of pendingAsks.entries()) {
      if (isSameSemanticSlot(entry, slot)) {
        hadFullMatch = true;
        break;
      }
    }
    if (!hadFullMatch) {
      return { kind: 'user_moved_on' };
    }
  }

  // 3. No regex hits — Plan 03-11 Task 2 shape-aware branch. Walk pending
  //    asks in insertion order (oldest first). First match wins.
  //
  //    yes_no  → text against YES_NO_VOCABULARY (bounded set)
  //    circuit_ref → extractCircuitRef (single-number, 1..200, no decimals)
  //
  //    number / free_text / undefined shapes never match here — they fall
  //    through to the conservative user_moved_on default, preserving the
  //    Open Question #4 ruling for asks where false attribution is
  //    expensive (a bare "2" reply to a number ask is genuinely ambiguous
  //    between "value" and "circuit ref"; a "2" reply to a circuit_ref ask
  //    is not).
  const yesNoNormalised = normaliseForYesNo(newText);
  const lowerNewText = typeof newText === 'string' ? newText.toLowerCase() : '';
  for (const [id, entry] of pendingAsks.entries()) {
    if (entry.expectedAnswerShape === 'yes_no') {
      if (YES_NO_VOCABULARY.has(yesNoNormalised)) {
        return { kind: 'answers', toolCallId: id, userText: newText };
      }
    } else if (entry.expectedAnswerShape === 'circuit_ref') {
      if (extractCircuitRef(lowerNewText) !== null) {
        return { kind: 'answers', toolCallId: id, userText: newText };
      }
    }
  }

  // 4. Conservative fail-safe (Open Question #4): no regex hits and no
  //    shape-aware match.
  return { kind: 'user_moved_on' };
}
