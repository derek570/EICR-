/**
 * Plan 00B-4 §C1b — the live vendor lane: sealed dispatch authority, live
 * client construction, provider-id capture, and the one-call retry clamp.
 *
 * These pins live in their own file rather than in `plan00-evidence.test.js`
 * (already 4000 lines) because they are the only Plan-00 tests that reach
 * OUTSIDE the evidence modules — into the model-AB boot, the lane driver and
 * the real `EICRExtractionSession`. Keeping them together is what makes the
 * "one dispatch means exactly one provider request" claim checkable in one
 * place.
 *
 * Groups:
 *   1 — dispatch authority (the construction boundary)
 *   2 — live client construction + lane env pinning
 *   3 — provider call-id capture and error classification
 *   4 — the retry clamp, driven through the REAL session path
 *   5 — lane-driver liveMode wiring
 */

import { jest } from '@jest/globals';

import { EVIDENCE_PREFIX } from '../../scripts/plan00-evidence/lib/constants.mjs';
import { createMemoryStore } from '../../scripts/plan00-evidence/lib/memory-store.mjs';
import { createS3Store, loadAuditedPrefix } from '../../scripts/plan00-evidence/lib/store.mjs';
import {
  REQUIRED_ATTESTATION_KEYS,
  REQUIRED_LIVE_PROVIDERS,
  REQUIRED_VENDOR_KEY_ENV,
  assertDispatchAuthority,
  brandLiveEvaluationClient,
  describeLiveEvaluationClient,
  isLiveDispatchCapability,
  isLiveEvaluationClient,
  isMockDenyInstalled,
  mintLiveDispatchCapability,
} from '../../scripts/plan00-evidence/lib/live-capability.mjs';
import {
  classifyProviderError,
  createLiveEvaluationClients,
  createProviderCallRecorder,
  extractProviderCallId,
  pinLiveLaneEnv,
  wrapRecordingClient,
} from '../../scripts/model-ab/lib/live-lane-boot.mjs';
import { installRecordedFetchDeny } from '../../scripts/field-replay/lib/network-guard.mjs';
import { EICRExtractionSession } from '../extraction/eicr-extraction-session.js';

const TEST_DIGESTS = { promptDigest: 'pd', toolDigest: 'td', expectationDigest: '2b'.repeat(32) };

async function loadRunner() {
  return import('../../scripts/plan00-evidence/lib/runner.mjs');
}

/** A fully-satisfied mint input set — individual tests break exactly one term. */
function mintInputs(overrides = {}) {
  const attestation = {};
  for (const key of REQUIRED_ATTESTATION_KEYS) attestation[key] = true;
  const clients = {};
  for (const provider of REQUIRED_LIVE_PROVIDERS) {
    clients[provider] = brandLiveEvaluationClient({ tag: provider }, { provider, maxRetries: 0 });
  }
  const env = {};
  for (const key of REQUIRED_VENDOR_KEY_ENV) env[key] = `${key.toLowerCase()}-value`;
  return {
    dispatch: async () => ({ verdict: 'PASS', providerCallIds: ['prov_live_1'] }),
    clients,
    attestation,
    env,
    // A fetch impl that is emphatically NOT the mock lane's `deniedFetch`.
    fetchImpl: function realishFetch() {},
    ...overrides,
  };
}

