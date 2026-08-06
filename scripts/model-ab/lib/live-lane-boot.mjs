/**
 * Plan 00B-4 §C1b — the LIVE vendor-lane boot path.
 *
 * ## Why this is a separate boot and not a flag on the mock boot
 *
 * `bootLaneDriver` (lane-driver.mjs) exists to make a provider call
 * IMPOSSIBLE: it deletes the vendor keys, installs a fetch that denies every
 * request, freezes time with fake timers, and hands the session an
 * undispatchable bootstrap client. Every one of those is load-bearing for the
 * deterministic lane and every one of them is wrong for a live sample. Trying
 * to express "all of that, except the four things that matter" as booleans on
 * one function is how a live run silently inherits a mock guard (or worse, how
 * a mock run silently loses one). The two boots therefore share the
 * fixture-driving body (`driveFixture`) and nothing else.
 *
 * ## The one-call rule, and why `maxRetries: 0` alone does not deliver it
 *
 * 00B's evidence contract needs each attempt to consume exactly ONE provider
 * identity, because `sample_identity` is a hash over the ordered provider call
 * ids and a silent retry would fold in an id no reviewer ever authorised.
 * There are TWO retry loops between the lane and the vendor:
 *
 *   1. the SDK's own (`new Anthropic({ maxRetries })`, `new OpenAI({ maxRetries })`)
 *   2. `callWithRetry` in `src/extraction/eicr-extraction-session.js`, which
 *      wraps every provider call in its own attempt loop over 429/5xx
 *
 * Disabling (1) leaves (2) running three attempts. So the lane clamps BOTH:
 * `maxRetries: 0` at construction, and the session's lane-only
 * `maxProviderAttempts: 1` option. That option is resolved ONCE at
 * construction (Research §Pitfall 4) and is absent everywhere else, so
 * production retry behaviour is byte-identical.
 *
 * ## Provider identity is captured from ERRORS too
 *
 * An errored call still consumed a vendor identity. If it carries a request
 * id, that id belongs in the attempt record — otherwise a rate-limited sample
 * would look like it never happened. The recorder therefore wraps
 * `messages.create` (the ONLY dispatch the session performs — verified by
 * grep: two call sites, both `client.messages.create`) and reads the id from
 * the success response AND from the thrown error, then classifies the error
 * into a kind that maps to an INVALID terminal. Semantic PASS/FAIL is a
 * statement about the MODEL; an infrastructure failure is a statement about
 * the lane, and conflating them would let a bad afternoon on the vendor's side
 * masquerade as a regression.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { brandLiveEvaluationClient } from '../../plan00-evidence/lib/live-capability.mjs';

/** Hosts the live lane may reach. Everything else is denied by the policy
 *  fetch, so a stray telemetry/postcode call cannot leave the lane. */
export const LIVE_ALLOWED_HOSTS = Object.freeze(['api.anthropic.com', 'api.openai.com']);

/** The live lane reuses the mock driver's offline playback-ack identity — the
 *  ACK route is implementation evidence and never touches a vendor. */
export const LIVE_DRIVER_USER = 'lane-driver-user';
export const LIVE_DRIVER_TOKEN = 'lane-driver-offline-token';

/** Absolute ceiling on vendor calls per boot — a runaway tool loop burns money
 *  and pollutes the id stream; the policy fetch throws past this. */
export const DEFAULT_LIVE_HARD_MAX_VENDOR_CALLS = 64;

/** Real-time pump tuning. 400 iterations × 250ms ≈ 100s of provider budget. */
const DEFAULT_POLL_MS = 250;
const DEFAULT_MAX_IDLE_MS = 90_000;
const MAX_TICK_MS = 5_000;

/** Error kinds. Every one maps to an INVALID terminal, never a FAIL. */
export const PROVIDER_ERROR_KINDS = Object.freeze({
  RATE_LIMIT: 'provider_rate_limit',
  NETWORK: 'provider_network_error',
  SERVER: 'provider_server_error',
  PROVIDER: 'provider_error',
});

const NETWORK_ERRNO =
  /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED)$/;

/**
 * Pin the live-lane environment. Deliberately mirrors `pinMockLaneEnv` for the
 * DETERMINISM pins (tool-call mode, speculator off, tier routing off, throwaway
 * storage) and deliberately diverges on the vendor keys — a live lane that
 * cannot authenticate is not a lane.
 *
 * @param {object} [env] injectable for tests; defaults to process.env
 * @returns {{localDataDir:string}}
 */
