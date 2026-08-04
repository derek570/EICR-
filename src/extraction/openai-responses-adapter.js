/**
 * OpenAI Responses-API tool-use adapter — the fixed sibling of
 * openai-tooluse-adapter.js. Exposes the same Anthropic-shaped
 * `messages.stream()` contract, backed by OpenAI's `/v1/responses` endpoint
 * instead of `/v1/chat/completions`, using REAL server-sent streaming rather
 * than a single buffered call.
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
 * WHY REAL STREAMING (not the original buffer-then-synthesize design,
 * upgraded 2026-07-31 for a fair Loaded Barrel comparison): production runs
 * with VOICE_LATENCY_LOADED_BARREL=true, which speculatively pre-synthesizes
 * ElevenLabs confirmation audio the MOMENT a tool_use's content_block_stop
 * fires mid-stream (stage6-tool-loop.js's onToolUseStreamed hook) — before
 * the model's full response has finished. A buffer-then-synthesize adapter
 * can't give Luna that same advantage: by construction the ENTIRE OpenAI
 * response has already landed before any synthetic event is emitted, so
 * onToolUseStreamed fires at the same moment finalMessage() would resolve
 * regardless. Wiring real streaming here — consuming OpenAI's actual SSE
 * events (`response.output_item.added` / `.function_call_arguments.delta` /
 * `.output_item.done` / `.completed`, verified live) and translating them to
 * Anthropic-shaped events AS THEY ARRIVE — lets Luna's tool_use blocks reach
 * the assembler (and therefore Loaded Barrel) the moment each one's own
 * arguments finish, not after the whole response completes. This matters
 * most on multi-tool-call turns; on a single-call turn the win is whatever
 * gap exists between function_call_arguments.done and response.completed
 * (observed ~100-300ms in earlier probes) — real but modest, since the
 * dominant cost (reasoning time before the FIRST tool_use appears) can't be
 * parallelized by streaming either way.
 *
 * WHY the request/response shapes differ from openai-tooluse-adapter.js:
 *   - Tools are FLAT ({type:'function', name, description, parameters}), not
 *     nested under a `function` key.
 *   - GPT-5.6 explicit-cache mode -> a `developer` input item split at the
 *     stable breakpoint; rollback/older models -> top-level `instructions`.
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
 *     ({type:'reasoning', id, encrypted_content}) on the FINAL assistant
 *     message (built from `.finalResponse()`, not the live event stream —
 *     reasoning items are never surfaced to the assembler, only to
 *     buildAnthropicContent for continuity). runToolLoop pushes that content
 *     array onto `messages` opaquely (it only inspects blocks of type
 *     'tool_use'), so it round-trips untouched; this module's own translator
 *     re-expands it into a `reasoning` input item, in original order, on the
 *     next round.
 *
 * WHAT REACHES THE ASSEMBLER, LIVE, vs WHAT'S BUFFERED: only `function_call`
 * item lifecycle events (`response.output_item.added` /
 * `.function_call_arguments.delta` / `.output_item.done`) are translated into
 * live content_block_start/delta/stop events — matching the Chat Completions
 * assembler's own contract, which no-ops on text and never tracks reasoning
 * blocks (createAssembler only creates per-index state for `tool_use`-typed
 * content_block_start). Message-type text and reasoning items are captured
 * ONLY in the final buffered content (via `.finalResponse()` +
 * `buildAnthropicContent`), exactly as the non-streaming design did —
 * streaming only changes WHEN tool_use blocks become visible, not what ends
 * up in the final content array.
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
 * SCOPE: read-back extraction path only; additive cost telemetry is ignored
 * safely by older iOS/web clients.
 */
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import {
  SYSTEM_BLOCK_SEPARATOR,
  getOpenAIStableSystemBlockCount,
  renderSystemPrompt,
} from './system-prompt-renderer.js';

// ---------------------------------------------------------------------------
// Anthropic -> Responses request translation
// ---------------------------------------------------------------------------

const flattenSystem = renderSystemPrompt;
const PROMPT_CACHE_KEY_VERSION = 'certmate-s6-v1';

