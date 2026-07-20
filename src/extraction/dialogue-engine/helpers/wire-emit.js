/**
 * Wire-emit helpers — produce the `ask_user_started` and `extraction`
 * payloads iOS already understands. Each schema declares its own
 * `toolCallIdPrefix` and `extractionSource` so the emitted shapes stay
 * byte-identical to the per-domain scripts they replace.
 */

import { applyFieldNameCorrection } from '../../field-name-corrections.js';

/**
 * PLAN-C P4d (row 1) — the response-epoch stamping primitives for the
 * dialogue-engine ask CREATION paths.
 *
 * Every `ask_user_started` frame the engine emits in response to a chimed
 * utterance must carry that utterance's response epoch (`utterance_id`) so the
 * client chime-silence watchdog disarms on the spoken question instead of
 * false-firing a 20s native apology over an ask the inspector already heard.
 *
 * `RESPONSE_EPOCH_REQUIRED` is a sentinel default on all three builders. A
 * builder called WITHOUT threading the argument (a missed nested-fn thread)
 * hits the sentinel and THROWS — turning a silent-null epoch leak into a loud
 * test/lint failure (the plan's REQUIRED contract). An explicit `null` (there
 * is genuinely no arming utterance — e.g. a test path or a script entered
 * outside a live turn) is allowed and simply omits the wire field.
 *
 * `stampResponseEpoch` adds `utterance_id` ONLY for a non-empty string epoch,
 * so the no-epoch case stays byte-identical to the pre-P4d wire shape and the
 * `advanceResponseEpoch` "non-empty only" rule (P4c) is mirrored here.
 */
export const RESPONSE_EPOCH_REQUIRED = Symbol('dialogue.responseEpoch.required');

function requireResponseEpoch(fnName, responseEpoch) {
  if (responseEpoch === RESPONSE_EPOCH_REQUIRED) {
    throw new Error(
      `${fnName}: responseEpoch is required — thread the creation-time response ` +
        `epoch through, or pass null explicitly when there is no arming utterance.`
    );
  }
}

function stampResponseEpoch(payload, responseEpoch) {
  if (typeof responseEpoch === 'string' && responseEpoch) {
    payload.utterance_id = responseEpoch;
  }
  return payload;
}

/**
 * Build an ask_user_started payload for a missing slot. Three flavours:
 *   - 'which_circuit' → entry without a circuit number; question asks
 *                       for the circuit, not a value. context_field /
 *                       context_circuit are null (iOS re-routes the
 *                       answer back through the engine on the next
 *                       turn).
 *   - 'value'         → standard "what's the next reading?" prompt.
 *   - 'value_no_field' → same as 'value' but emits null context_field
 *                        (kept for the IR voltage tool_call_id pattern,
 *                        which uses the field name in the ID; the
 *                        existing scripts use this shape too).
 *
 * Returns the wire-shape object ready to JSON.stringify and send.
 */
export function buildScriptAsk({
  toolCallIdPrefix,
  sessionId,
  circuit_ref,
  missing_field,
  whichCircuitQuestion,
  slotQuestion,
  now,
  kind,
  responseEpoch = RESPONSE_EPOCH_REQUIRED,
}) {
  requireResponseEpoch('buildScriptAsk', responseEpoch);
  if (kind === 'which_circuit') {
    return stampResponseEpoch(
      {
        type: 'ask_user_started',
        tool_call_id: `${toolCallIdPrefix}-${sessionId}-which-${now}`,
        question: whichCircuitQuestion,
        reason: 'missing_context',
        context_field: null,
        context_circuit: null,
        expected_answer_shape: 'value',
      },
      responseEpoch
    );
  }
  // Post-completion bulk-apply prompt (RCD, 2026-05-21). Acts like
  // 'which_circuit' on the wire (null context_field/circuit, value
  // shape so iOS waits for a reply) but uses an explicit prompt text
  // passed via slotQuestion. Tool-call-id includes "bulk-apply" so
  // the call stays distinct from the slot asks the engine just
  // emitted.
  if (kind === 'bulk_apply') {
    return stampResponseEpoch(
      {
        type: 'ask_user_started',
        tool_call_id: `${toolCallIdPrefix}-${sessionId}-bulk-apply-${now}`,
        question: slotQuestion,
        reason: 'missing_context',
        context_field: null,
        context_circuit: null,
        expected_answer_shape: 'value',
      },
      responseEpoch
    );
  }
  return stampResponseEpoch(
    {
      type: 'ask_user_started',
      tool_call_id: `${toolCallIdPrefix}-${sessionId}-${circuit_ref}-${missing_field}-${now}`,
      question: slotQuestion,
      reason: 'missing_value',
      context_field: missing_field,
      context_circuit: circuit_ref,
      expected_answer_shape: 'value',
    },
    responseEpoch
  );
}

