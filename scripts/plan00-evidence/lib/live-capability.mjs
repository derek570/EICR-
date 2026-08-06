/**
 * Plan 00B-4 §C1b — the SEALED live-dispatch capability.
 *
 * ## The hazard this closes
 *
 * `runReservedAttempt` used to take a plain injected `execute` function and
 * trust whatever it returned — including the `providerCallIds` it folds into
 * `sample_identity`. The ONLY thing keeping a mock verdict out of the durable
 * evidence bucket was the CLI's `refuseLiveDispatch()` throw: a discipline
 * boundary, not a structural one. Any future caller wiring a fake executor to
 * an S3-backed store would have produced a perfectly well-formed, permanently
 * durable attempt record attesting to provider calls that never happened.
 * Evidence that cannot be distinguished from forgery is not evidence.
 *
 * ## The construction boundary
 *
 * Authority to dispatch against the DURABLE store is a capability object that
 * exists in a module-private `WeakSet`. It cannot be spread, serialised,
 * copied onto a lookalike, or reconstructed from state: the only way to hold
 * one is to have been handed it by `mintLiveDispatchCapability`, and that
 * function refuses to mint unless EVERY live-lane precondition already holds —
 * both evaluation clients carry this module's own client brand with retries
 * disabled, the mock network deny is absent, real vendor keys are present, and
 * the caller has already passed its oracle-digest / attestation / deployment /
 * source-binding checks.
 *
 * Pairing that with `isDurableStore` (store.mjs) and the option-rejecting
 * memory-store constructor gives the invariant the plan asks for: an injected
 * fake against the real bucket, and a durable adapter handed to the memory
 * store, are both UNREPRESENTABLE rather than merely forbidden.
 *
 * ## Why the client brand lives here too
 *
 * The brand has to be minted by whatever actually constructs the SDK clients
 * (`scripts/model-ab/lib/live-lane-boot.mjs`) but VERIFIED by the capability
 * gate. Keeping both halves in this module makes the dependency one-way (boot
 * imports capability, never the reverse) and means a "client" hand-stamped
 * with `{ maxRetries: 0 }` by a test cannot satisfy the gate — only a real
 * boot-constructed client is in the WeakMap.
 */

import { isDurableStore } from './store.mjs';

/** Capability objects minted by `mintLiveDispatchCapability` in this process. */
const SEALED_CAPABILITIES = new WeakSet();

/** Evaluation clients constructed by the live boot: client → {provider, maxRetries}. */
const LIVE_EVALUATION_CLIENTS = new WeakMap();

/** The attestation facts a caller must have established BEFORE minting. */
export const REQUIRED_ATTESTATION_KEYS = Object.freeze([
  'oracleDigestVerified',
  'expectationAttestationVerified',
  'deploymentVerified',
  'sourceBindingVerified',
]);

/** Both providers must be booted — a lane that can only reach one vendor cannot
 *  run the model-lane corpus, and a half-booted lane is exactly the state where
 *  a fallback to some other client would go unnoticed. */
export const REQUIRED_LIVE_PROVIDERS = Object.freeze(['anthropic', 'openai']);

/** Vendor keys that must be present and non-empty for a live boot. */
export const REQUIRED_VENDOR_KEY_ENV = Object.freeze(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);

/**
 * The mock lane installs its fetch deny as a NAMED function literal
 * (`deniedFetch`, scripts/field-replay/lib/network-guard.mjs). Its presence is
 * the single most reliable signal that the process was booted for the
 * deterministic replay lane, where every provider call is a scripted fake.
 */
const MOCK_DENY_FETCH_NAME = 'deniedFetch';

/**
 * Brand an SDK client as a genuine live evaluation client. Called ONLY by the
 * live boot, immediately after construction, with the retry setting it actually
 * passed to the SDK. Refuses anything but a hard zero: the whole point of the
 * lane is that one dispatch means one provider request.
 */
export function brandLiveEvaluationClient(client, { provider, maxRetries } = {}) {
  if (typeof client !== 'object' || client === null) {
    throw new TypeError('brandLiveEvaluationClient: client must be an object');
  }
  if (!REQUIRED_LIVE_PROVIDERS.includes(provider)) {
    throw new TypeError(
      `brandLiveEvaluationClient: unknown provider "${provider}" — expected one of ${REQUIRED_LIVE_PROVIDERS.join(', ')}`
    );
  }
  if (maxRetries !== 0) {
    throw new TypeError(
      `brandLiveEvaluationClient: ${provider} client must be constructed with maxRetries: 0 ` +
        `(got ${JSON.stringify(maxRetries)}) — an SDK retry consumes a second provider identity ` +
        'that the attempt record cannot account for'
    );
  }
  LIVE_EVALUATION_CLIENTS.set(client, Object.freeze({ provider, maxRetries }));
  return client;
}

/** True only for a client branded by the live boot in this process. */
export function isLiveEvaluationClient(client) {
  return (
    (typeof client === 'object' || typeof client === 'function') &&
    client !== null &&
    LIVE_EVALUATION_CLIENTS.has(client)
  );
}

/** `{provider, maxRetries}` for a branded client, else null. */
export function describeLiveEvaluationClient(client) {
  if (!isLiveEvaluationClient(client)) return null;
  return LIVE_EVALUATION_CLIENTS.get(client);
}

