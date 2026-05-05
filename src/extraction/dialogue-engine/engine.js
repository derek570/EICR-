/**
 * Dialogue script engine — slot-filling state machine that powers
 * ring-continuity, insulation-resistance, and (in PR2) OCPD / RCD /
 * RCBO walk-throughs.
 *
 * Replaces the per-domain `*-script.js` pattern. Each domain declares a
 * schema (slots, triggers, prompts) and the engine runs them
 * uniformly.
 *
 * Wire contract identical to the per-domain scripts: returns one of
 *   - { handled: false }
 *   - { handled: true, fallthrough: false }
 *   - { handled: true, fallthrough: true, transcriptText }
 * matching what `processRingContinuityTurn` and
 * `processInsulationResistanceTurn` returned. iOS sees no protocol
 * change.
 *
 * Single state object on the session: `session.dialogueScriptState`.
 * Replaces `session.ringContinuityScript` and
 * `session.insulationResistanceScript`. Only one script can be active
 * per session at a time — same constraint the previous design
 * enforced via mutually-exclusive triggers.
 */

import {
  parseCircuitDigit,
  findCircuitByDesignation,
  findCircuitsByDesignation,
  readExistingValues,
} from './helpers/circuit-resolution.js';
import {
  extractNamedFieldValues,
  nextMissingSlot,
  countFilledForCancel,
} from './helpers/extraction.js';
import { applyWrite } from './helpers/snapshot-write.js';
import {
  buildScriptAsk,
  buildScriptInfo,
  buildExtractionPayload,
  buildDisambiguationQuestion,
  safeSend,
} from './helpers/wire-emit.js';
import { applyDerivations } from './helpers/derivations.js';

/**
 * Process one transcript turn against all registered schemas. Walks the
 * schema list once. If a schema is currently active, only that schema's
 * active-path runs. Otherwise each schema's entry detector runs in
 * registry order until one matches.
 *
 * @param {object} ctx
 * @param {object} ctx.ws         iOS WebSocket — outgoing wire emit only
 * @param {object} ctx.session    EICRExtractionSession instance
 * @param {string} ctx.sessionId
 * @param {string} ctx.transcriptText
 * @param {Array}  ctx.schemas    Ordered list of dialogue schemas
 * @param {object} [ctx.logger]   Optional pino-style logger
 * @param {number} [ctx.now]      Override for test determinism
 */
export function processDialogueTurn(ctx) {
  const { ws, session, sessionId, transcriptText, schemas, logger, now = Date.now() } = ctx;
  if (!session) return { handled: false };
  if (!Array.isArray(schemas) || schemas.length === 0) return { handled: false };
  const text = typeof transcriptText === 'string' ? transcriptText : '';

  const state = session.dialogueScriptState;

  // Paused-state hard-timeout sweep — paused scripts (active=false)
  // sit waiting for the resume hook to wake them after Sonnet creates
  // a matching circuit. If too much time has passed, the inspector
  // has clearly moved on and any later matching create_circuit (e.g.
  // an unrelated kitchen circuit) shouldn't accidentally resume the
  // stale IR session. Reuse the schema's hardTimeoutMs so the
  // tolerance matches the active-path sweep.
  if (state && state.paused && !state.active) {
    const schema = schemas.find((s) => s.name === state.schemaName);
    if (schema && now - (state.paused_at ?? 0) > schema.hardTimeoutMs) {
      logger?.info?.(`${schema.logEventPrefix}_paused_hard_timeout`, {
        sessionId,
        ms_since_paused: now - (state.paused_at ?? 0),
        ambiguous_bare_value: state.ambiguous_bare_value?.value ?? null,
      });
      clearScriptState(session);
    }
  }

  // Active path: one script is in progress; only its handlers run.
  if (state?.active) {
    const schema = schemas.find((s) => s.name === state.schemaName);
    if (!schema) {
      // The active script belongs to a schema this caller didn't pass
      // in. Don't touch its state — return handled:false so the caller
      // proceeds with its normal flow (e.g. invoking the IR wrapper
      // while ring is the active script means ring stays untouched
      // and IR returns handled:false). The legacy two-wrapper call
      // pattern in sonnet-stream.js depends on this isolation.
      return { handled: false };
    } else {
      // Hard timeout sweep — if the script has been idle too long,
      // clear and fall through to entry detection. The user might be
      // starting a fresh script after stepping away.
      if (now - state.last_turn_at > schema.hardTimeoutMs) {
        logger?.info?.(`${schema.logEventPrefix}_hard_timeout`, {
          sessionId,
          circuit_ref: state.circuit_ref,
          filled: Object.keys(state.values).length,
          ms_since_last_turn: now - state.last_turn_at,
        });
        clearScriptState(session);
        // Fall through to entry detection below.
      } else {
        return runActivePath({
          ws,
          session,
          sessionId,
          text,
          transcriptText,
          schema,
          schemas,
          logger,
          now,
        });
      }
    }
  }

  // Entry detection — first matching schema wins.
  for (const schema of schemas) {
    const entry = detectEntry(text, schema);
    if (!entry.matched) continue;
    return runEntry({ ws, session, sessionId, text, schema, schemas, entry, logger, now });
  }

  return { handled: false };
}

/**
 * Test if a transcript matches a schema's entry triggers. Returns
 * { matched, circuit_ref } — circuit_ref is the digit captured by the
 * trigger regex, or null if the regex matched but didn't bind a digit.
 *
 * Each trigger regex is expected to have an optional capture group at
 * position 1 for the circuit number.
 */
function detectEntry(text, schema) {
  if (typeof text !== 'string' || !text) return { matched: false, circuit_ref: null };
  for (const pattern of schema.triggers) {
    const m = text.match(pattern);
    if (m) {
      const ref = m[1] ? Number(m[1]) : null;
      const validRef = Number.isInteger(ref) && ref > 0 ? ref : null;
      return { matched: true, circuit_ref: validRef };
    }
  }
  return { matched: false, circuit_ref: null };
}

/**
 * Detect a different entry on a NEW circuit while one is already
 * active. Used so an inspector mid-script can seamlessly switch to a
 * different circuit by re-stating the entry phrase with a new ref.
 */
function detectDifferentEntry(text, schema, currentCircuitRef) {
  for (const pattern of schema.triggers) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const newRef = Number(m[1]);
      if (Number.isInteger(newRef) && newRef > 0 && newRef !== currentCircuitRef) {
        return newRef;
      }
    }
  }
  return null;
}

function clearScriptState(session) {
  if (session) session.dialogueScriptState = null;
}

/**
 * Build the re-ask question for the "couldn't resolve circuit" recovery
 * path. Quotes the user's failed answer back so the second attempt is
 * unambiguous: "What's the circuit number for the upstairs sockets?"
 *
 * Schemas may override via `schema.retryCircuitQuestion(text)`. Default
 * works for every walk-through because the load reference (the user's
 * text) is the schema-agnostic part of the question.
 *
 * Empty / whitespace-only text falls back to the schema's regular
 * `whichCircuitQuestion` — there's nothing useful to quote back.
 */
function buildCircuitRetryQuestion(schema, designationAttempt) {
  const trimmed = typeof designationAttempt === 'string' ? designationAttempt.trim() : '';
  if (typeof schema.retryCircuitQuestion === 'function') {
    const out = schema.retryCircuitQuestion(trimmed);
    if (typeof out === 'string' && out.length > 0) return out;
  }
  if (trimmed.length === 0) return schema.whichCircuitQuestion;
  return `What's the circuit number for the ${trimmed}?`;
}

/**
 * Initialise the dialogue state for a freshly-entered script.
 *
 * `circuit_retry_attempted` and `last_designation_attempt` (added 2026-04-30
 * after the 14 Silvertown Road repro — session 842A3289) drive the
 * "re-ask once before discarding pending_writes" recovery path in the
 * active-path handler below. See the comment on the unresolvable-circuit
 * branch for the failure mode they fix.
 */
