/**
 * Stage 6 Phase 5 Plan 05-04 — restrained-mode rolling-window state machine.
 *
 * STA-05 — activate when `triggerCount` asks arrive within `windowTurns`
 * turns; auto-release after `releaseMs` wall-clock. Emit caller-supplied
 * onActivate / onRelease callbacks on transitions ONLY (not on every
 * recordAsk-while-active). Pure module: zero imports, only Node.js
 * built-in setTimeout / clearTimeout / Date.now.
 *
 * WHY a dedicated module: research §Pattern 3 + §Pitfall 2 — rolling-
 * window logic is the highest-risk surface in Phase 5 (off-by-one trap
 * in eviction; double-activation trap on threshold checks). Isolating
 * it in a pure factory lets STT-08 cover every boundary in unit tests
 * without spinning up a session, and keeps the wiring in
 * sonnet-stream.js to the bare minimum (a constructor call + 3
 * destroy() lines on the termination paths).
 *
 * WHY zero imports: the caller (sonnet-stream.js) supplies the side
 * effects via onActivate / onRelease. This module never touches a ws,
 * a logger, or any other Stage 6 module. Two consequences:
 *   1. STT-08 unit tests run in O(ms) without any mocking infrastructure.
 *   2. A future sister state machine (e.g. per-key budget, plan 05-03)
 *      can copy this template without inheriting a dependency tree.
 *
 * WHY inclusive-inclusive window: ROADMAP §Phase 5 SC #5 says verbatim
 * "any rolling 5-turn window". The natural mental model is "the current
 * turn plus the four previous turns", so window covers T, T-1, T-2,
 * T-3, T-4 — five entries. Eviction predicate therefore
 * `askTurns[0] < currentTurn - (windowTurns - 1)` (= `< T - 4`),
 * keeping turn T-4 in. Group 2 boundary tests lock this. Research
 * §Pitfall 2 codifies the off-by-one trap of `<=` vs `<` here.
 *
 * WHY belt-and-braces double-activation guard (Pitfall 1): the wrapper
 * (Plan 05-01) already short-circuits asks when isActive() is true, so
 * recordAsk SHOULD never fire while active in production. But the
 * threshold check still tests `!isActive()` defensively. Group 4 test 2
 * exercises the path: even if a defective wrapper hammers recordAsk
 * while active, the second activate() never fires onActivate.
 *
 * WHY destroy() is silent (no onRelease): destroy is a session-
 * termination signal that upstream already emits via session_stopped /
 * session_terminated log rows + ask-registry rejectAll. A duplicate
 * mode-off notification at this layer would be noise. Group 5 test 2
 * locks this. If a future caller needs "mode-off-now" semantics on
 * teardown, they can read isActive() before calling destroy.
 *
 * WHY nowFn is injectable: Plan 05-06 (exit-gate harness) needs to
 * advance the wall-clock comparison without waiting real time.
 * Defaults to `Date.now`; production wiring (sonnet-stream.js) does
 * NOT override. The hook is read LIVE on every isActive() call so a
 * test can roll the clock backward and watch the state flip back to
 * true (validates the hook is not cached). 05-PLAN-CHECK.md raised
 * this gap and required the hook to land in 05-04 before Wave 2.
 *
 * Requirements: STA-05 (the rule), STT-08 (the test), STB-05 (no
 * existing backstop weakened — this ADDS a guard).
 */

/**
 * Default turnId parser. Extracts the integer turn count from
 * `${sessionId}-turn-${n}` (the canonical shape set in
 * stage6-shadow-harness.js:216).
 *
 * Defensive: on parse failure, returns a monotonically-increasing
 * fallback counter via closure scope. NEVER throws, NEVER blocks
 * activation — a malformed turnId is an upstream bug, not this
 * module's problem to surface. Group 6 test 2 covers the fallback
 * path; the contract is that 3 malformed asks in a row still trigger
 * activation (because the fallback yields 1, 2, 3 — a valid 5-turn
 * window).
 */
function createDefaultParseTurn() {
  let fallbackCounter = 0;
  return function parseTurn(turnId) {
    if (typeof turnId !== 'string') return ++fallbackCounter;
    const m = turnId.match(/-turn-(\d+)$/);
    if (!m) return ++fallbackCounter;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : ++fallbackCounter;
  };
}

