/**
 * stage6-control-flow-errors.js — F7 Item 3 (task #14). ONE shared FATAL
 * control-flow discriminator + guard, dependency-free so every layer of the
 * Stage-6 extraction stack can import it without a cycle.
 *
 * The extraction watchdog's absolute-ceiling cancellation must propagate a
 * FATAL error through EVERY error-recovery layer (runToolLoop's dispatcher
 * catch, the gate wrapper, createAskDispatcher's generic classification, the
 * shadow-harness live/shadow catches, sonnet-stream's generic catch) WITHOUT
 * being converted into a generic dispatcher_error / empty-extraction / legacy
 * fallback. Each of those layers tests `isStage6FatalControlFlowError(err)`
 * BEFORE its generic recovery and rethrows the fatal type unchanged.
 *
 * Two fatal types:
 *   - ExtractionCancelledError — the per-generation AbortController fired
 *     (absolute ceiling, or a no-ask 30s deadline). Carries the abort reason
 *     as `cause`.
 *   - AskRegistrationHookError — the Item-3 onAskRegistered CONTROL hook
 *     threw / rejected the registration (a stale generation tried to register
 *     an ask). Cannot be swallowed — a swallowed failure reopens the
 *     concurrency bug.
 */

/**
 * The per-generation extraction was cancelled (watchdog ceiling / no-ask
 * deadline). The SDK does not preserve custom cancellation types, so an
 * external signal abort surfaces from MessageStream as APIUserAbortError;
 * runToolLoop re-wraps that into this type while `signal.aborted === true`.
 */
export class ExtractionCancelledError extends Error {
  constructor(message = 'extraction cancelled', options = {}) {
    super(message);
    this.name = 'ExtractionCancelledError';
    // Node's Error supports { cause }; set explicitly for older engines too.
    if (options && 'cause' in options) this.cause = options.cause;
    this.isStage6FatalControlFlow = true;
  }
}

/**
 * The onAskRegistered CONTROL hook rejected the registration (stale
 * generation) or threw. Part of the shared fatal discriminator so the gate
 * wrapper / dispatcher / tool loop propagate it unchanged rather than
 * converting it to a dispatcher_error envelope (which would swallow it).
 */
export class AskRegistrationHookError extends Error {
  constructor(message = 'ask registration hook error', options = {}) {
    super(message);
    this.name = 'AskRegistrationHookError';
    if (options && 'cause' in options) this.cause = options.cause;
    this.isStage6FatalControlFlow = true;
  }
}

/**
 * True iff `err` is one of the shared FATAL control-flow types. Recovery
 * layers test this BEFORE their generic error handling and rethrow on a match.
 * Uses a branded property (not only instanceof) so a re-wrapped copy across a
 * module boundary is still recognised.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isStage6FatalControlFlowError(err) {
  if (!err) return false;
  if (err instanceof ExtractionCancelledError) return true;
  if (err instanceof AskRegistrationHookError) return true;
  return err.isStage6FatalControlFlow === true;
}

/**
 * Guard used at every named cancellation check site. Semantics:
 *   - return when `signal` is absent or not aborted;
 *   - if `signal.reason` is already an ExtractionCancelledError, rethrow it
 *     unchanged (preserve the original cause/stack);
 *   - otherwise throw a NEW ExtractionCancelledError with `signal.reason` as
 *     cause.
 *
 * @param {AbortSignal | null | undefined} signal
 * @returns {void}
 */
export function throwIfStage6Cancelled(signal) {
  if (!signal || !signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof ExtractionCancelledError) throw reason;
  throw new ExtractionCancelledError('extraction cancelled', { cause: reason });
}
