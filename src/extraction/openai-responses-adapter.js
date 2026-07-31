/**
 * OpenAI Responses-API tool-use adapter — the fixed sibling of
 * openai-tooluse-adapter.js. Exposes the same Anthropic-shaped
 * `messages.stream()` contract, backed by OpenAI's `/v1/responses` endpoint
 * instead of `/v1/chat/completions`.
 *
 * WHY THIS EXISTS (verified live, 2026-07-31): `gpt-5.6-luna` on
 * `/v1/chat/completions` REJECTS function tools with any `reasoning_effort`
 * other than 'none' (HTTP 400: "Function tools with reasoning_effort are not
 * supported for gpt-5.6-luna in /v1/chat/completions. To use function tools,
 * use /v1/responses or set reasoning_effort to 'none'."). Forcing
 * reasoning='none' on the Chat Completions adapter produced a reasoning
 * model with its reasoning switched off — the observed symptom was Luna
 * looping to the 8-round tool-loop cap (~20s) on every non-trivial turn
 * instead of ever emitting a clean end_turn, because a reasoning model
 * without reasoning can't decide it's done. `/v1/responses` allows
 * reasoning_effort WITH function tools; a live probe with reasoning='low'
 * against the exact record_reading schema resolved cleanly in one round.
 *
 * WHY the request/response shapes differ from openai-tooluse-adapter.js:
 *   - Tools are FLAT ({type:'function', name, description, parameters}), not
 *     nested under a `function` key.
 *   - System prompt -> `instructions` (top-level), not a messages[0] system row.
 *   - History -> `input` (an array of typed items), not `messages`. A prior
 *     assistant tool_use round becomes a `function_call` item; a tool_result
 *     becomes a `function_call_output` item keyed by call_id (not tool_use_id
 *     — DIFFERENT field name, same value).
 *   - The model returns a `reasoning` item (opaque `encrypted_content`)
 *     alongside each `function_call`/`message` item in `output[]`. Per
 *     OpenAI's continuation contract this must be echoed back verbatim on the
 *     NEXT request in the same conversation for reasoning continuity — this
 *     adapter is STATELESS across createStream() calls (mirrors the Chat
 *     Completions adapter's design: runToolLoop owns and re-sends the full
 *     `messages` history every round), so reasoning items are smuggled
 *     through as an extra Anthropic-shaped content-block type
 *     ({type:'reasoning', id, encrypted_content}) on the synthesized
 *     assistant message. runToolLoop pushes that content array onto
 *     `messages` opaquely (it only inspects blocks of type 'tool_use'), so it
 *     round-trips untouched; this module's own translator re-expands it into
 *     a `reasoning` input item, in original order, on the next round.
 *
 * USAGE MAPPING (verified live against a cache-cold + cache-warm call pair):
 *   `usage.input_tokens` is the TOTAL prompt size for that call — INCLUSIVE
 *   of both `input_tokens_details.cached_tokens` (read from cache, billed
 *   ~10% of input) and `.cache_write_tokens` (newly written this call,
 *   billed ~125% of input — same 1.25x convention as Anthropic's 5-minute
 *   TTL). The remainder (`input_tokens - cached - write`) is billed at full
 *   input price. Mirrored into the Anthropic Message.usage shape so
 *   CostTracker-style consumers get the same three-bucket split Anthropic
 *   responses carry.
 *
 * SCOPE: read-back extraction path only; iOS/web wire contract unchanged.
 */
import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Anthropic -> Responses request translation
// ---------------------------------------------------------------------------

function flattenSystem(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text || '' : ''))
      .join('');
  }
  return '';
}

/** Anthropic tool defs -> Responses API function tools (FLAT, no nested `function` key). */
function toResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description || '',
    parameters: t.input_schema || { type: 'object', properties: {} },
  }));
}

/**
 * Translate the Anthropic `messages` array into a Responses API `input`
 * array. Order is preserved item-for-item so a `reasoning` block placed
 * before its `tool_use` sibling (as synthesized by buildAnthropicContent
 * below) reconstructs as `reasoning` input item immediately before its
 * `function_call` item — the ordering OpenAI's continuation contract expects.
 */
function toResponsesInput(messages) {
  const input = [];
  for (const m of messages) {
    const content = m.content;

    if (typeof content === 'string') {
      input.push({ role: m.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (m.role === 'assistant') {
      for (const block of content) {
        if (block.type === 'reasoning') {
          // Echoed back verbatim per OpenAI's reasoning-continuity contract.
          input.push({
            type: 'reasoning',
            id: block.id,
            content: [],
            encrypted_content: block.encrypted_content ?? null,
            summary: [],
          });
        } else if (block.type === 'tool_use') {
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments:
              typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
          });
        } else if (block.type === 'text' && block.text) {
          input.push({ role: 'assistant', content: block.text });
        }
      }
      continue;
    }

    // role === 'user': tool_result -> function_call_output (keyed by call_id,
    // NOT tool_use_id — same value, different field name on this API).
    const userTextParts = [];
    for (const block of content) {
      if (block.type === 'tool_result') {
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output:
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
        });
      } else if (block.type === 'text') {
        userTextParts.push(block.text || '');
      }
    }
    if (userTextParts.length > 0) {
      input.push({ role: 'user', content: userTextParts.join('') });
    }
  }
  return input;
}

// ---------------------------------------------------------------------------
// Responses -> Anthropic response translation
// ---------------------------------------------------------------------------

/**
 * Responses API has no single `finish_reason` — presence of a pending
 * function_call is what tells runToolLoop to dispatch and re-invoke
 * (Anthropic's stop_reason:'tool_use'); its absence means the turn is done
 * (stop_reason:'end_turn'), matching runToolLoop's `stop_reason !== 'tool_use'`
 * happy-path branch. `incomplete_details` (e.g. hit max_output_tokens) maps
 * to 'max_tokens' so the loop's existing handling applies unchanged.
 */
