/**
 * replay-clock.mjs — the recorded lane's deterministic clock + TIMER LEDGER
 * + clock pump (plan Item 2 "Captured timing is replayed, not discarded").
 *
 * Fake clock: @sinonjs/fake-timers with an EXACT `toFake` list —
 * ['Date','setTimeout','clearTimeout','setInterval','clearInterval'] and
 * NOTHING else. The package's defaults fake additional facilities: a faked
 * queueMicrotask/nextTick/setImmediate can reorder ask registration or
 * deadlock the pump, and a faked performance/hrtime would invalidate the
 * advisory timing evidence — all of those stay REAL.
 *
 * Timer ledger: fake-timers exposes no semantic label linking a handle to a
 * production purpose, and delay-only selection is unsafe when multiple
 * timers share a deadline. The ledger installs immediately AFTER the fake
 * clock and BEFORE extraction imports, wrapping setTimeout/clearTimeout to
 * record handle, due time, delay, normalized callsite, generation, and the
 * currently-registered ask ID where applicable. Ask-timeout binding is
 * POST-REGISTRATION (both the initial and pvr-* dispatchers call setTimeout
 * BEFORE pendingAsks.register, so no ask ID exists at timer creation): the
 * ledger first records the timeout handle unbound, classified by normalized
 * callsite; onAskRegistered(toolCallId) inspects the real
 * pendingAsks.entries() entry, retrieves its timer handle, and atomically
 * binds that existing ledger record — zero or multiple matches FAIL.
 *
 * Clock pump: START the runShadowHarness promise without awaiting, inspect
 * the next pending ledger entry, advance ONLY allowlisted gate/finalizer
 * timers with tickAsync, drain microtasks, then await completion. NEVER
 * setSystemTime alone (moving the clock does not execute elapsed timers)
 * and NEVER runAllAsync (it would fire the 45s ask timeout / keepalive /
 * finalizer timers and REPLACE the production outcome under test). ONE
 * narrow exception: an emitted ask explicitly declaring terminal outcome
 * `timeout` lets the pump advance THAT ask's identified ASK_USER_TIMEOUT_MS
 * timer (and only it).
 */

export const EXACT_TO_FAKE = Object.freeze([
  'Date',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
]);

/** Production timing constants the classifier keys on. */
export const QUESTION_GATE_DELAY_MS = 1500;
export const ASK_USER_TIMEOUT_MS = 45000;

/** Timer classifications the pump may advance. */
export const TIMER_CLASSES = Object.freeze({
  QUESTION_GATE: 'question_gate',
  VOICE_FINALIZER: 'voice_finalizer',
  ASK_TIMEOUT: 'ask_timeout',
  UNKNOWN: 'unknown',
});

/**
 * Default production-callsite allowlist. Each rule: { class, callsite:
 * RegExp on the normalized callsite, delay?: exact ms }. The runner may
 * extend; tests supply fabricated callsites.
 */
export const DEFAULT_CALLSITE_ALLOWLIST = Object.freeze([
  // The 1.5s QUESTION_GATE debounce is armed by the gate WRAPPER
  // (stage6-ask-gate-wrapper.js:465 — verified against the live turn);
  // the dispatcher pattern is retained for legacy callsites.
  { class: TIMER_CLASSES.QUESTION_GATE, callsite: /stage6-ask-gate-wrapper|stage6-dispatcher-ask/, delay: QUESTION_GATE_DELAY_MS },
  { class: TIMER_CLASSES.ASK_TIMEOUT, callsite: /stage6-dispatcher-ask|stage6-ask-gate-wrapper/, delay: ASK_USER_TIMEOUT_MS },
  { class: TIMER_CLASSES.VOICE_FINALIZER, callsite: /voice-latency|finalizer/ },
]);

function normalizeCallsite(stack) {
  const lines = String(stack ?? '').split('\n').slice(1);
  for (const line of lines) {
    if (line.includes('replay-clock.mjs')) continue;
    // "    at fn (file:///path/to/module.mjs:12:5)" → "module.mjs:12"
    const m = /\(?((?:file:\/\/)?[^()\s]+?):(\d+):\d+\)?$/.exec(line.trim());
    if (m) {
      const base = m[1].split('/').pop();
      return `${base}:${m[2]}`;
    }
  }
  return 'unknown';
}

/**
 * Install the fake clock + ledger. `FakeTimers` is the imported
 * @sinonjs/fake-timers module (injected so this module itself stays
 * dependency-light for tests). Returns the controller.
 */
