/**
 * f7-audibility-core.js — ENVIRONMENT-NEUTRAL audibility invariant helpers
 * (plan replay-corpus-gate-2026-07, Item 2 "Jest-independent invariant
 * module"). Extracted from f7-audibility-matrix.js as an INTERFACE REFACTOR,
 * not a pure move: the original `iosSendAttempts` read
 * `logger.info.mock.calls` (a jest-mock API) and `turnIsAudible` expected
 * the F7 WS stub's `ws.sent` — both are environment-bound. The core
 * versions accept PLAIN CAPTURED ARRAYS; thin jest and standalone-runner
 * ADAPTERS convert their respective logger/WS captures (parity tests prove
 * both adapters return identical verdicts).
 *
 * HARD CONSTRAINT: this module imports NOTHING from src/extraction/ (and no
 * jest). The replay runner imports it BEFORE the fake clock installs and
 * before any extraction module is dynamically imported — a production
 * import here would evaluate extraction modules early and break the
 * bootstrap's zero-extraction-static-imports rule.
 */

// ───────────────────────────────────────────────────────────────────────────
// WS-stub fixtures (env-neutral: they are plain objects recording frames).
// Production checks `ws.readyState === ws.OPEN` before sending, so a stub
// with only `readyState: 1` (and no `OPEN`) makes EVERY send look closed —
// a missing-`OPEN` double already burned the field-feedback wave.
// ───────────────────────────────────────────────────────────────────────────

/** Open WS stub: OPEN:1, readyState:1, records each parsed frame in `sent`. */
export function makeOpenWs() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(payload) {
      this.sent.push(JSON.parse(payload));
    },
  };
}

/** Closed WS stub (readyState 3): production's guard never calls send. */
export function makeClosedWs() {
  const ws = makeOpenWs();
  ws.readyState = 3;
  return ws;
}

/** Throwing WS stub: OPEN so production ATTEMPTS the send, but send throws. */
export function makeThrowingWs() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send() {
      throw new Error('ws send failed (throwing-stub)');
    },
  };
}

/** `ask_user_started` frames in a plain captured frame array. */
export function askStartedFrames(sentFrames) {
  if (!Array.isArray(sentFrames)) return [];
  return sentFrames.filter((f) => f && f.type === 'ask_user_started');
}

// ───────────────────────────────────────────────────────────────────────────
// Mock-Anthropic SSE round builders (moved UNCHANGED from the matrix module).
// ───────────────────────────────────────────────────────────────────────────

/** Build one tool_use round's SSE events from an array of {id, name, input}. */
export function toolUseRound(toolCalls) {
  const events = [];
  toolCalls.forEach((tc, i) => {
    events.push({
      type: 'content_block_start',
      index: i,
      content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
    });
    events.push({
      type: 'content_block_delta',
      index: i,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input ?? {}) },
    });
    events.push({ type: 'content_block_stop', index: i });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  return events;
}

/** Build one end_turn round's SSE events (optional trailing text). */
export function endTurnRound(text = '') {
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ];
}

// ───────────────────────────────────────────────────────────────────────────
// Audibility oracles (env-neutral forms).
// Audible text is defined EVERYWHERE as a trimmed-non-empty string — web
// trims before speaking, so a whitespace-only prompt must NOT count.
// ───────────────────────────────────────────────────────────────────────────

/** Audible text predicate — trimmed-non-empty string. */
export function isAudibleText(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

/**
 * Audibility oracle over plain captures: a chime-producing turn is audible
 * iff the captured frames include ≥1 `ask_user_started` OR the result
 * carries ≥1 confirmation with trimmed-non-empty text. NEVER decided by
 * outcome name — only observed emission + surviving spoken text.
 */
export function turnIsAudible(result, sentFrames) {
  const confs = Array.isArray(result?.confirmations) ? result.confirmations : [];
  const spoke = confs.some((c) => isAudibleText(c?.text));
  // An emitted ask counts as audible ONLY if it carries speakable question
  // text. A chime followed by an empty/whitespace-only ask frame is silence
  // to a hands-free inspector — counting the bare frame would let the
  // beep-to-speech invariant pass with nothing spoken (see the line-100
  // invariant: a whitespace-only prompt must NOT count).
  const emitted = askStartedFrames(sentFrames).some((f) => isAudibleText(f?.question));
  return spoke || emitted;
}

/** Surviving wire confirmations with audible text (invariant (b)). */
export function audibleConfirmations(result) {
  const confs = Array.isArray(result?.confirmations) ? result.confirmations : [];
  return confs.filter((c) => isAudibleText(c?.text));
}

/**
 * Every `ios_send_attempt` telemetry row from a PLAIN captured log-row
 * array: entries are `{ name, meta }` (the standalone runner records rows
 * in this shape; the jest adapter converts `logger.info.mock.calls`).
 */
export function iosSendAttempts(logRows) {
  if (!Array.isArray(logRows)) return [];
  return logRows.filter((r) => r && r.name === 'ios_send_attempt').map((r) => r.meta);
}

/** True if ANY wire confirmation entry carries a `_confidence` key. */
export function anyConfidenceKeyOnWire(result) {
  const confs = Array.isArray(result?.confirmations) ? result.confirmations : [];
  return confs.some((c) => c && Object.prototype.hasOwnProperty.call(c, '_confidence'));
}

/**
 * Collect every spoken text string: confirmations + expanded_text + reading
 * expanded_text + the TRIMMED QUESTION TEXT OF EVERY EMITTED ASK FRAME.
 * The pre-refactor pair inspected only confirmations + extracted readings —
 * despite the helper comment it never saw `ask_user_started` frames, leaving
 * the blocking no-`__`-sentinel assertion blind to a sentinel spoken in a
 * clarification QUESTION.
 */
export function spokenTexts(result, sentFrames) {
  const out = [];
  const confs = Array.isArray(result?.confirmations) ? result.confirmations : [];
  for (const c of confs) {
    if (typeof c?.text === 'string') out.push(c.text);
    if (typeof c?.expanded_text === 'string') out.push(c.expanded_text);
  }
  const readings = Array.isArray(result?.extracted_readings) ? result.extracted_readings : [];
  for (const r of readings) {
    if (typeof r?.expanded_text === 'string') out.push(r.expanded_text);
  }
  for (const f of askStartedFrames(sentFrames)) {
    if (typeof f?.question === 'string') out.push(f.question.trim());
  }
  return out;
}

/** True if any spoken text (incl. emitted ask questions) contains `__`. */
export function anySentinelInSpokenText(result, sentFrames) {
  return spokenTexts(result, sentFrames).some((t) => typeof t === 'string' && t.includes('__'));
}
