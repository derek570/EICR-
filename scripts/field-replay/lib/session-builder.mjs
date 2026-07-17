/**
 * session-builder.mjs — the PRODUCTION-PARITY replay-runtime builder (plan
 * Item 2). The existing direct bench runner is NOT production-composed: it
 * registers only `voiceLatency.flags` and passes pendingAsks/ws/logger/
 * generationId, while production sonnet-stream.js ALSO supplies askBudget,
 * restrainedMode, filledSlotsShadow, fallbackToLegacy, and parsed client
 * capabilities — without askBudget + restrainedMode the harness never calls
 * wrapAskDispatcherWithGates and never creates the D2 observation-
 * clarification chain broker, and without
 * voiceLatency.capabilities.hasLowConfReadbackV1 sub-0.5-confidence
 * record_reading calls are SKIPPED even though build-419 clients advertise
 * the capability — the gate would diverge from production, including on
 * keystone ⑤.
 *
 * HARD CONSTRAINT: zero static extraction imports. The runner dynamically
 * imports the extraction modules AFTER the env loader + fake clock install
 * and passes them in via `modules`.
 *
 * ACTIVE_ENTRY_CLASSIFICATION is the machine-checked table covering EVERY
 * field the production activeSessions.set block initializes (sonnet-stream
 * silently DISABLES behaviour behind defensive instanceof-Map checks when a
 * map is absent, so an incomplete entry passes while testing less than
 * production). A parity test parses the production source and FAILS
 * whenever production adds/removes a field without a table update.
 */

import { mintSessionId, mintGenerationId, mintUtteranceId } from './canonical-crypto.mjs';

/** classification: reproduced | deliberately_excluded | irrelevant */
export const ACTIVE_ENTRY_CLASSIFICATION = Object.freeze({
  session: { class: 'reproduced', how: 'EICRExtractionSession built with the fixture certType + dummy key (recorded) / explicit key (live)' },
  questionGate: { class: 'deliberately_excluded', why: 'legacy pre-Stage-6 question path — consumed by the batch-flush callback, not runShadowHarness; Stage 6 asks flow through pendingAsks' },
  ws: { class: 'reproduced', how: 'replay WS stub per turn (open | closed | throw_on_send from fixture provenance)' },
  userId: { class: 'irrelevant', why: 'cost-attribution metadata only; symbolic value supplied' },
  jobId: { class: 'irrelevant', why: 'cost-attribution metadata only; symbolic value supplied' },
  jobAddress: { class: 'irrelevant', why: 'cost-attribution metadata only; sanitized fixtures carry synthetic addresses' },
  certType: { class: 'reproduced', how: 'fixture job_state.certificateType → session constructor arg' },
  protocolVersion: { class: 'irrelevant', why: 'logged at session_start only; no harness read' },
  fallbackToLegacy: { class: 'reproduced', how: 'provenance-backed fixture field, stored on the entry AND passed as the harness option' },
  lastRegexResults: { class: 'reproduced', how: 'initialized [] (per-turn regex results flow through the harness arguments)' },
  isExtracting: { class: 'reproduced', how: 'initialized false' },
  pendingTranscripts: { class: 'reproduced', how: 'initialized [] (queue/overtake is ingress — v1 excluded — but the field exists with production shape)' },
  pendingExtractions: { class: 'reproduced', how: 'initialized []' },
  pendingRefinements: { class: 'irrelevant', why: 'post-harness egress refinement path (v1 capability exclusion); initialized to production shape (Map)' },
  recentlyRefinedIds: { class: 'irrelevant', why: 'post-harness egress refinement path; initialized to production shape (Map)' },
  rehydrateSessionId: { class: 'irrelevant', why: 'session_resume path is out of replay scope; symbolic value supplied' },
  pendingAsks: { class: 'reproduced', how: 'createPendingAsksRegistry() — the REAL registry (identity preservation is load-bearing)' },
  restrainedMode: { class: 'reproduced', how: 'the production no-op stub shape {isActive:()=>false, recordAsk, destroy} — a truthy value is REQUIRED for wrapAskDispatcherWithGates composition' },
  askBudget: { class: 'reproduced', how: 'createAskBudget() (default cap 2), persisted across turns' },
  voiceLatency: { class: 'reproduced', how: 'flags via snapshotFlagsForSession() (env pinned first), capabilities via parseVoiceLatencyCapabilities(fixture.client_capabilities), lastAudioSeqByCorrelation new Map()' },
  pendingFastTtsSlots: { class: 'reproduced', how: 'new Map() (harness finally-block clears per turn)' },
  fastPathCorrelationIdByTurn: { class: 'reproduced', how: 'new Map() — populated by the harness from the SINGULAR regexFastCorrelationId option' },
  broadcastIntentByTurn: { class: 'reproduced', how: 'new Map() (runLiveMode writes on detectBroadcastIntent)' },
  filledSlotsShadow: { class: 'reproduced', how: 'createFilledSlotsShadowLogger({sessionGetter, logger: captured logger})' },
  consumedAskUtterances: { class: 'reproduced', how: 'initialized new Set() (ask-answer dedupe ledger)' },
  seenTranscriptUtterances: { class: 'reproduced', how: 'initialized new Set() (reverse-race dedupe ledger)' },
  recentAskAnswers: { class: 'reproduced', how: '[] (content-match fallback dedupe)' },
  recentTranscripts: { class: 'reproduced', how: 'initialized [] (reverse content-match dedupe FIFO)' },
});

