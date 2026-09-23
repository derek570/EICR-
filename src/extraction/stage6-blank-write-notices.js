/**
 * PLAN-C3 (feedback-2026-09-17, Decision 5) — audibility for a rejected
 * mutation, and the per-turn REJECTION JOURNAL that gives a later ask or
 * answer a deterministic way to refer back to it.
 *
 * WHY THIS IS A SHARED MODULE AND NOT INLINE AT EACH SITE. Six boundaries
 * reject a blank write (circuit reading, board reading, bulk write, create,
 * rename, dialogue seed) and three more reject an off-enum value. They live
 * in four dispatcher files. The SLOT IDENTITY, the spoken composition and the
 * journal record have to agree across all of them — two slot derivations is
 * how a refusal and its superseding read-back stop reconciling, and the
 * inspector hears both. One module, one derivation.
 *
 * WHAT IS NOT HERE. No new spoken channel: every notice is staged on the
 * EXISTING `stageMandatoryNotice` / net-0 drain, which already owns
 * call-level coverage, same-slot reconciliation, per-slot attempt ordinals,
 * the 30 s render-time dedupe anchor and the rendered-inventory distinctness
 * sweep. This module composes the label and picks the family; the channel
 * does the rest.
 *
 * LEAK SAFETY. Every rendered component is server-owned: the field_schema
 * label, the circuit ref, the board ORDINAL, the resolved scope descriptor,
 * and the value the slot STILL HOLDS (snapshot state the inspector has
 * already heard read back). The model's rejected string is NEVER rendered and
 * NEVER journaled. These families are registered in
 * `VALUE_BEARING_NOTICE_FAMILIES`, so the drain's telemetry row omits its
 * text preview for them.
 */

import { createRequire } from 'node:module';
import { stageMandatoryNotice, spokenBoardOrdinal } from './refusal-notices.js';
import { rawCircuitSlot, boardSlotKey } from './stage6-per-turn-writes.js';
import { getCircuitBucket, resolveEffectiveBoardId } from './stage6-multi-board-shape.js';
import { CONFIRMATION_FRIENDLY_NAMES, deriveFriendlyName } from './confirmation-text.js';

const fieldSchemaRequire = createRequire(import.meta.url);
const FIELD_SCHEMA = fieldSchemaRequire('../../config/field_schema.json');

/**
 * The sentinel a model puts on `answer_user.rejection_ref` to declare "this
 * answer is about something else". It is the ONLY way a model line is heard
 * beside a staged refusal.
 */
export const UNRELATED_REJECTION_REF = 'unrelated';

/**
 * Server-minted reference for one rejected tool call: `<turnId>:<toolCallId>`.
 * Both halves are server-owned and already unique within a turn, and the pair
 * is readable in a CloudWatch row. The model may echo it on a later
 * `ask_user` / `answer_user` so the server can tie the two together WITHOUT
 * inferring lineage from `context_circuits`, which a plural ask and a bulk
 * ask can share.
 */
export function mintRejectionRef(turnId, toolCallId) {
  if (toolCallId == null) return null;
  return `${String(turnId ?? '')}:${String(toolCallId)}`;
}

/**
 * Append one entry to the per-turn rejection journal — the ONE place a later
 * ask or answer looks up what a `rejection_ref` meant.
 *
 * `scopeSet` is the dispatcher's RESOLVED circuit list: for a bulk call the
 * FINAL eligible candidates after selector, spare policy, exclusions and
 * board resolution, computed BEFORE any validation runs. Resolving it late
 * (at the apply loop) is how an off-enum producer ends up with no scope at
 * all and has to describe the request in the model's own words.
 *
 * `bulkInput` is the IMMUTABLE raw bulk request, so a later answer-resolution
 * site can rebuild a byte-equal bulk write rather than reconstructing one
 * from the descriptor it spoke.
 */
