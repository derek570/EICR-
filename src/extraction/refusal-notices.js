/**
 * Plan B (honest-refusal, 2026-07-28, feedback id 101 secondary) — the SHARED
 * refusal/mandatory-notice registry.
 *
 * WHAT: the notice-family machinery Plan A1a proved on `clear_board_reading`
 * (family registry + staging/coalescing + drain-time rotation selection),
 * EXTRACTED here so new structural-refusal families are DECLARED, not
 * re-implemented — plus Plan B's own B-staged families (`unsupported_clear`,
 * `wrong_tool_clear`, the two `model_contract` routes and the four BRIDGE
 * denial pools) and every ordinal-bearing terminal template.
 *
 * WHY dispatcher-authored: the dispatcher that rejects an operation is the
 * ONLY code that deterministically knows whether the rejection is STRUCTURAL
 * (the system cannot do this) or RECOVERABLE (the model should retry with a
 * fix). Refusals are therefore staged at dispatch time and spoken at the
 * harness net-0 drain — never inferred from error envelopes at the net
 * (error codes carry no capability taxonomy: `field_not_clearable` means a
 * structural gap pre-A1b and a recoverable wrong-tool choice post-A1b).
 *
 * DEPENDENCY DIRECTION (round-2 extraction constraint): this module is
 * dependency-DOWNSTREAM-only — it imports NOTHING from the dispatchers or the
 * harness. `stage6-dispatchers-board.js` keeps a compatibility RE-EXPORT of
 * `BOARD_CLEAR_NOTICE_FAMILIES` / `selectMandatoryNoticeText` so existing A1a
 * suites keep their import paths. Plan 2A adds two imports, both pure
 * ALIAS-TABLE leaves (`value-enum-validator.js` → one further leaf;
 * `field-name-corrections.js` → none), so the direction still holds.
 *
 * TWO SELECTION REGIMES (round-13):
 *   - DIRECT (A1a) notices — no `coveredToolCallIds` — keep the exact A1a
 *     semantics: per-session `_mandatoryNoticeRotation[family]` monotonic
 *     cursor, djb2-seeded first selection, duplicate staging does NOT advance
 *     the cursor, selection at the DRAIN. From attempt 6 (pool exhausted — the
 *     strict 5-variant cycle would wrap to a byte-identical string inside the
 *     clients' 30 s text dedupe and be swallowed to SILENCE) a per-family
 *     ordinal-bearing TERMINAL renders instead — the one sanctioned A1a
 *     rendering change (plan B §3.5). The direct ordinal is FAMILY-wide
 *     (`_mandatoryNoticeDirectCount`, session-lifetime monotonic) and the
 *     wording says so ("⟨n⟩ refused so far"), never "attempt ⟨n⟩ for ⟨label⟩"
 *     (round-10: five capability-missing clears on other fields followed by
 *     the first Ze clear must not say "attempt 6 for Ze").
 *   - B-STAGED notices — `coveredToolCallIds` present — select from the
 *     PER-SLOT attempt count (`session.refusedOps[repeatKey].count`), never
 *     the family cursor (round-11/12: a shared family cursor wraps modulo the
 *     pool, so same-label different-slot refusals collide and same-slot
 *     attempts realign after poolSize intervening family notices). Attempts
 *     1–2 rotate the route's own pool; attempt 3+ renders the route's
 *     ordinal-bearing terminal. `refusedOps` entries reset once older than
 *     the 30 s client-dedupe window (the ordinal exists to defeat that
 *     dedupe; outside the window a fresh attempt 1 is honest and safe).
 *
 * COVERAGE (round-3): `coveredToolCallIds` is CALL-level evidence for the A3
 * arbitration — the union of covered ids is compared against the turn's
 * rejected-envelope ids. Coalescing APPENDS ids (five same-slot rejections →
 * one notice covering five ids); it must never destroy coverage evidence.
 * Count and cursor advance ONLY when a NEW family+slot notice is ACCEPTED
 * (or an existing direct notice FIRST transitions to covered — round-14);
 * coalesced duplicates append coverage but advance neither.
 *
 * LEAK SAFETY: every rendered label is server-owned (field_schema labels,
 * CONFIRMATION_FRIENDLY_NAMES, board ORDINALS — never a model-controlled
 * string). The `model_contract` routes render NO label at all and key their
 * repeat state on server-owned constants (`model_contract::unknown_tool`,
 * `model_contract::offschema_clear`), never the hallucinated tool name or
 * the off-schema field string.
 *
 * THIRD REGIME — PARTIAL-FAILURE notices (plan 2A, 2026-07-30, feedback id
 * 112). Plan B's two regimes above both answer "the whole turn was refused";
 * this one answers "part of the turn silently did not land". It reuses the
 * family/rotation/inventory pattern but lives on its OWN per-turn accumulator
 * (`perTurnWrites.partialFailureNotices`) and its OWN session rotation key
 * (`_partialFailureRotation`) — see PARTIAL-FAILURE SEPARATION below.
 */

import { canonicaliseNumericReadingField } from './value-enum-validator.js';
import { FIELD_CORRECTIONS } from './field-name-corrections.js';

// The clients' A1(b) field-nil text dedupe window: byte-identical spoken
// lines within this window are swallowed client-side. Every rotation /
// ordinal rule in this module exists to keep repeats byte-distinct inside it.
export const REFUSAL_REPEAT_WINDOW_MS = 30_000;