/**
 * The builder's harness-option table — enumerates EVERY argument of the
 * production sonnet-stream runShadowHarness call (sonnet-stream.js:4247)
 * and how the replay supplies it. `capability_exclusion` names the fixture
 * tag validation must REJECT dependence on when the argument is omitted.
 */
export const HARNESS_OPTION_TABLE = Object.freeze({
  confirmationsEnabled: { source: 'fixture turn (provenance-backed; never invented)' },
  generationId: { source: 'deterministic mint H(field-replay/generation, corpusId, turnIndex)' },
  signal: { source: 'per-turn AbortController().signal — production supplies one per generation; the shipped F7 watchdog/cancellation lifecycle depends on it. Fixture-CONTROLLED cancellation triggers do NOT exist in v1', capability_exclusion: 'watchdog_cancellation' },
  onAskRegistered: { source: 'generation-OWNING replay implementation: records the ask, binds the ledger ask-timeout via the registry entry timer handle, schedules the reconciliation microtask' },
  inResponseTo: { source: 'fixture turn (provenance-backed; the orphan-audibility net depends on it)' },
  utteranceId: { source: 'deterministic mint (own per-turn domain)' },
  pendingAsks: { source: 'entry.pendingAsks (the REAL registry, same identity)' },
  restrainedMode: { source: 'entry.restrainedMode (production stub shape)' },
  askBudget: { source: 'entry.askBudget' },
  filledSlotsShadow: { source: 'entry.filledSlotsShadow' },
  fallbackToLegacy: { source: 'fixture field (=== true semantics preserved)' },
  ws: { source: 'the replay WS stub for the turn' },
  regexFastCorrelationId: { source: 'SINGULAR production option (sonnet-stream.js:4343; a plural property would be silently ignored) — fixture may store array-valued regex_fast_correlation_ids; the builder passes per-turn through the singular option; absence passed only when evidence-backed', capability_exclusion: 'fast_path_finalizer' },
  logger: { source: 'the replay capturing logger (harness-supported option; production omits it and uses the module logger — the replay supplies it to capture rows per turn)' },
});

/**
 * Build the production-parity active-sessions entry + session. `modules`
 * carries the dynamically imported production factories:
 * { EICRExtractionSession, activeSessions, createPendingAsksRegistry,
 *   createAskBudget, snapshotFlagsForSession, parseVoiceLatencyCapabilities,
 *   createFilledSlotsShadowLogger }.
 */