function initScriptState(session, schema, circuit_ref, now) {
  session.dialogueScriptState = {
    active: true,
    schemaName: schema.name,
    circuit_ref,
    values: {},
    pending_writes: [],
    skipped_slots: new Set(),
    entered_at: now,
    last_turn_at: now,
    circuit_retry_attempted: false,
    last_designation_attempt: null,
    // entered_via_pivot is set true only by runPivot; default false on
    // every direct entry path (regex / runEntry / enterScriptByName).
    entered_via_pivot: false,
    pivoted_from: null,
    // Composite-figure capture: a bare value the named-extractors couldn't
    // tag to a slot ("the IR for the cooker is 299"). The schema's
    // bareEntryParser populates this in runEntry; the resume path asks a
    // disambiguation question before draining it into the right slot.
    ambiguous_bare_value: null,
    // Pause/resume markers — set by the second-miss fallthrough when
    // there's preserved context worth waking up later (ambiguous bare
    // value or queued pending_writes). `paused: true` + `active: false`
    // means the engine's entry-detection treats this as no-script-active
    // (so a fresh utterance can start a new script) but the resume hook
    // (post-Sonnet-turn, on create_circuit) can find this state and
    // re-enter the script with the new circuit_ref bound.
    paused: false,
    paused_designation_hint: null,
    paused_at: null,
    // Disambiguation phase: set by tryResumePausedScript when an
    // ambiguous bare value needs L-L vs L-E routing. The active-path
    // pre-slot check intercepts the next user reply, runs
    // schema.disambiguateBareValue(text), assigns the value to the
    // chosen slot, then continues to askNextOrFinish.
    awaiting_disambiguation: null,
    // Designation disambiguation — set when the entry or
    // circuit-resolution path matched ≥2 circuits with the same
    // designation (CCU often stamps three "Sockets" or two "Lighting"
    // rows from a single sticker). The engine asks "Which 'sockets' —
    // circuit 2, 4 or 7?"; the next active-turn validates the user's
    // digit answer is in this list, or runs a designation match
    // restricted to these refs ("the kitchen one" → unique). One retry
    // before falling through to Sonnet, mirroring circuit_retry.
    pending_designation_candidates: null,
    designation_disambiguation_retry_attempted: false,
  };
}

/**
 * Handle the entry turn for a schema (no prior state, trigger
 * matched). Resolves the circuit (regex or designation), seeds the
 * values map with any pre-existing snapshot values, applies any
 * volunteered values from the entry utterance, then asks for the next
 * missing slot.
 */
function runEntry({ ws, session, sessionId, text, schema, schemas, entry, logger, now }) {
  let circuitRef = entry.circuit_ref;
  let entryDesignationMatched = false;
  // Designation lookup at entry time. Three outcomes:
  //   - 1 candidate → resolve circuit immediately (existing behaviour).
  //   - 2+ candidates with a shared designation → CCU stamped multiple
  //     circuits with the same label ("Sockets" × 3). Circuit stays
  //     unresolved; the disambiguation ask below quotes the shared
  //     label and lists the candidate refs.
  //   - 0 candidates → existing fallthrough (engine asks "Which
  //     circuit?" generically; ANY digit/designation can resolve).
  // Only attempted when the entry regex didn't capture a digit, so a
  // "ring continuity for circuit 4" still wins via the digit path.
  let designationCandidates = [];
  let designationSharedLabel = null;
  if (circuitRef === null) {
    const lookup = findCircuitsByDesignation(session, text);
    if (lookup.candidates.length === 1) {
      circuitRef = lookup.matched;
      entryDesignationMatched = true;
    } else if (lookup.candidates.length >= 2) {
      designationCandidates = lookup.candidates;
      designationSharedLabel = lookup.sharedDesignation;
    }
  }

  const slotFields = schema.slots.map((s) => s.field);
  const existing = circuitRef ? readExistingValues(session, circuitRef, slotFields) : {};
  const volunteered = extractNamedFieldValues(text, schema.slots);

  initScriptState(session, schema, circuitRef, now);
  const state = session.dialogueScriptState;
  if (designationCandidates.length >= 2) {
    state.pending_designation_candidates = designationCandidates;
  }

  // Seed values from existing snapshot — skip-already-filled relies on this.
  for (const [f, v] of Object.entries(existing)) {
    if (slotFields.includes(f) && v !== '' && v !== null && v !== undefined) {
      state.values[f] = v;
    }
  }

  // Apply or queue volunteered values from the entry utterance.
  // Track any pivot request from a derivation (e.g., "OCPD on circuit
  // 5 BS EN 61009" enters OCPD with circuit and bs_en, derivation
  // pivots to RCBO mid-entry).
  const writes = [];
  let pivotTo = null;
  for (const w of volunteered) {
    if (state.values[w.field] !== undefined) continue;
    if (circuitRef !== null) {
      const slot = schema.slots.find((s) => s.field === w.field);
      const r = applyWriteWithDerivations(session, schema, slot, circuitRef, w.value, now);
      writes.push(w);
      if (r.pivotTo) pivotTo = r.pivotTo;
    } else {
      // Circuit not yet known → queue. The active path drains
      // pending_writes once a digit or designation answer lands.
      state.pending_writes.push(w);
    }
  }

  if (writes.length > 0) {
    safeSend(ws, buildExtractionPayload(circuitRef, writes, schema.extractionSource));
  }

  // Composite-figure capture: when circuit_ref couldn't be resolved at
  // entry AND the named extractors didn't find a tagged value, try the
  // schema's bareEntryParser. For IR this catches "the IR for the
  // cooker is 299 milligrams" — a single value the inspector tossed out
  // before naming the circuit. Stashed in state for the resume path to
  // disambiguate (L-L vs L-E) once the circuit lands.
  //
  // Limited to the unresolved-circuit path because that's the failure
  // mode field-tested in session C3963EA1 (2026-05-02). Resolved-circuit
  // entries with bare values flow through the existing slot-by-slot
  // walk-through unchanged.
  //
  // Gating note: `writes` only ever populates when circuitRef !== null
  // (resolved-circuit path applies named values immediately). On the
  // unresolved path, named values land in `state.pending_writes` —
  // both must be empty for the bare parser to fire, otherwise an
  // utterance like "live to live 200 megaohms" (L-L tagged) would
  // also stash 200 as ambiguous.
  if (
    circuitRef === null &&
    writes.length === 0 &&
    state.pending_writes.length === 0 &&
    typeof schema.bareEntryParser === 'function'
  ) {
    const bare = schema.bareEntryParser(text);
    if (bare !== null && bare !== undefined) {
      state.ambiguous_bare_value = {
        value: bare,
        source: schema.bareEntrySource ?? 'bare',
      };
      logger?.info?.(`${schema.logEventPrefix}_bare_value_captured`, {
        sessionId,
        source: schema.bareEntrySource ?? 'bare',
        textPreview: text.slice(0, 80),
      });
    }
  }

  logger?.info?.(`${schema.logEventPrefix}_entered`, {
    sessionId,
    circuit_ref: circuitRef,
    entry_designation_matched: entryDesignationMatched,
    designation_candidates: designationCandidates.length >= 2 ? designationCandidates : [],
    pre_existing_filled: Object.keys(existing).filter((f) => slotFields.includes(f)),
    volunteered_writes: writes.map((w) => w.field),
    pending_writes: state.pending_writes.map((w) => w.field),
    ambiguous_bare_value: state.ambiguous_bare_value?.value ?? null,
    textPreview: text.slice(0, 80),
  });

  // What do we ask next?
  if (circuitRef === null) {
    // 2+ candidates with the same designation → quote the shared label
    // back. Sole-match would have set circuitRef above; zero matches
    // falls through to the schema's generic question.
    const whichQuestion =
      designationCandidates.length >= 2
        ? buildDisambiguationQuestion(designationSharedLabel, designationCandidates)
        : schema.whichCircuitQuestion;
    safeSend(
      ws,
      buildScriptAsk({
        toolCallIdPrefix: schema.toolCallIdPrefix,
        sessionId,
        circuit_ref: null,
        missing_field: null,
        whichCircuitQuestion: whichQuestion,
        slotQuestion: null,
        now,
        kind: 'which_circuit',
      })
    );
    return { handled: true, fallthrough: false };
  }

  // Pivot — entry-time derivation requested a schema transition.
  if (pivotTo) {
    return runPivot({
      ws,
      session,
      sessionId,
      schemas,
      fromSchema: schema,
      toSchemaName: pivotTo,
      logger,
      now,
    });
  }

  return askNextOrFinish({ ws, session, sessionId, schema, logger, now });
}