function isGPT56Model(model) {
  return /^gpt-5\.6(?:-|$)/i.test(String(model ?? '').trim());
}

/**
 * Source-controlled rollback for GPT-5.6 explicit caching. `implicit` keeps
 * the pre-change Responses payload. Older OpenAI model families also retain
 * implicit caching because the explicit-breakpoint contract is GPT-5.6-only.
 */
function resolvePromptCacheMode(raw = process.env.OPENAI_EXTRACT_PROMPT_CACHE, model) {
  const configured = String(raw ?? 'implicit')
    .trim()
    .toLowerCase();
  if (configured !== 'explicit' && configured !== 'implicit') {
    throw new Error(`Unsupported OPENAI_EXTRACT_PROMPT_CACHE: ${raw}`);
  }
  return configured === 'explicit' && isGPT56Model(model) ? 'explicit' : 'implicit';
}

function systemTextEntries(system) {
  if (typeof system === 'string') {
    return system.length > 0 ? [{ sourceIndex: 0, text: system }] : [];
  }
  if (!Array.isArray(system)) return [];
  return system
    .map((block, sourceIndex) => ({
      sourceIndex,
      text: typeof block === 'string' ? block : block?.type === 'text' ? block.text || '' : '',
    }))
    .filter(({ text }) => text.length > 0);
}

/**
 * Convert the system blocks into one developer message while preserving the
 * exact text produced by renderSystemPrompt(). The separator is prefixed to
 * each later content block so the cache marker can sit at the stable-prefix
 * boundary without changing a single model-visible byte.
 */
function toExplicitSystemInput(system) {
  const entries = systemTextEntries(system);
  if (entries.length === 0) return { item: null, stableText: '', breakpointEnabled: false };

  const stableSourceCount = getOpenAIStableSystemBlockCount(system);
  const stableEntries = entries.filter(({ sourceIndex }) => sourceIndex < stableSourceCount);
  const stableLastSourceIndex = stableEntries.at(-1)?.sourceIndex;
  const content = entries.map(({ sourceIndex, text }, index) => {
    const block = {
      type: 'input_text',
      text: `${index === 0 ? '' : SYSTEM_BLOCK_SEPARATOR}${text}`,
    };
    if (sourceIndex === stableLastSourceIndex) {
      block.prompt_cache_breakpoint = { mode: 'explicit' };
    }
    return block;
  });

  return {
    item: { role: 'developer', content },
    stableText: stableEntries.map(({ text }) => text).join(SYSTEM_BLOCK_SEPARATOR),
    breakpointEnabled: stableEntries.length > 0,
  };
}

/** PII-safe routing key: only a version label plus a digest leaves process. */
function buildPromptCacheKey({ model, stableText, tools }) {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        version: PROMPT_CACHE_KEY_VERSION,
        model: String(model ?? ''),
        stableText,
        tools: tools ?? [],
      })
    )
    .digest('hex')
    .slice(0, 48);
  return `${PROMPT_CACHE_KEY_VERSION}-${digest}`;
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
 * Translate OpenAI's REAL Responses-API streaming events into the Anthropic
 * event sequence the assembler consumes, AS THEY ARRIVE — the mechanism that
 * makes Loaded Barrel's onToolUseStreamed hook fire mid-generation for Luna
 * instead of only after the full response lands (see module docstring).
 *
 * Only function_call item lifecycle events become content_block_start/delta/
 * stop — matching the assembler's own contract (it only tracks per-index
 * state for `tool_use`-typed content_block_start; text/reasoning are no-ops
 * there today, and the FINAL content array — including reasoning, for
 * continuity — is built separately from `.finalResponse()`, not from this
 * live translation). Delta routing is keyed by `event.item_id`/`item.id`
 * (never assumed ordering), the same defensive pattern the Anthropic
 * assembler itself uses for interleaved blocks.
 *
 * @param {AsyncIterable<object>} openaiStream Real SSE-shaped events from
 *   `openai.responses.stream(...)`.
 */