export function recordRejection(
  perTurnWrites,
  { ref, field, scopeSet = null, boardId = null, toolCallId = null, bulkInput = null, scope = null }
) {
  if (!perTurnWrites || ref == null) return null;
  if (!Array.isArray(perTurnWrites.rejections)) perTurnWrites.rejections = [];
  const entry = Object.freeze({
    ref,
    field: field ?? null,
    scopeSet: Array.isArray(scopeSet) ? Object.freeze([...scopeSet]) : null,
    boardId: boardId ?? null,
    toolCallId,
    bulkInput: bulkInput ? Object.freeze({ ...bulkInput }) : null,
    // PLAN-C3 — the RESOLVED descriptor components, stored so a post-ask
    // refusal renders the SAME scope sentence the first refusal did. Deriving
    // them a second time from `bulkInput` would re-run the resolution against
    // a snapshot the turn may since have changed, and the two lines about one
    // scope would stop agreeing.
    scope: scope ? Object.freeze({ ...scope }) : null,
  });
  perTurnWrites.rejections.push(entry);
  return entry;
}

/** Look one up by ref. Null for the sentinel, an unknown ref, or a malformed one. */
export function findRejection(perTurnWrites, ref) {
  if (typeof ref !== 'string' || ref.length === 0) return null;
  if (ref === UNRELATED_REJECTION_REF) return null;
  const journal = perTurnWrites?.rejections;
  if (!Array.isArray(journal)) return null;
  return journal.find((r) => r && r.ref === ref) ?? null;
}

// ---- spoken composition ----------------------------------------------------

/** Server-owned spoken label for a circuit field, or null when the schema has none. */
export function circuitFieldLabel(field) {
  const label = FIELD_SCHEMA.circuit_fields?.[field]?.label;
  return typeof label === 'string' && label.trim().length > 0 ? label : null;
}

/**
 * Server-owned spoken label for a board / supply / installation field. This
 * is deliberately `boardFieldSpokenName`'s derivation, not the field_schema
 * label: `stageBoardReadingDispositionRefusal` already speaks board fields
 * this way, and a second spelling for the same field would render two
 * different lines about one slot.
 */
export function boardFieldLabel(field) {
  if (typeof field !== 'string' || field.length === 0) return null;
  return CONFIRMATION_FRIENDLY_NAMES[field] ?? deriveFriendlyName(field);
}

