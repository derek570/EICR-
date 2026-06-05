/**
 * OpenAI vision adapter — exposes an Anthropic-shaped `messages.create()`
 * interface backed by OpenAI Chat Completions, so existing per-window
 * extraction code in ccu-sliding-window.js can swap VLM provider via env
 * var without changing its call shape.
 *
 * Why an adapter rather than a parallel implementation:
 *   - extractViaSlidingWindow takes an `anthropic` client object and calls
 *     `anthropic.messages.create({...}, {signal})` exactly once per window.
 *     The function is otherwise model-agnostic — alignment, voting, slot
 *     emission, all the same. Wrapping OpenAI behind the same shape lets
 *     us A/B between VLM providers (env var pick) without forking the
 *     extractor or maintaining two near-identical pipelines.
 *
 *   - Used ONLY for sliding-window per-window calls (Stage 3 — the
 *     production hot path that exhibits within-window over-enumeration on
 *     identical-looking MCB rows). The whole-image board classifier and
 *     other VLM stages stay on Anthropic — they don't have the same
 *     failure mode and Sonnet's been reliable on board-level metadata.
 *
 * Prompt caching: GPT-5.5 (and earlier 5.x models) automatically cache
 * prompt prefixes longer than ~1024 tokens that repeat verbatim across
 * calls. Our sliding-window prompt is identical for all 9 windows of a
 * given board (only the image changes), so caching engages automatically
 * and the cache hits show up in `usage.prompt_tokens_details.cached_tokens`.
 *
 * For caching to work the prompt text must appear at the SAME token
 * position on every call. We send `text` BEFORE `image_url` in the user
 * content array so the prompt sits as a stable prefix; the per-window
 * image — which is the only varying input — comes after and breaks the
 * cacheable region but only at that point.
 */
import OpenAI from 'openai';

/**
 * Translate an Anthropic-shaped `messages.create()` payload into an
 * OpenAI Chat Completions call and translate the response back. The
 * response shape mirrors Anthropic's so callers can read `resp.content`
 * and `resp.usage.input_tokens` / `resp.usage.output_tokens` unchanged.
 *
 * @param {OpenAI} openai
 * @param {object} payload  Anthropic-shaped payload:
 *   { model, max_tokens, messages: [{ role: 'user', content: [{type:'image'|'text', ...}] }] }
 * @param {object} options
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{content:Array<{type:'text', text:string}>, usage:{input_tokens:number, output_tokens:number, cached_input_tokens:number}}>}
 */