function runArgs(cohortId, extra = {}) {
  return {
    cohortId,
    requirementKey: `corpus:${cohortId}:luna:run-1:fx2`,
    generation: 1,
    requirementClass: 'vendor_corpus',
    model: 'gpt-5.6-luna',
    tier: 'fast',
    ...TEST_DIGESTS,
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1 — dispatch authority: the construction boundary
//
// The plan's requirement is that a mock verdict in the durable evidence
// store becomes UNREPRESENTABLE rather than merely forbidden. Two halves:
// an injected fake can never be paired with the S3 adapter, and the memory
// store can never be handed one.
// ─────────────────────────────────────────────────────────────────────────
describe('1 — dispatch authority (00B-4 §C1b)', () => {
  test('an injected fake paired with the DURABLE store refuses before anything is consumed', async () => {
    const { runReservedAttempt } = await loadRunner();
    // A genuinely branded durable store. `createS3Store` performs no I/O at
    // construction, so this is hermetic — and it is the real adapter, not a
    // stand-in, which is the whole point of the pin.
    const store = createS3Store({ bucket: 'plan00-live-lane-pin' });

    // Deliberately NO cohortId/requirementKey/generation. If the authority
    // gate were not the very first statement, `buildAttemptCandidate` would
    // throw while hashing an undefined requirement key — a DIFFERENT error.
    // Getting the authority message back is therefore proof of ordering: no
    // ordinal bound, no PENDING created, no provider called.
    await expect(
      runReservedAttempt(store, { execute: async () => ({ verdict: 'PASS' }) })
    ).rejects.toThrow(/injected executor was supplied alongside the DURABLE evidence store/);
  });

  test('the durable store also refuses a MISSING capability rather than falling back', async () => {
    const { runReservedAttempt } = await loadRunner();
    const store = createS3Store({ bucket: 'plan00-live-lane-pin' });
    await expect(runReservedAttempt(store, runArgs('cohort-c1b0000000001'))).rejects.toThrow(
      /not a sealed live-dispatch capability/
    );
  });

  test('the memory-store constructor rejects a durable adapter argument', () => {
    const s3 = createS3Store({ bucket: 'plan00-live-lane-pin' });
    expect(() => createMemoryStore({ adapter: s3 })).toThrow(/refusing a DURABLE store adapter/);
    // ...under ANY option name — the guard is on the value, not the key.
    expect(() => createMemoryStore({ bucket: s3 })).toThrow(/refusing a DURABLE store adapter/);
    // And unknown options are rejected rather than silently ignored, so a
    // future adapter-shaped option cannot slip through unnoticed.
    expect(() => createMemoryStore({ store: {} })).toThrow(/unknown option "store"/);
    expect(() => createMemoryStore({ bucket: 'ok', versioning: 'Enabled' })).not.toThrow();
  });

  test('a sealed capability cannot be forged, spread or reconstructed', () => {
    const real = mintLiveDispatchCapability(mintInputs());
    expect(isLiveDispatchCapability(real)).toBe(true);

    // A spread copy carries identical STATE and zero authority — the WeakSet
    // membership is the capability, and it does not travel with the fields.
    const spread = { ...real };
    expect(isLiveDispatchCapability(spread)).toBe(false);

    // Neither does a hand-rolled lookalike, however convincing.
    const lookalike = Object.freeze({
      dispatch: async () => ({}),
      providers: { ...real.providers },
    });
    expect(isLiveDispatchCapability(lookalike)).toBe(false);

    const store = createMemoryStore();
    expect(() => assertDispatchAuthority(store, { liveDispatch: spread })).toThrow(
      /lookalike object cannot be forged/
    );
  });

  test('mintLiveDispatchCapability refuses on every unmet precondition', () => {
    // Unbranded client — a plain object stamped with the right shape is not
    // a boot-constructed client.
    expect(() =>
      mintLiveDispatchCapability(
        mintInputs({ clients: { anthropic: { maxRetries: 0 }, openai: { maxRetries: 0 } } })
      )
    ).toThrow(/anthropic client is not a branded live evaluation client/);

    // Only one provider booted.
    const half = mintInputs();
    expect(() =>
      mintLiveDispatchCapability({ ...half, clients: { anthropic: half.clients.anthropic } })
    ).toThrow(/openai client is not a branded live evaluation client/);

    // A branded client registered under the WRONG provider name.
    const swapped = mintInputs();
    expect(() =>
      mintLiveDispatchCapability({
        ...swapped,
        clients: { anthropic: swapped.clients.openai, openai: swapped.clients.openai },
      })
    ).toThrow(/branded as "openai"/);

    // Any missing attestation flag, one at a time.
    for (const key of REQUIRED_ATTESTATION_KEYS) {
      const inputs = mintInputs();
      inputs.attestation[key] = false;
      expect(() => mintLiveDispatchCapability(inputs)).toThrow(
        new RegExp(`attestation\\.${key} must be exactly true`)
      );
    }

    // Any missing vendor key, one at a time.
    for (const key of REQUIRED_VENDOR_KEY_ENV) {
      const inputs = mintInputs();
      inputs.env[key] = '   ';
      expect(() => mintLiveDispatchCapability(inputs)).toThrow(
        new RegExp(`${key} is absent or empty`)
      );
    }

    // A non-function dispatch.
    expect(() => mintLiveDispatchCapability(mintInputs({ dispatch: null }))).toThrow(
      /dispatch must be a function/
    );
  });

  test('brandLiveEvaluationClient refuses anything but a hard zero retry budget', () => {
    expect(() => brandLiveEvaluationClient({}, { provider: 'anthropic', maxRetries: 1 })).toThrow(
      /must be constructed with maxRetries: 0/
    );
    expect(() =>
      brandLiveEvaluationClient({}, { provider: 'anthropic', maxRetries: undefined })
    ).toThrow(/must be constructed with maxRetries: 0/);
    expect(() => brandLiveEvaluationClient({}, { provider: 'deepgram', maxRetries: 0 })).toThrow(
      /unknown provider "deepgram"/
    );
    expect(() => brandLiveEvaluationClient(null, { provider: 'openai', maxRetries: 0 })).toThrow(
      /client must be an object/
    );

    const client = brandLiveEvaluationClient({}, { provider: 'openai', maxRetries: 0 });
    expect(isLiveEvaluationClient(client)).toBe(true);
    expect(describeLiveEvaluationClient(client)).toEqual({ provider: 'openai', maxRetries: 0 });
    expect(isLiveEvaluationClient({ ...client })).toBe(false);
  });

  test('a sealed capability DOES dispatch, and its terminal reaches the store', async () => {
    const { runReservedAttempt } = await loadRunner();
    const store = createMemoryStore();
    const cohortId = 'cohort-c1b0000000002';
    let dispatches = 0;
    const capability = mintLiveDispatchCapability(
      mintInputs({
        dispatch: async () => {
          dispatches += 1;
          return { verdict: 'PASS', providerCallIds: ['prov_live_seal_1'] };
        },
      })
    );

    const res = await runReservedAttempt(store, runArgs(cohortId, { liveDispatch: capability }));
    expect(dispatches).toBe(1);
    expect(res.verdict).toBe('PASS');
    expect(res.terminalPublished).toBe(true);

    // Read the terminal back OUT of the store rather than trusting the return
    // value — the pin is that durable evidence EXISTS for a sealed dispatch.
    const { records } = await loadAuditedPrefix(store, `${EVIDENCE_PREFIX}/events/`);
    const terminals = records.map((r) => r.payload).filter((p) => p?.kind === 'attempt_terminal');
    expect(terminals).toHaveLength(1);
    // `buildEvent` SPREADS the terminal body flat into the payload beside
    // schema_version/kind/cohort_id — there is no nested `body` envelope.
    expect(terminals[0].cohort_id).toBe(cohortId);
    expect(terminals[0].verdict).toBe('PASS');
    expect(terminals[0].provider_call_ids).toEqual(['prov_live_seal_1']);
    expect(terminals[0].requirement_key).toBe(runArgs(cohortId).requirementKey);
  });

  test('supplying BOTH execute and a capability is refused rather than silently preferred', () => {
    const store = createMemoryStore();
    const capability = mintLiveDispatchCapability(mintInputs());
    expect(() =>
      assertDispatchAuthority(store, { execute: async () => ({}), liveDispatch: capability })
    ).toThrow(/exactly one of `execute` or `liveDispatch`/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2 — live client construction + lane env pinning
// ─────────────────────────────────────────────────────────────────────────
describe('2 — live evaluation client construction', () => {
  function factories() {
    const seen = [];
    const make = (label) =>
      jest.fn((opts) => {
        seen.push({ label, opts });
        return { label, messages: { create: jest.fn(async () => ({ id: `${label}_resp` })) } };
      });
    return {
      seen,
      anthropicFactory: make('anthropic'),
      openaiToolUseFactory: make('openai-tooluse'),
      openaiResponsesFactory: make('openai-responses'),
    };
  }

  const ENV = { ANTHROPIC_API_KEY: 'ak-live', OPENAI_API_KEY: 'ok-live' };

  test('both providers are constructed with real keys and retries hard-disabled, then branded', () => {
    const f = factories();
    const recorder = createProviderCallRecorder();
    const clients = createLiveEvaluationClients({
      recorder,
      env: ENV,
      extractionApi: 'responses',
      anthropicFactory: f.anthropicFactory,
      openaiToolUseFactory: f.openaiToolUseFactory,
      openaiResponsesFactory: f.openaiResponsesFactory,
    });

    expect(f.anthropicFactory).toHaveBeenCalledWith({ apiKey: 'ak-live', maxRetries: 0 });
    expect(f.openaiResponsesFactory).toHaveBeenCalledWith({ apiKey: 'ok-live', maxRetries: 0 });
    expect(f.openaiToolUseFactory).not.toHaveBeenCalled();

    for (const provider of REQUIRED_LIVE_PROVIDERS) {
      expect(isLiveEvaluationClient(clients[provider])).toBe(true);
      expect(describeLiveEvaluationClient(clients[provider])).toEqual({ provider, maxRetries: 0 });
    }
  });

  test('the chat_completions branch constructs the tool-use client instead', () => {
    const f = factories();
    createLiveEvaluationClients({
      recorder: createProviderCallRecorder(),
      env: ENV,
      extractionApi: 'chat_completions',
      anthropicFactory: f.anthropicFactory,
      openaiToolUseFactory: f.openaiToolUseFactory,
      openaiResponsesFactory: f.openaiResponsesFactory,
    });
    expect(f.openaiToolUseFactory).toHaveBeenCalledWith({ apiKey: 'ok-live', maxRetries: 0 });
    expect(f.openaiResponsesFactory).not.toHaveBeenCalled();
  });

  test('an unsupported OPENAI_EXTRACT_API and absent vendor keys both refuse', () => {
    const f = factories();
    const base = {
      recorder: createProviderCallRecorder(),
      anthropicFactory: f.anthropicFactory,
      openaiToolUseFactory: f.openaiToolUseFactory,
      openaiResponsesFactory: f.openaiResponsesFactory,
    };
    expect(() =>
      createLiveEvaluationClients({ ...base, env: ENV, extractionApi: 'assistants' })
    ).toThrow(/unsupported OPENAI_EXTRACT_API "assistants"/);
    expect(() =>
      createLiveEvaluationClients({
        ...base,
        env: { OPENAI_API_KEY: 'ok' },
        extractionApi: 'responses',
      })
    ).toThrow(/ANTHROPIC_API_KEY absent/);
    expect(() =>
      createLiveEvaluationClients({
        ...base,
        env: { ANTHROPIC_API_KEY: 'ak' },
        extractionApi: 'responses',
      })
    ).toThrow(/OPENAI_API_KEY absent/);
  });

  test('pinLiveLaneEnv PRESERVES vendor keys and refuses to boot without them', () => {
    expect(() => pinLiveLaneEnv({ OPENAI_API_KEY: 'ok' })).toThrow(
      /ANTHROPIC_API_KEY is absent or empty/
    );
    expect(() => pinLiveLaneEnv({ ANTHROPIC_API_KEY: 'ak', OPENAI_API_KEY: '' })).toThrow(
      /OPENAI_API_KEY is absent or empty/
    );

    const env = { ANTHROPIC_API_KEY: 'ak', OPENAI_API_KEY: 'ok', S3_BUCKET: 'prod-bucket' };
    const { localDataDir } = pinLiveLaneEnv(env);
    // The keys survive — this is exactly what separates the live boot from
    // the mock lane's network-deny/fake-client boot.
    expect(env.ANTHROPIC_API_KEY).toBe('ak');
    expect(env.OPENAI_API_KEY).toBe('ok');
    expect(env.SONNET_TOOL_CALLS).toBe('live');
    expect(env.S3_BUCKET).toBeUndefined();
    expect(typeof localDataDir).toBe('string');
    expect(env.LOCAL_DATA_DIR).toBe(localDataDir);
  });

  test('the mock lane fetch deny being installed blocks minting outright', () => {
    const deny = installRecordedFetchDeny();
    try {
      expect(isMockDenyInstalled()).toBe(true);
      expect(() => mintLiveDispatchCapability(mintInputs({ fetchImpl: globalThis.fetch }))).toThrow(
        /deterministic replay lane fetch deny is installed/
      );
    } finally {
      deny.restore();
    }
    expect(isMockDenyInstalled()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3 — provider call-id capture and error classification
//
// An errored call still consumed a provider identity. If the id is dropped
// there, the attempt record understates what the vendor actually served.
// ─────────────────────────────────────────────────────────────────────────
describe('3 — provider call-id capture', () => {
  test('extractProviderCallId reads every documented carrier, in precedence order', () => {
    expect(extractProviderCallId({ id: 'msg_1' })).toBe('msg_1');
    expect(extractProviderCallId({ _request_id: 'req_1' })).toBe('req_1');
    expect(extractProviderCallId({ request_id: 'req_2' })).toBe('req_2');
    expect(extractProviderCallId({ requestID: 'req_3' })).toBe('req_3');
    expect(extractProviderCallId({ response: { id: 'resp_1' } })).toBe('resp_1');
    expect(extractProviderCallId({ headers: { 'request-id': 'hdr_1' } })).toBe('hdr_1');
    expect(extractProviderCallId({ headers: { 'x-request-id': 'hdr_2' } })).toBe('hdr_2');
    expect(extractProviderCallId({ headers: new Headers({ 'request-id': 'hdr_3' }) })).toBe(
      'hdr_3'
    );
    // Precedence: the message id wins over a header when both exist.
    expect(extractProviderCallId({ id: 'msg_9', headers: { 'request-id': 'hdr_9' } })).toBe(
      'msg_9'
    );
    // Trimmed, never fabricated.
    expect(extractProviderCallId({ id: '  msg_pad  ' })).toBe('msg_pad');
    expect(extractProviderCallId({ id: '   ' })).toBeNull();
    expect(extractProviderCallId(null)).toBeNull();
    expect(extractProviderCallId('msg_x')).toBeNull();
  });

  test('an ERROR object still yields its provider id', () => {
    const err = Object.assign(new Error('rate limited'), {
      status: 429,
      _request_id: 'req_err_1',
    });
    expect(extractProviderCallId(err)).toBe('req_err_1');

    const withHeaders = Object.assign(new Error('boom'), {
      status: 500,
      headers: { 'x-request-id': 'req_err_2' },
    });
    expect(extractProviderCallId(withHeaders)).toBe('req_err_2');
  });

  test('classifyProviderError maps rate-limit, server, network and generic failures', () => {
    expect(classifyProviderError({ status: 429 })).toBe('provider_rate_limit');
    expect(classifyProviderError({ status: 503 })).toBe('provider_server_error');
    expect(classifyProviderError({ response: { status: 500 } })).toBe('provider_server_error');
    expect(classifyProviderError({ code: 'ECONNRESET' })).toBe('provider_network_error');
    expect(classifyProviderError({ cause: { code: 'ENOTFOUND' } })).toBe('provider_network_error');
    expect(classifyProviderError({ name: 'APIConnectionError' })).toBe('provider_network_error');
    expect(classifyProviderError({ name: 'APIConnectionTimeoutError' })).toBe(
      'provider_network_error'
    );
    expect(classifyProviderError(new TypeError('fetch failed'))).toBe('provider_network_error');
    expect(classifyProviderError({ status: 400 })).toBe('provider_error');
    expect(classifyProviderError(new Error('who knows'))).toBe('provider_error');
  });

  test('the recorder preserves order, dedupes ids, and counts every call', () => {
    const recorder = createProviderCallRecorder();
    recorder.record({ provider: 'anthropic', callId: 'a1', ok: true });
    recorder.record({ provider: 'openai', callId: 'o1', ok: true });
    recorder.record({
      provider: 'anthropic',
      callId: 'a1',
      ok: false,
      errorKind: 'provider_error',
    });
    recorder.record({
      provider: 'anthropic',
      callId: null,
      ok: false,
      errorKind: 'provider_error',
    });

    expect(recorder.ids()).toEqual(['a1', 'o1']);
    expect(recorder.callCount).toBe(4);
    expect(recorder.calls().map((c) => c.ok)).toEqual([true, true, false, false]);
    // A recorded call is frozen — nothing downstream can rewrite history.
    expect(Object.isFrozen(recorder.calls()[0])).toBe(true);

    recorder.reset();
    expect(recorder.ids()).toEqual([]);
    expect(recorder.callCount).toBe(0);
  });

  test('wrapRecordingClient records on success AND on throw, then rethrows', async () => {
    const recorder = createProviderCallRecorder();
    const create = jest
      .fn()
      .mockResolvedValueOnce({ id: 'msg_ok' })
      .mockRejectedValueOnce(
        Object.assign(new Error('rate limited'), { status: 429, _request_id: 'req_bad' })
      );
    const wrapped = wrapRecordingClient(
      { messages: { create } },
      {
        provider: 'anthropic',
        recorder,
      }
    );

    await expect(wrapped.messages.create({})).resolves.toEqual({ id: 'msg_ok' });
    await expect(wrapped.messages.create({})).rejects.toThrow('rate limited');

    expect(recorder.ids()).toEqual(['msg_ok', 'req_bad']);
    expect(recorder.calls()[1]).toMatchObject({
      provider: 'anthropic',
      callId: 'req_bad',
      ok: false,
      errorKind: 'provider_rate_limit',
    });
  });

  test('wrapRecordingClient refuses a client it cannot instrument', () => {
    const recorder = createProviderCallRecorder();
    expect(() => wrapRecordingClient(null, { provider: 'anthropic', recorder })).toThrow(
      /client must be an object/
    );
    expect(() => wrapRecordingClient({}, { provider: 'anthropic', recorder })).toThrow(
      /client\.messages\.create must be a function/
    );
    expect(() =>
      wrapRecordingClient(
        { messages: { create: () => {} } },
        { provider: 'anthropic', recorder: {} }
      )
    ).toThrow(/recorder must expose record\(\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4 — the retry clamp, driven through the REAL session path
//
// SDK `maxRetries: 0` is NOT sufficient: `callWithRetry` wraps every provider
// call in its own attempt loop (default 3). These pins drive the real
// `EICRExtractionSession` — not client construction alone — because the loop
// is where a silent second provider request would actually come from.
// ─────────────────────────────────────────────────────────────────────────
describe('4 — the one-call clamp through EICRExtractionSession', () => {
  const ENV_KEYS = [
    'SONNET_EXTRACT_MODEL',
    'OBSERVATION_EXTRACT_MODEL',
    'OBSERVATION_TIER_ROUTING',
    'VOICE_LATENCY_ROUND1_MODEL',
  ];
  let savedEnv;
  let realSetTimeout;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // The backoff sleeps are real production behaviour and are deliberately
    // NOT changed by the lane; collapsing them here keeps the pin fast
    // without touching the code under test.
    realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  /** A recorded Anthropic-shaped client whose every call fails with a
   *  retryable 429 carrying a real provider request id. */
  function failingClient(recorder) {
    const create = jest.fn(async () => {
      throw Object.assign(new Error('rate limited'), {
        status: 429,
        _request_id: 'req_clamp_1',
      });
    });
    const wrapped = wrapRecordingClient(
      { messages: { create }, stream: () => {} },
      {
        provider: 'anthropic',
        recorder,
      }
    );
    return { create, wrapped };
  }

  test('a single provider error yields exactly ONE request, ONE recorded id, and no silent second attempt', async () => {
    const recorder = createProviderCallRecorder();
    const { create, wrapped } = failingClient(recorder);
    const session = new EICRExtractionSession('anthropic-key', 'clamp-lane', 'eicr', {
      providerClients: { anthropic: wrapped },
      // The lane clamp. `maxRetries` below is still the production default 3
      // — proving the clamp, not the argument, is what bounds the loop.
      maxProviderAttempts: 1,
    });

    await expect(
      session.callWithRetry([{ role: 'user', content: 'Zs on circuit 4 is 0.55' }], 3, 'SYSTEM')
    ).rejects.toThrow('rate limited');

    expect(create).toHaveBeenCalledTimes(1);
    expect(recorder.callCount).toBe(1);
    expect(recorder.ids()).toEqual(['req_clamp_1']);
    expect(recorder.calls()[0]).toMatchObject({ ok: false, errorKind: 'provider_rate_limit' });
  });

  test('that thrown error terminates INVALID rather than a semantic verdict', async () => {
    const { runReservedAttempt } = await loadRunner();
    const store = createMemoryStore();
    const cohortId = 'cohort-c1b0000000003';
    const recorder = createProviderCallRecorder();
    const { wrapped } = failingClient(recorder);
    const session = new EICRExtractionSession('anthropic-key', 'clamp-invalid', 'eicr', {
      providerClients: { anthropic: wrapped },
      maxProviderAttempts: 1,
    });

    const res = await runReservedAttempt(
      store,
      runArgs(cohortId, {
        execute: async () => {
          await session.callWithRetry([{ role: 'user', content: 'reading' }], 3, 'SYSTEM');
          return { verdict: 'PASS', providerCallIds: recorder.ids() };
        },
      })
    );

    expect(res.verdict).toBe('INVALID');
    expect(res.reason).toMatch(/^executor_threw:/);
    // Infrastructure failure never counts as semantic pass/fail, and the
    // requirement stays replaceable under a later generation.
    expect(res.terminalPublished).toBe(true);
  });

  test('outside the lane the production retry budget is UNCHANGED', async () => {
    const recorder = createProviderCallRecorder();
    const { create, wrapped } = failingClient(recorder);
    // No `maxProviderAttempts` — exactly how production constructs it.
    const session = new EICRExtractionSession('anthropic-key', 'clamp-absent', 'eicr', {
      providerClients: { anthropic: wrapped },
    });
    expect(session._maxProviderAttempts).toBeNull();

    await expect(
      session.callWithRetry([{ role: 'user', content: 'reading' }], 3, 'SYSTEM')
    ).rejects.toThrow('rate limited');
    expect(create).toHaveBeenCalledTimes(3);

    // ...and the parameter DEFAULT is still 3 when no call site passes one.
    create.mockClear();
    await expect(
      session.callWithRetry([{ role: 'user', content: 'reading' }], undefined, 'SYSTEM')
    ).rejects.toThrow('rate limited');
    expect(create).toHaveBeenCalledTimes(3);
  });

  test('a non-retryable client error is never retried, in or out of the lane', async () => {
    for (const options of [{}, { maxProviderAttempts: 1 }]) {
      const recorder = createProviderCallRecorder();
      const create = jest.fn(async () => {
        throw Object.assign(new Error('bad request'), { status: 400, _request_id: 'req_400' });
      });
      const wrapped = wrapRecordingClient(
        { messages: { create } },
        {
          provider: 'anthropic',
          recorder,
        }
      );
      const session = new EICRExtractionSession('anthropic-key', 'clamp-4xx', 'eicr', {
        providerClients: { anthropic: wrapped },
        ...options,
      });
      await expect(
        session.callWithRetry([{ role: 'user', content: 'reading' }], 3, 'SYSTEM')
      ).rejects.toThrow('bad request');
      expect(create).toHaveBeenCalledTimes(1);
      expect(recorder.ids()).toEqual(['req_400']);
    }
  });

  test('an injected branded client fully pre-empts SDK client construction', () => {
    const branded = brandLiveEvaluationClient(
      { messages: { create: jest.fn() } },
      { provider: 'anthropic', maxRetries: 0 }
    );
    const session = new EICRExtractionSession('anthropic-key', 'clamp-preempt', 'eicr', {
      providerClients: { anthropic: branded },
      maxProviderAttempts: 1,
    });
    // If `_createExtractionClient` had run it would have produced an
    // UNBRANDED SDK client with the SDK's own default retry budget.
    expect(session.client).toBe(branded);
    expect(isLiveEvaluationClient(session.client)).toBe(true);
    expect(session._maxProviderAttempts).toBe(1);
  });

  test('maxProviderAttempts only accepts a positive integer', () => {
    for (const bad of [0, -1, 1.5, '1', null, undefined, NaN]) {
      const session = new EICRExtractionSession('k', 'clamp-bad', 'eicr', {
        providerClients: { anthropic: { messages: { create: jest.fn() } } },
        maxProviderAttempts: bad,
      });
      expect(session._maxProviderAttempts).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5 — lane-driver liveMode wiring
// ─────────────────────────────────────────────────────────────────────────
describe('5 — driveFixture liveMode', () => {
  test('a liveMode boot without live provider clients refuses before any session is built', async () => {
    const { driveFixture } = await import('../../scripts/model-ab/lib/lane-driver.mjs');
    await expect(
      driveFixture({
        boot: { liveMode: true, sonnetStream: {}, lifecycle: {} },
        fixture: { corpus_id: 'frc_stub' },
        expectation: {},
        judge: () => ({ verdict: 'PASS' }),
      })
    ).rejects.toThrow(/liveMode boot must supply liveProviderClients/);
  });
});