export function pinLiveLaneEnv(env = process.env) {
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    const value = env[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `pinLiveLaneEnv: ${key} is absent or empty — the live vendor lane dispatches real ` +
          'provider calls and must never fall back to a mock client'
      );
    }
  }
  env.SONNET_TOOL_CALLS = 'live';
  env.VOICE_LATENCY_LOADED_BARREL = 'false';
  env.OBSERVATION_TIER_ROUTING = 'false';
  delete env.VOICE_LATENCY_ROUND1_MODEL;
  delete env.VOICE_LATENCY_KILL_SWITCH;
  // Storage: env-disable S3 so uploads become local writes into a throwaway
  // dir. The lane's evidence goes to the versioned evidence bucket through the
  // evidence store, never through the session's own upload path.
  delete env.S3_BUCKET;
  const localDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan00-live-lane-'));
  env.LOCAL_DATA_DIR = localDataDir;
  return { localDataDir };
}

/**
 * Pull a PII-free provider call id out of a success response or a thrown error.
 * Both SDKs expose the id in more than one place depending on transport and
 * failure mode, so this checks each known carrier in a fixed order and returns
 * the first non-empty string. Returns null when the vendor gave us nothing —
 * NEVER a fabricated or derived id (the runner fails closed on a missing id,
 * which is the correct outcome; inventing one would defeat the whole contract).
 */
