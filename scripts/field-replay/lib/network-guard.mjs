/**
 * network-guard.mjs — network denial for the field-replay lanes (plan
 * Item 2). Broader than vendor keys: `runLiveMode` calls `lookupPostcode()`
 * (a REAL request to postcodes.io via global fetch) when regexResults
 * contains install.postcode — fixture validation REJECTS such fixtures in
 * v1, and this guard is the defence-in-depth beneath validation. Per the
 * Threat-model scope decision, the in-process fetch guard + the
 * execSync-throw Secrets-Manager test are the ACCIDENT-GRADE authority for
 * this wave (the known live network paths — Anthropic SDK, lookupPostcode —
 * both use global fetch); OS-level --network=none + the non-fetch transport
 * matrix live in field-replay-hardening-followups.
 */

/**
 * RECORDED lane: deny ALL fetch. Installed for the recorded lane only and
 * restored in finally (a global guard would also block the Anthropic SDK
 * request the live nightly lane exists to make).
 */
export function installRecordedFetchDeny() {
  const original = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = function deniedFetch(input) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    attempts.push(url);
    throw new Error(`field-replay recorded lane: network fetch DENIED (${url}) — deterministic fixtures make no network calls`);
  };
  return {
    attempts,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/**
 * LIVE lane: explicit outbound-host policy — permit the configured
 * Anthropic endpoint, deny postcodes.io and other incidental HTTP, and
 * enforce the HARD per-run vendor-call ceiling at the FETCH boundary
 * (a messages.stream wrapper counts logical rounds, not outbound calls —
 * the SDK defaults maxRetries: 2, so one stream() can issue up to three
 * HTTP attempts). MUST be installed BEFORE `new EICRExtractionSession(...)`
 * — the Anthropic SDK snapshots the current global fetch into client.fetch
 * at construction; a wrapper installed after would deny postcodes.io while
 * leaving Anthropic on the unguarded original.
 */
export function installLiveFetchPolicy({ allowedHosts = ['api.anthropic.com'], hardMaxVendorCalls }) {
  const original = globalThis.fetch;
  const state = { vendorCalls: 0, denied: [] };
  globalThis.fetch = function policedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      host = '';
    }
    const allowed = allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!allowed) {
      state.denied.push(url);
      throw new Error(`field-replay live lane: outbound host DENIED (${host || url}) — only ${allowedHosts.join(', ')} is permitted`);
    }
    state.vendorCalls += 1;
    if (hardMaxVendorCalls != null && state.vendorCalls > hardMaxVendorCalls) {
      throw new Error(`field-replay live lane: hard_max_vendor_calls (${hardMaxVendorCalls}) exceeded at the fetch boundary — vendor invocation blocked`);
    }
    return original.call(globalThis, input, init);
  };
  return {
    state,
    restore() {
      globalThis.fetch = original;
    },
  };
}
