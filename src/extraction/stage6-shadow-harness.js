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
 *              drive createAssembler() against a canned interleaved-tool_use
 *              fixture, THEN log stage6_divergence carrying both payloads.
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
 * (those land in Phase 2+), so we feed a canonical canned SSE fixture
 * through the assembler on every shadow turn. Pattern: "the pipe exists
 * and fires under load; Phase 2 just swaps what the pipe carries."
 *
 * WHY THIS SHAPE: Async function taking the session + forwarded args is
 * the smallest drop-in replacement for the call site in sonnet-stream.js
 * (~line 1245). No class, no subclassing — the session object already
 * carries all the state we need; we just fork on session.toolCallsMode.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import logger from '../logger.js';
import { createAssembler } from './stage6-stream-assembler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Canonical Phase-1 shadow input. Lives under __tests__/fixtures so the
 * same file is consumed by harness tests AND production shadow traffic —
 * single source of truth, zero drift. Reading from __tests__/ in prod is
 * intentional and documented in the plan: Phase 1 has nothing real to feed
 * the assembler yet; Phase 2 will replace this read with the actual
 * Anthropic event stream without changing the rest of this module.
 */
const FIXTURE_PATH = path.resolve(
  __dirname,
  '../__tests__/fixtures/stage6-sse/shadow-canned-interleaved.json',
);

/** Memoised once per process — the file is immutable and ~1KB. */
let _cachedFixture = null;
/** Remembered failure so we don't retry the read on every turn if it's broken. */
let _fixtureLoadFailed = false;

function loadCannedFixture(log) {
  if (_cachedFixture) return _cachedFixture;
  if (_fixtureLoadFailed) return null;
  try {
    _cachedFixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    return _cachedFixture;
  } catch (err) {
    // Fixture-read failure must NOT break extraction. We log once (warn)
    // and soft-fail every subsequent call by returning null, which the
    // divergence log will surface as an empty records payload.
    _fixtureLoadFailed = true;
    try {
      log?.warn?.('stage6_shadow_fixture_load_failed', {
        error: err?.message,
        path: FIXTURE_PATH,
      });
    } catch {
      // logger failures must also not break extraction
    }
    return null;
  }
}

/**
 * Drive the stream assembler against the canned fixture and return the
 * finalized reconstruction. Pure in-memory — zero API calls, zero cost.
 */
function runAssemblerReplay(log) {
  const events = loadCannedFixture(log);
  if (!events) {
    return { records: [], stop_reason: null, replay_skipped: true };
  }
  const asm = createAssembler({ logger: log });
  for (const ev of events) asm.handle(ev);
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
    // Run legacy FIRST. If it throws, we rethrow unchanged — no divergence
    // log (no payload to compare) and no assembler drive (no point wasting
    // cycles on the error path).
    const legacy = await session.extractFromUtterance(transcriptText, regexResults, options);

    // Drive the stream assembler against the canned interleaved fixture.
    // This is what makes ROADMAP Phase 1 SC #2 literally true: the
    // streaming-assembly branch is invoked from sonnet-stream.js on every
    // shadow-mode turn, not merely unit-tested in isolation.
    const toolCallReplay = runAssemblerReplay(log);

    const turnId = `${session.sessionId}-turn-${(session.turnCount ?? 0) + 1}`;

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