export function extractProviderCallId(value) {
  if (value == null || (typeof value !== 'object' && typeof value !== 'function')) return null;
  const headerLookup = (headers) => {
    if (headers == null) return null;
    if (typeof headers.get === 'function') {
      const got = headers.get('request-id') ?? headers.get('x-request-id');
      return typeof got === 'string' && got.length > 0 ? got : null;
    }
    if (typeof headers === 'object') {
      const got = headers['request-id'] ?? headers['x-request-id'];
      return typeof got === 'string' && got.length > 0 ? got : null;
    }
    return null;
  };
  const candidates = [
    value.id,
    value._request_id,
    value.request_id,
    value.requestID,
    value.error?.request_id,
    value.response?.id,
    headerLookup(value.headers),
    headerLookup(value.response?.headers),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}

/**
 * Classify a provider error. Every branch returns a kind that the caller maps
 * to an INVALID terminal — the distinction exists so a run console can say
 * WHICH infrastructure failure happened, not so any of them can become a FAIL.
 */
export function classifyProviderError(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (status === 429) return PROVIDER_ERROR_KINDS.RATE_LIMIT;
  if (typeof status === 'number' && status >= 500) return PROVIDER_ERROR_KINDS.SERVER;
  const code = err?.code ?? err?.cause?.code ?? err?.errno;
  if (typeof code === 'string' && NETWORK_ERRNO.test(code)) return PROVIDER_ERROR_KINDS.NETWORK;
  const name = err?.name ?? err?.constructor?.name;
  if (
    name === 'APIConnectionError' ||
    name === 'APIConnectionTimeoutError' ||
    name === 'AbortError'
  ) {
    return PROVIDER_ERROR_KINDS.NETWORK;
  }
  if (typeof status === 'number') return PROVIDER_ERROR_KINDS.PROVIDER;
  if (err instanceof TypeError && /fetch/i.test(String(err?.message ?? ''))) {
    return PROVIDER_ERROR_KINDS.NETWORK;
  }
  return PROVIDER_ERROR_KINDS.PROVIDER;
}

/**
 * Ordered, de-duplicated provider-call-id recorder.
 *
 * Order matters (the sample identity hashes the ORDERED list) and duplicates
 * must collapse (a single response read twice is one identity), so this is an
 * insertion-ordered Set rather than an array push.
 */
export function createProviderCallRecorder() {
  const ids = new Set();
  const calls = [];
  return {
    /** @param {{provider:string, callId:string|null, ok:boolean, errorKind?:string|null}} call */
    record(call) {
      calls.push(Object.freeze({ errorKind: null, ...call }));
      if (typeof call.callId === 'string' && call.callId.length > 0) ids.add(call.callId);
      return call;
    },
    /** Ordered unique ids, exactly as the attempt record wants them. */
    ids() {
      return [...ids];
    },
    /** PII-free per-call log: provider, id, ok, error kind. No payloads. */
    calls() {
      return [...calls];
    },
    /** Count of dispatches attempted — the one-call rule's observable. */
    get callCount() {
      return calls.length;
    },
    reset() {
      ids.clear();
      calls.length = 0;
    },
  };
}

/**
 * Wrap an SDK client so every `messages.create` records its provider call id —
 * on success AND on failure. Returns a NEW object; the underlying client is
 * never mutated (a mutated SDK client would leak the recorder into any other
 * consumer that happens to share it).
 */
export function wrapRecordingClient(client, { provider, recorder }) {
  if (typeof client !== 'object' || client === null) {
    throw new TypeError('wrapRecordingClient: client must be an object');
  }
  if (typeof client.messages?.create !== 'function') {
    throw new TypeError('wrapRecordingClient: client.messages.create must be a function');
  }
  if (recorder == null || typeof recorder.record !== 'function') {
    throw new TypeError('wrapRecordingClient: recorder must expose record()');
  }
  const messages = client.messages;
  const wrapped = {
    ...client,
    messages: {
      ...messages,
      async create(...args) {
        try {
          const response = await messages.create.apply(messages, args);
          recorder.record({
            provider,
            callId: extractProviderCallId(response),
            ok: true,
          });
          return response;
        } catch (err) {
          recorder.record({
            provider,
            callId: extractProviderCallId(err),
            ok: false,
            errorKind: classifyProviderError(err),
          });
          throw err;
        }
      },
    },
  };
  // `stream` is not on the live session's dispatch path (verified: the session
  // only ever calls `messages.create`). It is carried through UNWRAPPED rather
  // than deleted so a future caller gets the real method instead of a silent
  // undefined — and a pin asserts the recorder saw a create-shaped call, so a
  // future switch to `stream` fails loudly instead of recording nothing.
  return wrapped;
}

/**
 * Construct BOTH evaluation clients with retries disabled, wrap them in the
 * recorder, and brand the WRAPPERS — the wrapper is what gets injected into the
 * session, so the wrapper is what the capability gate must recognise.
 *
 * Constructors are injected so the pins can assert the exact options passed to
 * the SDKs without holding real credentials.
 */
export function createLiveEvaluationClients({
  recorder,
  env = process.env,
  anthropicFactory,
  openaiToolUseFactory,
  openaiResponsesFactory,
  extractionApi = (process.env.OPENAI_EXTRACT_API || 'responses').trim(),
} = {}) {
  if (recorder == null || typeof recorder.record !== 'function') {
    throw new TypeError('createLiveEvaluationClients: recorder must expose record()');
  }
  if (typeof anthropicFactory !== 'function') {
    throw new TypeError('createLiveEvaluationClients: anthropicFactory required');
  }
  const anthropicKey = env.ANTHROPIC_API_KEY;
  const openaiKey = env.OPENAI_API_KEY;
  if (typeof anthropicKey !== 'string' || anthropicKey.trim() === '') {
    throw new Error('createLiveEvaluationClients: ANTHROPIC_API_KEY absent');
  }
  if (typeof openaiKey !== 'string' || openaiKey.trim() === '') {
    throw new Error('createLiveEvaluationClients: OPENAI_API_KEY absent');
  }

  const anthropicRaw = anthropicFactory({ apiKey: anthropicKey, maxRetries: 0 });

  let openaiRaw;
  if (extractionApi === 'chat_completions') {
    if (typeof openaiToolUseFactory !== 'function') {
      throw new TypeError('createLiveEvaluationClients: openaiToolUseFactory required');
    }
    openaiRaw = openaiToolUseFactory({ apiKey: openaiKey, maxRetries: 0 });
  } else if (extractionApi === 'responses') {
    if (typeof openaiResponsesFactory !== 'function') {
      throw new TypeError('createLiveEvaluationClients: openaiResponsesFactory required');
    }
    openaiRaw = openaiResponsesFactory({ apiKey: openaiKey, maxRetries: 0 });
  } else {
    throw new Error(
      `createLiveEvaluationClients: unsupported OPENAI_EXTRACT_API "${extractionApi}" — ` +
        'expected "responses" or "chat_completions"'
    );
  }

  return {
    anthropic: brandLiveEvaluationClient(
      wrapRecordingClient(anthropicRaw, { provider: 'anthropic', recorder }),
      {
        provider: 'anthropic',
        maxRetries: 0,
      }
    ),
    openai: brandLiveEvaluationClient(
      wrapRecordingClient(openaiRaw, { provider: 'openai', recorder }),
      {
        provider: 'openai',
        maxRetries: 0,
      }
    ),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A REAL-TIME control satisfying the exact surface `driveFixture` expects from
 * the deterministic replay clock.
 *
 * The live lane cannot install fake timers: the SDK's own timeout, the TCP
 * stack and the provider all need wall-clock time to pass, and a frozen clock
 * would deadlock the very call we are trying to sample. So the pump becomes a
 * bounded real-time poll. The idle budget is what stops a hung provider call
 * from parking the lane forever — past it `advanceNext` stops advancing and the
 * driver's own iteration cap converts the stall into an INVALID_HOLD.
 */
export function makeRealtimeClockControl({
  maxIdleMs = DEFAULT_MAX_IDLE_MS,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  let idleMs = 0;
  return {
    realtime: true,
    async drainMicrotasks() {
      // Three passes: enough to flush a promise chain a few links deep without
      // pretending to be a scheduler.
      for (let i = 0; i < 3; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    async tick(ms) {
      const delay = Math.max(0, Math.min(Number(ms) || 0, MAX_TICK_MS));
      if (delay > 0) await sleep(delay);
      return { advanced: true };
    },
    async advanceNext() {
      if (idleMs >= maxIdleMs) return { advanced: false, idleMs };
      await sleep(pollMs);
      idleMs += pollMs;
      return { advanced: true, idleMs };
    },
    /** No ledger in real time — nothing was intercepted, so nothing leaked. */
    resetLedger() {
      idleMs = 0;
      return { clearedPending: 0 };
    },
    uninstall() {},
  };
}

/**
 * Boot the LIVE lane. Order is load-bearing:
 *
 *   1. pin env (keys PRESERVED, storage redirected)
 *   2. install the host-allowlisted policy fetch — BEFORE any SDK client is
 *      constructed, because the SDKs snapshot `globalThis.fetch` at
 *      construction (see network-guard.mjs); installing it afterwards would
 *      leave the vendor clients on the unguarded original
 *   3. import production modules
 *   4. construct + wrap + brand both evaluation clients
 */
export async function bootLiveLaneDriver({
  repoRoot,
  allowedHosts = LIVE_ALLOWED_HOSTS,
  hardMaxVendorCalls = DEFAULT_LIVE_HARD_MAX_VENDOR_CALLS,
  maxIdleMs = DEFAULT_MAX_IDLE_MS,
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('bootLiveLaneDriver: repoRoot required');
  }
  pinLiveLaneEnv();

  const flLib = (f) => pathToFileURL(path.join(repoRoot, 'scripts/field-replay/lib', f)).href;
  const srcMod = (f) => pathToFileURL(path.join(repoRoot, 'src', f)).href;

  const { installLiveFetchPolicy } = await import(flLib('network-guard.mjs'));
  const fetchPolicy = installLiveFetchPolicy({
    allowedHosts: [...allowedHosts],
    hardMaxVendorCalls,
  });

  const sonnetStream = await import(srcMod('extraction/sonnet-stream.js'));
  const lifecycle = await import(srcMod('extraction/plan00-lifecycle-hooks.js'));
  const { EICRExtractionSession } = await import(srcMod('extraction/eicr-extraction-session.js'));
  const capture = await import(srcMod('extraction/plan00-semantic-capture.js'));
  const ledgers = await import(srcMod('extraction/plan00-audibility-ledgers.js'));
  const { createPlaybackAckRouter } = await import(srcMod('routes/voice-latency-playback-ack.js'));
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { createOpenAIToolUseAdapter } = await import(
    srcMod('extraction/openai-tooluse-adapter.js')
  );
  const { createOpenAIResponsesAdapter } = await import(
    srcMod('extraction/openai-responses-adapter.js')
  );
  const express = (await import('express')).default;
  const request = (await import('supertest')).default;

  const recorder = createProviderCallRecorder();
  const liveProviderClients = createLiveEvaluationClients({
    recorder,
    anthropicFactory: (opts) => new Anthropic(opts),
    openaiToolUseFactory: createOpenAIToolUseAdapter,
    openaiResponsesFactory: createOpenAIResponsesAdapter,
  });

  const app = express();
  app.use(express.json());
  const offlineAuth = (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${LIVE_DRIVER_TOKEN}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.user = { id: LIVE_DRIVER_USER };
    return next();
  };
  app.use('/api', createPlaybackAckRouter({ requireAuth: offlineAuth }));

  return {
    liveMode: true,
    clockCtl: makeRealtimeClockControl({ maxIdleMs }),
    TIMER_CLASSES: null,
    sonnetStream,
    lifecycle,
    capture,
    ledgers,
    EICRExtractionSession,
    makeTurnClient: null,
    liveProviderClients,
    providerCallRecorder: recorder,
    fetchPolicy,
    playbackApp: app,
    request,
  };
}