async function callOpenAIChat(openai, payload, options = {}) {
  const { model, max_tokens, messages } = payload;
  const { signal } = options;

  // Translate Anthropic content blocks → OpenAI content parts.
  // Anthropic image: { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: <b64> } }
  // OpenAI image:    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,<b64>' } }
  // Text blocks pass through with no shape change but field naming matches.
  //
  // Order: text-first, image-after. The prompt text is identical across
  // all sliding-window calls; putting it first keeps the cacheable
  // prefix stable. Reversing the order would break prompt caching after
  // the first window because the image bytes are unique per call.
  const translated = messages.map((m) => {
    const parts = [];
    const textParts = [];
    const imageParts = [];
    for (const c of m.content) {
      if (c.type === 'text') {
        textParts.push({ type: 'text', text: c.text });
      } else if (c.type === 'image' && c.source?.type === 'base64') {
        const b64 = c.source.data;
        const mt = c.source.media_type || 'image/jpeg';
        imageParts.push({
          type: 'image_url',
          image_url: { url: `data:${mt};base64,${b64}` },
        });
      } else if (c.type === 'image_url') {
        // Already in OpenAI shape — pass through.
        imageParts.push(c);
      }
    }
    parts.push(...textParts, ...imageParts);
    return { role: m.role, content: parts };
  });

  // GPT-5.x are reasoning models — they spend tokens on internal chain-of-
  // thought before emitting any visible output. The visible answer for our
  // task is short (a JSON list of ~5 device entries, ~280 tokens), but the
  // reasoning trace can run to several thousand tokens at default reasoning
  // effort. If max_completion_tokens caps that budget too low the model
  // exhausts the cap mid-reasoning and returns empty content — exactly the
  // "Unexpected end of JSON input" we hit on the first integration run.
  //
  // Two adjustments for GPT-5.x:
  //   - Bump max_completion_tokens significantly (visible output stays small;
  //     the headroom is for internal reasoning).
  //   - Set reasoning_effort to "minimal" for this kind of structured-
  //     extraction task. The work is identifying and listing what's visible,
  //     not multi-step reasoning, so deep reasoning burns money without
  //     improving output quality. Anthropic's equivalent (extended thinking
  //     budget) doesn't apply to Sonnet by default so the migration is
  //     directly comparable on the visible-output side.
  const isGpt5x = /^gpt-5/i.test(model || '');
  const requestPayload = {
    model,
    messages: translated,
    // For non-reasoning models, max_tokens (=max_completion_tokens) caps the
    // visible output. For reasoning models, it caps reasoning + visible
    // output combined. We multiply for GPT-5.x to leave headroom for
    // reasoning while still respecting the caller's intent for visible-
    // output size.
    max_completion_tokens: isGpt5x ? Math.max(max_tokens * 4, 8192) : max_tokens,
  };
  if (isGpt5x) {
    // GPT-5.5 supports 'none' | 'low' | 'medium' | 'high' | 'xhigh'.
    // Per-window enumeration is a structured listing task with no
    // multi-step deduction, so we disable reasoning entirely — the
    // visible output is what we care about and reasoning tokens are
    // pure waste here.
    requestPayload.reasoning_effort = 'none';
  }
  const resp = await openai.chat.completions.create(requestPayload, { signal });

  const choice = resp.choices?.[0];
  const text = choice?.message?.content ?? '';
  const usage = resp.usage || {};
  const cachedInput = usage.prompt_tokens_details?.cached_tokens || 0;

  // Defensive: if GPT-5.x returns empty visible content despite the
  // increased reasoning budget, surface a structured error rather than
  // letting the caller's JSON.parse fail with "Unexpected end of JSON
  // input" (which obscures the real cause). This catches the case where
  // the reasoning trace consumed the entire budget AND the case where
  // the model's stop reason was `length`, not `stop`.
  if (!text || text.trim().length === 0) {
    const finishReason = choice?.finish_reason || 'unknown';
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;
    throw new Error(
      `OpenAI returned empty content (finish_reason=${finishReason}, ` +
        `reasoning_tokens=${reasoningTokens}, completion_tokens=${usage.completion_tokens || 0}, ` +
        `max_completion_tokens=${requestPayload.max_completion_tokens})`
    );
  }

  // Anthropic-shaped return: callers read resp.content[].text and
  // resp.usage.input_tokens / output_tokens. We pass cached_input_tokens
  // as an extra field so cost-tracking can apply the cache discount.
  return {
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cached_input_tokens: cachedInput,
    },
  };
}

/**
 * Build an Anthropic-API-shaped wrapper around OpenAI. Only `messages.create`
 * is implemented because that's the single method extractViaSlidingWindow
 * uses; future call sites that need other Anthropic methods would extend
 * this object.
 *
 * @param {{apiKey:string}} opts
 * @returns {{messages:{create:Function}}}
 */
export function createOpenAIAnthropicAdapter({ apiKey }) {
  if (!apiKey) {
    throw new Error('createOpenAIAnthropicAdapter: apiKey required');
  }
  const openai = new OpenAI({ apiKey });
  return {
    messages: {
      create: (payload, options) => callOpenAIChat(openai, payload, options),
    },
  };
}

/**
 * Predicate: should we use the OpenAI adapter for this model name?
 * Routes any model identifier starting with "gpt-" through OpenAI; everything
 * else (claude-sonnet-*, claude-opus-*, claude-haiku-*) stays on Anthropic.
 */
export function isOpenAIModel(modelName) {
  return typeof modelName === 'string' && modelName.trim().toLowerCase().startsWith('gpt-');
}
