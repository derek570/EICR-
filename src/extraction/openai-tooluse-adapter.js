/**
 * OpenAI tool-use adapter — exposes an Anthropic-shaped `messages.stream()`
 * interface backed by OpenAI Chat Completions function calling, so the live
 * Stage 6 extraction loop (`runToolLoop`) can A/B a `gpt-*` model (e.g.
 * GPT-5.6 Luna) against the Anthropic default WITHOUT forking the loop, the
 * assembler, the dispatchers, or any of the 6800 tests around them.
 *
 * WHY a streaming tool-use adapter (the vision adapter is not enough):
 *   - `openai-vision-adapter.js` implements only the NON-streaming
 *     `messages.create()` — enough for one-shot CCU vision windows. Its own
 *     docstring says "future call sites that need other Anthropic methods
 *     would extend this object." This is that extension.
 *   - `runToolLoop` calls `client.messages.stream(streamArgs, {signal})`,
 *     iterates the returned object as an async-iterable to drive
 *     `createAssembler()`, AND awaits `.finalMessage()` for the assistant
 *     turn + usage. So the adapter must satisfy BOTH the async-iterator and
 *     the finalMessage() halves of the Anthropic MessageStream contract.
 *
 * WHY synthesize events from a non-streaming call (correct-first, for a trial):
 *   - The assembler is a pure reducer over Anthropic tool_use streaming events
 *     (content_block_start -> input_json_delta -> content_block_stop ->
 *     message_delta -> message_stop). We make ONE non-streaming OpenAI call,
 *     get the complete tool_calls, and emit that exact event sequence. This
 *     is byte-for-byte what the assembler expects and cannot desync from a
 *     partial stream.
 *   - The cost is that Loaded Barrel streamed pre-synth (Phase 2.D, the
 *     `onToolUseStreamed` latency optimisation) fires only after the whole
 *     OpenAI response lands, not mid-stream. That is a LATENCY property, not
 *     a CORRECTNESS one — fine for a "could it work" trial. A true streaming
 *     translation (OpenAI SSE deltas -> Anthropic input_json_delta) is the
 *     documented follow-up once the corpus A/B shows the model is worth it.
 *
 * SCOPE: this is the read-back extraction path only. The wire contract to
 * iOS/web is unchanged — extraction is server-side, clients never see which
 * provider produced the tool calls. Selection is gated on the model name
 * starting with "gpt-" (see isOpenAIModel in openai-vision-adapter.js), so the
 * Anthropic default path is byte-identical when the flag is off.
 */
import OpenAI from 'openai';
import { renderSystemPrompt } from './system-prompt-renderer.js';

// ---------------------------------------------------------------------------
// Anthropic -> OpenAI request translation
// ---------------------------------------------------------------------------

/**
 * The harness forwards `system` opaquely — it may be a plain string OR an
 * array of Anthropic text blocks ({type:'text', text, cache_control}) used to
 * place prompt-cache breakpoints. OpenAI takes a single system string, so we
 * concatenate the text of every block. cache_control is dropped (OpenAI caches
 * long repeated prefixes automatically; there is no explicit breakpoint API).
 */
const flattenSystem = renderSystemPrompt;

/**
 * Anthropic tool defs -> OpenAI function tools.
 * { name, description, input_schema } -> { type:'function', function:{ name, description, parameters } }
 */
function toOpenAITools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

/**
 * Translate the Anthropic `messages` array (which `runToolLoop` MUTATES each
 * round — appending assistant(tool_use) and user(tool_result) turns) into
 * OpenAI Chat Completions messages.
 *
 *   Anthropic assistant [{type:'text'},{type:'tool_use', id, name, input}]
 *     -> OpenAI { role:'assistant', content, tool_calls:[{id, type:'function',
 *                 function:{ name, arguments: JSON.stringify(input) }}] }
 *   Anthropic user [{type:'tool_result', tool_use_id, content, is_error}]
 *     -> one OpenAI { role:'tool', tool_call_id, content } per result
 *   Anthropic user string / [{type:'text'}]  -> OpenAI { role:'user', content }
 */