/**
 * Apply a write to the snapshot AND run any slot derivations. Returns
 * { pivotTo } so the caller can defer pivot handling to a clean point
 * in the active-path flow (after all in-utterance writes have landed).
 */
function applyWriteWithDerivations(session, schema, slot, circuit_ref, value, now) {
  applyWrite(session, schema, circuit_ref, slot.field, value, now);
  return applyDerivations({ session, schema, slot, value });
}

/**
 * Active path: a script is already in progress on this session. Walks
 * cancel → different-entry → topic-switch → per-slot-skip →
 * circuit-resolution → value-extraction → ask-next-or-finish, in that
 * order.
 */
function runActivePath({
  ws,
  session,
  sessionId,
  text,
  transcriptText,
  schema,
  schemas,
  logger,
  now,
}) {
  const state = session.dialogueScriptState;
  state.last_turn_at = now;

  // 0. Disambiguation reply — when the resume hook asked "Was 299
  //    L-L or L-E?", intercept the answer here BEFORE cancel /
  //    different-entry / topic-switch detection. The user's reply is
  //    a routing answer ("live to live"), not a cancel verb or topic
  //    pivot, so the normal active-path checks would mis-classify
  //    them. Schema's disambiguateBareValue returns either
  //    { field } (assign + continue), { discard: true } (drop the
  //    bare value + continue), or null (unparseable — re-ask once,
  //    then discard on second miss).
  if (state.awaiting_disambiguation && typeof schema.disambiguateBareValue === 'function') {
    const bare = state.awaiting_disambiguation;
    const verdict = schema.disambiguateBareValue(text);
    if (verdict && verdict.field) {
      // Belt-and-braces: don't overwrite if the inspector somehow
      // filled the chosen slot in the meantime (rare but possible if
      // a parallel write landed).
      if (state.values[verdict.field] == null) {
        applyWrite(session, schema, state.circuit_ref, verdict.field, bare.value, now);
        state.values[verdict.field] = bare.value;
        safeSend(
          ws,
          buildExtractionPayload(
            state.circuit_ref,
            [{ field: verdict.field, value: bare.value }],
            schema.extractionSource
          )
        );
      }
      logger?.info?.(`${schema.logEventPrefix}_disambiguation_resolved`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        bare_value: bare.value,
        target_field: verdict.field,
        textPreview: text.slice(0, 80),
      });
      state.awaiting_disambiguation = null;
      state.disambiguation_retry_attempted = false;
      return askNextOrFinish({ ws, session, sessionId, schema, logger, now });
    }
    if (verdict && verdict.discard) {
      logger?.info?.(`${schema.logEventPrefix}_disambiguation_discarded_by_user`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        bare_value: bare.value,
        textPreview: text.slice(0, 80),
      });
      state.awaiting_disambiguation = null;
      state.disambiguation_retry_attempted = false;
      return askNextOrFinish({ ws, session, sessionId, schema, logger, now });
    }
    // Unparseable. Re-ask once, then drop the bare value on a second
    // miss so the script doesn't loop forever.
    if (!state.disambiguation_retry_attempted) {
      state.disambiguation_retry_attempted = true;
      logger?.info?.(`${schema.logEventPrefix}_disambiguation_retry`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        textPreview: text.slice(0, 80),
      });
      safeSend(
        ws,
        buildScriptAsk({
          toolCallIdPrefix: schema.toolCallIdPrefix,
          sessionId,
          circuit_ref: state.circuit_ref,
          missing_field: '_ir_disambiguate_bare',
          whichCircuitQuestion: null,
          slotQuestion:
            typeof schema.bareDisambiguationQuestion === 'function'
              ? schema.bareDisambiguationQuestion(bare.value)
              : `Live-to-live or live-to-earth?`,
          now,
          kind: 'value',
        })
      );
      return { handled: true, fallthrough: false };
    }
    logger?.info?.(`${schema.logEventPrefix}_disambiguation_dropped`, {
      sessionId,
      circuit_ref: state.circuit_ref,
      bare_value: bare.value,
      reason: 'second_unparseable',
      textPreview: text.slice(0, 80),
    });
    state.awaiting_disambiguation = null;
    state.disambiguation_retry_attempted = false;
    return askNextOrFinish({ ws, session, sessionId, schema, logger, now });
  }

  // 1. Cancel — preserve writes, clear state, announce.
  if (matchesAny(text, schema.cancelTriggers)) {
    const { filled, total } = countFilledForCancel(state.values, schema.slots);
    logger?.info?.(`${schema.logEventPrefix}_cancelled`, {
      sessionId,
      circuit_ref: state.circuit_ref,
      filled,
      textPreview: text.slice(0, 80),
    });
    safeSend(
      ws,
      buildScriptInfo({
        toolCallIdPrefix: schema.toolCallIdPrefix,
        sessionId,
        kind: 'cancel',
        text: filled > 0 ? schema.cancelMessage({ filled, total }) : schema.cancelMessageEmpty,
        now,
      })
    );
    clearScriptState(session);
    return { handled: true, fallthrough: false };
  }

  // 2. Different entry on a NEW circuit — seamlessly switch.
  const newRef = detectDifferentEntry(text, schema, state.circuit_ref);
  if (newRef !== null) {
    const { filled } = countFilledForCancel(state.values, schema.slots);
    logger?.info?.(`${schema.logEventPrefix}_switched_circuit`, {
      sessionId,
      from_ref: state.circuit_ref,
      to_ref: newRef,
      partial_filled_on_old: filled,
      textPreview: text.slice(0, 80),
    });
    clearScriptState(session);
    // Recurse so the fresh entry runs on the same transcript.
    return processDialogueTurn({
      ws,
      session,
      sessionId,
      transcriptText,
      schemas: [schema],
      logger,
      now,
    });
  }

  // 3. Topic switch — clear state, fallthrough to Sonnet.
  if (matchesAny(text, schema.topicSwitchTriggers)) {
    const { filled } = countFilledForCancel(state.values, schema.slots);
    logger?.info?.(`${schema.logEventPrefix}_topic_switch`, {
      sessionId,
      circuit_ref: state.circuit_ref,
      filled,
      textPreview: text.slice(0, 80),
    });
    clearScriptState(session);
    return { handled: true, fallthrough: true, transcriptText };
  }

  // 4. Resolve circuit FIRST if pending. Digit answer preferred,
  //    designation answer falls out via findCircuitsByDesignation.
  //
  //    When `pending_designation_candidates` is set, the previous turn
  //    asked "Which 'sockets' — circuit 2, 4 or 7?". This turn must
  //    pick from that closed set:
  //      - digit answer → must be in the candidate list, else reject
  //        and run one retry. Stops "circuit 5" landing on a circuit
  //        that wasn't even an option.
  //      - non-digit answer → restrict the designation match to the
  //        candidate set. "the kitchen one" against [2, 4, 7] picks
  //        the one whose designation contains "kitchen", if unique.
  const candidateSet =
    Array.isArray(state.pending_designation_candidates) &&
    state.pending_designation_candidates.length >= 2
      ? state.pending_designation_candidates
      : null;
  const writes = [];
  let drainedFromPending = false;
  let circuitResolvedThisTurn = false;
  if (state.circuit_ref === null) {
    let ref = parseCircuitDigit(text);
    if (ref !== null && candidateSet && !candidateSet.includes(ref)) {
      // Digit answer outside the offered set. Reject and re-ask once.
      // Falls through to the existing `circuit_retry_attempted` block
      // below by clearing the digit and treating this turn as
      // unresolvable. Logged separately so CloudWatch can flag
      // inspectors who consistently pick out-of-set numbers.
      logger?.info?.(`${schema.logEventPrefix}_designation_disambiguation_out_of_set`, {
        sessionId,
        offered: candidateSet,
        rejected: ref,
        textPreview: text.slice(0, 80),
      });
      ref = null;
    }
    if (ref === null) {
      // Designation match. When a candidate set is offered, narrow the
      // search to those refs so a noisy designation ("kitchen" when
      // "kitchen" is also somewhere outside the candidate set) doesn't
      // pull a non-candidate ref. When no candidate set, full lookup
      // (existing behaviour).
      const lookup = findCircuitsByDesignation(
        session,
        text,
        candidateSet ? { restrictToRefs: candidateSet } : {}
      );
      if (lookup.matched !== null) {
        ref = lookup.matched;
        logger?.info?.(`${schema.logEventPrefix}_designation_match`, {
          sessionId,
          circuit_ref: ref,
          restricted: candidateSet ? candidateSet : null,
          textPreview: text.slice(0, 80),
        });
      }
    }
    if (ref !== null) {
      state.circuit_ref = ref;
      circuitResolvedThisTurn = true;
      // Clear the candidate set — disambiguation done.
      state.pending_designation_candidates = null;
      state.designation_disambiguation_retry_attempted = false;
      const slotFields = schema.slots.map((s) => s.field);
      const existing = readExistingValues(session, ref, slotFields);
      for (const [f, v] of Object.entries(existing)) {
        if (slotFields.includes(f) && v !== '' && v !== null && v !== undefined) {
          state.values[f] = v;
        }
      }
      // Drain pending_writes onto the now-resolved circuit.
      if (Array.isArray(state.pending_writes) && state.pending_writes.length > 0) {
        for (const w of state.pending_writes) {
          if (state.values[w.field] !== undefined) continue;
          applyWrite(session, schema, ref, w.field, w.value, now);
          writes.push(w);
          drainedFromPending = true;
        }
        state.pending_writes = [];
      }
      logger?.info?.(`${schema.logEventPrefix}_circuit_resolved`, {
        sessionId,
        circuit_ref: ref,
        pre_existing_filled: Object.keys(state.values).filter(
          (f) => !writes.some((w) => w.field === f)
        ),
        drained_pending_writes: writes.map((w) => w.field),
        textPreview: text.slice(0, 80),
      });
    } else {
      // Couldn't resolve. Try to queue any volunteered values for a
      // later turn that DOES name the circuit.
      const followUpVolunteered = extractNamedFieldValues(text, schema.slots);
      if (followUpVolunteered.length > 0) {
        for (const w of followUpVolunteered) {
          const alreadyQueued = (state.pending_writes ?? []).some(
            (existing) => existing.field === w.field
          );
          if (alreadyQueued) continue;
          if (!Array.isArray(state.pending_writes)) state.pending_writes = [];
          state.pending_writes.push(w);
        }
        logger?.info?.(`${schema.logEventPrefix}_queued_values`, {
          sessionId,
          textPreview: text.slice(0, 80),
          queued_fields: followUpVolunteered.map((w) => w.field),
          pending_writes_total: state.pending_writes.length,
        });
        return { handled: true, fallthrough: false };
      }
      // First miss: re-ask once before discarding pending_writes. Save
      // the user's text so the re-ask can quote it back ("What's the
      // circuit number for the upstairs sockets?") and flag the retry
      // so a SECOND unresolvable answer falls through as before.
      //
      // Why re-ask instead of immediate fallthrough: 2026-04-30 14
      // Silvertown Road repro (session 842A3289). The inspector said
      // "Ring continuity lives are 0.32" → script enters with R1=0.32
      // queued and asks "Which circuit?". Inspector answers "upstairs
      // socket." (Deepgram dropped the trailing 's'). At THAT moment
      // circuit 4 had no `circuit_designation` on the snapshot —
      // Sonnet's `rename_circuit(4 → "upstairs sockets")` didn't land
      // for another 14s. The lookup returned null, the engine
      // discarded R1=0.32, and the inspector had to redo the entire
      // ring continuity test. Re-asking lets the engine recover when
      // the snapshot is empty / stale or when Deepgram garbled the
      // designation slightly. Two attempts before conceding to Sonnet
      // matches the legacy "Fix C deferred" TODO from the original
      // ring-continuity-script.js (line 798–800 in the legacy file).
      //
      // Why a flag (not a counter): one retry is enough to catch the
      // designation-not-yet-written race without dragging the
      // conversation. If the inspector is genuinely off-topic, the
      // second answer falls through to Sonnet just like before — same
      // exit log row + same discarded_pending_writes payload, plus a
      // `retry_attempted: true` field so CloudWatch can split first-
      // miss-recoveries from genuine fallthroughs.
      if (!state.circuit_retry_attempted) {
        state.circuit_retry_attempted = true;
        const trimmed = text.trim();
        state.last_designation_attempt = trimmed.slice(0, 60);
        logger?.info?.(`${schema.logEventPrefix}_circuit_retry`, {
          sessionId,
          textPreview: text.slice(0, 80),
          pending_designation_candidates: candidateSet,
          pending_writes: Array.isArray(state.pending_writes)
            ? state.pending_writes.map((w) => w.field)
            : [],
        });
        // When we're still in disambiguation mode, repeat the
        // candidate list rather than asking a freeform "What's the
        // circuit number for the kitchen sockets?" — the inspector
        // already heard a candidate list once and the re-ask should
        // stay anchored to the same options. Re-derive the shared
        // designation from the snapshot (cheap; the candidate set is
        // small) so we keep the quoted-label form.
        let retryQuestion;
        if (candidateSet) {
          // Pull a representative designation from any candidate; if
          // they share, the helper will quote it back.
          const sharedLookup = findCircuitsByDesignation(session, '', {
            restrictToRefs: candidateSet,
          });
          // sharedLookup ignores empty text; fall back to scanning
          // the snapshot directly for the first candidate's designation.
          let sharedLabel = sharedLookup.sharedDesignation;
          if (!sharedLabel) {
            const snap = session?.stateSnapshot?.circuits;
            const firstRef = candidateSet[0];
            const bucket = Array.isArray(snap)
              ? snap.find((c) => Number(c?.circuit_ref) === Number(firstRef))
              : (snap?.[firstRef] ?? snap?.[String(firstRef)]);
            const des = bucket?.circuit_designation || bucket?.designation || null;
            sharedLabel = des ? des.toLowerCase().trim() : null;
            // Only quote it back if every candidate actually shares it.
            if (sharedLabel) {
              const all = candidateSet.every((r) => {
                const b = Array.isArray(snap)
                  ? snap.find((c) => Number(c?.circuit_ref) === Number(r))
                  : (snap?.[r] ?? snap?.[String(r)]);
                const d = b?.circuit_designation || b?.designation || '';
                return d.toLowerCase().trim() === sharedLabel;
              });
              if (!all) sharedLabel = null;
            }
          }
          retryQuestion = buildDisambiguationQuestion(sharedLabel, candidateSet);
        } else {
          retryQuestion = buildCircuitRetryQuestion(schema, state.last_designation_attempt);
        }
        safeSend(
          ws,
          buildScriptAsk({
            toolCallIdPrefix: schema.toolCallIdPrefix,
            sessionId,
            circuit_ref: null,
            missing_field: null,
            whichCircuitQuestion: retryQuestion,
            slotQuestion: null,
            now,
            kind: 'which_circuit',
          })
        );
        return { handled: true, fallthrough: false };
      }

      // Second miss: fall through to Sonnet. Two behaviours:
      //
      // (a) Pause-and-preserve — when the schema opts in via
      //     `resumeAfterCircuitCreation: true` AND there's context
      //     worth resuming later (an ambiguous bare value from entry
      //     or queued pending_writes from named extractors). The
      //     resume hook (post-Sonnet-turn, in stage6 dispatcher)
      //     checks paused state on every create_circuit /
      //     rename_circuit and re-enters the script with the new
      //     circuit_ref bound when designation matches. `active:
      //     false` so the engine's entry-detection treats this as
      //     inactive — a brand-new utterance can still start fresh.
      //
      // (b) Existing behaviour — clear state and fall through. Used
      //     for schemas that haven't opted in (e.g. ring continuity —
      //     Silvertown repro deliberately discards on second miss),
      //     or when there's nothing meaningful to resume. The
      //     `retry_attempted: true` log field distinguishes this from
      //     a first-turn fallthrough either way.
      //
      // The pause path was added 2026-05-02 after field session
      // C3963EA1 (cooker circuit). Inspector said "Insulation
      // resistance for the cooker is 299 milligrams" before the cooker
      // circuit existed. Clear-and-fall-through silently discarded the
      // 299. With pause-and-preserve, Sonnet handles circuit creation
      // and the IR script picks back up with circuit_ref=2 and
      // ambiguous_bare_value still in state, ready for the L-L vs L-E
      // disambiguation step.
      const hasResumableContext =
        state.ambiguous_bare_value !== null ||
        (Array.isArray(state.pending_writes) && state.pending_writes.length > 0);

      if (schema.resumeAfterCircuitCreation === true && hasResumableContext) {
        state.active = false;
        state.paused = true;
        state.paused_designation_hint = text.trim().slice(0, 60);
        state.paused_at = now;
        logger?.info?.(`${schema.logEventPrefix}_paused_for_sonnet`, {
          sessionId,
          textPreview: text.slice(0, 80),
          paused_designation_hint: state.paused_designation_hint,
          ambiguous_bare_value: state.ambiguous_bare_value?.value ?? null,
          preserved_pending_writes: Array.isArray(state.pending_writes)
            ? state.pending_writes.map((w) => w.field)
            : [],
          retry_attempted: true,
        });
        return { handled: true, fallthrough: true, transcriptText };
      }

      logger?.info?.(`${schema.logEventPrefix}_unresolvable_circuit`, {
        sessionId,
        textPreview: text.slice(0, 80),
        discarded_pending_writes: Array.isArray(state.pending_writes)
          ? state.pending_writes.map((w) => w.field)
          : [],
        retry_attempted: true,
      });
      clearScriptState(session);
      return { handled: true, fallthrough: true, transcriptText };
    }
  }

  // 5. Identify the slot we're currently expecting (next missing).
  const currentSlot = nextMissingSlot(state.values, schema.slots, state.skipped_slots);

  // 5a. Per-slot skip — schemas that opt in (PR2 OCPD/RCD/RCBO) let
  //     the inspector say "skip that" / "I don't know" to mark the
  //     CURRENT slot as deliberately blank and move on, without
  //     cancelling the whole script. Detected ONLY when there's a
  //     current slot to skip; if all slots are filled the cancel
  //     verbs (whole-script) take the same words via topicSwitchTriggers
  //     anyway.
  if (
    currentSlot &&
    Array.isArray(schema.skipSlotTriggers) &&
    matchesAny(text, schema.skipSlotTriggers)
  ) {
    state.skipped_slots.add(currentSlot.field);
    logger?.info?.(`${schema.logEventPrefix}_slot_skipped`, {
      sessionId,
      circuit_ref: state.circuit_ref,
      field: currentSlot.field,
      textPreview: text.slice(0, 80),
    });
    return askNextOrFinish({ ws, session, sessionId, schema, logger, now });
  }

  // 6. Schema-specific exclusive-parser hook (for IR voltage phase):
  //    when the current expected slot has `exclusiveWhenExpected: true`,
  //    skip named-field extraction and run only this slot's parser on
  //    the bare text. If nothing parses, finish silently.
  if (currentSlot && currentSlot.exclusiveWhenExpected) {
    const value = currentSlot.parser(text);
    if (value !== null && value !== undefined) {
      applyWriteWithDerivations(session, schema, currentSlot, state.circuit_ref, value, now);
      writes.push({ field: currentSlot.field, value });
    }
    if (writes.length > 0) {
      safeSend(ws, buildExtractionPayload(state.circuit_ref, writes, schema.extractionSource));
    }
    finishScript({ ws, session, sessionId, schema, logger, now });
    return { handled: true, fallthrough: false };
  }

  // 7. Named-field extraction — multiple slots can fill from one
  //    utterance. Track any pivot request from a derivation.
  let pivotTo = null;
  const named = extractNamedFieldValues(text, schema.slots);
  for (const w of named) {
    if (state.values[w.field] !== undefined) continue;
    const slot = schema.slots.find((s) => s.field === w.field);
    const r = applyWriteWithDerivations(session, schema, slot, state.circuit_ref, w.value, now);
    writes.push(w);
    if (r.pivotTo) pivotTo = r.pivotTo;
  }

  // 8. Bare-value fallback. If no named matched on this turn, treat a
  //    bare value as the currently-expected slot. Suppressed when:
  //    a) we just drained pending writes (utterance already consumed
  //       by the resolver — e.g. "downstairs sockets" → designation
  //       match → c1 → drained R1).
  //    b) circuit_ref was JUST resolved this turn (the digit that
  //       resolved would otherwise re-parse as a value).
  //    c) the next-expected slot has acceptsBareValue=false.
  if (
    !drainedFromPending &&
    !circuitResolvedThisTurn &&
    named.length === 0 &&
    state.circuit_ref !== null &&
    currentSlot &&
    currentSlot.acceptsBareValue !== false
  ) {
    const bareValue = currentSlot.parser(text);
    // 2026-05-04 (field test 07635782 follow-up): per-slot allowed-value
    // gate. The OCPD breaking-capacity slot now declares the realistic kA
    // set ([1.5, 3, 4.5, 6, 10, 16, 20, 25, 36, 50, 80] — see
    // schemas/ocpd.js). When the inspector said "six" the engine accepted
    // it, then asked the breaking-capacity question, and Deepgram heard
    // the next answer as "66" — a kA value that doesn't exist for any
    // real MCB. The parser was OK with it (range 1..200) and it landed
    // on the cert. With this gate the engine treats out-of-set values
    // like a parser-failure: log + drop + re-ask. Set membership is
    // string-equality on the parser's canonical output so "6" and "6.0"
    // compare correctly (parseKa returns "6" not "6.0").
    if (
      bareValue !== null &&
      bareValue !== undefined &&
      Array.isArray(currentSlot.allowedValues) &&
      !currentSlot.allowedValues.includes(bareValue)
    ) {
      // Optional logger — same defensive pattern as runPivot uses
      // (some unit tests construct sessions without a logger). Drop
      // silently into the re-ask path if no logger is wired.
      logger?.info?.(`${schema.logEventPrefix}_slot_value_out_of_set`, {
        sessionId,
        circuit_ref: state.circuit_ref,
        field: currentSlot.field,
        rejected_value: bareValue,
        allowed_count: currentSlot.allowedValues.length,
        textPreview: text.slice(0, 80),
      });
      // Fall through with bareValue cleared — engine re-asks the same
      // slot on the next turn (no write, no pivot).
    } else if (bareValue !== null && bareValue !== undefined) {
      const r = applyWriteWithDerivations(
        session,
        schema,
        currentSlot,
        state.circuit_ref,
        bareValue,
        now
      );
      writes.push({ field: currentSlot.field, value: bareValue });
      if (r.pivotTo) pivotTo = r.pivotTo;
    }
  }

  if (writes.length > 0) {
    safeSend(ws, buildExtractionPayload(state.circuit_ref, writes, schema.extractionSource));
  }

  // 9. Pivot — if a derivation requested a schema transition (e.g.,
  //    OCPD's bs_en slot fills with "BS EN 61009" → pivot to RCBO),
  //    close the current script's state, open the target's, carry
  //    over filled values, and ask the next missing slot for the new
  //    schema. This happens AFTER the writes emit so the wire shape
  //    shows the OCPD-side write before the RCBO ask.
  if (pivotTo) {
    return runPivot({
      ws,
      session,
      sessionId,
      schemas,
      fromSchema: schema,
      toSchemaName: pivotTo,
      logger,
      now,
    });
  }

  return askNextOrFinish({ ws, session, sessionId, schema, logger, now });
}

