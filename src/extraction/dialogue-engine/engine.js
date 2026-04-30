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
  safeSend,
} from './helpers/wire-emit.js';

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
        return runActivePath({ ws, session, sessionId, text, transcriptText, schema, logger, now });
      }
    }
  }

  // Entry detection — first matching schema wins.
  for (const schema of schemas) {
    const entry = detectEntry(text, schema);
    if (!entry.matched) continue;
    return runEntry({ ws, session, sessionId, text, schema, entry, logger, now });
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
 * Initialise the dialogue state for a freshly-entered script.
 */
function initScriptState(session, schema, circuit_ref, now) {
  session.dialogueScriptState = {
    active: true,
    schemaName: schema.name,
    circuit_ref,
    values: {},
    pending_writes: [],
    entered_at: now,
    last_turn_at: now,
  };
}

/**
 * Handle the entry turn for a schema (no prior state, trigger
 * matched). Resolves the circuit (regex or designation), seeds the
 * values map with any pre-existing snapshot values, applies any
 * volunteered values from the entry utterance, then asks for the next
 * missing slot.
 */
function runEntry({ ws, session, sessionId, text, schema, entry, logger, now }) {
  let circuitRef = entry.circuit_ref;
  let entryDesignationMatched = false;
  if (circuitRef === null) {
    const designationMatch = findCircuitByDesignation(session, text);
    if (designationMatch !== null) {
      circuitRef = designationMatch;
      entryDesignationMatched = true;
    }
  }

  const slotFields = schema.slots.map((s) => s.field);
  const existing = circuitRef ? readExistingValues(session, circuitRef, slotFields) : {};
  const volunteered = extractNamedFieldValues(text, schema.slots);

  initScriptState(session, schema, circuitRef, now);
  const state = session.dialogueScriptState;

  // Seed values from existing snapshot — skip-already-filled relies on this.
  for (const [f, v] of Object.entries(existing)) {
    if (slotFields.includes(f) && v !== '' && v !== null && v !== undefined) {
      state.values[f] = v;
    }
  }

  // Apply or queue volunteered values from the entry utterance.
  const writes = [];
  for (const w of volunteered) {
    if (state.values[w.field] !== undefined) continue;
    if (circuitRef !== null) {
      applyWrite(session, schema, circuitRef, w.field, w.value, now);
      writes.push(w);
    } else {
      // Circuit not yet known → queue. The active path drains
      // pending_writes once a digit or designation answer lands.
      state.pending_writes.push(w);
    }
  }

  if (writes.length > 0) {
    safeSend(ws, buildExtractionPayload(circuitRef, writes, schema.extractionSource));
  }

  logger?.info?.(`${schema.logEventPrefix}_entered`, {
    sessionId,
    circuit_ref: circuitRef,
    entry_designation_matched: entryDesignationMatched,
    pre_existing_filled: Object.keys(existing).filter((f) => slotFields.includes(f)),
    volunteered_writes: writes.map((w) => w.field),
    pending_writes: state.pending_writes.map((w) => w.field),
    textPreview: text.slice(0, 80),
  });

  // What do we ask next?
  if (circuitRef === null) {
    // Entry without a circuit. Ask which one.
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
    return { handled: true, fallthrough: false };
  }

  return askNextOrFinish({ ws, session, sessionId, schema, logger, now });
}

/**
 * Active path: a script is already in progress on this session. Walks
 * cancel → different-entry → topic-switch → circuit-resolution →
 * value-extraction → ask-next-or-finish, in that order.
 */
function runActivePath({ ws, session, sessionId, text, transcriptText, schema, logger, now }) {
  const state = session.dialogueScriptState;
  state.last_turn_at = now;

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
  //    designation answer falls out via findCircuitByDesignation.
  const writes = [];
  let drainedFromPending = false;
  let circuitResolvedThisTurn = false;
  if (state.circuit_ref === null) {
    let ref = parseCircuitDigit(text);
    if (ref === null) {
      const designationMatch = findCircuitByDesignation(session, text);
      if (designationMatch !== null) {
        ref = designationMatch;
        logger?.info?.(`${schema.logEventPrefix}_designation_match`, {
          sessionId,
          circuit_ref: ref,
          textPreview: text.slice(0, 80),
        });
      }
    }
    if (ref !== null) {
      state.circuit_ref = ref;
      circuitResolvedThisTurn = true;
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
      // Nothing to work with — exit and let Sonnet handle.
      logger?.info?.(`${schema.logEventPrefix}_unresolvable_circuit`, {
        sessionId,
        textPreview: text.slice(0, 80),
        discarded_pending_writes: Array.isArray(state.pending_writes)
          ? state.pending_writes.map((w) => w.field)
          : [],
      });
      clearScriptState(session);
      return { handled: true, fallthrough: true, transcriptText };
    }
  }

  // 5. Identify the slot we're currently expecting (next missing).
  //    If the schema declares a `currentExpectedSlot` hook (used by IR
  //    to enforce voltage-only parsing in the voltage phase), call it
  //    instead of the default.
  const currentSlot = nextMissingSlot(state.values, schema.slots);

  // 6. Schema-specific exclusive-parser hook (for IR voltage phase):
  //    when the current expected slot has `exclusiveWhenExpected: true`,
  //    skip named-field extraction and run only this slot's parser on
  //    the bare text. If nothing parses, finish silently.
  if (currentSlot && currentSlot.exclusiveWhenExpected) {
    const value = currentSlot.parser(text);
    if (value !== null && value !== undefined) {
      applyWrite(session, schema, state.circuit_ref, currentSlot.field, value, now);
      writes.push({ field: currentSlot.field, value });
    }
    if (writes.length > 0) {
      safeSend(ws, buildExtractionPayload(state.circuit_ref, writes, schema.extractionSource));
    }
    finishScript({ ws, session, sessionId, schema, logger, now });
    return { handled: true, fallthrough: false };
  }

  // 7. Named-field extraction — multiple slots can fill from one
  //    utterance ("circuit 1, neutrals 0.43" already-resolved variant).
  const named = extractNamedFieldValues(text, schema.slots);
  for (const w of named) {
    if (state.values[w.field] !== undefined) continue;
    applyWrite(session, schema, state.circuit_ref, w.field, w.value, now);
    writes.push(w);
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
    if (bareValue !== null && bareValue !== undefined) {
      applyWrite(session, schema, state.circuit_ref, currentSlot.field, bareValue, now);
      writes.push({ field: currentSlot.field, value: bareValue });
    }
  }

  if (writes.length > 0) {
    safeSend(ws, buildExtractionPayload(state.circuit_ref, writes, schema.extractionSource));
  }

  return askNextOrFinish({ ws, session, sessionId, schema, logger, now });
}

/**
 * After any writes have landed, ask for the next missing slot or
 * finish the script. Shared between entry-path and active-path.
 */
function askNextOrFinish({ ws, session, sessionId, schema, logger, now }) {
  const state = session.dialogueScriptState;
  const nextSlot = nextMissingSlot(state.values, schema.slots);
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

// Test-only exports for unit tests.
export const __testing__ = {
  detectEntry,
  detectDifferentEntry,
  initScriptState,
  clearScriptState,
};