export function buildReplaySession({ modules, fixture, apiKey = 'sk-field-replay-recorded-dummy', logger, toolCallsMode = 'live' }) {
  const {
    EICRExtractionSession,
    activeSessions,
    createPendingAsksRegistry,
    createAskBudget,
    snapshotFlagsForSession,
    parseVoiceLatencyCapabilities,
    createFilledSlotsShadowLogger,
  } = modules;

  const corpusId = fixture.corpus_id;
  const sessionId = mintSessionId(corpusId);
  const certType = fixture.job_state?.certificateType ?? 'eicr';
  const session = new EICRExtractionSession(apiKey, sessionId, certType, { toolCallsMode });

  // Provenance-backed client capabilities (e.g. ['low_conf_readback_v1']) —
  // the wire shape production parses at session_start.
  const capsList = fixture.client_capabilities?.value ?? [];
  const capabilitiesWire = {
    voice_latency: { version: 1, supports: Array.isArray(capsList) ? capsList : [] },
  };

  const entry = {
    session,
    questionGate: null, // deliberately_excluded — see ACTIVE_ENTRY_CLASSIFICATION
    ws: null, // per-turn stub installed by the runner
    userId: 'sym_replay_user',
    jobId: 'sym_replay_job',
    jobAddress: null,
    certType,
    protocolVersion: 2,
    fallbackToLegacy: fixture.fallback_to_legacy?.value === true,
    lastRegexResults: [],
    isExtracting: false,
    pendingTranscripts: [],
    pendingExtractions: [],
    pendingRefinements: new Map(),
    recentlyRefinedIds: new Map(),
    rehydrateSessionId: 'sym_replay_rehydrate',
    pendingAsks: createPendingAsksRegistry(),
    restrainedMode: { isActive: () => false, recordAsk: () => {}, destroy: () => {} },
    askBudget: createAskBudget(),
    voiceLatency: {
      flags: snapshotFlagsForSession(),
      capabilities: parseVoiceLatencyCapabilities(capabilitiesWire),
      lastAudioSeqByCorrelation: new Map(),
    },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    filledSlotsShadow: null, // set below (needs the entry getter)
    consumedAskUtterances: new Set(),
    seenTranscriptUtterances: new Set(),
    recentAskAnswers: [],
    recentTranscripts: [],
  };
  entry.filledSlotsShadow = createFilledSlotsShadowLogger({
    sessionGetter: () => activeSessions.get(sessionId),
    logger,
  });
  activeSessions.set(sessionId, entry);

  return {
    sessionId,
    session,
    entry,
    /** The fixture's seeded job state — the runner passes it to session.start(). */
    fixtureJobState: fixture.job_state ?? { boards: [], circuits: [] },
    /** Build the per-turn harness options (mirrors sonnet-stream.js:4247). */
    buildTurnOptions({ turnIndex, turn, ws, onAskRegistered, signal }) {
      // The production option is SINGULAR regexFastCorrelationId — the
      // fixture may store an array; pass it through the singular option
      // (production normalises single-or-array), preserving recorded
      // presence + cardinality via fixture-local symbolic ids.
      const rfc = turn.regex_fast_correlation_ids;
      const regexFastCorrelationId =
        rfc == null || rfc.length === 0 ? undefined : rfc.length === 1 ? rfc[0] : rfc;
      return {
        confirmationsEnabled: turn.confirmations_enabled?.value === true,
        generationId: mintGenerationId(corpusId, turnIndex),
        signal,
        onAskRegistered,
        inResponseTo: turn.in_response_to?.value === true,
        utteranceId: mintUtteranceId(corpusId, turnIndex),
        pendingAsks: entry.pendingAsks,
        restrainedMode: entry.restrainedMode,
        askBudget: entry.askBudget,
        filledSlotsShadow: entry.filledSlotsShadow,
        fallbackToLegacy: entry.fallbackToLegacy === true,
        ws,
        ...(regexFastCorrelationId !== undefined ? { regexFastCorrelationId } : {}),
        logger,
      };
    },
    /** Teardown per plan Item 2 cleanup: never force-clear session state. */
    teardown() {
      try {
        entry.pendingAsks.rejectAll('test_teardown');
      } catch {
        /* second rejectAll on empty registry is documented-safe */
      }
      entry.askBudget?.destroy?.();
      entry.restrainedMode?.destroy?.();
      session._clearCacheKeepalive?.();
      if (session.isActive) session.stop?.();
      activeSessions.delete(sessionId);
    },
  };
}
