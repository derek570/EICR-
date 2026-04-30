/**
 * Wire-emit helpers — produce the `ask_user_started` and `extraction`
 * payloads iOS already understands. Each schema declares its own
 * `toolCallIdPrefix` and `extractionSource` so the emitted shapes stay
 * byte-identical to the per-domain scripts they replace.
 */

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
}) {
  if (kind === 'which_circuit') {
    return {
      type: 'ask_user_started',
      tool_call_id: `${toolCallIdPrefix}-${sessionId}-which-${now}`,
      question: whichCircuitQuestion,
      reason: 'missing_context',
      context_field: null,
      context_circuit: null,
      expected_answer_shape: 'value',
    };
  }
  return {
    type: 'ask_user_started',
    tool_call_id: `${toolCallIdPrefix}-${sessionId}-${circuit_ref}-${missing_field}-${now}`,
    question: slotQuestion,
    reason: 'missing_value',
    context_field: missing_field,
    context_circuit: circuit_ref,
    expected_answer_shape: 'value',
  };
}

/**
 * Build a completion / cancellation TTS payload. Piggybacks on
 * `ask_user_started` with `expected_answer_shape: 'none'` because that's
 * the wire shape iOS already plays through ElevenLabs; iOS treats the
 * 'none' shape as a brief informational announcement.
 */
export function buildScriptInfo({ toolCallIdPrefix, sessionId, kind, text, now }) {
  return {
    type: 'ask_user_started',
    tool_call_id: `${toolCallIdPrefix}-${sessionId}-${kind}-${now}`,
    question: text,
    reason: 'info',
    context_field: null,
    context_circuit: null,
    expected_answer_shape: 'none',
  };
}

/**
 * Build the extraction payload for one or more script-driven writes.
 * Mirrors `extracted_readings` shape so iOS sees the same structure as
 * Sonnet emits via the bundler.
 */
export function buildExtractionPayload(circuit_ref, writes, source) {
  return {
    type: 'extraction',
    result: {
      readings: writes.map((w) => ({
        field: w.field,
        circuit: circuit_ref,
        value: w.value,
        confidence: 1.0,
        source,
      })),
      observations: [],
      questions: [],
    },
  };
}

/**
 * Send a JSON payload over the WS, swallowing send errors. The script's
 * persistent state is the source of truth, not the wire.
 */
export function safeSend(ws, payload) {
  if (!ws || typeof ws.send !== 'function') return;
  try {
    if (ws.readyState !== undefined && ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  } catch {
    // Intentional: WS send failures must not tear down the script.
  }
}