/**
 * Rolling-window restrained-mode state machine.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowTurns=5]   Rolling-window size in turns.
 * @param {number} [opts.triggerCount=3]  Ask count within window that activates.
 * @param {number} [opts.releaseMs=60000] Wall-clock duration of active state.
 * @param {() => void} [opts.onActivate]  Fired exactly once on entering active.
 *                                        Caller supplies side-effects (ws.send,
 *                                        logger.info). Re-activation after
 *                                        release fires this callback AGAIN as a
 *                                        separate event (Group 4 test 3).
 * @param {() => void} [opts.onRelease]   Fired exactly once on wall-clock
 *                                        expiry. NOT fired on destroy().
 * @param {(turnId: string) => number} [opts.parseTurnFn]
 *   Injectable turn-id parser. Default extracts integer from
 *   `${sessionId}-turn-${n}` per shadow-harness convention with a
 *   monotonic fallback for malformed ids.
 * @param {() => number} [opts.nowFn=Date.now]
 *   Injectable wall-clock reader for isActive() comparison + activate()
 *   `activeUntilMs` computation. Default Date.now keeps production
 *   wiring zero-config; tests/exit-gate scripts can drive the clock
 *   manually.
 *
 * @returns {{
 *   recordAsk(turnId: string): void,
 *   isActive(): boolean,
 *   destroy(): void,
 *   _state(): { askTurns: number[], activeUntilMs: number },
 * }}
 */
export function createRestrainedMode({
  windowTurns = 5,
  triggerCount = 3,
  releaseMs = 60000,
  onActivate,
  onRelease,
  parseTurnFn = createDefaultParseTurn(),
  nowFn = Date.now,
} = {}) {
  /** @type {number[]} Integer turn numbers within the rolling window. */
  const askTurns = [];
  /** Wall-clock time at which the active state expires (ms epoch). */
  let activeUntilMs = 0;
  /** Handle for the pending setTimeout release callback (or null). */
  let releaseTimer = null;

  function isActive() {
    // Belt-and-braces: the setTimeout-driven release sets activeUntilMs=0
    // when it fires. The wall-clock comparison is a backup so even if the
    // timer is somehow stalled (impossible under normal Node.js semantics,
    // but defensive against runtime quirks / fake-timer interactions in
    // tests), the state still auto-releases at the deadline.
    return activeUntilMs > 0 && nowFn() < activeUntilMs;
  }

  function activate() {
    // Pitfall 1 defence — even if the call-site forgets the !isActive guard,
    // re-entry into activate() while already active is a no-op. Group 4
    // test 2 locks this.
    if (isActive()) return;

    activeUntilMs = nowFn() + releaseMs;

    // Defensive — if a previous releaseTimer somehow survived (impossible
    // given the !isActive guard above, but cheap insurance), clear it
    // before scheduling the new one.
    if (releaseTimer) clearTimeout(releaseTimer);

    releaseTimer = setTimeout(() => {
      activeUntilMs = 0;
      releaseTimer = null;
      onRelease?.();
    }, releaseMs);

    onActivate?.();
  }

  function recordAsk(turnId) {
    const currentTurn = parseTurnFn(turnId);

    // Eviction: keep entries whose turn >= currentTurn - (windowTurns - 1).
    // For windowTurns=5, eviction threshold is < currentTurn - 4 — turn T-4
    // is on the inclusive boundary and stays in. ROADMAP SC #5 wording
    // "any rolling 5-turn window" is locked by Group 2 boundary tests.
    while (askTurns.length && askTurns[0] < currentTurn - (windowTurns - 1)) {
      askTurns.shift();
    }
    askTurns.push(currentTurn);

    // Threshold check + double-activation guard. The internal !isActive
    // inside activate() is the second line of defence (Pitfall 1).
    if (askTurns.length >= triggerCount && !isActive()) {
      activate();
    }
  }

  function destroy() {
    // Pitfall 5 — cancel the pending release timer so jest.getTimerCount()
    // returns 0 after destroy and Node.js exits cleanly. Group 5 test 1
    // locks this.
    if (releaseTimer) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
    // Mutate-in-place so the array's backing store is freed promptly. The
    // factory closure holds the only reference, so this is a real free.
    askTurns.length = 0;
    activeUntilMs = 0;
    // Deliberately NOT calling onRelease — destroy is a teardown signal,
    // not a state transition. Group 5 test 2 locks this.
  }

  return {
    recordAsk,
    isActive,
    destroy,
    // Test-only state inspector. Returns a defensive copy of askTurns so
    // tests can't mutate the internal array. activeUntilMs is a primitive,
    // copied by value implicitly.
    _state: () => ({ askTurns: [...askTurns], activeUntilMs }),
  };
}