/**
 * Pivot from one schema to another. Carries over circuit_ref + any
 * filled values that the target schema's slot list covers (via
 * `readExistingValues` against the snapshot — derivation `sets` and
 * `mirrors` already wrote to the snapshot, so the target picks them
 * up automatically). Then asks the next missing slot for the new
 * schema.
 */
function runPivot({ ws, session, sessionId, schemas, fromSchema, toSchemaName, logger, now }) {
  const target = schemas.find((s) => s.name === toSchemaName);
  if (!target) {
    logger?.warn?.(`${fromSchema.logEventPrefix}_pivot_target_missing`, {
      sessionId,
      from: fromSchema.name,
      to: toSchemaName,
    });
    // Defensive — caller's schemas list missing the pivot target.
    // Fall through to ask the next missing on the source schema.
    return askNextOrFinish({ ws, session, sessionId, schema: fromSchema, logger, now });
  }
  const previous = session.dialogueScriptState;
  const circuit_ref = previous?.circuit_ref ?? null;
  logger?.info?.(`${fromSchema.logEventPrefix}_pivot`, {
    sessionId,
    from: fromSchema.name,
    to: toSchemaName,
    circuit_ref,
  });
  initScriptState(session, target, circuit_ref, now);
  const state = session.dialogueScriptState;
  // 2026-04-30 (Codex P2 follow-up): tag the post-pivot state so
  // subsequent enterScriptByName calls hitting the already_active path
  // can report the provenance accurately. Without this, a defensive
  // Sonnet retry while RCBO is active (after an OCPD→RCBO pivot)
  // would receive `pivoted:false` from the dispatcher — wrong, the
  // active script DID arrive via pivot.
  state.entered_via_pivot = true;
  state.pivoted_from = fromSchema.name;
  // Hydrate the target's values from any snapshot fields its slots
  // cover. Includes anything the source schema wrote during this
  // turn (the derivations' sets+mirrors landed before pivot).
  const slotFields = target.slots.map((s) => s.field);
  const existing = circuit_ref ? readExistingValues(session, circuit_ref, slotFields) : {};
  for (const [f, v] of Object.entries(existing)) {
    if (slotFields.includes(f) && v !== '' && v !== null && v !== undefined) {
      state.values[f] = v;
    }
  }
  return askNextOrFinish({ ws, session, sessionId, schema: target, logger, now });
}