function mapStopReason(resp) {
  if (resp?.incomplete_details) return 'max_tokens';
  const hasFunctionCall = (resp?.output ?? []).some((o) => o.type === 'function_call');
  return hasFunctionCall ? 'tool_use' : 'end_turn';
}

/**
 * Build the Anthropic-shaped `content` array from a Responses API result,
 * preserving output[] order: reasoning item(s) first, then function_call(s)
 * and/or the final text message. `input` on each tool_use block is the
 * PARSED arguments object; a parse failure yields {} here (the synthesized
 * assembler event carries the raw string separately, so the assembler's own
 * invalid_json path still fires — same contract as the Chat Completions
 * adapter).
 */
function buildAnthropicContent(resp) {
  const blocks = [];
  for (const item of resp?.output ?? []) {
    if (item.type === 'reasoning') {
      blocks.push({
        type: 'reasoning',
        id: item.id,
        encrypted_content: item.encrypted_content ?? null,
      });
    } else if (item.type === 'function_call') {
      let parsed = {};
      try {
        parsed = JSON.parse(item.arguments || '{}');
      } catch {
        parsed = {};
      }
      blocks.push({ type: 'tool_use', id: item.call_id, name: item.name, input: parsed });
    } else if (item.type === 'message') {
      const text = (item.content ?? [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text || '')
        .join('');
      if (text) blocks.push({ type: 'text', text });
    }
    // Other item types (web_search_call, etc.) are not used by this tool set
    // and are intentionally dropped — they never arise from our tool schema.
  }
  return blocks;
}

/**
 * Emit the Anthropic streaming event sequence the assembler consumes, one
 * content_block per function_call item (reasoning items are NOT surfaced to
 * the assembler — they carry no dispatchable tool_use and would confuse its
 * index-keyed reducer; they only need to round-trip via buildAnthropicContent
 * for the NEXT request's continuity, not via the streamed-record path).
 */
function* synthesizeEvents(resp, stopReason) {
  yield { type: 'message_start' };
  let index = 0;
  for (const item of resp?.output ?? []) {
    if (item.type === 'message') {
      const text = (item.content ?? [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text || '')
        .join('');
      if (text) {
        yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text } };
        yield { type: 'content_block_stop', index };
        index += 1;
      }
    } else if (item.type === 'function_call') {
      yield {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: item.call_id, name: item.name, input: {} },
      };
      yield {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: item.arguments || '' },
      };
      yield { type: 'content_block_stop', index };
      index += 1;
    }
  }
  yield { type: 'message_delta', delta: { stop_reason: stopReason } };
  yield { type: 'message_stop' };
}

/**
 * Responses API usage -> Anthropic Message.usage shape. `input_tokens` on
 * the wire is the TOTAL prompt size (inclusive of cache read + cache write);
 * split into the three Anthropic-shaped buckets so cost accounting downstream
 * (run-lane.mjs) treats both providers identically.
 */
function mapUsage(usage) {
  const total = usage?.input_tokens || 0;
  const cached = usage?.input_tokens_details?.cached_tokens || 0;
  const cacheWrite = usage?.input_tokens_details?.cache_write_tokens || 0;
  return {
    input_tokens: Math.max(total - cached - cacheWrite, 0),
    output_tokens: usage?.output_tokens || 0,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cached,
  };
}

// ---------------------------------------------------------------------------
// The stream object (async-iterable + finalMessage)
// ---------------------------------------------------------------------------

function createStream(openai, streamArgs, options) {
  const { model, max_tokens, system, messages, tools } = streamArgs;
  const { signal } = options || {};

  const requestPayload = {
    model,
    instructions: flattenSystem(system),
    input: toResponsesInput(messages),
    tools: toResponsesTools(tools),
    tool_choice: 'auto',
    // Structured extraction with tool calls; visible output stays small, the
    // headroom is for reasoning tokens (counted inside output_tokens, not
    // billed separately — see mapUsage docstring).
    max_output_tokens: Math.max((max_tokens || 4096) * 4, 8192),
    reasoning: { effort: (process.env.OPENAI_EXTRACT_REASONING_EFFORT || 'low').trim() },
  };

  let resultPromise = null;
  const run = () => {
    if (!resultPromise) {
      resultPromise = openai.responses
        .create(requestPayload, signal ? { signal } : undefined)
        .then((resp) => ({
          resp,
          stopReason: mapStopReason(resp),
          usage: mapUsage(resp.usage),
          content: buildAnthropicContent(resp),
        }));
    }
    return resultPromise;
  };

  return {
    async *[Symbol.asyncIterator]() {
      const { resp, stopReason } = await run();
      for (const ev of synthesizeEvents(resp, stopReason)) yield ev;
    },
    async finalMessage() {
      const { content, usage, stopReason } = await run();
      return { content, usage, stop_reason: stopReason, role: 'assistant' };
    },
  };
}

/**
 * Build an Anthropic-API-shaped wrapper around OpenAI's Responses API,
 * exposing `messages.stream` (the method runToolLoop uses).
 *
 * @param {{apiKey:string}} opts
 * @returns {{messages:{stream:Function, create:Function}}}
 */
export function createOpenAIResponsesAdapter({ apiKey }) {
  if (!apiKey) {
    throw new Error('createOpenAIResponsesAdapter: apiKey required');
  }
  const openai = new OpenAI({ apiKey });
  return {
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
  toResponsesTools,
  toResponsesInput,
  mapStopReason,
  buildAnthropicContent,
  synthesizeEvents,
  mapUsage,
});
