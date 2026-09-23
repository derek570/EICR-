/**
 * PLAN-B (feedback-2026-09-17, B3/B4) — canned nets ask the model first.
 *
 * WHAT: `requestModelAuthoredLine(deps, { netKind, context })` runs ONE extra
 * provider call, after the primary tool loop, at a net site that is about to
 * speak a canned "I didn't understand" line. The model may answer through one
 * retry-only tool, `net_response`, whose every field is a closed code or a
 * verbatim quotation. The server renders the spoken line from a fixed table.
 * If the model's call is missing, invalid or fails, the helper returns `null`
 * and the net speaks its canned string exactly as before.
 *
 * WHY: Derek's direction for this wave is that no deterministic path ends a
 * turn with canned speech when it did not understand the inspector; the model
 * has the context and should own the wording (WAVE-CONTEXT § The principle).
 * Session CC9E0915 11:46–11:51: seven customer-chat turns produced five
 * rotating canned apologies. "Chime is a promise" (F7) is not weakened — the
 * canned line survives as the last resort behind a model that emitted nothing.
 *
 * THE CONTRACT: the server owns every sentence that asserts an outcome; the
 * model contributes structured context that cannot assert a mutation.
 *   - `outcome_code` is a closed enum per `netKind`; its template's fixed
 *     text states what happened (every template says nothing was recorded).
 *   - `heard` is not prose the model writes but a quotation it selects: at
 *     most 12 words that must occur in the turn's CANONICAL inspector
 *     transcript. The rendered bytes come from the transcript, never from the
 *     model's copy, so the model cannot alter a character.
 *   - `question` is a closed code; the server owns every question sentence.
 * There is no success-word or disclosure-word list because there is no free
 * prose to police. The one meaning-adjacent check is the existing prompt-leak
 * output filter, applied to the INSPECTOR's quoted words.
 *
 * NO FUZZY MATCHING (hard rule since 2026-06-24): the quotation check is an
 * exact, case-insensitive, whitespace-run-tolerant match on whole words. No
 * edit distance, no token overlap. A quote that starts or ends mid-word is
 * rejected rather than accepted: a partial word ("0.3" out of "0.32") is a
 * truncation, and a truncated quote can change what the inspector said.
 *
 * ONLY `net_response` IS DISPATCHED. The helper's dispatcher refuses every
 * other tool name with `retry_tool_not_allowed` and touches no session state,
 * so a retry can never write, ask, or answer.
 */

import { runToolLoop } from './stage6-tool-loop.js';
import { checkForPromptLeak } from './stage6-prompt-leak-filter.js';

export const NET_RESPONSE_TOOL_NAME = 'net_response';

/** The five question codes and the server's sentence for each. */
export const NET_QUESTION_SENTENCES = Object.freeze({
  which_circuit: 'Which circuit was that?',
  which_field: 'Which reading is that?',
  what_value: 'What was the value?',
  repeat_please: 'Say it again?',
  none: null,
});
export const NET_QUESTION_CODES = Object.freeze(Object.keys(NET_QUESTION_SENTENCES));

/** `heard` is at most this many words. Longer is rejected, never truncated. */
export const HEARD_MAX_WORDS = 12;

/**
 * The rendering table: `(netKind, outcome_code)` → template. Each template
 * takes the validated excerpt (already wrapped in “…” by the caller of
 * `head`) and returns the fixed opening sentence; `defaultQuestion` is the
 * sentence spoken when `question` is ABSENT (`null` means the row has no
 * default). `question: 'none'` drops the default. `noop` and `catchall` share
 * their three rows.
 */
const NOOP_ROWS = Object.freeze({
  nothing_recorded: {
    head: (q) => `Nothing was recorded${q ? ` — I heard ${q}` : ''}.`,
    defaultQuestion: null,
  },
  need_repeat: {
    head: (q) => `Nothing was recorded — I didn't catch that${q ? `; I heard ${q}` : ''}.`,
    defaultQuestion: 'Say it again?',
  },
  chat: {
    head: (q) =>
      `Nothing was recorded — that didn't sound like a reading${q ? `; I heard ${q}` : ''}.`,
    defaultQuestion: null,
  },
});