/** True when the deterministic replay lane's fetch deny is installed. */
export function isMockDenyInstalled(fetchImpl = globalThis.fetch) {
  return typeof fetchImpl === 'function' && fetchImpl.name === MOCK_DENY_FETCH_NAME;
}

/**
 * Mint the sealed capability. Every check here is a PRE-condition of holding
 * dispatch authority, so a failure throws rather than returning a falsy value —
 * a caller that ignores a return value must not accidentally proceed.
 *
 * @param {object} opts
 * @param {Function} opts.dispatch  the real executor (fixture → judge → result)
 * @param {{anthropic:object, openai:object}} opts.clients  boot-branded clients
 * @param {object} opts.attestation  every REQUIRED_ATTESTATION_KEYS flag === true
 * @param {object} [opts.env]  defaults to process.env (injectable for tests)
 * @param {Function} [opts.fetchImpl]  defaults to globalThis.fetch
 */
export function mintLiveDispatchCapability({
  dispatch,
  clients,
  attestation,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof dispatch !== 'function') {
    throw new TypeError('mintLiveDispatchCapability: dispatch must be a function');
  }

  if (typeof clients !== 'object' || clients === null) {
    throw new TypeError('mintLiveDispatchCapability: clients must be an object');
  }
  const clientMeta = {};
  for (const provider of REQUIRED_LIVE_PROVIDERS) {
    const client = clients[provider];
    const meta = describeLiveEvaluationClient(client);
    if (!meta) {
      throw new Error(
        `mintLiveDispatchCapability: ${provider} client is not a branded live evaluation client — ` +
          'only clients constructed by the live lane boot may dispatch against durable evidence'
      );
    }
    if (meta.provider !== provider) {
      throw new Error(
        `mintLiveDispatchCapability: client registered under "${provider}" was branded as "${meta.provider}"`
      );
    }
    clientMeta[provider] = meta;
  }

  if (typeof attestation !== 'object' || attestation === null) {
    throw new TypeError('mintLiveDispatchCapability: attestation must be an object');
  }
  for (const key of REQUIRED_ATTESTATION_KEYS) {
    if (attestation[key] !== true) {
      throw new Error(
        `mintLiveDispatchCapability: attestation.${key} must be exactly true before dispatch ` +
          '— the cohort binding is what makes a provider call attributable'
      );
    }
  }

  if (isMockDenyInstalled(fetchImpl)) {
    throw new Error(
      'mintLiveDispatchCapability: the deterministic replay lane fetch deny is installed — ' +
        'this process was booted for mock/replay and its verdicts must never enter the evidence store'
    );
  }

  for (const key of REQUIRED_VENDOR_KEY_ENV) {
    const value = env?.[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `mintLiveDispatchCapability: ${key} is absent or empty — a live lane must hold real vendor keys`
      );
    }
  }

  const capability = Object.freeze({
    dispatch,
    providers: Object.freeze({ ...clientMeta }),
  });
  SEALED_CAPABILITIES.add(capability);
  return capability;
}

/** True only for a capability minted by `mintLiveDispatchCapability`. */
export function isLiveDispatchCapability(value) {
  return typeof value === 'object' && value !== null && SEALED_CAPABILITIES.has(value);
}

/** Throwing form, for call sites that want the failure attributed to them. */
export function assertLiveDispatchCapability(value, context = 'live dispatch') {
  if (!isLiveDispatchCapability(value)) {
    throw new Error(
      `${context}: not a sealed live-dispatch capability — a lookalike object cannot be forged ` +
        'into dispatch authority; mint one via mintLiveDispatchCapability after a real live boot'
    );
  }
  return value;
}

/**
 * The single gate every dispatch passes through. Returns the executor the
 * caller is actually authorised to run, so there is no path that "checks" and
 * then uses a different function.
 *
 * DURABLE store  ⇒ the sealed capability is REQUIRED and an injected `execute`
 *                  is REFUSED outright (not merely ignored — a caller passing
 *                  one believes it will run, and silently running something
 *                  else is worse than failing).
 * memory store   ⇒ exactly one of the two, so a test is explicit about which
 *                  world it is in.
 */
export function assertDispatchAuthority(store, { execute = null, liveDispatch = null } = {}) {
  const durable = isDurableStore(store);

  if (durable) {
    if (execute != null) {
      throw new Error(
        'dispatch authority: an injected executor was supplied alongside the DURABLE evidence ' +
          'store — fake executors are reachable only through the memory store, so that mock ' +
          'verdicts can never be published as durable evidence; nothing was allocated or reserved'
      );
    }
    assertLiveDispatchCapability(liveDispatch, 'dispatch authority');
    return liveDispatch.dispatch;
  }

  if (liveDispatch != null && execute != null) {
    throw new Error(
      'dispatch authority: supply exactly one of `execute` or `liveDispatch`, not both'
    );
  }
  if (liveDispatch != null) {
    assertLiveDispatchCapability(liveDispatch, 'dispatch authority');
    return liveDispatch.dispatch;
  }
  if (typeof execute !== 'function') {
    throw new TypeError('dispatch authority: `execute` must be a function');
  }
  return execute;
}