/**
 * After any writes have landed, ask for the next missing slot or
 * finish the script. Shared between entry-path and active-path.
 */
function askNextOrFinish({ ws, session, sessionId, schema, logger, now }) {
  const state = session.dialogueScriptState;
  const nextSlot = nextMissingSlot(state.values, schema.slots, state.skipped_slots);
  if (!nextSlot) {
    finishScript({ ws, session, sessionId, schema, logger, now });
    return { handled: true, fallthrough: false };
  }
  safeSend(
    ws,
    buildScriptAsk({
      toolCallIdPrefix: schema.toolCallIdPrefix,
      sessionId,
      circuit_ref: state.circuit_ref,
      missing_field: nextSlot.field,
      whichCircuitQuestion: schema.whichCircuitQuestion,
      slotQuestion: nextSlot.question,
      now,
      kind: 'value',
    })
  );
  return { handled: true, fallthrough: false };
}

/**
 * Emit the schema's completion TTS, log, and clear state. The schema
 * supplies its own `finishMessage(values)` for byte-identical output.
 */
function finishScript({ ws, session, sessionId, schema, logger, now }) {
  const state = session.dialogueScriptState;
  if (!state) return;
  const { circuit_ref, values } = state;
  safeSend(
    ws,
    buildScriptInfo({
      toolCallIdPrefix: schema.toolCallIdPrefix,
      sessionId,
      kind: 'done',
      text: schema.finishMessage({ values }),
      now,
    })
  );
  logger?.info?.(`${schema.logEventPrefix}_completed`, {
    sessionId,
    circuit_ref,
    values: { ...values },
  });
  clearScriptState(session);
  if (typeof schema.onFinish === 'function') {
    schema.onFinish(session, circuit_ref);
  }
}

