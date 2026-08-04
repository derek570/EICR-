/**
 * Plan 00B-2 C4 — the REAL-SERVER semantic-oracle lane driver.
 *
 * Boots the REAL `initSonnetStream(null, getKey, verifyToken,
 * { evaluationContextFactory, sessionFactory })`, connects a fake ws that
 * CAPTURES the async production message listener, and drives each frozen
 * vendor-lane fixture through the ACTUAL WS ingress — never a direct
 * runShadowHarness call. The fixture's FULL frozen source YAML is the
 * EXECUTION INPUT (job_state, client_capabilities, model_rounds,
 * transcripts, answers); the generated projection is the JUDGING TARGET
 * only. Verdicts come from the C3 completion latch's `frozen.evidence` via
 * the explicit accessor on the RETAINED entry reference — never the live
 * ledgers, never `frozen.candidate`.
 *
 * Mock-mode isolation: lane-isolation envs pinned, vendor keys cleared,
 * network fetch denied, storage redirected to a temp dir (S3 env-disabled),
 * and the sessionFactory constructs the ONE session with an undispatchable
 * bootstrap client — the strict per-turn scripted client (the field-replay
 * runner's own `makeTurnClient`) is swapped in immediately before each
 * transcript. Mock playback ACKs traverse the REAL HTTP route via the
 * exported playback-ack router factory mounted under supertest with a
 * strict offline bearer-token auth — implementation evidence only, never
 * vendor evidence.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const DRIVER_USER = 'lane-driver-user';
const DRIVER_TOKEN = 'lane-driver-offline-token';
const CLOCK_START_MS = 1_754_300_000_000; // fixed epoch — deterministic, > 0
const PUMP_ITERATION_CAP = 400;

/** Pin the lane-isolation environment BEFORE any extraction import. */
export function pinMockLaneEnv() {
  process.env.SONNET_TOOL_CALLS = 'live';
  process.env.VOICE_LATENCY_LOADED_BARREL = 'false';
  process.env.OBSERVATION_TIER_ROUTING = 'false';
  delete process.env.VOICE_LATENCY_ROUND1_MODEL;
  delete process.env.VOICE_LATENCY_KILL_SWITCH;
  // Vendor keys cleared — with the undispatchable bootstrap client and the
  // per-turn scripted client, nothing may ever construct a live credential.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  // Storage: env-disable S3 (uploads become local-file writes) and point
  // the local sink at a throwaway temp dir so the driver never writes into
  // the repo.
  delete process.env.S3_BUCKET;
  process.env.LOCAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plan00-lane-'));
}

/**
 * Boot the driver: install the deterministic replay clock + network deny,
 * then dynamically import the production modules (imports MUST follow the
 * clock install so every extraction timer is ledgered).
 */
export async function bootLaneDriver({ repoRoot }) {
  pinMockLaneEnv();

  const flLib = (f) => pathToFileURL(path.join(repoRoot, 'scripts/field-replay/lib', f)).href;
  const srcMod = (f) => pathToFileURL(path.join(repoRoot, 'src', f)).href;

  const { installRecordedFetchDeny } = await import(flLib('network-guard.mjs'));
  installRecordedFetchDeny();

  const FakeTimers = (await import('@sinonjs/fake-timers')).default ??
    (await import('@sinonjs/fake-timers'));
  const { installReplayClock, DEFAULT_CALLSITE_ALLOWLIST, TIMER_CLASSES } = await import(
    flLib('replay-clock.mjs')
  );
  const clockCtl = installReplayClock(FakeTimers, {
    startMs: CLOCK_START_MS,
    // The driver additionally allows the question-gate flush timers armed by
    // the gate wrapper; everything else stays refuse-by-default.
    allowlist: DEFAULT_CALLSITE_ALLOWLIST,
  });

  // Dynamic production imports AFTER the clock install.
  const sonnetStream = await import(srcMod('extraction/sonnet-stream.js'));
  const lifecycle = await import(srcMod('extraction/plan00-lifecycle-hooks.js'));
  const { EICRExtractionSession } = await import(srcMod('extraction/eicr-extraction-session.js'));
  const capture = await import(srcMod('extraction/plan00-semantic-capture.js'));
  const ledgers = await import(srcMod('extraction/plan00-audibility-ledgers.js'));
  const { makeTurnClient } = await import(flLib('replay-runner-core.mjs'));
  const { createPlaybackAckRouter } = await import(srcMod('routes/voice-latency-playback-ack.js'));
  const express = (await import('express')).default;
  const request = (await import('supertest')).default;

  // The REAL playback-ack route in a minimal offline express app: strict
  // driver-minted bearer auth installs the fixture user; the route's
  // validation and owner check run UNMODIFIED with ZERO database access.
  const app = express();
  app.use(express.json());
  const offlineAuth = (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${DRIVER_TOKEN}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.user = { id: DRIVER_USER };
    return next();
  };
  app.use('/api', createPlaybackAckRouter({ requireAuth: offlineAuth }));

  return {
    clockCtl,
    TIMER_CLASSES,
    sonnetStream,
    lifecycle,
    capture,
    ledgers,
    EICRExtractionSession,
    makeTurnClient,
    playbackApp: app,
    request,
  };
}