function capitaliseFirst(s) {
  return typeof s === 'string' && s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * §3.5/§3.5a (A1a) — the FIVE mandatory-notice families. Each is ≥3 exact,
 * semantically-equivalent strings; families are mutually string-distinct and
 * distinct from REJECTED_PROMPTS / CATCHALL_AUDIBILITY_PROMPTS /
 * NOOP_AUDIBILITY_PROMPTS (never a "didn't catch that" — the request WAS
 * understood, and "say it again" wording is precisely the infinite-retry
 * invitation this plan exists to kill). Rotation exists because byte-identical
 * repeats inside 30 s are swallowed by the clients' A1(b) field-nil text
 * dedupe — Derek said "Delete Ze" THREE times; attempts 2 and 3 must not go
 * silent.
 *
 * Wording is TRUTHFUL for the dark state: no "please update the app" until
 * A1b ships a client that could actually be updated to.
 *
 * MOVED VERBATIM from stage6-dispatchers-board.js (plan B §3.1 extraction);
 * rendered bytes are pinned by the A1a parity suite. A compat re-export
 * remains at the old import path.
 */
export const BOARD_CLEAR_NOTICE_FAMILIES = Object.freeze({
  // Codex diff-review r1 (A1a): FIVE variants per family (the plan's floor is
  // "≥3"). With exactly three, a FOURTH same-family retry inside the
  // clients' 30 s field-nil text-dedupe window would wrap back to the first
  // byte-identical string and be swallowed; five keeps five consecutive
  // retries audibly distinct — comfortably past the observed three-attempt
  // loop. (Plan B closes the residual attempt-6 wrap with the direct
  // terminals below.)
  board_clear_capability_missing: Object.freeze([
    (f) => `Board-reading clear isn't available in this app version — delete ${f} on screen.`,
    (f) => `This app version can't clear board readings by voice — remove ${f} using the screen.`,
    (f) =>
      `Voice clearing for board readings isn't supported in this app build — edit ${f} on screen instead.`,
    (f) =>
      `Board readings can't be cleared by voice on this app version — take ${f} out on screen.`,
    (f) =>
      `This build doesn't support voice-clearing board readings — clear ${f} from the screen instead.`,
  ]),
  board_clear_disabled: Object.freeze([
    (f) => `Clearing board readings is switched off right now — please delete ${f} on screen.`,
    (f) => `Board-reading clears are currently turned off — remove ${f} using the screen for now.`,
    (f) => `The board-clear function is disabled at the moment — edit ${f} on screen instead.`,
    (f) => `Board-reading clearing is temporarily off — please take ${f} out on screen.`,
    (f) =>
      `Clears for board readings are switched off for now — clear ${f} from the screen instead.`,
  ]),
  board_clear_already_empty: Object.freeze([
    (f) => `${capitaliseFirst(f)} is already blank.`,
    (f) => `There's no ${f} recorded — nothing to clear.`,
    (f) => `${capitaliseFirst(f)} is already empty, so no value was removed.`,
    (f) => `Nothing is recorded for ${f} — there's no value to remove.`,
    (f) => `${capitaliseFirst(f)} holds no value at the moment, so there was nothing to clear.`,
  ]),
  field_not_applicable_on_eicr: Object.freeze([
    () =>
      `Comments only apply to an EIC — this certificate is an EICR, so there's nothing to clear.`,
    () => `This is an EICR — the comments field belongs to an EIC and isn't in use here.`,
    () => `There's no comments field on an EICR — that one only exists on an EIC certificate.`,
    () => `The comments field doesn't exist on an EICR certificate, so there's nothing to remove.`,
    () => `Comments belong to EIC certificates only — this EICR has no comments field to clear.`,
  ]),
  board_clear_scope_unclassified: Object.freeze([
    (f) => `${capitaliseFirst(f)} can't be cleared by voice yet — delete it on screen.`,
    (f) => `Voice clearing isn't set up for ${f} — remove it using the screen.`,
    (f) => `Clearing ${f} by voice isn't wired up yet — edit it on screen instead.`,
    (f) => `${capitaliseFirst(f)} isn't voice-clearable yet — take it out on screen.`,
    (f) => `Voice can't clear ${f} for now — please remove it from the screen.`,
  ]),
});

/**
 * Plan B §3.5 — DIRECT-denial ordinal terminals, one per A1a family, rendered
 * from attempt 6 onward (pool exhausted). PER-FAMILY, ROUTE-DISTINCT,
 * TRUTHFUL (round-9: a single "nothing recorded" generic is FALSE for the
 * four denial families — the field frequently HOLDS a value and was refused
 * for capability/policy reasons). The ordinal is the FAMILY-wide
 * session-lifetime refusal count (round-10) and the trusted label is kept
 * SEPARATELY in the sentence for slot-distinct bytes. `already_empty` alone
 * keeps the empty-flavoured wording.
 */
export const DIRECT_DENIAL_TERMINALS = Object.freeze({
  board_clear_capability_missing: (f, n) =>
    `Board-level clears still aren't available on this device — that's ${n} refused so far; ${f} hasn't been cleared.`,
  board_clear_disabled: (f, n) =>
    `Board clearing is switched off right now — ${n} clears refused so far; ${f} hasn't been cleared.`,
  field_not_applicable_on_eicr: (f, n) =>
    `${capitaliseFirst(f)} doesn't apply on this certificate type — that's ${n} of these refusals now; nothing to clear here.`,
  board_clear_scope_unclassified: (f, n) =>
    `I still can't place ${f} at board level — ${n} such refusals logged; it hasn't been cleared.`,
  board_clear_already_empty: (f, n) =>
    `There's still nothing recorded for ${f} — that's ${n} empty clears now; nothing to clear.`,
});

/**
 * Plan B §3.4 — B-STAGED variant pools, keyed by ROUTE. Every route has its
 * OWN ≥3 byte-distinct pool (round-15: first attempts of two routes sharing a
 * pool would both select idx 0 and render identical bytes — the client 30 s
 * text dedupe is family-BLIND, so the second chimed turn would be silently
 * swallowed). The four bridge pools are byte-distinct from A1a's DIRECT pools
 * for the same families (same honest semantics, different strings — a direct
 * denial and a bridged denial on a discriminator-exempt GLOBAL slot like Ze
 * on adjacent turns must not select the same string).
 *
 * Label contract: `f` is the STAGE-TIME discriminated label (field label +
 * circuit + board ordinal as the slot demands — see the staging sites), so
 * rendered identity ALIGNS with the repeat-bucket identity on every
 * rendering (round-12). The `model_contract` routes take no label at all.
 *
 * Wording contract: non-retry-inviting (no "say that again"), non-blaming.
 * `wrong_tool_clear` and both `model_contract` routes never claim "can't do
 * that" — the operation is NOT impossible and the inspector did nothing
 * wrong; the honest story is an internal snag that is logged.
 */
export const B_STAGED_POOLS = Object.freeze({
  unsupported_clear: Object.freeze([
    (f) => `I can't clear ${f} by voice yet — use the screen to remove it.`,
    (f) => `Clearing ${f} isn't something voice can do yet — edit it on screen.`,
    (f) => `Voice clearing isn't available for ${f} — remove it on screen for now.`,
  ]),
  wrong_tool_clear: Object.freeze([
    (f) =>
      `${capitaliseFirst(f)} hasn't been cleared — that request took a wrong turn internally, and it's logged.`,
    (f) =>
      `That clear for ${f} hit a routing snag on my side — nothing was removed, and it's logged.`,
    (f) =>
      `${capitaliseFirst(f)} is still recorded — the clear didn't route correctly here; it's logged.`,
  ]),
  unknown_tool: Object.freeze([
    () => `I hit an internal snag with that one — it's logged.`,
    () => `Something went wrong on my side with that request — it's been logged.`,
    () => `That ran into an internal problem here — it's logged for review.`,
  ]),
  offschema_clear: Object.freeze([
    () => `That clear request didn't match a field I recognise — it's logged.`,
    () => `I couldn't match that clear to a field I know — it's been logged.`,
    () => `That clear didn't line up with any known field — it's logged for review.`,
  ]),
  // BRIDGE pools — the four A1a denial families as staged by the
  // clear_reading→classifyBoardClear bridge (plan B §3.2). Byte-distinct
  // from the DIRECT pools above.
  board_clear_capability_missing: Object.freeze([
    (f) => `Voice can't clear ${f} in this app version — use the screen to remove it.`,
    (f) => `${capitaliseFirst(f)} can't be removed by voice on this build — clear it on screen.`,
    (f) => `Removing ${f} by voice needs a newer app version — use the screen for now.`,
  ]),
  board_clear_disabled: Object.freeze([
    (f) => `Board clears are switched off at the moment — remove ${f} on screen.`,
    (f) =>
      `${capitaliseFirst(f)} can't be cleared right now — board clearing is off; use the screen.`,
    (f) => `Board-level clearing is off for now — take ${f} out on screen.`,
  ]),
  field_not_applicable_on_eicr: Object.freeze([
    (f) =>
      `${capitaliseFirst(f)} isn't part of an EICR — there's nothing to clear on this certificate.`,
    (f) => `An EICR doesn't carry ${f} — nothing to remove there.`,
    (f) => `${capitaliseFirst(f)} only exists on an EIC — this EICR has nothing to clear for it.`,
  ]),
  board_clear_scope_unclassified: Object.freeze([
    (f) => `${capitaliseFirst(f)} isn't set up for voice clearing at board level — use the screen.`,
    (f) => `I can't place ${f} at board level for a clear — remove it on screen.`,
    (f) => `Voice board-clearing for ${f} isn't wired up — edit it on screen instead.`,
  ]),
});

/**
 * Plan B §3.5 — B-staged ordinal terminals, one per route, rendered from
 * attempt 3 onward. Ordinal-bearing AND label-bearing wherever a trusted
 * label exists (slot-distinctness: two different slots at the same ordinal
 * must not render identical bytes); every route DISTINCT (the client dedupe
 * is key-blind, so equal ordinals across routes must not collide).
 * Per-attempt wording is truthful here because the repeat keys are
 * slot-scoped (unlike the family-wide direct counters).
 */
export const B_STAGED_TERMINALS = Object.freeze({
  // round-18: "voice-editable" was FALSE for circuit_ref (renameable by voice
  // via rename_circuit, just not clearable) — the terminal says CLEARABLE,
  // byte-exact to the plan template (Codex diff-review cycle 1).
  unsupported_clear: (f, n) =>
    `Still can't clear ${f} — that's attempt ${n}; it isn't voice-CLEARABLE in this build.`,
  wrong_tool_clear: (f, n) =>
    `${capitaliseFirst(f)} has NOT been cleared — attempt ${n} hit a routing snag, and it's logged.`,
  unknown_tool: (f, n) => `That one hit the same internal snag again — attempt ${n} is logged.`,
  offschema_clear: (f, n) =>
    `That clear request keeps missing a field I recognise — attempt ${n} is logged.`,
  board_clear_capability_missing: (f, n) =>
    `Board-level clears still aren't available on this device — attempt ${n} for ${f}.`,
  board_clear_disabled: (f, n) =>
    `Board clearing is switched off right now — attempt ${n} for ${f}.`,
  field_not_applicable_on_eicr: (f, n) =>
    `${capitaliseFirst(f)} doesn't apply on this certificate type — attempt ${n}.`,
  board_clear_scope_unclassified: (f, n) =>
    `I still can't place ${f} at board level — attempt ${n} is logged.`,
});

// djb2 over the turn id — the F/U-2/3 seeding hash. Used ONLY to seed the
// first selection of a family's rotation cursor (so different sessions start
// at different phrasings); NEVER as the per-turn selector (a hash gives no
// no-consecutive-repeat guarantee — A1a §3.5's executed counter-examples).
function djb2Index(turnId, count) {
  let h = 5381;
  const str = String(turnId ?? '');
  for (let i = 0; i < str.length; i += 1) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h % count;
}

/**
 * A1a §3.5 — pinned DIRECT selection algorithm: a per-session, per-family
 * STRICT MONOTONIC CYCLE. Consecutive selections are always distinct; three
 * consecutive fires are three distinct strings. Seeded from the djb2 hash on
 * first use. State lives beside the session's dispatcher context and MUST be
 * stored (a re-derivation would repeat the prior text and the clients' 30 s
 * dedupe would go silent).
 *
 * Codex diff-review r1 (A1a): selection is called at the DRAIN (the
 * harness's net-0 site), NEVER at stage time — dedupe AND the drain's
 * same-slot suppression must complete BEFORE the cursor advances, so a
 * suppressed notice can never consume a variant (a consumed-but-unspoken
 * variant lets the next emitted notice wrap to the last AUDIBLE byte string
 * and be client-deduped into silence). EXPORTED for the harness + unit
 * tests. MOVED VERBATIM from stage6-dispatchers-board.js (plan B §3.1);
 * byte-parity pinned.
 */
export function selectMandatoryNoticeText(session, family, turnId, friendly) {
  const variants = BOARD_CLEAR_NOTICE_FAMILIES[family];
  if (!session._mandatoryNoticeRotation || typeof session._mandatoryNoticeRotation !== 'object') {
    session._mandatoryNoticeRotation = {};
  }
  const state = session._mandatoryNoticeRotation;
  const prev = state[family];
  const idx =
    typeof prev === 'number' ? (prev + 1) % variants.length : djb2Index(turnId, variants.length);
  state[family] = idx;
  return variants[idx](friendly);
}

/**
 * Plan B §3.5 — bump the per-slot refusal attempt counter. Entries RESET
 * once older than the 30 s client-dedupe window (outside it a byte-repeat is
 * no longer swallowed, so a fresh "attempt 1" is honest and safe); inside it
 * the count is what drives pool rotation and the ordinal terminal.
 * Session-scoped lazy map — `session.refusedOps[repeatKey] = {count, lastAt}`.
 */
function bumpRefusedOp(session, repeatKey, nowMs) {
  if (!session.refusedOps || typeof session.refusedOps !== 'object') {
    session.refusedOps = {};
  }
  const entry = session.refusedOps[repeatKey];
  if (!entry || nowMs - entry.lastAt > REFUSAL_REPEAT_WINDOW_MS) {
    session.refusedOps[repeatKey] = { count: 1, lastAt: nowMs };
    return 1;
  }
  entry.count += 1;
  entry.lastAt = nowMs;
  return entry.count;
}

/**
 * Stage a mandatory notice (A1a §3.5a net 0 / plan B §3.2) as METADATA ONLY —
 * the spoken text is selected at the harness DRAIN, after within-turn dedupe
 * (here) and the drain's same-slot suppression / coverage arbitration have
 * all settled, so rotation state advances EXACTLY once per notice that will
 * actually be emitted. Entries carry the telemetry dimensions the drain's
 * `stage6.mandatory_notice_emitted` row requires (family / field / board /
 * reason — PII-safe: field names and board ids, never values).
 *
 * Plan B additions:
 *   - `coveredToolCallIds` (CALL-level coverage for the A3 arbitration).
 *     Coalescing APPENDS ids — five same-slot rejections in one turn produce
 *     ONE notice covering five ids.
 *   - `route` + `repeatKey` (B-staged selection identity — see the module
 *     header). Both are server-owned constants or slot-derived strings,
 *     never model-controlled text.
 *   - refusedOps bump: exactly once per turn per family+slot, when the
 *     notice is ACCEPTED as covered — i.e. a NEW covered entry, or the FIRST
 *     transition of an existing direct-only entry to covered (round-14
 *     mixed-route provenance; dispatch-order-independent). Coalesced
 *     duplicates and direct-only stagings never bump.
 */
export function stageMandatoryNotice(
  perTurnWrites,
  session,
  {
    family,
    slotKey: slot,
    turnId,
    friendly,
    field,
    boardId,
    reason,
    coveredToolCallIds,
    route,
    repeatKey,
  },
  nowMs = Date.now()
) {
  if (!Array.isArray(perTurnWrites.mandatoryNotices)) return;
  const incomingCovered = Array.isArray(coveredToolCallIds) && coveredToolCallIds.length > 0;
  const existing = perTurnWrites.mandatoryNotices.find(
    (n) => n && n.family === family && n.slotKey === slot
  );
  if (existing) {
    if (incomingCovered) {
      const wasCovered =
        Array.isArray(existing.coveredToolCallIds) && existing.coveredToolCallIds.length > 0;
      if (!wasCovered) {
        // FIRST direct→covered transition: the entry becomes B-staged. Adopt
        // the B selection identity AND the incoming rendering/telemetry
        // metadata (Codex diff-review cycle 1: the DIRECT notice's friendly
        // lacks the B slot discriminator — e.g. the board ordinal on a
        // board-scoped field — so retaining it would make the rendered
        // bytes dispatch-order-DEPENDENT and let two boards' first attempts
        // collide into client-dedupe silence). Initialise the per-slot
        // counter exactly once — WITHOUT touching the A1a family cursor.
        existing.coveredToolCallIds = [];
        existing.route = route ?? existing.route ?? family;
        existing.repeatKey = repeatKey ?? existing.repeatKey ?? `${family}::${slot}`;
        if (friendly != null) existing.friendly = friendly;
        if (field !== undefined) existing.field = field ?? null;
        if (boardId !== undefined) existing.boardId = boardId ?? null;
        if (reason != null) existing.reason = reason;
        if (turnId != null) existing.turnId = turnId;
        bumpRefusedOp(session, existing.repeatKey, nowMs);
      }
      for (const id of coveredToolCallIds) {
        if (id != null && !existing.coveredToolCallIds.includes(id)) {
          existing.coveredToolCallIds.push(id);
        }
      }
    }
    return;
  }
  const notice = {
    family,
    slotKey: slot,
    turnId,
    friendly,
    field: field ?? null,
    boardId: boardId ?? null,
    reason: reason ?? family,
  };
  if (incomingCovered) {
    notice.coveredToolCallIds = [...coveredToolCallIds];
    notice.route = route ?? family;
    notice.repeatKey = repeatKey ?? `${family}::${slot}`;
    bumpRefusedOp(session, notice.repeatKey, nowMs);
  }
  perTurnWrites.mandatoryNotices.push(notice);
}

/**
 * Plan B §3.5 rule (3) — the spoken board component is a server-owned
 * INJECTIVE identifier: the board's ORDINAL (1-based index in
 * `snapshot.boards`), NEVER the designation alone (`add_board` enforces no
 * designation uniqueness) and never a raw board-id string. Returns null when
 * the board can't be resolved (legacy single-board snapshots with no
 * boards[]) — callers then omit the board clause, which is safe because a
 * second board cannot exist without a boards[] array.
 */
export function spokenBoardOrdinal(snapshot, boardId) {
  if (boardId == null || !Array.isArray(snapshot?.boards)) return null;
  const idx = snapshot.boards.findIndex((b) => b && b.id === boardId);
  return idx >= 0 ? idx + 1 : null;
}

/**
 * Plan B §3.2 — stage the `model_contract` unknown-tool refusal. An unknown
 * tool name is a model/protocol contract error, NOT evidence the user's
 * request is impossible (a supported request expressed through a
 * hallucinated tool name must never draw "I can't do that") — so the
 * wording is the non-blaming internal-snag family. Slot + repeat key are
 * the server-owned `unknown_tool` constants (leak safety: never the
 * hallucinated tool name); multiple unknown-tool failures in one turn
 * coalesce to ONE line whose coverage lists every call id (round-8).
 * Without a call id there is nothing for the A3 arbitration to cover, so
 * nothing is staged (fail-closed to today's behaviour).
 */
export function stageUnknownToolRefusal(perTurnWrites, session, { turnId, toolCallId }) {
  if (toolCallId == null) return;
  stageMandatoryNotice(perTurnWrites, session, {
    family: 'model_contract',
    slotKey: 'unknown_tool',
    turnId,
    friendly: null,
    field: null,
    boardId: null,
    reason: 'unknown_tool',
    coveredToolCallIds: [toolCallId],
    route: 'unknown_tool',
    repeatKey: 'model_contract::unknown_tool',
  });
}

/** True when a staged notice carries call-level coverage (B-staged). */
export function noticeIsCovered(notice) {
  return Array.isArray(notice?.coveredToolCallIds) && notice.coveredToolCallIds.length > 0;
}

/**
 * Drain-time renderer — the ONE dispatch point for both selection regimes.
 * Called by the harness net-0 drain for every notice that survived
 * suppression/arbitration. Returns the spoken string, or null for an
 * unknown family (the drain's empty-text skip keeps the turn on today's
 * fail-audible paths — marker-② speaks if nothing else does).
 */
export function renderMandatoryNoticeText(session, notice, turnId, nowMs = Date.now()) {
  if (!noticeIsCovered(notice)) {
    // DIRECT (A1a) regime — byte-parity for attempts 1..poolSize, then the
    // family terminal (the sanctioned wrap-silence fix). The parallel
    // direct count is SESSION-LIFETIME monotonic (round-11: pruning it
    // would understate the "⟨n⟩ refused so far" session wording) and never
    // touches the rotation cursor (whose `typeof prev === 'number'` djb2
    // seeding must stay byte-identical).
    const variants = BOARD_CLEAR_NOTICE_FAMILIES[notice.family];
    if (!variants) return null;
    if (
      !session._mandatoryNoticeDirectCount ||
      typeof session._mandatoryNoticeDirectCount !== 'object'
    ) {
      session._mandatoryNoticeDirectCount = {};
    }
    const prevCount = session._mandatoryNoticeDirectCount[notice.family] ?? 0;
    session._mandatoryNoticeDirectCount[notice.family] = prevCount + 1;
    if (prevCount >= variants.length) {
      const terminal = DIRECT_DENIAL_TERMINALS[notice.family];
      if (terminal) return terminal(notice.friendly, prevCount + 1);
    }
    return selectMandatoryNoticeText(session, notice.family, turnId, notice.friendly);
  }
  // B-STAGED regime — per-slot count, route-scoped pool, ordinal terminal
  // from attempt 3. The count was bumped at ACCEPTANCE (stage time), so the
  // drain only reads it — a drain:false-suppressed or reconciled-away
  // attempt still counts as an attempt (truthful ordinals: the inspector
  // DID attempt it), but never consumes pool rotation for other slots.
  const route =
    notice.route ?? (notice.family === 'model_contract' ? notice.slotKey : notice.family);
  const pool = B_STAGED_POOLS[route];
  if (!pool) return null;
  const repeatKey = notice.repeatKey ?? `${notice.family}::${notice.slotKey}`;
  const entry = session?.refusedOps?.[repeatKey];
  const count = entry?.count ?? 1;
  // Codex diff-review cycle 1 — anchor the 30 s expiry at the moment the
  // notice is actually RENDERED for speech, not at stage time: a refusal
  // staged before a blocking ask can drain tens of seconds later, and a
  // stage-time anchor would let the NEXT attempt reset to attempt 1 while
  // the just-spoken attempt-1 text is still inside the client's dedupe
  // window. Notices that never drain keep their stage-time stamp.
  if (entry) entry.lastAt = nowMs;
  if (count >= 3) {
    const terminal = B_STAGED_TERMINALS[route];
    if (terminal) return terminal(notice.friendly, count);
  }
  return pool[(count - 1) % pool.length](notice.friendly);
}

/**
 * Centralised rendered-string inventory for the two client-dedupe
 * distinctness sweeps (marker-② apology union + client-watchdog
 * ALL_BACKEND_LINES). Renders EVERY family/route variant AND every terminal
 * with a FIXED sample label + ordinal so the sweeps can assert full-string
 * mutual distinctness ACROSS families and routes (round-5: the client
 * dedupe is family-blind). Two entries here rendering identical bytes means
 * two different spoken outcomes could swallow each other inside 30 s.
 */
export function renderedNoticeInventory() {
  const SAMPLE_LABEL = 'earth loop impedance Ze';
  const SAMPLE_N = 7;
  const out = [];
  for (const [family, variants] of Object.entries(BOARD_CLEAR_NOTICE_FAMILIES)) {
    variants.forEach((v, i) =>
      out.push({ family, route: 'direct', kind: `variant_${i}`, text: v(SAMPLE_LABEL) })
    );
    out.push({
      family,
      route: 'direct',
      kind: 'terminal',
      text: DIRECT_DENIAL_TERMINALS[family](SAMPLE_LABEL, SAMPLE_N),
    });
  }
  for (const [route, pool] of Object.entries(B_STAGED_POOLS)) {
    pool.forEach((v, i) =>
      out.push({ family: route, route: 'b_staged', kind: `variant_${i}`, text: v(SAMPLE_LABEL) })
    );
    out.push({
      family: route,
      route: 'b_staged',
      kind: 'terminal',
      text: B_STAGED_TERMINALS[route](SAMPLE_LABEL, SAMPLE_N),
    });
  }
  // Plan 2A — the partial-failure families join the SAME sweeps. Rendered
  // twice, once per grammatical number: the singular and plural fills are
  // different spoken lines from the same template, and a template that
  // collapsed them (e.g. one that never used the number-dependent slots)
  // would let "circuit 7 not found" swallow "circuits 7 and 8 not found"
  // inside the 30 s window.
  for (const [family, variants] of Object.entries(PARTIAL_FAILURE_FAMILIES)) {
    for (const [numberKind, sample] of [
      ['singular', PARTIAL_FAILURE_SAMPLE_SINGULAR],
      ['plural', PARTIAL_FAILURE_SAMPLE_PLURAL],
    ]) {
      variants.forEach((v, i) =>
        out.push({
          family,
          route: 'partial_failure',
          kind: `variant_${i}_${numberKind}`,
          text: v({ ...sample, fieldLabel: SAMPLE_LABEL }),
        })
      );
      out.push({
        family,
        route: 'partial_failure',
        kind: `terminal_${numberKind}`,
        text: PARTIAL_FAILURE_TERMINALS[family](
          { ...sample, fieldLabel: SAMPLE_LABEL },
          SAMPLE_N
        ),
      });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Plan 2A (2026-07-30, feedback id 112) — PARTIAL-FAILURE notices
// ───────────────────────────────────────────────────────────────────────────
//
// THE DEFECT CLASS: a turn that ends with ≥1 sibling SUCCESS can still contain
// rejections and silent skips that reach the inspector as nothing at all. The
// A3 orphan net only fires when EVERY tool call errored (`allRejected`), and
// the capability-gate skips return `is_error:false` so they are not even
// rejections — so "Zs for circuits 5 to 10 is 0.4" on a board where 7 and 8
// don't exist read back four values and said NOTHING about the two that were
// dropped. Audio-First #1 in the zero-times direction: the hands-free
// inspector has no way to learn a reading never landed.
//
// THE ANSWER: every genuine rejection or silent skip inside a turn that ends
// with ≥1 sibling success speaks ONE aggregated notice naming what did NOT
// land — "Circuits 7 and 8 weren't found — no Zs recorded for them."
//
// PARTIAL-FAILURE SEPARATION (round-2 BLOCKER, implemented structurally):
// these notices are staged on their OWN per-turn array,
// `perTurnWrites.partialFailureNotices`, NOT on `mandatoryNotices`. §3.1 only
// requires that they be excluded from plan B's `coveredUnion` and
// `stampCoveredNoticesNonDraining`, which is satisfied by staging them
// WITHOUT `coveredToolCallIds` — but both of those helpers, and the net-0
// drain filter, iterate `mandatoryNotices` and key on shapes a future family
// could accidentally satisfy (the drain filter admits any entry with a string
// `family` and `drain !== false`). A separate array makes the exclusion a
// property of the DATA STRUCTURE rather than of a field being absent, which is
// what the requirement actually means. Entries still carry
// `noticeKind: 'partial_failure'` so a consumer that ever does see both
// arrays can tell them apart.
//
// WHY NOT ask-coverage suppression (churn circuit-breaker, §3.1 round 6): a
// same-turn model ask about circuit 7 alongside the notice "circuits 7 and 8
// weren't found" repeats circuit 7 in one extra sentence, but it can never
// HIDE circuit 8. Redundancy is fail-audible; the suppression machinery that
// would have removed it was fail-silent-by-bug. The double-mention is
// ACCEPTED, dated, by design (P2 precedent, 2026-07-24: "worst case an extra
// read-back, never silence").

/**
 * P5's clear-wire exemption, HAND-MIRRORED.
 *
 * `stage6-event-bundler.js` owns the authoritative `CLEAR_WIRE_EXEMPT` set:
 * `r2_ohm` must NOT be folded onto its `FIELD_CORRECTIONS` image (`r2`),
 * because iOS maps `r2` to the R1+R2 cell and `r2_ohm` to the distinct R2
 * end-to-end cell — collapsing them would make the two different measurements
 * one identity.
 *
 * Mirrored as a literal rather than imported: the bundler is a ~1700-line
 * module that imports the dispatchers' world, and this module's contract is to
 * be dependency-DOWNSTREAM-only (see the header). The codebase's established
 * answer to exactly this shape is a hand-mirrored literal plus a reciprocal
 * DRIFT TEST (`impedance-clamp.js`, `ios-dedupe-key.js`), and that is what
 * guards it here — `refusal-notices.test.js` asserts set equality against the
 * bundler's export, so adding a member there without adding it here fails.
 */
export const NOTICE_FIELD_IDENTITY_EXEMPT = Object.freeze(new Set(['r2_ohm']));

/**
 * The ONE canonical field identity used by the partial-failure machinery, on
 * BOTH sides of the drain's survivor test.
 *
 * WHY two tables (§3.1): the model may spell the same slot several ways within
 * one turn, and a notice staged under one spelling must SUBTRACT against a
 * later write under another, or the inspector hears "no Zs recorded for
 * circuit 4" about a circuit 4 Zs that is sitting in the certificate — a false
 * negative is worse than the silence this whole plan removes, because it
 * invites the inspector to re-dictate a value that is already correct.
 *   - `canonicaliseNumericReadingField` folds the DIALOGUE-slot aliases
 *     (`rcd_trip_time` → `rcd_time_ms`).
 *   - `FIELD_CORRECTIONS` folds the LEGACY WIRE names (`measured_zs_ohm` →
 *     `zs`, `max_zs`/`ocpd_max_zs` → `ocpd_max_zs_ohm`, …).
 * Applied in that order because the wire table is keyed on the post-dialogue
 * spellings.
 *
 * Non-string input passes through untouched — the caller's trust guards decide
 * whether such a target may be staged at all.
 */
export function canonicalPartialFailureFieldIdentity(field) {
  if (typeof field !== 'string' || field.length === 0) return field;
  const dialogueFolded = canonicaliseNumericReadingField(field);
  if (NOTICE_FIELD_IDENTITY_EXEMPT.has(dialogueFolded)) return dialogueFolded;
  return FIELD_CORRECTIONS[dialogueFolded] ?? dialogueFolded;
}

/**
 * Resolve the TRUSTED spoken label for a partial-failure target, RAW SPELLING
 * FIRST and the canonical identity only as a fallback.
 *
 * The ORDER is the safety property, and it is the opposite way round from the
 * subtraction identity above — hence this helper, so the order is stated once
 * with its reasoning instead of being re-derived at each call site.
 *
 * WHY raw first (Codex diff-review cycle 1): canonicalisation is NOT
 * label-preserving, and it loses labels far more often than it gains them.
 * `measured_zs_ohm` ("Measured Zs (ohm)") canonicalises to `zs`, which has NO
 * schema label at all — so canonicalising before the lookup would stage
 * NOTHING for the headline id-112 utterance and leave exactly the silence this
 * plan exists to remove. Same for `rcd_time_ms`, `r1_r2_ohm`,
 * `ir_live_live_mohm`.
 *
 * WHY a canonical fallback at all: a few aliases run the other way — bare
 * `max_zs` / `ocpd_max_zs` carry no label of their own but canonicalise to
 * `ocpd_max_zs_ohm` ("Max Zs (ohm)"), which does. Without the fallback a model
 * using the short spelling would go silent for a field the schema can name
 * perfectly well.
 *
 * Both branches read `field_schema.json` labels, so every rendered string stays
 * SERVER-OWNED — a model-supplied field name is never itself spoken, and a
 * field neither spelling can name stages nothing (the caller's trust guard).
 *
 * @param {object|undefined} circuitFields `FIELD_SCHEMA.circuit_fields` — passed
 *   in rather than imported so this module stays dependency-downstream-only.
 * @param {string} field raw, model-supplied field name
 * @returns {string|null} a non-blank trusted label, or null if neither spelling has one
 */
export function resolvePartialFailureFieldLabel(circuitFields, field) {
  if (typeof field !== 'string' || field.length === 0) return null;
  const raw = circuitFields?.[field]?.label;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  const canonical = canonicalPartialFailureFieldIdentity(field);
  if (canonical === field) return null;
  const folded = circuitFields?.[canonical]?.label;
  if (typeof folded === 'string' && folded.trim().length > 0) return folded;
  return null;
}

/**
 * Target descriptor slots every partial-failure variant renders from. Built by
 * `describePartialFailureTargets` so the number-dependent grammar is decided
 * ONCE and every variant stays renderable for singular, plural and
 * scope-level target sets.
 *
 * @typedef {object} PartialFailureTargetDescriptor
 * @property {string} subject      capitalised — "Circuit 7" / "Circuits 7 and 8" / "Those circuits"
 * @property {string} subjectLower "circuit 7" / "circuits 7 and 8" / "those circuits"
 * @property {string} wasWere      "wasn't" / "weren't"
 * @property {string} isAre        "isn't" / "aren't"
 * @property {string} pronoun      "it" / "them"
 * @property {string} fieldLabel   server-owned spoken field label (never model-controlled)
 */

/** Inventory samples — see renderedNoticeInventory. */
const PARTIAL_FAILURE_SAMPLE_SINGULAR = Object.freeze({
  subject: 'Circuit 7',
  subjectLower: 'circuit 7',
  wasWere: "wasn't",
  isAre: "isn't",
  pronoun: 'it',
});
const PARTIAL_FAILURE_SAMPLE_PLURAL = Object.freeze({
  subject: 'Circuits 7 and 8',
  subjectLower: 'circuits 7 and 8',
  wasWere: "weren't",
  isAre: "aren't",
  pronoun: 'them',
});

/**
 * Wording pools, ONE family per (field-independent) REASON. Variant 0 of each
 * family is the §3.1 "gap-only primary" form — it names ONLY what did not land
 * and never re-states what did, because the successful siblings have already
 * been read back individually and repeating them would bury the gap.
 *
 * ≥3 byte-distinct variants per family, all enrolled in
 * `renderedNoticeInventory` so the existing client-dedupe distinctness sweeps
 * enforce mutual distinctness against every plan A1a/B line too.
 *
 * SCOPE-LEVEL targets ("Those circuits") are reachable ONLY through
 * `lim_capability_gated` — the bulk `set_field_for_all_circuits` LIM gate is
 * the one producer that rejects before its target refs exist (see
 * stage6-dispatchers-circuit.js). `circuit_not_found` variant 2 asserts
 * something about the board that would be a LIE for a scope target, so
 * `stagePartialFailureNotice` REJECTS a scope target on any other family
 * rather than trusting call sites to remember.
 */
export const PARTIAL_FAILURE_FAMILIES = Object.freeze({
  // Channel 1 (record_reading circuit_not_found) + the set_field_for_all
  // `!bucket` miss. Same user-visible truth from both producers — the circuit
  // the inspector named is not on the board being written to.
  circuit_not_found: Object.freeze([
    (t) => `${t.subject} ${t.wasWere} found — no ${t.fieldLabel} recorded for ${t.pronoun}.`,
    (t) => `I couldn't find ${t.subjectLower}, so no ${t.fieldLabel} went in for ${t.pronoun}.`,
    (t) => `${t.subject} ${t.isAre} not on this board — ${t.fieldLabel} wasn't recorded.`,
  ]),
  // Channel 6a/6c — LIM accepted by the server but the client can't store it.
  lim_capability_gated: Object.freeze([
    (t) =>
      `${t.subject} ${t.wasWere} recorded — this app version can't store LIM for ${t.fieldLabel}.`,
    (t) =>
      `This app version can't take LIM for ${t.fieldLabel}, so nothing went in for ${t.subjectLower}.`,
    (t) => `LIM for ${t.fieldLabel} needs a newer app version — ${t.subjectLower} ${t.wasWere} saved.`,
  ]),
  // Channel 6b — the pre-apply low-confidence gate. Worded as MY uncertainty,
  // never as the inspector mis-speaking, and every variant invites a repeat
  // (unlike the capability families, saying it again is the actual fix).
  low_conf_capability_gated: Object.freeze([
    (t) =>
      `I wasn't confident enough in that one — no ${t.fieldLabel} recorded for ${t.subjectLower}. Say it again?`,
    (t) =>
      `${t.subject} ${t.wasWere} recorded — I wasn't sure enough of the ${t.fieldLabel} value. Try that one again.`,
    (t) => `No ${t.fieldLabel} went in for ${t.subjectLower} — I only half caught it. Repeat that one?`,
  ]),
  // Channel 3 — a per-circuit ok:false inside an ask fan-out's resolved_writes.
  write_failed: Object.freeze([
    (t) => `${t.fieldLabel} didn't save for ${t.subjectLower} — worth saying that one again.`,
    (t) => `Couldn't record ${t.fieldLabel} for ${t.subjectLower}.`,
    (t) => `${t.subject} ${t.wasWere} updated — ${t.fieldLabel} didn't go in for ${t.pronoun}.`,
  ]),
});

/** The one family a scope-level (ref-less) target may render under. */
export const PARTIAL_FAILURE_SCOPE_FAMILIES = Object.freeze(new Set(['lim_capability_gated']));

/**
 * Speak a ref list the way a person would: "7", "7 and 8", "7, 8 and 11".
 * Ordinal-keyed targets (unmatched designation spans, scope records) never
 * reach here — they have no ref to speak.
 */
function speakRefList(refs) {
  if (refs.length === 1) return String(refs[0]);
  const head = refs.slice(0, -1).join(', ');
  return `${head} and ${refs[refs.length - 1]}`;
}

/**
 * Build the grammar descriptor for one aggregate's target list.
 *
 * Returns null when NOTHING can be named trustworthily — a scope record with
 * no refs is fine (it says "those circuits"), but an aggregate whose only
 * targets are ref-less and non-scope has nothing honest to say and must not
 * speak (fail-silent HERE is correct: the marker-② catch-all still owns the
 * turn, so the chime is not broken).
 *
 * @param {{kind: 'circuit'|'scope', ref?: number}[]} targets
 * @param {string} fieldLabel server-owned spoken label
 * @returns {PartialFailureTargetDescriptor|null}
 */
export function describePartialFailureTargets(targets, fieldLabel) {
  if (!Array.isArray(targets) || targets.length === 0) return null;
  if (typeof fieldLabel !== 'string' || fieldLabel.trim().length === 0) return null;

  const refs = [];
  let scope = false;
  for (const t of targets) {
    if (t?.kind === 'scope') scope = true;
    else if (Number.isInteger(t?.ref)) refs.push(t.ref);
  }

  if (refs.length > 0) {
    // Deterministic, ascending — the same set of misses must speak the same
    // bytes whatever order the dispatcher happened to reject them in, or the
    // client's text dedupe stops recognising a genuine repeat.
    const unique = [...new Set(refs)].sort((a, b) => a - b);
    const plural = unique.length > 1;
    const list = speakRefList(unique);
    return {
      subject: `${plural ? 'Circuits' : 'Circuit'} ${list}`,
      subjectLower: `${plural ? 'circuits' : 'circuit'} ${list}`,
      wasWere: plural ? "weren't" : "wasn't",
      isAre: plural ? "aren't" : "isn't",
      pronoun: plural ? 'them' : 'it',
      fieldLabel,
    };
  }

  if (scope) {
    return {
      subject: 'Those circuits',
      subjectLower: 'those circuits',
      wasWere: "weren't",
      isAre: "aren't",
      pronoun: 'them',
      fieldLabel,
    };
  }
  return null;
}

/**
 * Ordinal-bearing TERMINALS, one per partial-failure family, rendered from
 * the 4th repeat of the SAME spoken identity inside the 30 s client-dedupe
 * window (Codex diff-review cycle 2).
 *
 * Why they exist: three variants rotating mod 3 means the 4th repeat of one
 * identity wraps to variant 0 — byte-identical to the 1st. Notices ride the
 * field-nil channel, whose client dedupe is TEXT-KEYED with a 30 s TTL, so
 * that 4th notice is swallowed and a chimed turn goes SILENT (Audio-First #1).
 * marker-② cannot rescue it either: the queued prompt counts as speech intent,
 * so the catch-all is already suppressed by the time the client drops it. This
 * is the same latent wrap-to-identical-string hole plan B closed for the
 * DIRECT regime (terminal from attempt 6) and the B-STAGED regime (from
 * attempt 3); the plan is silent on it, so the sibling regimes decided the
 * shape.
 *
 * Contract, mirroring `B_STAGED_TERMINALS`: ordinal-bearing (so consecutive
 * repeats past the wrap are byte-distinct from each other), label-bearing
 * (so two different slots at the same ordinal don't collide — the dedupe is
 * key-blind), every family DISTINCT from every other family's terminal AND
 * from all twelve variants, and every line still TRUTHFUL — it says the value
 * still isn't recorded, which remains exactly the case.
 */
export const PARTIAL_FAILURE_TERMINALS = Object.freeze({
  circuit_not_found: (t, n) =>
    `Still nothing on this board for ${t.subjectLower} — that's attempt ${n}, and ${t.fieldLabel} remains unrecorded.`,
  lim_capability_gated: (t, n) =>
    `LIM for ${t.fieldLabel} still needs a newer app version — attempt ${n} for ${t.subjectLower}, and it's logged.`,
  low_conf_capability_gated: (t, n) =>
    `I still haven't got the ${t.fieldLabel} for ${t.subjectLower} — attempt ${n}; try saying just the number on its own.`,
  write_failed: (t, n) =>
    `${capitaliseFirst(t.fieldLabel)} still hasn't saved for ${t.subjectLower} — attempt ${n} is logged.`,
});

/**
 * Bump the per-IDENTITY partial-failure repeat counter.
 *
 * Same 30 s reset semantics as plan B's `bumpRefusedOp` (outside the client
 * dedupe window a byte-repeat is no longer swallowed, so a fresh "attempt 1"
 * is honest), but an OWN session namespace: `session.refusedOps` keys are
 * B-staged slot keys whose counts drive that regime's pool rotation and
 * ordinals, and folding a second regime's keys in could perturb them.
 */
function bumpPartialFailureRepeat(session, repeatKey, nowMs) {
  if (!session.partialFailureRepeats || typeof session.partialFailureRepeats !== 'object') {
    session.partialFailureRepeats = {};
  }
  const entry = session.partialFailureRepeats[repeatKey];
  if (!entry || nowMs - entry.lastAt > REFUSAL_REPEAT_WINDOW_MS) {
    session.partialFailureRepeats[repeatKey] = { count: 1, lastAt: nowMs };
    return 1;
  }
  entry.count += 1;
  entry.lastAt = nowMs;
  return entry.count;
}

/** Repeats past this many inside the dedupe window render the terminal. */
const PARTIAL_FAILURE_TERMINAL_FROM = 4;

/**
 * Variant selection: PRIMARY-FIRST, then strictly monotonic, then TERMINAL.
 *
 * Deliberately NOT the A1a djb2-seeded scheme. §3.1 names variant 0 the
 * "gap-only primary wording" and the acceptance criterion pins the exact
 * bytes of the id-112 render, so the first selection must be index 0; a
 * turn-hashed seed would pick an arbitrary one.
 *
 * Distinctness is defended on THREE axes, because the client dedupe is
 * text-keyed and key-blind:
 *   1. The rotation cursor is per-FAMILY, not per-identity, which is what
 *      keeps two identities differing ONLY by board (same reason, same
 *      canonical field, same refs — the board never appears in the spoken
 *      text) from both starting at variant 0 and rendering identical bytes.
 *      Do not "simplify" this to a per-identity cursor: that reopens exactly
 *      that collision, and a swallowed second board is an unspoken miss.
 *   2. A per-identity `lastIdx` breaks the residual same-identity tie a
 *      SHARED cursor can still produce (X, Y, X interleaved can hand X the
 *      same index twice). One extra advance is provably enough to break it:
 *      `lastIdx` is a single value, so index+1 cannot also equal it.
 *   3. Past `PARTIAL_FAILURE_TERMINAL_FROM` repeats of one identity inside
 *      the 30 s window, the ordinal-bearing terminal takes over and every
 *      further repeat is byte-distinct by its ordinal.
 *
 * Own session key (`_partialFailureRotation`) so A1a's cursor
 * (`_mandatoryNoticeRotation`) and its byte-parity pins stay untouched.
 *
 * @param {object} session
 * @param {string} family
 * @param {PartialFailureTargetDescriptor} target
 * @param {{repeatKey?: string|null, nowMs?: number}} [opts] repeat identity for
 *   the terminal escalation. Omitted (or key-less) ⇒ rotation only, exactly the
 *   pre-terminal behaviour — unit tests that only exercise rotation stay valid.
 */
export function selectPartialFailureNoticeText(session, family, target, opts = {}) {
  const variants = PARTIAL_FAILURE_FAMILIES[family];
  if (!variants || !target) return null;
  if (!session._partialFailureRotation || typeof session._partialFailureRotation !== 'object') {
    session._partialFailureRotation = {};
  }
  const state = session._partialFailureRotation;
  const { repeatKey = null, nowMs = null } = opts ?? {};

  let repeats = 0;
  if (typeof repeatKey === 'string' && repeatKey.length > 0 && Number.isFinite(nowMs)) {
    repeats = bumpPartialFailureRepeat(session, repeatKey, nowMs);
    if (repeats >= PARTIAL_FAILURE_TERMINAL_FROM) {
      const terminal = PARTIAL_FAILURE_TERMINALS[family];
      // The terminal replaces the variant and deliberately does NOT advance
      // the family cursor — it consumed no variant, so the next fresh
      // identity should still get the one it would have had.
      if (terminal) return terminal(target, repeats);
    }
  }

  const prev = state[family];
  let idx = typeof prev === 'number' ? (prev + 1) % variants.length : 0;
  if (typeof repeatKey === 'string' && repeatKey.length > 0) {
    // Own session key, NOT a sub-object of the rotation state: that state is
    // pinned by shape (`{family: index}`) and must stay a pure cursor map.
    if (!session._partialFailureLastIdx || typeof session._partialFailureLastIdx !== 'object') {
      session._partialFailureLastIdx = {};
    }
    const lastByIdentity = session._partialFailureLastIdx;
    if (lastByIdentity[repeatKey] === idx) idx = (idx + 1) % variants.length;
    lastByIdentity[repeatKey] = idx;
  }
  state[family] = idx;
  return variants[idx](target);
}

/**
 * Stage one partial-failure TARGET at dispatch time.
 *
 * Aggregation is by `(field, reason, boardId)` per §3.1 — one notice per
 * (what was being written, why it failed, on which board) — with each
 * aggregate retaining its per-target list so the spoken line can name the
 * refs. Two boards' same-numbered misses therefore never merge into one
 * sentence claiming both.
 *
 * `field` may be the RAW spelling the model used — it is canonicalised HERE
 * (see canonicalPartialFailureFieldIdentity) rather than at each producer, so
 * an alias-spelled retry of the same slot subtracts at the drain instead of
 * producing a false "not recorded", and no call site can forget to fold.
 * `fieldLabel` is the server-owned spoken label; a call site that cannot
 * produce a TRUSTED label must not call this at all (leak safety — the
 * `unsupported_clear` precedent, stage6-dispatchers-circuit.js:579-628).
 *
 * Best-effort by contract: it never throws into a dispatcher's return path,
 * and it no-ops when the accumulator is absent (mirrors
 * `stageMandatoryNotice` — the harness owns the array's existence).
 *
 * @param {object} perTurnWrites
 * @param {{reason: string, field: string, fieldLabel: string, boardId: string|null,
 *          target: {kind: 'circuit'|'scope', ref?: number}, producer: string}} spec
 */
export function stagePartialFailureNotice(perTurnWrites, spec) {
  if (!perTurnWrites || typeof perTurnWrites !== 'object') return;
  if (!Array.isArray(perTurnWrites.partialFailureNotices)) return;

  const { reason, field, fieldLabel, boardId = null, target, producer } = spec ?? {};
  if (typeof reason !== 'string' || !PARTIAL_FAILURE_FAMILIES[reason]) return;
  if (typeof field !== 'string' || field.length === 0) return;
  if (typeof fieldLabel !== 'string' || fieldLabel.trim().length === 0) return;
  if (!target || (target.kind !== 'circuit' && target.kind !== 'scope')) return;
  if (target.kind === 'circuit' && !Number.isInteger(target.ref)) return;
  // A scope target renders "those circuits", which only tells the truth for a
  // whole-instruction refusal. Guarded here rather than at the call sites so a
  // future producer cannot silently mint a lying sentence.
  if (target.kind === 'scope' && !PARTIAL_FAILURE_SCOPE_FAMILIES.has(reason)) return;

  const canonicalField = canonicalPartialFailureFieldIdentity(field);
  const key = `${reason}::${canonicalField}::${boardId ?? ''}`;
  let aggregate = perTurnWrites.partialFailureNotices.find((n) => n.key === key);
  if (!aggregate) {
    aggregate = {
      noticeKind: 'partial_failure',
      key,
      reason,
      field: canonicalField,
      fieldLabel,
      boardId,
      producer,
      targets: [],
    };
    perTurnWrites.partialFailureNotices.push(aggregate);
  }
  const dup = aggregate.targets.some(
    (t) => t.kind === target.kind && (t.kind === 'scope' || t.ref === target.ref)
  );
  if (!dup) aggregate.targets.push({ ...target });
}

/**
 * Render ONE partial-failure aggregate at drain time, from the target list
 * that SURVIVED the drain's subtraction (never the staged list — a target that
 * later acquired a write must not be named).
 *
 * Selection happens here, at the drain, for the A1a reason: staging order is a
 * dispatcher-ordering artefact, and a notice that is dropped entirely must not
 * have consumed a rotation slot (which would make the NEXT turn's notice skip a
 * variant for no audible reason).
 *
 * The repeat counter behind the terminal escalation is bumped here too — and
 * deliberately NOT at stage time the way plan B's B-staged counter is. The two
 * counters answer different questions: B's ordinal must be TRUTHFUL about how
 * many times the inspector ATTEMPTED the operation (so a suppressed attempt
 * still counts), whereas this one exists solely to keep consecutive SPOKEN
 * bytes distinct inside the clients' text dedupe window — so only a notice
 * that actually reaches the FIFO may advance it.
 *
 * Returns null when nothing nameable survives — the caller then speaks nothing
 * for this aggregate, and marker-② still owns the turn's audibility floor.
 *
 * @param {object} session
 * @param {object} aggregate the staged aggregate
 * @param {{kind: 'circuit'|'scope', ref?: number}[]} survivingTargets
 * @param {{nowMs?: number}} [opts] wall clock for the 30 s repeat window.
 *   Defaults to `Date.now()`, mirroring `renderMandatoryNoticeText` — the clock
 *   read lives in this module so the harness call site needs no clock argument;
 *   tests inject a fake one.
 * @returns {string|null}
 */
export function renderPartialFailureNoticeText(session, aggregate, survivingTargets, opts = {}) {
  if (!session || !aggregate) return null;
  if (!PARTIAL_FAILURE_FAMILIES[aggregate.reason]) return null;
  const descriptor = describePartialFailureTargets(survivingTargets, aggregate.fieldLabel);
  if (!descriptor) return null;
  // Belt-and-braces on the scope rule: the staging guard already rejects a
  // scope target on a non-scope family, but the drain hands us a FILTERED list
  // and a future filter bug must not be able to mint a lying sentence.
  const scopeOnly = survivingTargets.every((t) => t?.kind === 'scope');
  if (scopeOnly && !PARTIAL_FAILURE_SCOPE_FAMILIES.has(aggregate.reason)) return null;
  return selectPartialFailureNoticeText(session, aggregate.reason, descriptor, {
    repeatKey: partialFailureTextIdentity(aggregate, survivingTargets),
    nowMs: Number.isFinite(opts?.nowMs) ? opts.nowMs : Date.now(),
  });
}

/**
 * The repeat identity for a partial-failure notice: EXACTLY the inputs that
 * determine the rendered bytes — family, the spoken field LABEL, and the spoken
 * target set. Nothing else.
 *
 * Deliberately NOT `aggregate.key`, which carries the board id: the board never
 * appears in the spoken sentence, so two boards' notices for the same field and
 * the same refs render identical text and MUST share one repeat counter — a
 * board-keyed counter would let each reach "attempt 4" independently and emit
 * byte-identical terminals, reopening the very swallow this escalation closes.
 * Conversely the LABEL rather than the canonical field, because the label is
 * what is spoken (two raw fields folding to one canonical field can carry
 * different labels, and those two sentences are genuinely distinct).
 */
function partialFailureTextIdentity(aggregate, survivingTargets) {
  const refs = (Array.isArray(survivingTargets) ? survivingTargets : [])
    .filter((t) => t?.kind === 'circuit' && Number.isInteger(t.ref))
    .map((t) => t.ref)
    .sort((a, b) => a - b)
    .join(',');
  const hasScope = (Array.isArray(survivingTargets) ? survivingTargets : []).some(
    (t) => t?.kind === 'scope'
  );
  return `${aggregate.reason}::${aggregate.fieldLabel ?? ''}::${refs}${hasScope ? '|scope' : ''}`;
}