/** "1, 2 and 3" — a spoken list, never a bare comma run. */
export function spokenRefList(refs) {
  const list = refs.map((r) => String(r));
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

/**
 * Sorted refs as spoken runs: [1,2,3,4,5,6,7,9,11,12,13,14] -> "1 to 7, 9 and
 * 11 to 14". A run needs three or more members; two adjacent refs stay a
 * plain pair so "1 to 2" is never spoken. Injective over the input set.
 */
export function spokenRefRuns(sortedRefs) {
  const parts = [];
  let i = 0;
  while (i < sortedRefs.length) {
    let j = i;
    while (j + 1 < sortedRefs.length && sortedRefs[j + 1] === sortedRefs[j] + 1) j += 1;
    if (j - i >= 2) {
      parts.push(`${sortedRefs[i]} to ${sortedRefs[j]}`);
    } else {
      for (let k = i; k <= j; k += 1) parts.push(String(sortedRefs[k]));
    }
    i = j + 1;
  }
  return spokenRefList(parts);
}

/**
 * The board clause every board-sensitive line ends with, exactly as
 * `stageStructuralReadingRefusal` renders it: `" on board <ordinal>"`, empty
 * when the session has one board. Without it the same field failing on two
 * boards inside the clients' 30 s text dedupe renders identical bytes and the
 * second is swallowed — the inspector hears about one board and assumes both.
 */
export function boardClause(snapshot, boardId) {
  const ordinal = spokenBoardOrdinal(snapshot, boardId);
  return ordinal == null ? '' : ` on board ${ordinal}`;
}

/**
 * Is the board component RENDERABLE? Mirrors the existing trusted-
 * discriminator contract: when a session HAS a boards[] array but the board
 * id does not resolve to an ordinal, stage NOTHING rather than speak a
 * sentence whose board component had to be guessed. Staging nothing is safe —
 * marker-2's catch-all still speaks — and it is the same choice
 * `stageCircuitPartialFailure` and the `unsupported_clear` branch make.
 */
export function boardRenderable(snapshot, boardId) {
  return (
    boardId == null ||
    !Array.isArray(snapshot?.boards) ||
    spokenBoardOrdinal(snapshot, boardId) != null
  );
}

/**
 * The "what does the slot still hold" tail. The inspector's real question
 * after a refusal is not "why" but "what is in the certificate now".
 *
 *   held value -> ", still 100"
 *   nothing    -> ", still blank"
 *
 * `held` comes from the snapshot AFTER the rejection (nothing was written, so
 * it is the pre-call value), never from the model's input.
 */
export function heldValueTail(held) {
  const text = held == null ? '' : String(held).trim();
  return text.length === 0 ? ', still blank' : `, still ${text}`;
}

/**
 * Compose the bulk SCOPE DESCRIPTOR from the RESOLVED scope, never from the
 * request words.
 *
 * INJECTIVE over `(selector, sparePolicy, excludes, boardId, resolvedRefs)`,
 * which is exactly `bulkScopeKey`'s membership — so two calls that render the
 * same string are the same slot, and two calls that are different slots
 * always render different strings. That equivalence is load-bearing: the
 * channel's per-slot attempt ordinal and the clients' byte-based 30 s dedupe
 * are two different identities, and a descriptor that collapsed two slots
 * would make the second refusal inaudible.
 *
 * Fixed composition order:
 *   1. selector name — "all circuits" / "the RCD-protected circuits"
 *   2. spare qualifier — "including spares" / "excluding spares"
 *   3. exclusions — "except 4 and 9", ALWAYS after the part they narrow, so
 *      `{rcd_protected_only, exclude:[4]}` is "the RCD-protected circuits …
 *      except 4" and never "all circuits except 4"
 *   4. the explicit ref list, APPENDED (never substituted) when six or fewer
 *      targets resolved — substituting it would make two selectors that
 *      resolve to the same five refs render identical bytes
 *   5. the board clause
 *
 * The spare qualifier is rendered UNCONDITIONALLY rather than only when it
 * differs from a default. Selector `all` is reached from three different raw
 * scopes (`all`, legacy `non_spare`, omitted) whose defaults disagree, and
 * the RESOLVED policy — not the raw scope — is what `bulkScopeKey` carries; a
 * qualifier that appeared only "when it is not the default" would have to
 * consult something outside the key and could render two strings for one
 * slot. Always rendering it keeps the descriptor a pure function of the key,
 * and it states what actually happened.
 */
export function describeBulkScope({
  selector,
  sparePolicy,
  excludes = [],
  resolvedRefs = [],
  snapshot = null,
  boardId = null,
}) {
  const selectorName =
    selector === 'rcd_protected_only' ? 'the RCD-protected circuits' : 'all circuits';
  const spareClause = sparePolicy === 'exclude' ? ' excluding spares' : ' including spares';
  const sortedExcludes = [...new Set(excludes)].sort((a, b) => a - b);
  const exceptClause = sortedExcludes.length > 0 ? ` except ${spokenRefList(sortedExcludes)}` : '';
  const sortedRefs = [...resolvedRefs].sort((a, b) => a - b);
  // Six or fewer: the explicit list, APPENDED to the qualifier. More than six:
  // the same set as compressed runs ("1 to 7, 9 and 11 to 14"). The runs are
  // still EXACT — two different resolved sets always render different bytes —
  // which the list has to be, because the refs are part of the slot key: a
  // descriptor that dropped them above six made "circuits 1-7" and "circuits
  // 1-8" render identically, and the client's 30 s byte dedupe swallowed the
  // second refusal.
  const listClause =
    sortedRefs.length === 0
      ? ''
      : sortedRefs.length <= 6
        ? ` — ${spokenRefList(sortedRefs)} —`
        : ` — ${spokenRefRuns(sortedRefs)} —`;
  return `${selectorName}${spareClause}${exceptClause}${listClause}${boardClause(snapshot, boardId)}`;
}

/**
 * The bulk slot identity: the descriptor's own membership plus the board, as
 * a NUL-free joined string so it can key the channel's `(family, slotKey)`
 * dedupe and its `${family}::${slotKey}` repeat bucket.
 */
export function bulkScopeKey({
  selector,
  sparePolicy,
  excludes = [],
  boardId = null,
  resolvedRefs = [],
}) {
  const ex = [...new Set(excludes)].sort((a, b) => a - b).join(',');
  const refs = [...resolvedRefs].sort((a, b) => a - b).join(',');
  const board = boardId == null || boardId === '' ? '' : String(boardId);
  return `${selector}|${sparePolicy}|${ex}|${board}|${refs}`;
}

/** `('bulk', field, board, scopeKey)` as one string. */
export function bulkSlotKey(field, boardId, scopeKey) {
  const board = boardId == null || boardId === '' ? '' : String(boardId);
  return `bulk ${String(field)} ${board} ${scopeKey}`;
}

/**
 * `(op, target_ref, resolvedBoardId)` for a create/rename refusal.
 * `targetRef` is the created circuit's number, or for a rename the SOURCE
 * ref — a rename's target ref is spoken in `friendly` but must never be the
 * key, or a 2-to-3 rename and a later 3-to-4 rename would share a slot.
 */
export function circuitOpSlotKey(op, targetRef, boardId) {
  const board = boardId == null || boardId === '' ? '' : String(boardId);
  return `op ${String(op)} ${String(targetRef)} ${board}`;
}

// ---- staging ---------------------------------------------------------------

/**
 * The one staging call every producer in this plan goes through. Keeps the
 * `family` / `route` / `repeatKey` triple consistent: `family` is what the
 * cancelled-path allowlist and the drain filter test, `route` is what selects
 * the wording pool, and they are NOT always the same string (a create's
 * designation and phase flavours are two routes of one family).
 */
export function stageRejectionNotice(
  perTurnWrites,
  session,
  { family, route, slotKey, turnId, friendly, field, boardId, toolCallId }
) {
  if (toolCallId == null || typeof friendly !== 'string' || friendly.trim().length === 0) {
    return false;
  }
  stageMandatoryNotice(perTurnWrites, session, {
    family,
    slotKey,
    turnId,
    friendly,
    field,
    boardId: boardId ?? null,
    reason: route,
    coveredToolCallIds: [toolCallId],
    route,
    repeatKey: `${route}::${slotKey}`,
  });
  return true;
}

/** `record_reading` blank -> `empty_write_blocked` on the circuit slot. */
export function stageBlankCircuitWriteNotice(
  perTurnWrites,
  session,
  { field, circuit, boardId, turnId, toolCallId, heldValue }
) {
  const label = circuitFieldLabel(field);
  const snapshot = session?.stateSnapshot;
  if (label == null || !Number.isInteger(circuit) || !boardRenderable(snapshot, boardId)) {
    return false;
  }
  const friendly = `${label} on circuit ${circuit}${boardClause(snapshot, boardId)}${heldValueTail(heldValue)}`;
  return stageRejectionNotice(perTurnWrites, session, {
    family: 'empty_write_blocked',
    route: 'empty_write_blocked',
    slotKey: rawCircuitSlot(field, circuit, boardId),
    turnId,
    friendly,
    field,
    boardId,
    toolCallId,
  });
}

/** `record_board_reading` blank -> `empty_write_blocked` on the BOARD slot. */
export function stageBlankBoardWriteNotice(
  perTurnWrites,
  session,
  { field, boardId, turnId, toolCallId, heldValue }
) {
  const label = boardFieldLabel(field);
  const snapshot = session?.stateSnapshot;
  if (label == null || !boardRenderable(snapshot, boardId)) return false;
  const friendly = `${label}${boardClause(snapshot, boardId)}${heldValueTail(heldValue)}`;
  return stageRejectionNotice(perTurnWrites, session, {
    family: 'empty_write_blocked',
    route: 'empty_write_blocked',
    slotKey: boardSlotKey(field, boardId),
    turnId,
    friendly,
    field,
    boardId,
    toolCallId,
  });
}

/**
 * A bulk rejection — blank, or an off-enum/shape value. ONE notice per call,
 * never partially retired: a bulk request is one statement about a scope, and
 * a later single-circuit write does not make it true.
 */
export function stageBulkRejectionNotice(
  perTurnWrites,
  session,
  { family, route, field, boardId, turnId, toolCallId, scope, extraTail = '' }
) {
  const label = circuitFieldLabel(field);
  const snapshot = session?.stateSnapshot;
  if (label == null || !boardRenderable(snapshot, boardId)) return false;
  const descriptor = describeBulkScope({ ...scope, snapshot, boardId });
  const scopeKey = bulkScopeKey({ ...scope, boardId });
  const friendly = `${label} for ${descriptor}${extraTail}`;
  return stageRejectionNotice(perTurnWrites, session, {
    family,
    route,
    slotKey: bulkSlotKey(field, boardId, scopeKey),
    turnId,
    friendly,
    field,
    boardId,
    toolCallId,
  });
}

/**
 * A create or rename blocked by a blank designation or phase. Two routes per
 * family so the spoken line matches what was actually missing: telling an
 * inspector to "say what it feeds" when they gave a perfectly good name and
 * an empty phase is a wrong answer that costs a whole turn.
 */
export function stageCircuitOpBlockedNotice(
  perTurnWrites,
  session,
  { op, reasonField, circuitRef, keyRef, boardId, turnId, toolCallId, designation, phase }
) {
  const snapshot = session?.stateSnapshot;
  if (!boardRenderable(snapshot, boardId)) return false;
  if (circuitRef == null) return false;
  const family = op === 'create' ? 'create_blocked' : 'rename_blocked';
  const route = `${family}_${reasonField === 'phase' ? 'phase' : 'designation'}`;
  const clause = boardClause(snapshot, boardId);
  const namedDesignation =
    designation == null || String(designation).trim() === '' ? null : String(designation).trim();
  let friendly;
  if (op === 'create') {
    friendly =
      reasonField === 'phase'
        ? `circuit ${circuitRef}${clause}, ${namedDesignation ?? 'unnamed'}, phase`
        : `circuit ${circuitRef}${clause}`;
  } else {
    friendly =
      reasonField === 'phase'
        ? `circuit ${circuitRef}'s phase${clause}${heldValueTail(phase)}`
        : `circuit ${circuitRef}${clause}${heldValueTail(designation)}`;
  }
  return stageRejectionNotice(perTurnWrites, session, {
    family,
    route,
    slotKey: circuitOpSlotKey(op, keyRef ?? circuitRef, boardId),
    turnId,
    friendly,
    field: reasonField === 'phase' ? 'phase' : 'circuit_designation',
    boardId,
    toolCallId,
  });
}

/**
 * A DIRECT enum/shape rejection, staged PROVISIONALLY.
 *
 * WHY PROVISIONAL AND NOT SILENT. The rejection returns the options and the
 * prompt tells the model to ask once; that `ask_user` is the intended audible
 * outcome and it reconciles this notice away at the drain. But in a MIXED
 * turn — a sibling write succeeds and is read back while the model neither
 * asks nor rewrites the rejected slot — `allRejected` is false, the coverage
 * arbitration never runs, and the sibling's read-back suppresses the
 * catch-all. Without this notice the rejected certificate value would have no
 * audible outcome at all. Staging it costs nothing when the model behaves.
 */
export function stageDirectEnumRejectedNotice(
  perTurnWrites,
  session,
  { field, circuit, boardId, turnId, toolCallId, heldValue }
) {
  const label = circuitFieldLabel(field) ?? boardFieldLabel(field);
  const snapshot = session?.stateSnapshot;
  if (label == null || !boardRenderable(snapshot, boardId)) return false;
  const isCircuit = Number.isInteger(circuit);
  const friendly = isCircuit
    ? `${label} on circuit ${circuit}${boardClause(snapshot, boardId)}${heldValueTail(heldValue)}`
    : `${label}${boardClause(snapshot, boardId)}${heldValueTail(heldValue)}`;
  return stageRejectionNotice(perTurnWrites, session, {
    family: 'enum_rejected',
    route: 'enum_rejected',
    slotKey: isCircuit ? rawCircuitSlot(field, circuit, boardId) : boardSlotKey(field, boardId),
    turnId,
    friendly,
    field,
    boardId,
    toolCallId,
  });
}

/**
 * The rejection that MATTERS for Decision 5: the one AFTER the ask. It can
 * only happen inside the ask dispatcher's resolution of the inspector's own
 * answer, so "post-ask" is a property of the CALL SITE, not of a counter —
 * which is why this plan needs no cross-turn rejection history at all.
 *
 * `scope` present means the registered ask carried the BULK stamp and this is
 * one notice for the whole scope; otherwise the key is the single ref or the
 * ask's circuit set.
 */
export function stageEnumRejectedAfterAskNotice(
  perTurnWrites,
  session,
  { field, circuit, circuits, boardId, turnId, toolCallId, heldValue, scope = null }
) {
  const snapshot = session?.stateSnapshot;
  if (!boardRenderable(snapshot, boardId)) return false;
  if (scope) {
    return stageBulkRejectionNotice(perTurnWrites, session, {
      family: 'enum_rejected_after_ask',
      route: 'enum_rejected_after_ask_bulk',
      field,
      boardId,
      turnId,
      toolCallId,
      scope,
      // No held-value claim for a bulk scope: each circuit holds its own
      // value, so "still <x>" would be a statement about the scope that is
      // false for most of it. "Unchanged" is what is actually true.
      extraTail: heldValue === undefined ? ' unchanged' : ` unchanged${heldValueTail(heldValue)}`,
    });
  }
  const label = circuitFieldLabel(field) ?? boardFieldLabel(field);
  if (label == null) return false;
  const refs = Array.isArray(circuits) && circuits.length > 0 ? circuits : null;
  const clause = boardClause(snapshot, boardId);
  let target;
  let slotKey;
  if (refs && refs.length > 1) {
    const sorted = [...refs].sort((a, b) => a - b);
    target = ` on circuits ${spokenRefList(sorted)}`;
    slotKey = rawCircuitSlot(field, `set:${sorted.join(',')}`, boardId);
  } else {
    const ref = refs ? refs[0] : circuit;
    if (Number.isInteger(ref)) {
      target = ` on circuit ${ref}`;
      slotKey = rawCircuitSlot(field, ref, boardId);
    } else {
      target = '';
      slotKey = boardSlotKey(field, boardId);
    }
  }
  return stageRejectionNotice(perTurnWrites, session, {
    family: 'enum_rejected_after_ask',
    route: 'enum_rejected_after_ask',
    slotKey,
    turnId,
    friendly: `${label}${target}${clause}${heldValueTail(heldValue)}`,
    field,
    boardId,
    toolCallId,
  });
}

// ---- ask lineage -----------------------------------------------------------

/**
 * PLAN-C3 — journal one registered ask and resolve WHICH rejection it is
 * about, if any.
 *
 * Two ways an ask can be tied to a rejection, in this order:
 *
 *   1. The model ECHOED the `rejection_ref` the rejecting tool result
 *      returned. Deterministic, and the only way to tell a bulk lineage from
 *      a plural one — `context_circuits: [1..14]` looks identical whether the
 *      model is asking about a bulk request or about fourteen circuits it
 *      listed itself.
 *   2. No echo: an EXACT match on (field, resolved board, the ask's circuit
 *      set equal to the rejection's resolved scope). Anything short of exact
 *      is an ordinary plural ask and gets no stamp — a subset or a superset
 *      is a different question about a different set of circuits.
 *
 * The ask is journaled either way, because the drain's covering-ask
 * reconciliation needs every ask, not only the ref-bearing ones.
 *
 * @returns {object|null} the matched rejection journal entry, or null.
 */
export function recordAskRegistration(
  session,
  perTurnWrites,
  { toolCallId, rejectionRef, field, circuit, circuits, boardId }
) {
  if (!perTurnWrites) return null;
  const resolvedBoardId = resolveEffectiveBoardId(session, boardId) ?? null;
  const refs =
    Array.isArray(circuits) && circuits.length > 0
      ? [...circuits]
      : Number.isInteger(circuit)
        ? [circuit]
        : [];
  if (!Array.isArray(perTurnWrites.askRegistrations)) perTurnWrites.askRegistrations = [];
  perTurnWrites.askRegistrations.push({
    toolCallId,
    rejectionRef: typeof rejectionRef === 'string' ? rejectionRef : null,
    field: field ?? null,
    circuits: refs,
    boardId: resolvedBoardId,
  });

  const echoed = findRejection(perTurnWrites, rejectionRef);
  if (echoed) return echoed;
  const journal = perTurnWrites.rejections;
  if (!Array.isArray(journal) || field == null) return null;
  const askSet = new Set(refs);
  return (
    journal.find((r) => {
      if (!r || r.field !== field) return false;
      if ((r.boardId ?? null) !== resolvedBoardId) return false;
      const scopeSet = Array.isArray(r.scopeSet) ? r.scopeSet : [];
      if (scopeSet.length !== askSet.size) return false;
      return scopeSet.every((ref) => askSet.has(ref));
    }) ?? null
  );
}

/**
 * PLAN-C3 — stage the POST-ASK refusal, the one Decision 5 is actually about.
 *
 * The bulk half reuses the stamp's stored `scope`, so the second line about a
 * scope names the same circuits as the first. Without the stamp this is an
 * ordinary single-circuit or plural refusal keyed on the ask's own context.
 */
export function stagePostAskRejection(
  session,
  perTurnWrites,
  turnId,
  { toolCallId, field, circuit, circuits, boardId, stamp }
) {
  const resolvedBoardId = resolveEffectiveBoardId(session, boardId) ?? null;
  if (stamp?.scope) {
    return stageEnumRejectedAfterAskNotice(perTurnWrites, session, {
      field: stamp.field ?? field,
      boardId: stamp.boardId ?? resolvedBoardId,
      turnId,
      toolCallId,
      scope: stamp.scope,
      heldValue: undefined,
    });
  }
  const refs =
    Array.isArray(circuits) && circuits.length > 0
      ? circuits
      : Number.isInteger(circuit)
        ? [circuit]
        : null;
  // One circuit: name what it STILL holds. A plural ask has no single held
  // value, so it gets the ref list and no value claim.
  const heldValue =
    refs && refs.length === 1
      ? (getCircuitBucket(session?.stateSnapshot, refs[0], resolvedBoardId)?.[field] ?? null)
      : null;
  return stageEnumRejectedAfterAskNotice(perTurnWrites, session, {
    field,
    circuit: refs && refs.length === 1 ? refs[0] : null,
    circuits: refs,
    boardId: resolvedBoardId,
    turnId,
    toolCallId,
    heldValue,
  });
}