async function* translateStreamingEvents(openaiStream) {
  yield { type: 'message_start' };
  let index = 0;
  const indexByItemId = new Map();
  let stopReason = 'end_turn';

  for await (const event of openaiStream) {
    switch (event.type) {
      case 'response.output_item.added': {
        if (event.item?.type === 'function_call') {
          const idx = index;
          index += 1;
          indexByItemId.set(event.item.id, idx);
          yield {
            type: 'content_block_start',
            index: idx,
            content_block: {
              type: 'tool_use',
              id: event.item.call_id,
              name: event.item.name,
              input: {},
            },
          };
        }
        // reasoning / message items are intentionally NOT surfaced here —
        // they never reach the assembler even in the non-streaming design;
        // final content (incl. reasoning, for continuity) comes from
        // finalResponse() -> buildAnthropicContent below.
        break;
      }
      case 'response.function_call_arguments.delta': {
        const idx = indexByItemId.get(event.item_id);
        if (idx !== undefined) {
          yield {
            type: 'content_block_delta',
            index: idx,
            delta: { type: 'input_json_delta', partial_json: event.delta || '' },
          };
        }
        break;
      }
      case 'response.output_item.done': {
        if (event.item?.type === 'function_call') {
          const idx = indexByItemId.get(event.item.id);
          if (idx !== undefined) {
            yield { type: 'content_block_stop', index: idx };
          }
        }
        break;
      }
      case 'response.completed': {
        stopReason = mapStopReason(event.response);
        break;
      }
      default:
        // response.created / response.in_progress / response.content_part.* /
        // response.output_text.* / response.reasoning_summary_text.* / other
        // event types are intentionally ignored on the live-translation path.
        break;
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

/**
 * Resolve the source-controlled OpenAI extraction service tier. Standard is
 * represented by omitting `service_tier`; Fast is an explicit Responses-API
 * request property. Fail closed on a typo so a supposedly accelerated field
 * trial cannot silently run at Standard latency.
 */
function resolveServiceTier(raw = process.env.OPENAI_EXTRACT_SERVICE_TIER) {
  const tier = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!tier || tier === 'default' || tier === 'standard') return undefined;
  if (tier === 'fast') return 'fast';
  throw new Error(`Unsupported OPENAI_EXTRACT_SERVICE_TIER: ${raw}`);
}

/**
 * Preserve raw provider metadata separately from the Anthropic-compatible
 * fallback fields. OpenAI may omit Standard's tier, and a partial response
 * may omit its model; billing attribution must be able to distinguish those
 * provider facts from adapter compatibility defaults.
 */
function toAnthropicMessage(finalResp, fallbackModel, fallbackServiceTier, promptCache) {
  const message = {
    content: buildAnthropicContent(finalResp),
    usage: mapUsage(finalResp.usage),
    stop_reason: mapStopReason(finalResp),
    role: 'assistant',
    model: finalResp?.model || fallbackModel,
    service_tier: finalResp?.service_tier || fallbackServiceTier,
    response_model: finalResp?.model ?? null,
    response_service_tier: finalResp?.service_tier ?? null,
    requested_model: fallbackModel,
    requested_service_tier: fallbackServiceTier ?? null,
  };
  if (promptCache) message.prompt_cache = promptCache;
  return message;
}

// ---------------------------------------------------------------------------
// The stream object (async-iterable + finalMessage)
// ---------------------------------------------------------------------------

/**
 * @param {OpenAI} openai
 * @param {object} streamArgs Anthropic-shaped { model, max_tokens, system, messages, tools }
 * @param {object} [options] { signal }
 * @returns {{
 *   [Symbol.asyncIterator]: () => AsyncGenerator, // drives the assembler live
 *   finalMessage: () => Promise<object>,          // the post-loop assistant turn
 * }}
 *
 * ONE real `openai.responses.stream(...)` call backs BOTH halves — memoised
 * so the HTTP request happens exactly once regardless of which the caller
 * touches first. `runToolLoop`'s actual usage pattern (iterate fully, THEN
 * call finalMessage()) means `.finalResponse()` resolves instantly at that
 * point, since the SDK has already fully drained the stream during
 * iteration; verified live that `.finalResponse()` also works correctly when
 * called WITHOUT prior manual iteration (the `create()` convenience method
 * below relies on this — though the only live-reachable `.create()` caller,
 * the cache-keepalive ping, passes no tools and fails non-fatally on error).
 */
function createStream(openai, streamArgs, options) {
  const {
    model,
    max_tokens,
    system,
    messages,
    tools,
    service_tier: serviceTierOverride,
    reasoning_effort: reasoningEffortOverride,
  } = streamArgs;
  const { signal } = options || {};

  const responsesTools = toResponsesTools(tools);
  const promptCacheMode = resolvePromptCacheMode(undefined, model);
  const conversationInput = toResponsesInput(messages);
  const promptCache = {
    mode: promptCacheMode,
    breakpoint_enabled: false,
    key_id: null,
  };
  const requestPayload = {
    model,
    input: conversationInput,
    tools: responsesTools,
    tool_choice: 'auto',
    // Structured extraction with tool calls; visible output stays small, the
    // headroom is for reasoning tokens (counted inside output_tokens, not
    // billed separately — see mapUsage docstring).
    max_output_tokens: Math.max((max_tokens || 4096) * 4, 8192),
    reasoning: {
      // Plan 00B-2 C3 — the tool-loop dispatch resolver
      // (stage6-shadow-harness resolveOpenAIReasoningEffort) is
      // authoritative and always threads streamArgs.reasoning_effort for
      // live OpenAI turns; the env fallback here is RETAINED for callers
      // that thread nothing (the create() cache-keepalive path) and yields
      // the same string when the env is unset.
      effort: String(
        reasoningEffortOverride ?? process.env.OPENAI_EXTRACT_REASONING_EFFORT ?? 'low'
      ).trim(),
    },
  };
  if (promptCacheMode === 'explicit') {
    const explicitSystem = toExplicitSystemInput(system);
    requestPayload.input = explicitSystem.item
      ? [explicitSystem.item, ...conversationInput]
      : conversationInput;
    if (explicitSystem.breakpointEnabled) {
      const promptCacheKey = buildPromptCacheKey({
        model,
        stableText: explicitSystem.stableText,
        tools: responsesTools,
      });
      requestPayload.prompt_cache_key = promptCacheKey;
      requestPayload.prompt_cache_options = { mode: 'explicit' };
      promptCache.breakpoint_enabled = true;
      promptCache.key_id = promptCacheKey.slice(-12);
    }
  } else {
    requestPayload.instructions = flattenSystem(system);
  }
  const configuredServiceTier = String(
    serviceTierOverride ?? process.env.OPENAI_EXTRACT_SERVICE_TIER ?? 'standard'
  )
    .trim()
    .toLowerCase();
  const serviceTier = resolveServiceTier(configuredServiceTier);
  if (serviceTier) requestPayload.service_tier = serviceTier;

  let openaiStreamPromise = null;
  const getOpenaiStream = () => {
    if (!openaiStreamPromise) {
      openaiStreamPromise = Promise.resolve(
        openai.responses.stream(requestPayload, signal ? { signal } : undefined)
      );
    }
    return openaiStreamPromise;
  };

  return {
    async *[Symbol.asyncIterator]() {
      const openaiStream = await getOpenaiStream();
      for await (const ev of translateStreamingEvents(openaiStream)) yield ev;
    },
    async finalMessage() {
      const openaiStream = await getOpenaiStream();
      const finalResp = await openaiStream.finalResponse();
      return toAnthropicMessage(finalResp, model, configuredServiceTier || 'standard', promptCache);
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
  isGPT56Model,
  resolvePromptCacheMode,
  systemTextEntries,
  toExplicitSystemInput,
  buildPromptCacheKey,
  toResponsesTools,
  toResponsesInput,
  mapStopReason,
  buildAnthropicContent,
  translateStreamingEvents,
  mapUsage,
  resolveServiceTier,
  toAnthropicMessage,
  createStream,
});
