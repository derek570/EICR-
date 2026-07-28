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
 * suites keep their import paths.
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
 */

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
  return out;
}