function toOpenAIMessages(system, messages) {
  const out = [];
  const sys = flattenSystem(system);
  if (sys) out.push({ role: 'system', content: sys });

  for (const m of messages) {
    const content = m.content;

    if (typeof content === 'string') {
      out.push({ role: m.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (m.role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      for (const block of content) {
        if (block.type === 'text') {
          textParts.push(block.text || '');
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              // input is a parsed object on the happy path; stringify for the
              // wire. If a prior round stored a raw string (parse failure),
              // pass it through unchanged.
              arguments:
                typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const msg = { role: 'assistant', content: textParts.join('') || null };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }

    // role === 'user' (or 'tool'): may carry tool_result blocks + text.
    const userTextParts = [];
    for (const block of content) {
      if (block.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content:
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
        });
      } else if (block.type === 'text') {
        userTextParts.push(block.text || '');
      }
    }
    if (userTextParts.length > 0) {
      out.push({ role: 'user', content: userTextParts.join('') });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI -> Anthropic response translation
// ---------------------------------------------------------------------------

/** OpenAI finish_reason -> Anthropic stop_reason (what runToolLoop branches on). */
function mapFinishReason(fr) {
  switch (fr) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    default:
      return 'end_turn';
  }
}

/**
 * Build the Anthropic-shaped `content` array (for finalMessage) from an OpenAI
 * choice. Text block first (if any), then one tool_use block per tool_call.
 * `input` is the PARSED arguments object; on parse failure we keep {} for the
 * history block — the assembler independently records the invalid_json error
 * from the synthetic delta (which carries the raw arguments string), so the
 * loop still emits a well-formed error tool_result.
 */
function buildAnthropicContent(message) {
  const blocks = [];
  if (message?.content) {
    blocks.push({ type: 'text', text: message.content });
  }
  for (const tc of message?.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || '{}');
    } catch {
      input = {};
    }
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  return blocks;
}

/**
 * Emit the exact Anthropic streaming event sequence the assembler consumes,
 * derived from a complete OpenAI response. One tool_use block per tool_call
 * (content_block_start -> input_json_delta with the RAW arguments string ->
 * content_block_stop), a text block if present, then message_delta (carrying
 * stop_reason) and message_stop.
 */
function* synthesizeEvents(message, stopReason) {
  yield { type: 'message_start' };
  let index = 0;
  if (message?.content) {
    yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
    yield {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text: message.content },
    };
    yield { type: 'content_block_stop', index };
    index += 1;
  }
  for (const tc of message?.tool_calls || []) {
    yield {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: tc.id, name: tc.function?.name, input: {} },
    };
    // Raw arguments string as ONE input_json_delta — the assembler concatenates
    // and JSON.parses once at content_block_stop, so truncated/invalid JSON
    // surfaces as an invalid_json error record exactly as with Anthropic.
    yield {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: tc.function?.arguments || '' },
    };
    yield { type: 'content_block_stop', index };
    index += 1;
  }
  yield { type: 'message_delta', delta: { stop_reason: stopReason } };
  yield { type: 'message_stop' };
}

/** OpenAI usage -> Anthropic Message.usage shape (for CostTracker.addSonnetUsage). */
function mapUsage(usage) {
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  const prompt = usage?.prompt_tokens || 0;
  return {
    // Anthropic's input_tokens excludes cache reads; mirror that split so the
    // cost tracker's cache discount applies cleanly.
    input_tokens: Math.max(prompt - cached, 0),
    output_tokens: usage?.completion_tokens || 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

// ---------------------------------------------------------------------------
// The stream object (async-iterable + finalMessage)
// ---------------------------------------------------------------------------

/**
 * Lazily perform ONE OpenAI call (memoised) and expose it as an Anthropic
 * MessageStream: async-iteration yields synthetic events; finalMessage()
 * resolves the assembled assistant message. Both share the same underlying
 * promise so the OpenAI call happens exactly once regardless of which the
 * caller touches first.
 */
function createStream(openai, streamArgs, options) {
  const { model, max_tokens, system, messages, tools } = streamArgs;
  const { signal } = options || {};

  const isGpt5x = /^gpt-5/i.test(model || '');
  const requestPayload = {
    model,
    messages: toOpenAIMessages(system, messages),
    tools: toOpenAITools(tools),
    tool_choice: 'auto',
    // Reasoning models spend hidden tokens before visible output. The visible
    // output here is a handful of tool calls (~small), so cap generously to
    // leave reasoning headroom; too low and the model exhausts the budget
    // mid-reasoning and returns zero tool_calls (the vision adapter hit this).
    max_completion_tokens: isGpt5x ? Math.max((max_tokens || 4096) * 4, 8192) : max_tokens || 4096,
  };
  if (isGpt5x) {
    // HARD CONSTRAINT (verified live 2026-07-31): on `/v1/chat/completions`,
    // GPT-5.6 Luna REJECTS function tools with any reasoning_effort other than
    // 'none' — 400 `invalid_request_error`: "Function tools with reasoning_effort
    // are not supported for gpt-5.6-luna in /v1/chat/completions. To use function
    // tools, use /v1/responses or set reasoning_effort to 'none'." The extraction
    // loop ALWAYS passes tools, so we default to 'none' here. Ops can override via
    // OPENAI_EXTRACT_REASONING_EFFORT, but a non-'none' value on Chat Completions
    // will 400 — reasoning-WITH-tools requires porting this adapter to the
    // Responses API (documented follow-up; a latency/quality question, not a
    // blocker for the correctness+cost trial).
    //
    // Plan 00B-2 C3 — this adapter DELIBERATELY ignores
    // streamArgs.reasoning_effort entirely (including direct
    // EICRExtractionSession callers that supply `reasoning_effort: low`):
    // the env-only resolution here IS the request payload on this
    // transport. The tool-loop dispatch resolver (stage6-shadow-harness
    // resolveOpenAIReasoningEffort) computes the same value for
    // ATTRIBUTION — authoritative for what is recorded, never for what is
    // sent here.
    requestPayload.reasoning_effort = (
      process.env.OPENAI_EXTRACT_REASONING_EFFORT || 'none'
    ).trim();
  }

  let resultPromise = null;
  const run = () => {
    if (!resultPromise) {
      resultPromise = openai.chat.completions
        .create(requestPayload, signal ? { signal } : undefined)
        .then((resp) => {
          const choice = resp.choices?.[0];
          const message = choice?.message || {};
          const stopReason = mapFinishReason(choice?.finish_reason);
          return {
            message,
            stopReason,
            usage: mapUsage(resp.usage),
            content: buildAnthropicContent(message),
            responseModel: resp.model ?? null,
            responseServiceTier: resp.service_tier ?? null,
            // Plan 00B-4 §C1c — the provider's own opaque call id
            // (`chatcmpl-…`). It is the ONLY durable proof that a lane
            // sample consumed a real vendor call, so it must survive the
            // adapter; it carries no inspector content.
            responseId: typeof resp?.id === 'string' && resp.id.length > 0 ? resp.id : null,
          };
        });
    }
    return resultPromise;
  };

  return {
    // Async-iterable half — drives the assembler.
    async *[Symbol.asyncIterator]() {
      const { message, stopReason } = await run();
      for (const ev of synthesizeEvents(message, stopReason)) {
        yield ev;
      }
    },
    // finalMessage() half — the assistant turn + usage for runToolLoop.
    // This adapter never sends `service_tier` on the request (Chat
    // Completions comparison lane runs at OpenAI's Standard/default tier
    // regardless of OPENAI_EXTRACT_SERVICE_TIER), so the truthful requested
    // tier is always 'standard'. Reporting it — plus the raw response
    // model/tier — keeps per-round billing attribution from falling back to
    // the loop-level Fast env default and mis-billing every round as Fast
    // with a fast_response_tier_missing contradiction.
    async finalMessage() {
      const { content, usage, stopReason, responseModel, responseServiceTier, responseId } =
        await run();
      return {
        content,
        usage,
        stop_reason: stopReason,
        role: 'assistant',
        requested_service_tier: 'standard',
        response_model: responseModel,
        response_service_tier: responseServiceTier,
        // Plan 00B-3 C5 — the ACTUAL API transport that served this round.
        api_transport: 'chat_completions',
        // Plan 00B-4 §C1c — stamped on the SAME carrier the Anthropic SDK
        // message uses for its own `id`, so one attribution seam covers
        // every provider without branching on transport.
        id: responseId,
      };
    },
  };
}

/**
 * Build an Anthropic-API-shaped wrapper around OpenAI exposing `messages.stream`
 * (the method runToolLoop uses). `messages.create` is also provided (delegating
 * to the same translation but resolving the whole response) for any non-loop
 * caller that expects the create() shape.
 *
 * `maxRetries` is OPTIONAL and OMITTED unless supplied, so production keeps the
 * SDK default byte-identically. It exists for the Plan-00 live evaluation lane,
 * which must issue exactly one provider call per attempt: a silent SDK retry
 * would consume a second provider identity that the evidence record could never
 * account for.
 *
 * @param {{apiKey:string, maxRetries?:number}} opts
 * @returns {{messages:{stream:Function, create:Function}}}
 */
export function createOpenAIToolUseAdapter({ apiKey, maxRetries }) {
  if (!apiKey) {
    throw new Error('createOpenAIToolUseAdapter: apiKey required');
  }
  const openai = new OpenAI(maxRetries == null ? { apiKey } : { apiKey, maxRetries });
  return {
    // Inert config echo so a caller/test can verify what the WIRED client
    // was actually constructed with (the OpenAI instance itself is closed
    // over) — added for the 08C-A providerMaxRetries ordering regression.
    providerConfig: Object.freeze({ maxRetries: maxRetries ?? null }),
    messages: {
      stream: (streamArgs, options) => createStream(openai, streamArgs, options),
      create: async (streamArgs, options) => {
        const stream = createStream(openai, streamArgs, options);
        return stream.finalMessage();
      },
    },
  };
}

export const _internals = Object.freeze({
  flattenSystem,
  toOpenAITools,
  toOpenAIMessages,
  mapFinishReason,
  buildAnthropicContent,
  synthesizeEvents,
  mapUsage,
  createStream,
});