export const NET_RENDERING_TABLE = Object.freeze({
  noop: NOOP_ROWS,
  catchall: NOOP_ROWS,
  orphan_value: Object.freeze({
    value_unplaced: {
      head: (q) =>
        `I couldn't place that reading — nothing was recorded${q ? `; I heard ${q}` : ''}.`,
      defaultQuestion: 'Which circuit?',
    },
    need_circuit: {
      head: (q) =>
        `I heard${q ? ` ${q},` : ''} a reading without a circuit — nothing was recorded.`,
      defaultQuestion: 'Which circuit was that?',
    },
  }),
  orphan_observation: Object.freeze({
    observation_unplaced: {
      head: (q) =>
        `I couldn't place that observation — nothing was recorded${q ? `; I heard ${q}` : ''}.`,
      defaultQuestion: 'Which circuit or board?',
    },
  }),
  rejected: Object.freeze({
    rejected_not_recorded: {
      head: (q) => `That wasn't recorded${q ? ` — I heard ${q}` : ''}.`,
      defaultQuestion: 'Say the value again?',
    },
  }),
  // B4 — the DROPPED-VALUE disclosure. The only valid code; its template
  // opens "I couldn't record that", so the disclosure is a property of the
  // table, never of the model's words.
  dropped_value: Object.freeze({
    not_recorded: {
      head: (q) => `I couldn't record that${q ? ` — I heard ${q}` : ''}.`,
      defaultQuestion: 'Say it again with the circuit?',
    },
  }),
});

export const NET_KINDS = Object.freeze(Object.keys(NET_RENDERING_TABLE));

/** The closed `outcome_code` enum for a net kind. */
export function outcomeCodesFor(netKind) {
  return Object.keys(NET_RENDERING_TABLE[netKind] ?? {});
}

/**
 * The retry-only tool. Defined here and NEVER added to the production tool
 * schema. Tool schemas are guidance, not grammar, so the dispatcher below
 * re-validates every field at runtime.
 */
export const NET_RESPONSE_TOOL = Object.freeze({
  name: NET_RESPONSE_TOOL_NAME,
  description:
    'Report why this turn produced nothing the inspector could hear. Pick outcome_code from the allowed list in the server note. Optionally quote up to 12 consecutive words of the inspector transcript EXACTLY as written in `heard`, and pick a question code if one would help. Call it exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      outcome_code: {
        type: 'string',
        description: 'One of the outcome codes the server note allows for this case.',
      },
      heard: {
        type: 'string',
        description:
          'Optional. Up to 12 consecutive words copied exactly from the inspector transcript. Never your own words.',
      },
      question: {
        type: 'string',
        enum: [...NET_QUESTION_CODES],
        description: 'Optional. The question the server should ask, or "none".',
      },
    },
    required: ['outcome_code'],
    additionalProperties: false,
  },
});

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Locate `heard` in the canonical transcript. Returns the transcript's own
 * bytes for the first whole-word, case-insensitive match (whitespace runs in
 * the transcript may be any length), or null.
 */