export function installReplayClock(FakeTimers, { startMs, allowlist = DEFAULT_CALLSITE_ALLOWLIST } = {}) {
  const clock = FakeTimers.install({
    now: startMs ?? 0,
    toFake: [...EXACT_TO_FAKE],
  });

  const ledger = {
    entries: [], // {handle, delay, dueMs, callsite, askToolCallId, generationId, cleared, fired}
    violations: [],
  };

  // Wrap the FAKED setTimeout/clearTimeout (installed on globalThis by the
  // clock) so every extraction-module timer is recorded. Installed BEFORE
  // extraction imports (per-corpus, not per-scenario).
  const fakedSetTimeout = globalThis.setTimeout;
  const fakedClearTimeout = globalThis.clearTimeout;

  globalThis.setTimeout = function ledgeredSetTimeout(fn, delay, ...rest) {
    const entry = {
      delay: Number(delay) || 0,
      dueMs: clock.now + (Number(delay) || 0),
      callsite: normalizeCallsite(new Error().stack),
      askToolCallId: null,
      generationId: null,
      cleared: false,
      fired: false,
      handle: null,
    };
    const wrapped = function (...args) {
      entry.fired = true;
      return fn(...args);
    };
    entry.handle = fakedSetTimeout(wrapped, delay, ...rest);
    ledger.entries.push(entry);
    return entry.handle;
  };
  globalThis.clearTimeout = function ledgeredClearTimeout(handle) {
    const entry = ledger.entries.find((e) => e.handle === handle && !e.cleared && !e.fired);
    if (entry) entry.cleared = true;
    return fakedClearTimeout(handle);
  };

  function classify(entry) {
    for (const rule of allowlist) {
      if (rule.delay != null && entry.delay !== rule.delay) continue;
      if (!rule.callsite.test(entry.callsite)) continue;
      return rule.class;
    }
    return TIMER_CLASSES.UNKNOWN;
  }

  function pendingEntries() {
    return ledger.entries
      .filter((e) => !e.cleared && !e.fired)
      .sort((a, b) => a.dueMs - b.dueMs);
  }

  return {
    clock,
    ledger,
    /** Scenario epoch — turn at_ms offsets are relative to this. */
    startMs: startMs ?? 0,

    /**
     * POST-REGISTRATION ask-timeout binding: given the REAL registry entry's
     * timer handle, atomically bind the existing ledger record. Zero or
     * multiple matching records FAIL (infrastructure error).
     */
    bindAskTimeout(toolCallId, timerHandle, generationId = null) {
      const matches = ledger.entries.filter(
        (e) => e.handle === timerHandle && !e.cleared && !e.fired,
      );
      if (matches.length !== 1) {
        const err = new Error(
          `ask-timeout binding for ${toolCallId}: expected exactly 1 ledger record for the registry timer handle, found ${matches.length}`,
        );
        err.infrastructure = true;
        ledger.violations.push(err.message);
        throw err;
      }
      matches[0].askToolCallId = toolCallId;
      matches[0].generationId = generationId;
      return matches[0];
    },

    classify,
    pendingEntries,

    /**
     * The pump: advance only the EARLIEST pending entry, and only when its
     * classification is allowed. `declaredTimeoutAskIds` is the set of ask
     * tool-call IDs whose fixtures explicitly declare terminal outcome
     * `timeout` — ONLY those ask-timeout timers may fire; any unrelated 45s
     * timer FAILS. Unknown/ambiguous entries are infrastructure_error.
     * Returns { advanced, entry, class } or throws with .infrastructure.
     */
    async advanceNext({ declaredTimeoutAskIds = new Set() } = {}) {
      const pending = pendingEntries();
      if (pending.length === 0) return { advanced: false, entry: null };
      const next = pending[0];
      const cls = classify(next);
      if (cls === TIMER_CLASSES.UNKNOWN) {
        const err = new Error(
          `clock pump: next pending timer is unclassified (callsite ${next.callsite}, delay ${next.delay}ms) — infrastructure_error`,
        );
        err.infrastructure = true;
        ledger.violations.push(err.message);
        throw err;
      }
      if (cls === TIMER_CLASSES.ASK_TIMEOUT) {
        if (!next.askToolCallId || !declaredTimeoutAskIds.has(next.askToolCallId)) {
          const err = new Error(
            `clock pump: refusing to fire ASK_USER_TIMEOUT_MS timer (ask ${next.askToolCallId ?? 'unbound'}) — only an explicitly declared terminal 'timeout' ask may time out`,
          );
          err.infrastructure = true;
          ledger.violations.push(err.message);
          throw err;
        }
      }
      const delta = Math.max(0, next.dueMs - clock.now);
      await clock.tickAsync(delta);
      return { advanced: true, entry: next, class: cls };
    },

    /** Advance the logical clock between transcripts/answers — tickAsync,
     *  never setSystemTime (elapsed timers must execute) and never
     *  runAllAsync. The caller guarantees no disallowed timer falls inside
     *  `deltaMs` (the pump inspects before each inter-turn advance). */
    async tick(deltaMs) {
      await clock.tickAsync(deltaMs);
    },

    /** Drain microtasks without moving time. */
    async drainMicrotasks() {
      await clock.tickAsync(0);
    },

    /** Reset ledger state between fixtures (corpus-lifetime clock). */
    resetLedger() {
      ledger.entries = [];
      ledger.violations = [];
    },

    /** Restore real timers + unwrap. Outermost finally only. */
    uninstall() {
      globalThis.setTimeout = fakedSetTimeout;
      globalThis.clearTimeout = fakedClearTimeout;
      clock.uninstall();
    },
  };
}