/**
 * Phrase a disambiguation prompt for an ambiguous designation match.
 * Quotes the shared designation back to the inspector and lists the
 * candidate circuit refs ("Which 'sockets' — circuit 2, 4 or 7?").
 *
 * `sharedDesignation` is the lowercased canonical text shared by every
 * candidate; pass null when candidates have distinct designations and
 * the engine wants the generic "Which one — circuit X or Y?" form.
 * `candidates` must be a sorted array of two or more positive ints.
 */
export function buildDisambiguationQuestion(sharedDesignation, candidates) {
  if (!Array.isArray(candidates) || candidates.length < 2) {
    return 'Which circuit?';
  }
  const list = formatCircuitList(candidates);
  if (typeof sharedDesignation === 'string' && sharedDesignation.trim()) {
    return `Which '${sharedDesignation.trim()}' — circuit ${list}?`;
  }
  return `Which one — circuit ${list}?`;
}

/**
 * Format an int list for natural-sounding TTS:
 *   [2, 4]        → "2 or 4"
 *   [2, 4, 7]     → "2, 4 or 7"
 *   [2, 4, 7, 10] → "2, 4, 7 or 10"
 *
 * Oxford-comma-free because the TTS reads more naturally without it
 * and the inspector only needs to hear the digits clearly.
 */
function formatCircuitList(refs) {
  if (refs.length === 1) return String(refs[0]);
  if (refs.length === 2) return `${refs[0]} or ${refs[1]}`;
  const head = refs.slice(0, -1).join(', ');
  const tail = refs[refs.length - 1];
  return `${head} or ${tail}`;
}

/**
 * Build the end-of-loop confirmation ask. Used by schemas that opt in
 * via `confirmationMessage(values)` — e.g. ring-continuity asks "R1 X,
 * Rn Y, R2 Z. All correct?" so the inspector can amend a Deepgram-
 * garbled reading before completion. Mirrors `buildScriptAsk`'s
 * `ask_user_started` shape so iOS doesn't need a new payload type;
 * distinguished by the `confirm` tool_call_id segment and the
 * schema-supplied `reason`. Byte-identical to the legacy
 * ring-continuity-script.js `buildScriptConfirm` when called with the
 * same prefix / sessionId / circuit_ref / now arguments.
 */
export function buildScriptConfirm({
  toolCallIdPrefix,
  sessionId,
  circuit_ref,
  question,
  reason,
  now,
  responseEpoch = RESPONSE_EPOCH_REQUIRED,
}) {
  requireResponseEpoch('buildScriptConfirm', responseEpoch);
  return stampResponseEpoch(
    {
      type: 'ask_user_started',
      tool_call_id: `${toolCallIdPrefix}-${sessionId}-${circuit_ref}-confirm-${now}`,
      question,
      reason,
      context_field: null,
      context_circuit: circuit_ref,
      expected_answer_shape: 'value',
    },
    responseEpoch
  );
}

/**
 * Build a completion / cancellation TTS payload. Piggybacks on
 * `ask_user_started` with `expected_answer_shape: 'none'` because that's
 * the wire shape iOS already plays through ElevenLabs; iOS treats the
 * 'none' shape as a brief informational announcement.
 */
export function buildScriptInfo({
  toolCallIdPrefix,
  sessionId,
  kind,
  text,
  now,
  responseEpoch = RESPONSE_EPOCH_REQUIRED,
}) {
  requireResponseEpoch('buildScriptInfo', responseEpoch);
  return stampResponseEpoch(
    {
      type: 'ask_user_started',
      tool_call_id: `${toolCallIdPrefix}-${sessionId}-${kind}-${now}`,
      question: text,
      reason: 'info',
      context_field: null,
      context_circuit: null,
      expected_answer_shape: 'none',
    },
    responseEpoch
  );
}