export function locateHeardSpan(heard, canonicalTranscript) {
  const tokens = String(heard).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || typeof canonicalTranscript !== 'string') return null;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${tokens.map(escapeRegExp).join('\\s+')}(?![\\p{L}\\p{N}])`,
    'iu'
  );
  const match = pattern.exec(canonicalTranscript);
  return match ? match[0] : null;
}

/**
 * Validate one `net_response` input against the net kind and the turn's
 * canonical transcript. Pure; no side effects.
 *
 * @returns {{ ok: true, value: {outcome_code, heardSpan, question} }
 *         | { ok: false, reason: string }}
 */
export function validateNetResponse(input, { netKind, canonicalTranscript }) {
  const allowed = outcomeCodesFor(netKind);
  const outcomeCode = input?.outcome_code;
  if (typeof outcomeCode !== 'string' || !allowed.includes(outcomeCode)) {
    return { ok: false, reason: 'outcome_code_not_allowed' };
  }
  let question = null;
  if (input?.question !== undefined && input?.question !== null) {
    if (typeof input.question !== 'string' || !NET_QUESTION_CODES.includes(input.question)) {
      return { ok: false, reason: 'question_not_allowed' };
    }
    question = input.question;
  }
  let heardSpan = null;
  const rawHeard = input?.heard;
  if (rawHeard !== undefined && rawHeard !== null) {
    if (typeof rawHeard !== 'string') return { ok: false, reason: 'heard_not_a_string' };
    const collapsed = rawHeard.trim().replace(/\s+/g, ' ');
    if (collapsed.length > 0) {
      if (collapsed.split(' ').length > HEARD_MAX_WORDS) {
        return { ok: false, reason: 'heard_too_long' };
      }
      if (typeof canonicalTranscript !== 'string' || canonicalTranscript.trim() === '') {
        return { ok: false, reason: 'heard_no_canonical_transcript' };
      }
      const span = locateHeardSpan(collapsed, canonicalTranscript);
      if (span == null) return { ok: false, reason: 'heard_not_in_transcript' };
      const leak = checkForPromptLeak(span, { field: 'heard' });
      if (!leak.safe) return { ok: false, reason: 'heard_filtered' };
      heardSpan = span;
    }
  }
  return { ok: true, value: { outcome_code: outcomeCode, heardSpan, question } };
}

/**
 * Render the spoken line for a validated response. `question` ABSENT → the
 * row's default sentence (if any); `'none'` → no question sentence at all;
 * a code → that code's server sentence.
 */
export function renderNetLine(netKind, { outcome_code, heardSpan, question }) {
  const row = NET_RENDERING_TABLE[netKind]?.[outcome_code];
  if (!row) throw new Error(`no_rendering_row:${netKind}:${outcome_code}`);
  const quoted = heardSpan ? `“${heardSpan}”` : null;
  const head = row.head(quoted);
  const questionSentence =
    question == null ? row.defaultQuestion : NET_QUESTION_SENTENCES[question];
  return questionSentence ? `${head} ${questionSentence}` : head;
}

/**
 * The retry-only dispatcher. `net_response` → validate + render; the first
 * VALID call latches the line (first-valid wins); any later `net_response` is
 * a duplicate; every other tool name is refused. Nothing here touches session
 * state, the per-turn write journal or the ask registry.
 */
export function createRetryDispatcher({ netKind, canonicalTranscript }) {
  const state = {
    latched: null,
    netResponseCalls: 0,
    duplicatesRejected: 0,
    forbiddenCalls: 0,
    rejections: [],
  };
  const reply = (call, body, isError) => ({
    tool_use_id: call?.tool_call_id ?? call?.id,
    content: JSON.stringify(body),
    is_error: isError,
  });
  async function dispatch(call) {
    if (call?.name !== NET_RESPONSE_TOOL_NAME) {
      state.forbiddenCalls += 1;
      return reply(
        call,
        { ok: false, error: { code: 'retry_tool_not_allowed', name: call?.name ?? null } },
        true
      );
    }
    state.netResponseCalls += 1;
    if (state.latched) {
      state.duplicatesRejected += 1;
      return reply(call, { ok: false, error: { code: 'net_response_duplicate' } }, true);
    }
    const verdict = validateNetResponse(call.input, { netKind, canonicalTranscript });
    if (!verdict.ok) {
      state.rejections.push(verdict.reason);
      return reply(
        call,
        { ok: false, error: { code: 'net_response_invalid', reason: verdict.reason } },
        true
      );
    }
    state.latched = { ...verdict.value, line: renderNetLine(netKind, verdict.value) };
    return reply(call, { ok: true }, false);
  }
  dispatch.state = state;
  return dispatch;
}

/** The server note appended as the helper's one user message. */
export function buildRetryNote({ netKind, context = {} }) {
  const json = {
    kind: netKind,
    allowed_outcome_codes: outcomeCodesFor(netKind),
    question_codes: [...NET_QUESTION_CODES],
    transcript: context.transcript ?? null,
    ...(context.handoff != null ? { handoff: context.handoff } : {}),
    ...(context.repeatAsk != null ? { repeat_ask: context.repeatAsk } : {}),
  };
  return (
    '[Server note: retry. Your turn produced no audible result for the inspector. Call ' +
    'net_response exactly ONCE: pick the outcome_code that fits (context.kind tells you ' +
    "which case); optionally quote up to 12 consecutive words of the inspector's " +
    'transcript in heard, exactly as written; and pick a question code if one would help.] ' +
    JSON.stringify(json)
  );
}

function appendUserText(messages, text) {
  const out = messages.map((m) => m);
  const last = out[out.length - 1];
  if (last && last.role === 'user') {
    const content = Array.isArray(last.content)
      ? [...last.content, { type: 'text', text }]
      : [
          { type: 'text', text: String(last.content ?? '') },
          { type: 'text', text },
        ];
    out[out.length - 1] = { ...last, content };
  } else {
    out.push({ role: 'user', content: text });
  }
  return out;
}

/**
 * Run the one-call retry.
 *
 * @param {object} deps — the primary call's already-resolved environment from
 *   runLiveMode: `{ target: {client, model, provider}, tier, reasoningEffort,
 *   turnKind, systemBlocks, messages, abortSignal, billingIdentity, ctx,
 *   logger }`. `messages` is the primary loop's final message list; it is
 *   copied, never mutated.
 * @param {{ netKind: string, context: object }} request — `context.canonicalInspectorTranscript`
 *   is the ONLY value `heard` is validated and rendered against.
 * @returns {Promise<{ line: string|null, outcome: 'answered'|'empty'|'provider_error'|'rejected',
 *   outcomeCode: string|null, roundUsage: object[], telemetry: object }>}
 */
export async function requestModelAuthoredLine(deps, { netKind, context = {} }) {
  if (!NET_RENDERING_TABLE[netKind]) throw new Error(`unknown_net_kind:${netKind}`);
  const dispatcher = createRetryDispatcher({
    netKind,
    canonicalTranscript: context.canonicalInspectorTranscript,
  });
  const messages = appendUserText(
    Array.isArray(deps?.messages) ? deps.messages : [],
    buildRetryNote({ netKind, context })
  );
  let roundUsage = [];
  let outcome;
  let providerError = null;
  try {
    const out = await runToolLoop({
      client: deps.target.client,
      model: deps.target.model,
      provider: deps.target.provider,
      openAIServiceTier: deps.tier,
      openAIReasoningEffort: deps.reasoningEffort,
      turnKind: deps.turnKind,
      // The helper's one round is always round 1 of a fresh loop; the
      // VOICE_LATENCY_ROUND1_MODEL ops lever must never apply to it.
      allowRound1ModelOverride: false,
      system: deps.systemBlocks,
      messages,
      tools: [NET_RESPONSE_TOOL],
      dispatcher,
      ctx: deps.ctx,
      billingIdentity: deps.billingIdentity,
      logger: deps.logger,
      maxRounds: 1,
      dispatchAtCap: true,
      signal: deps.abortSignal ?? undefined,
    });
    roundUsage = Array.isArray(out?.round_usage) ? out.round_usage : [];
    if (dispatcher.state.latched) outcome = 'answered';
    else if (dispatcher.state.netResponseCalls > 0 || dispatcher.state.forbiddenCalls > 0) {
      outcome = 'rejected';
    } else outcome = 'empty';
  } catch (err) {
    roundUsage = Array.isArray(err?.billableUsage?.round_usage)
      ? err.billableUsage.round_usage
      : [];
    providerError = err?.message ?? String(err);
    outcome = 'provider_error';
  }
  const rows = roundUsage.map((row) => ({
    ...row,
    usage_role: 'terminal_retry',
    ...(providerError ? { error: providerError } : {}),
  }));
  if (providerError && rows.length === 0) {
    rows.push({ usage_role: 'terminal_retry', error: providerError });
  }
  const latched = dispatcher.state.latched;
  const telemetry = {
    netKind,
    outcome_code: latched?.outcome_code ?? null,
    outcome,
    net_response_calls: dispatcher.state.netResponseCalls,
    duplicates_rejected: dispatcher.state.duplicatesRejected,
    forbidden_calls: dispatcher.state.forbiddenCalls,
    rejection_reasons: dispatcher.state.rejections.slice(),
    ...(providerError ? { error: providerError } : {}),
  };
  try {
    deps?.logger?.info?.('stage6.noop_retry_round', {
      sessionId: deps?.ctx?.sessionId,
      turnId: deps?.ctx?.turnId,
      ...telemetry,
    });
  } catch {
    // telemetry never breaks the net
  }
  return {
    line: outcome === 'answered' ? latched.line : null,
    outcome,
    outcomeCode: latched?.outcome_code ?? null,
    roundUsage: rows,
    telemetry,
  };
}
