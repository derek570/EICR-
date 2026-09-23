/**
 * PLAN-B (feedback-2026-09-17, B2) — repeat visibility for the model's own asks.
 *
 * WHAT: a per-session counter, keyed by `deriveAskKey`, of UNUSABLE replies to
 * the model's `ask_user` calls. When a key reaches its second unusable reply,
 * the ask's tool result gains a `[Server note: repeat_ask. …]` so the model's
 * next provider round in the same loop sees it before it can ask a third time.
 *
 * WHY: Derek's Decision 3 (2026-09-18) removed the per-key ask budget and
 * restrained mode — "If the model is deciding it should stop the garble storm,
 * shouldn't it?". But the model's recent-context window carries only read-back
 * turns, so it cannot see that it already asked twice. This note tells it. It
 * is information, never a gate: nothing is blocked, a third ask still
 * dispatches, and `stage6.repeat_ask {count}` records it. If the field shows
 * the model ignoring the note, the lever is the prompt or the model — never a
 * new cap.
 *
 * WHAT COUNTS AS UNUSABLE (the plan's classifier table):
 *   - outcome `timeout` or `user_moved_on`;
 *   - `answered` whose body carries `match_status: 'value_escalated'` with
 *     `parsed_hint === 'no_numeric_in_reply'` or a `multiple_numerics:` hint,
 *     and no write to the asked slot this turn.
 * Enum rejections (`invalid_value` / `did_you_mean`) are EXCLUDED: PLAN-C3 owns
 * that flow and its own notice. A usable answer resets the key.
 *
 * The classifier reads the EMITTED tool-result body, never a log row.
 */

import { deriveAskKey } from './stage6-ask-gate-wrapper.js';
import { EFFECTIVE_CIRCUIT_SLOT, projectReadingWinners } from './stage6-per-turn-writes.js';

/** The count at which the note is appended. */
export const REPEAT_ASK_NOTE_THRESHOLD = 2;

const UNUSABLE_NON_ANSWER_REASONS = new Set(['timeout', 'user_moved_on']);

function parseBody(result) {
  try {
    const body = JSON.parse(result?.content ?? 'null');
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

function isUnusableValueHint(parsedHint) {
  return (
    parsedHint === 'no_numeric_in_reply' ||
    (typeof parsedHint === 'string' && parsedHint.startsWith('multiple_numerics:'))
  );
}

function askedSlotWrittenThisTurn(input, perTurnWrites) {
  const field = input?.context_field;
  const circuit = input?.context_circuit;
  if (typeof field !== 'string' || !field || circuit == null) return false;
  for (const winner of projectReadingWinners(perTurnWrites)) {
    const value = winner?.value;
    const slot = value?.[EFFECTIVE_CIRCUIT_SLOT] ?? value;
    if (slot?.field === field && String(slot?.circuit) === String(circuit)) return true;
  }
  return false;
}

/**
 * Classify one `ask_user` tool result.
 *
 * @returns {{ kind: 'unusable', reply: object } | { kind: 'usable' } | { kind: 'ignored' }}
 *   `ignored` means the reply says nothing about usability (a pre-emit
 *   suppression, an enum rejection, or an unparseable body) and leaves the
 *   counter untouched.
 */
export function classifyAskReply({ input, result, perTurnWrites }) {
  const body = parseBody(result);
  if (!body) return { kind: 'ignored' };
  if (body.answered !== true) {
    if (UNUSABLE_NON_ANSWER_REASONS.has(body.reason)) {
      return { kind: 'unusable', reply: { outcome: body.reason } };
    }
    return { kind: 'ignored' };
  }
  if (body.match_status === 'invalid_value' || body.match_status === 'did_you_mean') {
    return { kind: 'ignored' };
  }
  if (body.match_status === 'value_escalated' && isUnusableValueHint(body.parsed_hint)) {
    if (askedSlotWrittenThisTurn(input, perTurnWrites)) return { kind: 'usable' };
    return {
      kind: 'unusable',
      reply: {
        outcome: 'answered',
        text: typeof body.untrusted_user_text === 'string' ? body.untrusted_user_text : '',
        parsed_hint: body.parsed_hint,
      },
    };
  }
  return { kind: 'usable' };
}

/** Render the note appended to the ask's tool result. */
export function renderRepeatAskNote({ input, replies }) {
  const context = {
    field: input?.context_field ?? null,
    circuit: input?.context_circuit ?? null,
    ...(input?.context_board_id != null ? { board_id: input.context_board_id } : {}),
    replies,
  };
  return (
    '[Server note: repeat_ask. The inspector has now given two replies to this ' +
    'question that could not be used. Do not ask it a third time: record the most ' +
    'defensible value if one is clear (LIM, N/A or ∞ where the field allows it), or ' +
    'say in one short line what you still need.] ' +
    JSON.stringify(context)
  );
}

/**
 * Per-session tracker. `observe` is called once per dispatched `ask_user`
 * result; it returns the note to append (only on the threshold reply) and the
 * running count.
 */
export function createRepeatAskTracker() {
  const byKey = new Map();
  return {
    observe({ input, result, perTurnWrites }) {
      const key = deriveAskKey(input ?? {});
      const verdict = classifyAskReply({ input, result, perTurnWrites });
      if (verdict.kind === 'usable') {
        byKey.delete(key);
        return { key, count: 0, note: null };
      }
      if (verdict.kind !== 'unusable') {
        return { key, count: byKey.get(key)?.count ?? 0, note: null };
      }
      const entry = byKey.get(key) ?? { count: 0, replies: [] };
      entry.count += 1;
      entry.replies.push(verdict.reply);
      if (entry.replies.length > REPEAT_ASK_NOTE_THRESHOLD) entry.replies.shift();
      byKey.set(key, entry);
      const note =
        entry.count === REPEAT_ASK_NOTE_THRESHOLD
          ? renderRepeatAskNote({ input, replies: entry.replies.slice() })
          : null;
      return { key, count: entry.count, note };
    },
    countFor(input) {
      return byKey.get(deriveAskKey(input ?? {}))?.count ?? 0;
    },
  };
}

/**
 * Ingress half of the carry: prepend a note the model never read to the next
 * turn's model-bound transcript. The note is normally read in the same loop
 * (the harness appends it to the ask's tool result); only a cancelled or
 * failed generation leaves it on `session.pendingRepeatAskNote`. It is the
 * LOWEST-precedence prepended note — PLAN-A's handoff note and the ring / IR /
 * voltage expiry notes come first — so when any server note is already
 * attached to this turn it waits for the next one.
 *
 * @returns {{ transcriptText: string, outcome: 'none'|'carried'|'deferred' }}
 */
export function attachCarriedRepeatAskNote(session, transcriptText) {
  const note = session?.pendingRepeatAskNote;
  if (typeof note !== 'string' || note.length === 0 || typeof transcriptText !== 'string') {
    return { transcriptText, outcome: 'none' };
  }
  if (transcriptText.includes('[Server note:')) return { transcriptText, outcome: 'deferred' };
  session.pendingRepeatAskNote = null;
  return { transcriptText: `${note} ${transcriptText}`, outcome: 'carried' };
}