/**
 * Build the extraction payload for one or more script-driven writes.
 * Mirrors `extracted_readings` shape so iOS sees the same structure as
 * Sonnet emits via the bundler.
 *
 * Audit-2026-06-02 Phase 2: writes carrying `auto_resolved: true` (the
 * derivation-mirror entries that applyDerivations now surfaces back to
 * the engine call sites) propagate that flag onto the resulting reading.
 * Pre-existing iOS decoders ignore the extra key; the bundler-emitted
 * Sonnet path has carried the same flag for over a year via the same
 * spread pattern. Setting it conditionally (only when truthy) keeps
 * the wire shape byte-identical for non-derivation writes.
 *
 * Audit-2026-06-02 Phase 3: applies the canonical → legacy field-name
 * rewrite inline so the dialogue-engine emit path is in lockstep with
 * the bundler path. Pre-Phase-3 a dialogue-driven write of
 * `ir_live_live_mohm` shipped to iOS with the canonical name; iOS
 * accepted it via the dual-alias decoder switch but the wire shape
 * documented the leak as the reality. Helper lives in
 * field-name-corrections.js (leaf module) to avoid circularly
 * importing sonnet-stream's WS handler graph.
 */
export function buildExtractionPayload(circuit_ref, writes, source) {
  return {
    type: 'extraction',
    result: {
      readings: writes.map((w) => {
        const reading = {
          field: w.field,
          circuit: circuit_ref,
          value: w.value,
          confidence: 1.0,
          source,
        };
        if (w.auto_resolved) reading.auto_resolved = true;
        // Apply field-name correction inline so a canonical Stage-6
        // name (e.g. `ir_live_live_mohm`) shows up on the wire as the
        // legacy iOS-facing name (`insulation_resistance_l_l`). Helper
        // is a no-op when the field name has no entry — engine schemas
        // that already use legacy names (rcdSchema's `rcd_trip_time`)
        // pass through unchanged. We pass null sessionId + null logger
        // because this hot path runs per emit; the bundler's path logs
        // identical "Field corrected" rows from sonnet-stream.js so
        // double-logging would just clutter CloudWatch.
        applyFieldNameCorrection(reading, null, null);
        return reading;
      }),
      observations: [],
      questions: [],
    },
  };
}

/**
 * F7 Item 2 — best-effort emission observer key. `runLiveMode`
 * (stage6-shadow-harness.js) attaches an `onAskUserStarted({toolCallId,
 * source})` callback to the live WS under this Symbol so `safeSend` can fire
 * it whenever it SUCCESSFULLY sends an `ask_user_started` frame from the
 * dialogue engine — the SINGLE choke point for every engine emission path
 * (enterScriptByName, tryResumePausedScript, tryEnterScriptFromWrites, and
 * their nested runPivot / disambiguation / askNextOrFinish sends). Firing here
 * structurally captures current AND future engine emission paths without
 * enumerating them (which does not converge — see the plan). Best-effort: the
 * observer runs AFTER the send returns and never alters send behaviour.
 */
export const ASK_STARTED_OBSERVER = Symbol('f7.askStartedObserver');

/**
 * Send a JSON payload over the WS, swallowing send errors. The script's
 * persistent state is the source of truth, not the wire.
 */
export function safeSend(ws, payload) {
  if (!ws || typeof ws.send !== 'function') return;
  try {
    if (ws.readyState !== undefined && ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
    // F7 Item 2 — report a SUCCESSFUL ask_user_started emission to the
    // per-turn audit observer (attached by runLiveMode). Runs only after
    // ws.send returns, so a swallowed/closed send never reports. Own
    // try/catch: an observer bug must never tear down the script.
    if (payload && payload.type === 'ask_user_started') {
      try {
        ws[ASK_STARTED_OBSERVER]?.({
          toolCallId: payload.tool_call_id,
          source: 'dialogue_script',
          // PLAN-C P4d (row 1) — the SEND-TIME stamped-id backstop. The
          // response epoch is snapshotted at frame CREATION by each builder
          // (never derived here — safeSend must NOT attach the epoch), so this
          // is a pure read of what already crossed the wire. `null` when the
          // creation-time epoch was empty/absent; a test asserts every engine
          // ask that armed a chime carried a non-null id.
          utteranceId: typeof payload.utterance_id === 'string' ? payload.utterance_id : null,
        });
      } catch {
        // best-effort observer — never propagate
      }
    }
  } catch {
    // Intentional: WS send failures must not tear down the script.
  }
}