function matchesAny(text, patterns) {
  if (typeof text !== 'string' || !text || !Array.isArray(patterns)) return false;
  return patterns.some((p) => p.test(text));
}

/**
 * Server-driven script entry — the back door for the Sonnet
 * `start_dialogue_script` tool (Plan: Silvertown follow-up 2026-04-30).
 *
 * Why this exists: the engine's regex entry triggers (each schema's
 * `triggers` list) inevitably miss garbles and paraphrases that
 * Sonnet's LLM understanding catches. Rather than chase every
 * Deepgram mishearing into the regex (the long tail is unbounded),
 * Sonnet emits a tool call when it recognises a structured walk-
 * through entry the engine missed; the dispatcher (in
 * stage6-dispatchers-script.js) calls this function to set up the
 * script state, and the next user turn flows through the active path
 * normally.
 *
 * Differs from `runEntry`:
 *   - Caller supplies `schemaName` (string) instead of providing the
 *     schema directly via the entry-detection loop.
 *   - There is NO transcript text to parse for designations or named-
 *     field values — Sonnet has already extracted what it could and
 *     either passed `circuit_ref` or expects the engine to ask.
 *   - Idempotent: returns `{ ok: true, status: 'already_active' }`
 *     when a script is in flight, so calling defensively from Sonnet
 *     is safe.
 *   - Returns a structured outcome object instead of the
 *     `{handled, fallthrough}` shape — the dispatcher converts to a
 *     tool_result envelope.
 *
 * Wire emission: the function still calls `safeSend(ws, ...)` to emit
 * the first ask (which-circuit or which-slot) so the inspector hears
 * the question on the SAME response Sonnet is closing. If `ws` is
 * absent (test path), the ask is captured in the return payload but
 * not sent.
 *
 * @param {object} args
 * @param {object} args.session
 * @param {string} args.sessionId
 * @param {Array}  args.schemas      Registered schema list to look up by name.
 * @param {string} args.schemaName   One of: ring_continuity, insulation_resistance, ocpd, rcd, rcbo.
 * @param {?number} [args.circuit_ref]  If known (Sonnet caught a digit), seeds state.circuit_ref.
 * @param {Array<{field: string, value: string}>} [args.pending_writes]
 *        Sonnet-extracted volunteered values from the same utterance ("ring
 *        continuity lives are 0.32" → [{field: 'ring_r1_ohm', value: '0.32'}]).
 *        Without this, the value Sonnet heard would be lost — the existing
 *        regex-driven entry preserved volunteered values via
 *        extractNamedFieldValues; this preserves the same property when
 *        Sonnet enters via the LLM-fallback path. Each entry is silently
 *        dropped if its `field` is not a slot of the chosen schema (defence
 *        against Sonnet hallucinating a field name) — the rest of the entry
 *        still proceeds. Validation logged via the schema's normal
 *        `_seeded_writes` event.
 * @param {object} [args.ws]
 * @param {object} [args.logger]
 * @param {number} [args.now]
 * @returns {{ok: boolean, status?: string, schema?: string, circuit_ref?: ?number, seeded_writes?: string[], error?: object}}
 */
