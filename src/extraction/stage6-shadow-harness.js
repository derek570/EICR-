/**
 * Stage 6 shadow-mode harness — Phase 1 fork point that wraps today's
 * legacy extractFromUtterance call so we can (a) keep iOS behavior
 * byte-identical in all modes while (b) exercising the streaming-assembly
 * branch (Plan 01-03's createAssembler) end-to-end from the real production
 * seam on every shadow-mode turn.
 *
 * WHAT: A single exported function runShadowHarness() that sonnet-stream.js
 * calls in place of session.extractFromUtterance(). Three modes, selected
 * via session.toolCallsMode (populated by Plan 01-05 from the env flag):
 *
 *   'off'    — passthrough: return session.extractFromUtterance(...). Zero
 *              observable difference from the pre-stage-6 world. Default.
 *   'shadow' — run legacy FIRST (so we always have a payload to log), THEN
 *              drive createAssembler() against canned interleaved-tool_use
 *              events, THEN log stage6_divergence carrying both payloads.
 *              Return the LEGACY result (never the reconstructed one) so
 *              iOS behavior stays byte-identical between 'off' and 'shadow'.
 *   'live'   — throw. Live dispatch is Phase-7 territory; failing loudly
 *              here is the safety net if an env flag gets mis-set ahead of
 *              time.
 *
 * WHY: ROADMAP Phase 1 SC #2 ("stream assembler is invoked from
 * sonnet-stream.js on every shadow-mode turn") is only literally true if
 * something actually drives createAssembler() from the production seam
 * during Phase 1. Phase 1 has no real Anthropic tool calls to consume
 * (those land in Phase 2+), so we feed canonical canned SSE events
 * through the assembler on every shadow turn. Pattern: "the pipe exists
 * and fires under load; Phase 2 just swaps what the pipe carries."
 *
 * WHY THIS SHAPE: Async function taking the session + forwarded args is
 * the smallest drop-in replacement for the call site in sonnet-stream.js
 * (~line 1248). No class, no subclassing — the session object already
 * carries all the state we need; we just fork on session.toolCallsMode.
 */

import logger from '../logger.js';
import { createAssembler } from './stage6-stream-assembler.js';
import { SHADOW_CANNED_EVENTS } from './stage6-shadow-canned.js';

/**
 * Drive the stream assembler against the canned events and return the
 * finalized reconstruction. Pure in-memory — zero API calls, zero cost.
 *
 * The events are an immutable module constant (see stage6-shadow-canned.js)
 * so this function is purely CPU-bound, deterministic, and has no load-
 * failure branch: if the module is missing, Node throws at service start
 * rather than silently soft-failing on every turn.
 */
function runAssemblerReplay(log) {
  const asm = createAssembler({ logger: log });
  for (const ev of SHADOW_CANNED_EVENTS) asm.handle(ev);
  return asm.finalize();
}

/**
 * Shadow-harness entry point. Drop-in replacement for
 * `session.extractFromUtterance(...)` at the sonnet-stream.js seam.
 *
 * @param {Object} session  An EICRExtractionSession-shaped object. Must
 *   expose: sessionId (string), turnCount (number, may be undefined on
 *   very-first turn), toolCallsMode ('off'|'shadow'|'live'|undefined),
 *   extractFromUtterance(transcript, regexResults, options) -> Promise.
 * @param {string} transcriptText
 * @param {Array} regexResults
 * @param {Object} [options] Forwarded verbatim to legacy. May also carry
 *   `.logger` for test injection (defaults to the project logger).
 * @returns {Promise<any>} The LEGACY result, unchanged — same return
 *   contract as session.extractFromUtterance.
 */
export async function runShadowHarness(session, transcriptText, regexResults, options = {}) {
  const log = options.logger ?? logger;
  const mode = session.toolCallsMode ?? 'off';

  if (mode === 'off') {
    return session.extractFromUtterance(transcriptText, regexResults, options);
  }

  if (mode === 'live') {
    // Intentional loud failure. If this ever fires in production, someone
    // set SONNET_TOOL_CALLS=live before Phase 7 shipped — that's a
    // deployment bug, not a recoverable condition.
    throw new Error('SONNET_TOOL_CALLS=live not implemented until Phase 7');
  }

  if (mode === 'shadow') {
    // Snapshot the turn number BEFORE the await. extractFromUtterance runs
    // `this.turnCount++` internally (eicr-extraction-session.js:641), so
    // `(session.turnCount ?? 0) + 1` read AFTER the await would be off by
    // one: the divergence log would carry turn-N+1 while the legacy
    // payload describes turn-N. Phase 7's analyzer correlates legacy and
    // tool_call rows by turnId — an off-by-one renders every row
    // unjoinable. Codex's Phase-1 STG review flagged this as MAJOR.
    const turnNum = (session.turnCount ?? 0) + 1;
    const turnId = `${session.sessionId}-turn-${turnNum}`;

    // Run legacy FIRST. If it throws, we rethrow unchanged — no divergence
    // log (no payload to compare) and no assembler drive (no point wasting
    // cycles on the error path).
    const legacy = await session.extractFromUtterance(transcriptText, regexResults, options);

    // Drive the stream assembler against the canned interleaved events.
    // This is what makes ROADMAP Phase 1 SC #2 literally true: the
    // streaming-assembly branch is invoked from sonnet-stream.js on every
    // shadow-mode turn, not merely unit-tested in isolation.
    const toolCallReplay = runAssemblerReplay(log);

    try {
      log.info('stage6_divergence', {
        sessionId: session.sessionId,
        turnId,
        legacy,
        tool_call: toolCallReplay,
        // Intentional: Phase 1's replay payload has no meaningful real
        // comparison to the legacy payload (different shapes, different
        // sources). Phase 7's analyzer applies the real normalisation +
        // sets the real divergent flag. Documented in OPEN_QUESTIONS.md.
        divergent: false,
        phase: 1,
      });
    } catch {
      // Logging failure must NOT break extraction. Swallow and continue.
    }

    return legacy;
  }

  // Unreachable given Plan 05's constructor-time validation, but defensive
  // in case someone mutates session.toolCallsMode post-construction.
  try {
    log.warn('stage6_shadow_harness_unknown_mode', { mode });
  } catch {
    // ignore
  }
  return session.extractFromUtterance(transcriptText, regexResults, options);
}
