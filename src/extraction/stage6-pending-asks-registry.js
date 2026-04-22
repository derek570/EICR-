/**
 * Stage 6 Phase 3 — per-session registry of pending ask_user Promises.
 *
 * Map-backed deferred-Promise broker for the blocking ask_user tool. One
 * instance per session (owned by activeSessions.get(id).pendingAsks).
 * Pure module — zero imports, no logger, no WS handle. Consumed by the ask
 * dispatcher (Plan 03-05) and sonnet-stream lifecycle (Plan 03-08).
 *
 * Codex STG #3 invariant: every resolution path goes through ONE function
 * enforcing (1) clearTimeout → (2) Map.delete → (3) user resolve in strict
 * order. Keeping this a standalone pure module makes the bypass routes
 * flagged in 03-RESEARCH.md Pitfall 1 impossible.
 *
 * Requirements: STD-02 (blocking primitive), STA-01 (serialisation),
 * STA-03 (timeout cancellation).
 */

/**
 * Factory. Call once per session. Returns an object owning a
 * Map<tool_call_id, entry> via closure. Entry shape:
 *   { resolve, timer, contextField, contextCircuit, expectedAnswerShape, askStartedAt }
 */
export function createPendingAsksRegistry() {
  const asks = new Map();

  return {
    // Anthropic-SDK retry-replay guard (Pitfall 7): a replayed tool_use id
    // MUST NOT overwrite the in-flight entry — that would orphan the old
    // resolve fn and old timer. Throw instead.
    //
    // Plan 03-12 r9 MAJOR remediation — `expectedAnswerShape` MUST be stored
    // on the entry (was silently dropped by the earlier destructure
    // {contextField, contextCircuit, resolve, timer, askStartedAt}). The
    // classifier at stage6-overtake-classifier.js:135 reads
    // `entry.expectedAnswerShape` to decide whether to fire the yes_no
    // no-regex short-circuit. Without it the shape branch could NEVER
    // match, so "yes" / "no" answers routed through the transcript channel
    // (pre-Phase-4 iOS or any legacy path) fell through to user_moved_on
    // and forced a re-ask every time. Restoring the field makes STA-04c
    // reachable in production.
    register(toolCallId, {
      contextField,
      contextCircuit,
      expectedAnswerShape,
      resolve,
      timer,
      askStartedAt,
    }) {
      if (asks.has(toolCallId)) {
        // Plan 03-10 Task 3 (STG MAJOR #3) — stamp a discriminant `.code`
        // on the duplicate throw so the dispatcher can tell our OWN
        // invariant (Pitfall 7 retry-replay) apart from any other
        // unexpected throw (corrupt entry shape, future capacity breach,
        // bad timer handle, etc.). The dispatcher's typed catch relies on
        // this code to decide "swallow + log as duplicate" vs "propagate".
        const err = new Error(`duplicate_tool_call_id:${toolCallId}`);
        err.code = 'DUPLICATE_TOOL_CALL_ID';
        throw err;
      }
      asks.set(toolCallId, {
        resolve,
        timer,
        contextField,
        contextCircuit,
        expectedAnswerShape,
        askStartedAt,
      });
    },

    // Strict ordering (Codex STG #3):
    //   1. clearTimeout — stop the 20s STA-03 timer firing into a deleted entry.
    //   2. Map.delete   — make subsequent resolve() calls return false
    //                     (Pitfall 2: answer-vs-timeout double-resolve race).
    //   3. user resolve — only NOW wake the awaiting dispatcher.
    // Returns true if an entry was resolved; false if unknown/already-resolved.
    resolve(toolCallId, outcome) {
      const entry = asks.get(toolCallId);
      if (!entry) return false;
      clearTimeout(entry.timer); // 1
      asks.delete(toolCallId); // 2
      entry.resolve({
        // 3
        ...outcome,
        wait_duration_ms: Date.now() - entry.askStartedAt,
      });
      return true;
    },

    // Overtake-classifier input (Plan 03-04, STA-04). Pure — no mutation.
    findByContext(contextField) {
      const out = [];
      for (const [id, entry] of asks) {
        if (entry.contextField === contextField) out.push({ id, ...entry });
      }
      return out;
    },

    // Session-termination sweep (Plan 03-08 reasons: session_terminated /
    // session_stopped / session_reconnected / test_teardown). Same strict
    // ordering as resolve(). Idempotent — second call is a no-op.
    //
    // Plan 03-12 r10 MAJOR remediation — snapshot + clear BEFORE invoking
    // user resolvers. The prior shape invoked entry.resolve() inline during
    // Map iteration and only `asks.clear()`-ed afterwards. A synchronous
    // resolver (or anything the resolver wakes up that re-enters the
    // registry — e.g. a dispatcher that inspects pendingAsks.size or calls
    // findByContext/entries during teardown) could then observe stale
    // entries whose resolve fn had already fired. Worse, the registry is
    // still mid-iteration, so a re-entrant rejectAll or resolve would
    // either double-fire or miss entries depending on mutation order.
    //
    // Fix: take a snapshot, clear the Map + timers first (same strict
    // ordering as resolve()), THEN invoke resolvers. Any re-entry now
    // sees an empty registry — the second rejectAll is the documented
    // no-op, any resolve() returns false (unknown id).
    rejectAll(reason) {
      const snapshot = [];
      for (const [, entry] of asks) {
        snapshot.push(entry);
        clearTimeout(entry.timer); // 1 — stop timers firing into cleared entries
      }
      asks.clear(); // 2 — make re-entrant reads see an empty registry
      const now = Date.now();
      for (const entry of snapshot) {
        // 3 — wake awaiting dispatchers. A throw here must NOT leave the
        // registry inconsistent (it's already cleared), so we let the
        // throw propagate and document that resolvers should be pure.
        entry.resolve({
          answered: false,
          reason,
          wait_duration_ms: now - entry.askStartedAt,
        });
      }
    },

    get size() {
      return asks.size;
    },

    // Iterator for Plan 03-04 overtake classification. Consumers MUST NOT
    // mutate the registry during iteration — use findByContext for a snapshot.
    entries() {
      return asks.entries();
    },
  };
}