export function enterScriptByName({
  session,
  sessionId,
  schemas,
  schemaName,
  circuit_ref = null,
  pending_writes = [],
  ws = null,
  logger = null,
  now = Date.now(),
}) {
  if (!session) return { ok: false, error: { code: 'no_session' } };
  if (!Array.isArray(schemas) || schemas.length === 0) {
    return { ok: false, error: { code: 'no_schemas' } };
  }
  const schema = schemas.find((s) => s.name === schemaName);
  if (!schema) {
    return { ok: false, error: { code: 'unknown_schema', schema: schemaName } };
  }

  // Idempotency: if a script is already in flight, return an
  // already_active envelope. Sonnet may emit this tool defensively
  // alongside the engine's own regex entry — we MUST NOT clear
  // existing state and re-enter (would lose values + reset the
  // retry-budget flag from Fix 1).
  const existing = session.dialogueScriptState;
  if (existing?.active) {
    logger?.info?.('stage6.dialogue_script_already_active', {
      sessionId,
      requested_schema: schemaName,
      active_schema: existing.schemaName,
      active_circuit_ref: existing.circuit_ref,
      entered_via_pivot: existing.entered_via_pivot === true,
    });
    return {
      ok: true,
      status: 'already_active',
      schema: existing.schemaName,
      circuit_ref: existing.circuit_ref,
      // Surface the existing script's pivot provenance so the
      // dispatcher's envelope reports `pivoted` correctly even on the
      // defensive-retry path. Codex P2: the prior dispatcher coerced
      // missing → false, which lied when a defensive retry hit RCBO
      // that had been entered via OCPD → RCBO pivot earlier.
      pivoted: existing.entered_via_pivot === true,
    };
  }

  // Validate circuit_ref if supplied. Null is allowed — engine asks.
  let resolvedCircuitRef = null;
  if (circuit_ref !== null && circuit_ref !== undefined) {
    if (!Number.isInteger(circuit_ref) || circuit_ref <= 0) {
      return {
        ok: false,
        error: { code: 'invalid_circuit_ref', circuit_ref },
      };
    }
    // Reject unknown circuit (mirror dispatchRecordReading semantics —
    // strict-mode forces Sonnet to call create_circuit explicitly if
    // it wants a new one, rather than silently creating via this back
    // door).
    const circuits = session.stateSnapshot?.circuits;
    const exists =
      (circuits && typeof circuits === 'object' && circuits[circuit_ref]) ||
      (Array.isArray(circuits) && circuits.some((c) => Number(c?.circuit_ref) === circuit_ref));
    if (!exists) {
      return {
        ok: false,
        error: { code: 'unknown_circuit', circuit_ref },
      };
    }
    resolvedCircuitRef = circuit_ref;
  }

  // Validate Sonnet-supplied volunteered values against the schema's
  // slot fields. Drop any entry with an unknown field — Sonnet should
  // not be hallucinating field names (the agentic prompt enumerates
  // them), but defence-in-depth here keeps a single bad entry from
  // poisoning the whole entry. Empty / non-string values also dropped.
  const slotFields = schema.slots.map((s) => s.field);
  const validWrites = [];
  const droppedFields = [];
  if (Array.isArray(pending_writes)) {
    for (const w of pending_writes) {
      if (
        !w ||
        typeof w.field !== 'string' ||
        !slotFields.includes(w.field) ||
        typeof w.value !== 'string' ||
        w.value.length === 0
      ) {
        if (w?.field) droppedFields.push(w.field);
        continue;
      }
      validWrites.push({ field: w.field, value: w.value });
    }
  }

  // Initialise state. Seed values from the existing snapshot so a
  // partial fill is honoured (mirrors runEntry's skip-already-filled).
  initScriptState(session, schema, resolvedCircuitRef, now);
  const state = session.dialogueScriptState;
  if (resolvedCircuitRef !== null) {
    const existingValues = readExistingValues(session, resolvedCircuitRef, slotFields);
    for (const [f, v] of Object.entries(existingValues)) {
      if (slotFields.includes(f) && v !== '' && v !== null && v !== undefined) {
        state.values[f] = v;
      }
    }
  }

  // Apply or queue Sonnet's volunteered writes. Mirrors runEntry's
  // logic exactly — including derivation processing — so byte-identical
  // state results from regex entry + Sonnet entry on the same utterance
  // shape. Critically, applyWriteWithDerivations is what fires the
  // OCPD/RCD → RCBO pivot when a seed write is `BS EN 61009`. Skipping
  // it (an earlier draft did) was a Codex-flagged regression: an
  // utterance like "OCPD on circuit 4, BS EN 61009" would stay in OCPD
  // and ask the next OCPD slot instead of switching to the RCBO flow.
  const appliedWrites = [];
  let pivotTo = null;
  for (const w of validWrites) {
    if (state.values[w.field] !== undefined) continue; // skip already-filled
    if (resolvedCircuitRef !== null) {
      const slot = schema.slots.find((s) => s.field === w.field);
      const r = applyWriteWithDerivations(session, schema, slot, resolvedCircuitRef, w.value, now);
      appliedWrites.push(w);
      if (r.pivotTo) pivotTo = r.pivotTo;
    } else {
      // Circuit unknown — queue. The active path drains pending_writes
      // once a digit or designation answer lands.
      state.pending_writes.push(w);
    }
  }

  // Wire-emit the applied extractions so iOS sees the values land
  // immediately. Mirrors runEntry's emit at engine.js:259.
  if (appliedWrites.length > 0) {
    safeSend(
      ws,
      buildExtractionPayload(resolvedCircuitRef, appliedWrites, schema.extractionSource)
    );
  }

  // Pivot — derivation requested a schema transition (e.g. ocpd_bs_en
  // = "BS EN 61009" pivots OCPD → RCBO). Mirrors runEntry's pivot
  // handling at engine.js:293. runPivot clears the current state,
  // initialises the target schema, mirrors any derived values, and
  // emits the next ask itself — so this branch RETURNS early and the
  // normal first-ask emission below is skipped.
  if (pivotTo) {
    runPivot({
      ws,
      session,
      sessionId,
      schemas,
      fromSchema: schema,
      toSchemaName: pivotTo,
      logger,
      now,
    });
    return {
      ok: true,
      status: 'entered',
      schema: pivotTo,
      circuit_ref: resolvedCircuitRef,
      seeded_writes: appliedWrites.map((w) => w.field),
      queued_writes: [],
      dropped_fields: droppedFields,
      pivoted: true,
    };
  }

  logger?.info?.(`${schema.logEventPrefix}_entered`, {
    sessionId,
    circuit_ref: resolvedCircuitRef,
    entry_designation_matched: false,
    pre_existing_filled: Object.keys(state.values).filter(
      (f) => !appliedWrites.some((w) => w.field === f)
    ),
    volunteered_writes: appliedWrites.map((w) => w.field),
    pending_writes: state.pending_writes.map((w) => w.field),
    dropped_fields: droppedFields,
    textPreview: '[server-entered via start_dialogue_script]',
    server_entered: true,
  });

  // Emit the appropriate first ask. If circuit unknown → which_circuit;
  // otherwise next missing slot. With pending_writes possibly already
  // filling the first N slots, we ask about the first slot that is
  // still empty (could be slot[0] if no writes, or a later slot if
  // Sonnet seeded values for the early slots).
  if (resolvedCircuitRef === null) {
    safeSend(
      ws,
      buildScriptAsk({
        toolCallIdPrefix: schema.toolCallIdPrefix,
        sessionId,
        circuit_ref: null,
        missing_field: null,
        whichCircuitQuestion: schema.whichCircuitQuestion,
        slotQuestion: null,
        now,
        kind: 'which_circuit',
      })
    );
  } else {
    const nextSlot = nextMissingSlot(state.values, schema.slots, state.skipped_slots);
    if (nextSlot) {
      safeSend(
        ws,
        buildScriptAsk({
          toolCallIdPrefix: schema.toolCallIdPrefix,
          sessionId,
          circuit_ref: resolvedCircuitRef,
          missing_field: nextSlot.field,
          whichCircuitQuestion: schema.whichCircuitQuestion,
          slotQuestion: nextSlot.question,
          now,
          kind: 'value',
        })
      );
    } else {
      // All slots filled (snapshot pre-fill + seeded writes) — finish
      // immediately. Reachable when Sonnet's pending_writes complete
      // an already-partial snapshot, or when an inspector dictates a
      // full reading family in one breath ("ring continuity for circuit
      // 4 lives 0.32 neutrals 0.31 cpc 0.55") and all three slots seed.
      finishScript({ ws, session, sessionId, schema, logger, now });
    }
  }

  return {
    ok: true,
    status: 'entered',
    schema: schema.name,
    circuit_ref: resolvedCircuitRef,
    seeded_writes: appliedWrites.map((w) => w.field),
    queued_writes: state.pending_writes ? state.pending_writes.map((w) => w.field) : [],
    dropped_fields: droppedFields,
  };
}

/**
 * Resume a paused dialogue script after Sonnet creates/renames a circuit
 * that matches the script's `paused_designation_hint`. Called by the
 * stage6 dispatcher hook after `runLiveMode` finishes a Sonnet turn,
 * with the per-turn `circuit_updates` list passed in. No-op if no
 * paused state exists, the schema didn't opt in, the pause has timed
 * out, or the hint doesn't designation-match one of the just-created
 * circuits.
 *
 * On successful resume:
 *   - state.circuit_ref bound to the matched ref
 *   - state.active flipped back to true, paused flags cleared
 *   - existing snapshot values on the new circuit seeded into state.values
 *   - pending_writes drained onto the new circuit (extraction_payload
 *     emitted to iOS for each)
 *   - next missing slot asked via askNextOrFinish (the disambiguation
 *     step for ambiguous_bare_value lands in a follow-up commit)
 *
 * Designation matching uses the same `findCircuitByDesignation` helper
 * that runEntry / runActivePath use, so the matcher is byte-identical
 * to what an inline circuit-name answer would have hit.
 *
 * Returns `{ resumed: true, circuit_ref }` on success, otherwise
 * `{ resumed: false, reason }` for telemetry.
 */