function makeCapturedWs() {
  const sent = [];
  const handlers = new Map();
  const ws = {
    readyState: 1,
    OPEN: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
    ping() {},
    close() {},
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  return {
    ws,
    sent,
    emit: (event, data) => {
      const h = handlers.get(event);
      if (!h) throw new Error(`lane-driver: no handler registered for ${event}`);
      return h(data);
    },
  };
}

function frameBuffer(frame) {
  return Buffer.from(JSON.stringify(frame));
}

/**
 * Drive ONE fixture through the real server and judge its frozen evidence.
 * Returns { corpus_id, verdict, reason, mismatches }.
 */
export async function driveFixture({ boot, fixture, expectation, judge, log = () => {} }) {
  const {
    clockCtl,
    sonnetStream,
    lifecycle,
    EICRExtractionSession,
    makeTurnClient,
    playbackApp,
    request,
  } = boot;
  const { initSonnetStream, activeSessions } = sonnetStream;
  const { getCompletionFreeze, EVALUATION_CONTEXT } = lifecycle;
  const corpusId = fixture.corpus_id;
  const sessionId = `lane-${corpusId}`;

  // Pinned lane flag: every vendor fixture runs confirmations-on. Fail
  // BEFORE execution if a fixture disagrees.
  for (const turn of fixture.turns ?? []) {
    if (turn.confirmations_enabled?.value !== true) {
      return {
        corpus_id: corpusId,
        verdict: 'INVALID_HOLD',
        reason: 'fixture_confirmations_flag_mismatch',
        mismatches: [],
      };
    }
  }

  // C4 scripted-client seam: construction-time factory. The ONE session is
  // constructed with an undispatchable bootstrap client and captured; real
  // vendor construction is impossible (keys cleared + guard).
  let capturedSession = null;
  const defaultModel = (process.env.SONNET_EXTRACT_MODEL || 'claude-sonnet-4-6').trim();
  const defaultProvider = defaultModel.toLowerCase().startsWith('gpt-') ? 'openai' : 'anthropic';
  const bootstrapClient = {
    messages: {
      create() {
        throw new Error('lane-driver bootstrap client must never dispatch');
      },
      stream() {
        throw new Error('lane-driver bootstrap client must be replaced before dispatch');
      },
    },
  };
  const sessionFactory = ({ apiKey, sessionId: sid, certificateType }) => {
    capturedSession = new EICRExtractionSession(apiKey, sid, certificateType, {
      toolCallsMode: 'live',
      providerClients: { [defaultProvider]: bootstrapClient },
    });
    return capturedSession;
  };

  // Fresh evaluation roles per fixture.
  const roles = {
    observer: null,
    mutationObserver: boot.capture.createMutationObserver({ sessionId }),
    askLedger: boot.ledgers.createAskLedger(),
    deliveryLedger: boot.ledgers.createDeliveryLedger(),
  };

  const wss = initSonnetStream(null, async () => 'lane-mock-key', () => true, {
    evaluationContextFactory: () => roles,
    sessionFactory,
  });
  const { ws, sent, emit } = makeCapturedWs();
  wss.emit('connection', ws, { headers: {} }, DRIVER_USER);

  // ── Ingress mapping (fixture → production wire, exact) ──
  const capsList = Array.isArray(fixture.client_capabilities?.value)
    ? fixture.client_capabilities.value
    : [];
  const fallbackToLegacy = fixture.fallback_to_legacy?.value === true;
  await emit(
    'message',
    frameBuffer({
      type: 'session_start',
      sessionId,
      jobState: fixture.job_state ?? { boards: [], circuits: [] },
      capabilities: { voice_latency: { version: 1, supports: capsList } },
      ...(fallbackToLegacy ? {} : { protocol_version: 'stage6' }),
    })
  );

  const entryRef = activeSessions.get(sessionId);
  if (!entryRef) {
    return { corpus_id: corpusId, verdict: 'INVALID_HOLD', reason: 'session_start_failed', mismatches: [] };
  }
  // Boot assertions: the handshake must not suppress Stage-6 asks, and the
  // captured session is THE entry session (identity retained to the end).
  if (entryRef.fallbackToLegacy !== fallbackToLegacy) {
    return { corpus_id: corpusId, verdict: 'INVALID_HOLD', reason: 'handshake_mismapped', mismatches: [] };
  }
  if (capturedSession == null || entryRef.session !== capturedSession) {
    return { corpus_id: corpusId, verdict: 'INVALID_HOLD', reason: 'session_factory_not_used', mismatches: [] };
  }

  const violations = [];
  let failure = null;
  // Codex r2 finding 9 — SESSION-lifetime: `sent` retains every frame the
  // session ever sent, so a per-turn set would rediscover (and try to
  // re-answer) a PREVIOUS turn's ask frame on the next turn's pump.
  const askFramesSeen = new Set();
  // Codex r2 finding 6 — the judge needs each fixture turn's extraction
  // turn id to bind expectations turn-exactly.
  const turnIds = [];

  for (const turn of fixture.turns ?? []) {
    // Per-turn strict scripted client, swapped in IMMEDIATELY before the
    // transcript; the session is never reconstructed or restarted.
    const turnClient = makeTurnClient({
      baseRounds: turn.model_rounds ?? [],
      branches: turn.branches ?? [],
      turnState: {},
      violations,
      corpusId,
      turnIndex: turn.turn_index,
    });
    capturedSession.client = turnClient;

    const declaredAnswers = [...(turn.ask_answers ?? [])];
    const answeredIds = new Set();
    const utteranceId = `lane-utt-${corpusId}-${turn.turn_index}`;
    turnIds.push(utteranceId);

    // START the transcript-handler promise WITHOUT awaiting — a dispatcher
    // ask keeps it pending while it awaits its answer.
    let settled = false;
    const turnPromise = Promise.resolve(
      emit(
        'message',
        frameBuffer({
          type: 'transcript',
          sessionId,
          text: turn.transcript,
          is_final: true,
          utterance_id: utteranceId,
          regexResults: turn.regex_results ?? [],
          confirmations_enabled: true,
          // Codex r2 finding 10 + mini-review r2 finding 10 — exact
          // fixture-to-wire ingress: the fixture stores a PROVENANCED
          // scalar ({value, provenance}); only a truthy OBJECT value is a
          // real wire question context. Forwarding the wrapper itself made
          // every false-valued fixture truthy at production's presence
          // check.
          ...(turn.in_response_to &&
          typeof turn.in_response_to === 'object' &&
          turn.in_response_to.value &&
          typeof turn.in_response_to.value === 'object'
            ? { in_response_to: turn.in_response_to.value }
            : {}),
        })
      )
    ).finally(() => {
      settled = true;
    });

    // ── bounded deterministic answer pump ──
    let iterations = 0;
    let pumpError = null;
    while (!settled) {
      iterations += 1;
      if (iterations > PUMP_ITERATION_CAP) {
        pumpError = 'pump_iteration_cap_exhausted';
        break;
      }
      await clockCtl.drainMicrotasks();
      if (settled) break;

      // New outbound ask frames enqueue matched declarations after send.
      const askFrames = sent.filter(
        (f) => f.type === 'ask_user_started' && !askFramesSeen.has(f.tool_call_id)
      );
      let progressed = false;
      for (const frame of askFrames) {
        askFramesSeen.add(frame.tool_call_id);
        if (String(frame.tool_call_id).startsWith('srv-')) {
          // Tier-2 interception — the corpus records a dialogue_answer_ingress
          // exclusion by design; a fixture reaching the engine is a
          // frozen-provenance violation, never something to answer.
          pumpError = 'dialogue_ingress_interception';
          break;
        }
        // Ask matching reuses the field-replay order: recorded tool id
        // first, then the semantic tuple.
        let idx = declaredAnswers.findIndex(
          (d) => d.match?.tool_call_id != null && d.match.tool_call_id === frame.tool_call_id
        );
        if (idx < 0) {
          idx = declaredAnswers.findIndex(
            (d) =>
              d.match?.tool_call_id == null &&
              (d.match?.context_field == null || d.match.context_field === frame.context_field) &&
              (d.match?.context_circuit == null ||
                d.match.context_circuit === frame.context_circuit)
          );
        }
        if (idx < 0) {
          pumpError = `unexpected_ask:${frame.tool_call_id}`;
          break;
        }
        const decl = declaredAnswers.splice(idx, 1)[0];
        answeredIds.add(frame.tool_call_id);
        // Advance the replay clock by the declared answer delay, then
        // re-enter the SAME captured message listener with the answer frame
        // while the transcript promise is pending. Registry/controller
        // objects are never resolved directly.
        const delay = Number(decl.at_ms_after_ask) || 0;
        if (delay > 0) await clockCtl.tick(delay);
        await emit(
          'message',
          frameBuffer({
            type: 'ask_user_answered',
            sessionId,
            tool_call_id: frame.tool_call_id,
            user_text: decl.answer?.user_text ?? decl.user_text ?? '',
          })
        );
        progressed = true;
      }
      if (pumpError) break;
      if (progressed) continue;

      // No settled promise, no new asks: advance the next allowlisted timer
      // (question-gate/finalizer). Unknown timers reject deterministically.
      try {
        const res = await clockCtl.advanceNext({ declaredTimeoutAskIds: new Set() });
        if (!res.advanced) {
          // Nothing pending and nothing settled — drain once more, then
          // treat a still-pending promise as a stall next iteration.
          await clockCtl.drainMicrotasks();
        }
      } catch (err) {
        pumpError = `unsupported_timer:${err.message}`;
        break;
      }
    }

    // Codex r4 finding 4 — a pumpError exit (unexpected_ask / iteration
    // cap / unsupported timer) can leave the transcript promise BLOCKED on
    // an ask whose timeout the stopped clock will never fire: awaiting it
    // unconditionally deadlocks the gate. Bounded settle first (fire
    // remaining ledgered timers), then await ONLY a settled promise —
    // an unsettled one is abandoned (its eventual rejection swallowed) and
    // the pumpError becomes the INVALID_HOLD reason.
    if (!settled) {
      for (let i = 0; i < 64 && !settled; i += 1) {
        try {
          const res = await clockCtl.advanceNext({ declaredTimeoutAskIds: new Set() });
          if (!res.advanced) break;
        } catch {
          break;
        }
        await clockCtl.drainMicrotasks();
      }
    }
    if (settled) {
      try {
        await turnPromise;
      } catch (err) {
        failure = failure ?? `turn_threw:${err?.message ?? String(err)}`;
      }
    } else {
      turnPromise.catch(() => {});
      failure = failure ?? pumpError ?? 'turn_never_settled';
    }
    if (pumpError) failure = failure ?? pumpError;
    if (declaredAnswers.length > 0) {
      failure = failure ?? 'answer_under_consumption';
    }
    // Strict per-turn consumption before advancing; assert NO vendor
    // fallback and NO unexpected call.
    turnClient.assertFullyConsumed();
    if (violations.length > 0) {
      failure = failure ?? `scripted_client_violation:${violations[0]?.code ?? 'violation'}`;
    }
    if (failure) break;
  }

  // ── mock playback pump (implementation evidence ONLY) ──
  // For every OPERATION-BACKED audible frame captured on the wire, POST the
  // exact production playback-ACK body through the REAL HTTP route.
  if (!failure) {
    const ackBodies = [];
    for (const frame of sent) {
      if (frame.type !== 'extraction') continue;
      const result = frame.result ?? frame;
      const turnId = result.turn_id ?? `lane-turn-${corpusId}`;
      for (const c of result.confirmations ?? []) {
        if (!c || c.field == null) continue;
        const body = {
          sessionId,
          turnId: String(turnId),
          source: 'bundler',
          at_ms: Date.now(),
          audio_source: 'confirmation',
        };
        if (Number.isInteger(c.circuit) && c.circuit >= 0 && c.circuit <= 99) {
          body.slot = { field: c.field, circuit: c.circuit, boardId: c.board_id ?? null };
        }
        ackBodies.push(body);
      }
    }
    for (const body of ackBodies) {
      const res = await request(playbackApp)
        .post('/api/voice-latency/playback-ack')
        .set('Authorization', `Bearer ${DRIVER_TOKEN}`)
        .send(body);
      if (res.status !== 204) {
        failure = `playback_ack_route_${res.status}`;
        break;
      }
    }
  }

  // ── stop, teardown assertions, judge ──
  await emit('message', frameBuffer({ type: 'session_stop', sessionId }));
  ws.readyState = 3;
  try {
    await emit('close');
  } catch {
    // some paths register no close handler on stubs — non-fatal
  }
  const leaked = clockCtl.resetLedger();
  if (activeSessions.has(sessionId)) {
    return { corpus_id: corpusId, verdict: 'INVALID_HOLD', reason: 'entry_not_deleted', mismatches: [] };
  }
  log(`lane-driver: ${corpusId} cleared ${leaked.clearedPending} armed timers at teardown`);

  if (failure) {
    return { corpus_id: corpusId, verdict: 'INVALID_HOLD', reason: failure, mismatches: [] };
  }

  // The normalised context is ENTRY-only and the entry left the registry at
  // stop — the RETAINED reference is the only thing the accessor can serve.
  const frozen = getCompletionFreeze(entryRef);
  void EVALUATION_CONTEXT;
  return { corpus_id: corpusId, ...judge(expectation, frozen, { turnIds }) };
}

/**
 * Run ALL vendor-lane fixtures through the driver (mock mode). Returns
 * { results, allPass }.
 */
export async function runVendorLaneMock({ repoRoot, log = () => {} }) {
  const boot = await bootLaneDriver({ repoRoot });
  try {
    const projLib = pathToFileURL(
      path.join(repoRoot, 'scripts/model-ab/lib/expectation-projection.mjs')
    ).href;
    const judgeLib = pathToFileURL(
      path.join(repoRoot, 'scripts/model-ab/lib/semantic-judge.mjs')
    ).href;
    const {
      VENDOR_LIVE_FIXTURE_IDS,
      listCorpusIds,
      loadFixture,
      projectFixtureExpectation,
      renderExpectationManifests,
    } = await import(projLib);
    const { judgeFrozenEvidence } = await import(judgeLib);

    // ── fixture input vs projection target: one-to-one join, inventory
    // equality and source/projection digest agreement — fail BEFORE any
    // sample runs.
    const inventory = listCorpusIds(repoRoot);
    const joinOk =
      inventory.length === VENDOR_LIVE_FIXTURE_IDS.length &&
      [...VENDOR_LIVE_FIXTURE_IDS].sort().every((id, i) => inventory[i] === id);
    if (!joinOk) {
      throw new Error('lane-driver: corpus inventory does not join the vendor-lane fixture ids');
    }
    const rendered = renderExpectationManifests(repoRoot);
    const committedPath = path.join(repoRoot, 'scripts/model-ab/plan00-expectation-manifest.json');
    const committed = JSON.parse(fs.readFileSync(committedPath, 'utf8'));
    if (committed.vendor_live_expectations?.sha256 !== rendered.vendor_live_sha256) {
      throw new Error(
        'lane-driver: committed vendor_live_expectations sha256 does not match the rendered projection — stale manifest'
      );
    }

    const results = [];
    for (const corpusId of VENDOR_LIVE_FIXTURE_IDS) {
      const fixture = loadFixture(repoRoot, corpusId);
      const expectation = projectFixtureExpectation(fixture);
      // Single-board jobs judge with the board wildcard (§B5 pinned IR contract).
      const boardCount = Array.isArray(fixture.job_state?.boards)
        ? fixture.job_state.boards.length
        : 0;
      const result = await driveFixture({
        boot,
        fixture,
        expectation,
        // Mini-review r2 finding 6 — the wrapper MUST forward driveFixture's
        // opts (turnIds) or the 9/9 acceptance silently judges whole-capture.
        judge: (exp, frozen, opts) =>
          judgeFrozenEvidence(exp, frozen, {
            boardWildcard: boardCount <= 1,
            ...(opts ?? {}),
            // Codex r1 (B-2/C-4) + mini-review M-6 — the corpus judges a
            // declared turn WINDOW and dialogue-script asks live OUTSIDE it
            // (the dialogue_answer_ingress exclusion): a fixture cannot even
            // declare the trailing script ask its transcript provokes.
            // Dispatcher and address-mirror asks ARE window-observable and
            // stay strict. Assigned AFTER the opts spread so no driveFixture
            // option can widen or disable the policy.
            windowedOpenAskFamilies: ['dialogue_script'],
          }),
        log,
      });
      log(
        `lane-driver: ${corpusId} → ${result.verdict}${result.reason ? ` (${result.reason})` : ''}`
      );
      results.push(result);
    }
    return { results, allPass: results.every((r) => r.verdict === 'PASS') };
  } finally {
    boot.clockCtl.uninstall();
  }
}