export function tryResumePausedScript({
  session,
  ws,
  schemas,
  circuitUpdates,
  logger,
  now = Date.now(),
}) {
  const state = session?.dialogueScriptState;
  if (!state || !state.paused) return { resumed: false, reason: 'no_paused_script' };
  if (!Array.isArray(schemas) || schemas.length === 0) {
    return { resumed: false, reason: 'no_schemas' };
  }
  if (!Array.isArray(circuitUpdates) || circuitUpdates.length === 0) {
    return { resumed: false, reason: 'no_circuit_updates' };
  }
  const schema = schemas.find((s) => s.name === state.schemaName);
  if (!schema) return { resumed: false, reason: 'schema_unknown' };
  if (schema.resumeAfterCircuitCreation !== true) {
    return { resumed: false, reason: 'schema_no_opt_in' };
  }

  // Stale-pause sweep — defense in depth (processDialogueTurn also sweeps
  // at the top of every turn). Belt-and-braces because the dispatcher hook
  // may fire on a turn that doesn't go through processDialogueTurn first.
  if (now - (state.paused_at ?? 0) > schema.hardTimeoutMs) {
    logger?.info?.(`${schema.logEventPrefix}_paused_hard_timeout_at_resume`, {
      sessionId: session.sessionId,
      ms_since_paused: now - (state.paused_at ?? 0),
    });
    clearScriptState(session);
    return { resumed: false, reason: 'paused_timeout' };
  }

  const designationHint = state.paused_designation_hint;
  if (typeof designationHint !== 'string' || designationHint.length === 0) {
    return { resumed: false, reason: 'no_designation_hint' };
  }
  const matchedRef = findCircuitByDesignation(session, designationHint);
  if (matchedRef === null) {
    return { resumed: false, reason: 'no_designation_match' };
  }

  // Confirm matchedRef is among the just-created / renamed circuits —
  // guards against accidentally resuming on a pre-existing circuit that
  // happens to designation-match (it would have matched at entry-time
  // and never paused in the first place; if we still get here, Sonnet
  // edited a different circuit and we shouldn't claim its create as
  // the resume trigger).
  const matchingOp = circuitUpdates.find(
    (op) => (op?.op === 'create' || op?.op === 'rename') && op?.circuit_ref === matchedRef
  );
  if (!matchingOp) {
    return { resumed: false, reason: 'matched_ref_not_in_circuit_updates' };
  }

  const previouslyPausedHint = designationHint;
  const previouslyPausedAt = state.paused_at;

  // Re-arm script for the active path on the bound circuit.
  state.active = true;
  state.paused = false;
  state.paused_designation_hint = null;
  state.paused_at = null;
  state.circuit_ref = matchedRef;
  state.last_turn_at = now;
  state.circuit_retry_attempted = false;
  state.last_designation_attempt = null;

  const slotFields = schema.slots.map((s) => s.field);
  const existing = readExistingValues(session, matchedRef, slotFields);
  for (const [f, v] of Object.entries(existing)) {
    if (slotFields.includes(f) && v !== '' && v !== null && v !== undefined) {
      state.values[f] = v;
    }
  }

  const drainedWrites = [];
  if (Array.isArray(state.pending_writes) && state.pending_writes.length > 0) {
    for (const w of state.pending_writes) {
      if (state.values[w.field] !== undefined) continue;
      applyWrite(session, schema, matchedRef, w.field, w.value, now);
      drainedWrites.push(w);
    }
    state.pending_writes = [];
  }

  if (drainedWrites.length > 0) {
    safeSend(ws, buildExtractionPayload(matchedRef, drainedWrites, schema.extractionSource));
  }

  logger?.info?.(`${schema.logEventPrefix}_resumed_after_circuit_create`, {
    sessionId: session.sessionId,
    circuit_ref: matchedRef,
    matched_via_designation: previouslyPausedHint,
    ms_since_paused: now - previouslyPausedAt,
    drained_pending_writes: drainedWrites.map((w) => w.field),
    ambiguous_bare_value: state.ambiguous_bare_value?.value ?? null,
    circuit_op: matchingOp.op,
  });

  // Disambiguation pre-step for an ambiguous bare value captured at
  // entry. Three branches:
  //
  //   (1) Both L-L and L-E are still empty → can't infer which slot the
  //       bare value belongs to; ask the inspector. State flips into
  //       `awaiting_disambiguation` mode and the active path's pre-slot
  //       check (added below) routes the next reply through the
  //       schema's `disambiguateBareValue`.
  //   (2) Exactly ONE of L-L/L-E is already filled (existing snapshot
  //       value or a drained pending_write) → auto-assign the bare
  //       value to the OTHER slot and continue. No question needed
  //       because there's only one possible target.
  //   (3) Both L-L and L-E filled → the bare value is redundant.
  //       Discard with a log; the script continues to whatever's
  //       still missing (probably voltage).
  //
  // Schema gates: `bareDisambiguationQuestion` + `disambiguateBareValue`
  // must be functions for branch (1) to fire; otherwise fall through
  // to the standard askNextOrFinish.
  if (
    state.ambiguous_bare_value !== null &&
    typeof schema.bareDisambiguationQuestion === 'function' &&
    typeof schema.disambiguateBareValue === 'function'
  ) {
    const llFilled = state.values.ir_live_live_mohm != null;
    const leFilled = state.values.ir_live_earth_mohm != null;
    const bare = state.ambiguous_bare_value;

    if (!llFilled && !leFilled) {
      // Branch (1): true ambiguity — ask.
      state.awaiting_disambiguation = bare;
      state.ambiguous_bare_value = null;
      const question = schema.bareDisambiguationQuestion(bare.value);
      logger?.info?.(`${schema.logEventPrefix}_disambiguation_asked`, {
        sessionId: session.sessionId,
        circuit_ref: matchedRef,
        bare_value: bare.value,
      });
      safeSend(
        ws,
        buildScriptAsk({
          toolCallIdPrefix: schema.toolCallIdPrefix,
          sessionId: session.sessionId,
          circuit_ref: matchedRef,
          missing_field: '_ir_disambiguate_bare',
          whichCircuitQuestion: null,
          slotQuestion: question,
          now,
          kind: 'value',
        })
      );
      return { resumed: true, circuit_ref: matchedRef };
    }

    if (llFilled !== leFilled) {
      // Branch (2): exactly one filled — auto-assign the bare value to
      // the other slot. No user question.
      const targetField = llFilled ? 'ir_live_earth_mohm' : 'ir_live_live_mohm';
      applyWrite(session, schema, matchedRef, targetField, bare.value, now);
      state.values[targetField] = bare.value;
      state.ambiguous_bare_value = null;
      logger?.info?.(`${schema.logEventPrefix}_disambiguation_auto_assigned`, {
        sessionId: session.sessionId,
        circuit_ref: matchedRef,
        bare_value: bare.value,
        target_field: targetField,
        reason: llFilled ? 'll_already_filled' : 'le_already_filled',
      });
      safeSend(
        ws,
        buildExtractionPayload(
          matchedRef,
          [{ field: targetField, value: bare.value }],
          schema.extractionSource
        )
      );
      askNextOrFinish({ ws, session, sessionId: session.sessionId, schema, logger, now });
      return { resumed: true, circuit_ref: matchedRef };
    }

    // Branch (3): both filled — bare value is redundant. Discard and
    // proceed.
    logger?.info?.(`${schema.logEventPrefix}_disambiguation_discarded`, {
      sessionId: session.sessionId,
      circuit_ref: matchedRef,
      bare_value: bare.value,
      reason: 'both_slots_already_filled',
    });
    state.ambiguous_bare_value = null;
  }

  askNextOrFinish({ ws, session, sessionId: session.sessionId, schema, logger, now });

  return { resumed: true, circuit_ref: matchedRef };
}

// Test-only exports for unit tests.
export const __testing__ = {
  detectEntry,
  detectDifferentEntry,
  initScriptState,
  clearScriptState,
};
