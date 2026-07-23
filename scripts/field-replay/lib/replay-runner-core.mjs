/**
 * replay-runner-core.mjs — drives ONE fixture through the REAL
 * runShadowHarness with recorded model rounds (plan Item 2), and the corpus
 * orchestrator behind `replay:field-corpus`.
 *
 * Key mechanics (all plan-pinned):
 *   - per-turn STRICT round cursors: a turn requesting more streams than
 *     declared THROWS (and latches the violation — `runLiveMode` catches
 *     non-control-flow errors and returns the production EMPTY extraction,
 *     which would otherwise falsely satisfy a missing-output expected_red);
 *     after each turn every declared round must have been consumed exactly
 *     once (mockClient returning an empty stream on exhaustion would mask
 *     this silently);
 *   - conditional next-round BRANCHES (keystone ⑤): before serving round
 *     N+1 past the base rounds, the driver selects a declared branch by the
 *     turn's observed ask state and applies the narrowly-scoped SYMBOLIC
 *     SUBSTITUTION (binding the server-generated clarification-chain id
 *     into the reconstructed call; schema validation re-runs after
 *     substitution);
 *   - the ask resolution mechanism: onAskRegistered RECORDS + schedules ONE
 *     reconciliation queueMicrotask (queueMicrotask ONLY — other Node
 *     schedulers may be faked/reordered by the fake clock); the WS
 *     `ask_user_started` callback only RECORDS the emission and SCHEDULES
 *     resolution via queueMicrotask (the stub invokes its callback
 *     SYNCHRONOUSLY from send — resolving inline would violate the
 *     never-resolve-inside-ws.send ordering rule); matching by recorded
 *     tool_call_id FIRST, then the semantic tuple; NON-emitted asks get the
 *     declared terminal outcome only after the production fast-fails had
 *     their chance;
 *   - captured timing replayed via the corpus-lifetime fake clock
 *     (installed by the CLI bootstrap BEFORE extraction imports); in-process
 *     jest tests may pass clockCtl=null (real timers — their fixtures avoid
 *     gate-delayed asks).
 */

import { buildReplaySession } from './session-builder.mjs';
import { evaluateTurn, evaluateGateState, OUTCOME } from './replay-assertions.mjs';
import { mockStream } from '../../../src/__tests__/helpers/mockStream.js';
import { toolUseRound, endTurnRound } from '../../../src/__tests__/helpers/f7-audibility-core.js';
import fs from 'node:fs';
import { discoverFixtures, assertUniqueCorpusIds, FIXTURE_BASENAME } from './discovery.mjs';
import { validateFixtureDocument } from './fixture-schema.mjs';
import { scanRawContent, scanParsedFixture } from './pii-scanner.mjs';
import { resolveExpiryChain, isExpired } from './evidence-events.mjs';

/**
 * Build a `validateToolInput(name, input) -> {ok, errors}` closure over the
 * REAL production tool schemas compiled with the shared Ajv config. Dynamic
 * imports keep this off the module-eval path (the env loader must run before
 * any extraction static import) and memoise the compiled validators.
 */
async function buildToolInputValidator() {
  let getToolByName, AjvClass, AJV_OPTIONS;
  try {
    ({ getToolByName } = await import('../../../src/extraction/stage6-tool-schemas.js'));
    ({ AJV_OPTIONS } = await import('./fixture-schema.mjs'));
    const mod = await import('ajv');
    AjvClass = mod.default?.default ?? mod.default ?? mod.Ajv;
  } catch {
    return null; // tool schemas unavailable → validator absent (skip schema check)
  }
  const ajv = new AjvClass({ ...AJV_OPTIONS });
  const cache = new Map();
  return (name, input) => {
    if (!cache.has(name)) {
      const tool = getToolByName(name);
      cache.set(name, tool?.input_schema ? ajv.compile(tool.input_schema) : null);
    }
    const validate = cache.get(name);
    if (!validate) return { ok: false, errors: `unknown tool '${name}'` };
    const ok = validate(input);
    return { ok, errors: ok ? '' : ajv.errorsText(validate.errors) };
  };
}

function roundToEvents(round) {
  if (round.stop_reason === 'tool_use') {
    return toolUseRound(
      (round.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.name, input: tc.input })),
    );
  }
  return endTurnRound(round.text ?? '');
}

/** JSON Pointer set (narrow substitution use only). */
function setByPointer(obj, pointer, value) {
  const parts = pointer.split('/').filter((p) => p !== '');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i].replace(/~1/g, '/').replace(/~0/g, '~');
    cur = cur[Array.isArray(cur) ? Number(k) : k];
    if (cur == null) throw new Error(`substitution pointer ${pointer} does not resolve`);
  }
  const last = parts[parts.length - 1].replace(/~1/g, '/').replace(/~0/g, '~');
  cur[Array.isArray(cur) ? Number(last) : last] = value;
}

/**
 * Strict per-turn client. `baseRounds` are the turn's declared rounds;
 * `branches` the conditional continuations; `turnState` exposes the
 * observed ask state for branch selection. Violations latch into
 * `violations` (reported OUT-OF-BAND, never as throws alone).
 */
function makeTurnClient({ baseRounds, branches, turnState, violations, corpusId, turnIndex }) {
  // Keep the response-array reference — a selected branch APPENDS its
  // rounds before stream() reads the next slot (plan: reuse mockClient
  // as-is; here the same consumption contract with branch support).
  const rounds = baseRounds.map(roundToEvents);
  const roundMeta = baseRounds.map((r) => ({ source: 'base', round: r }));
  let cursor = 0;
  let branchTaken = null;

  const maybeExtendWithBranch = () => {
    if (cursor < rounds.length || !branches || branches.length === 0 || branchTaken) return;
    const interceptorObserved = turnState.backendAsksObserved.length > 0;
    const interceptorAnswered = turnState.backendAsksAnswered.length > 0;
    const branch = branches.find((b) =>
      b.when === 'interceptor_ask_answered' ? interceptorObserved && interceptorAnswered : !interceptorObserved,
    );
    if (!branch) return;
    branchTaken = branch.branch_id;
    for (const round of branch.rounds) {
      // Deep-copy the reconstructed round, then apply symbolic
      // substitutions (e.g. bind the server-minted clarification-chain id).
      const copy = JSON.parse(JSON.stringify(round));
      for (const sub of branch.substitutions ?? []) {
        let value;
        if (sub.from === 'ask_tool_call_id') value = turnState.backendAsksObserved[0] ?? null;
        else if (sub.from === 'ask_answer_text') value = turnState.backendAsksAnswered[0]?.user_text ?? null;
        else if (sub.from === 'tool_result_field') value = turnState.toolResultBindings.get(sub.from_field) ?? null;
        if (value == null) {
          violations.push(`branch ${branch.branch_id}: substitution ${sub.bind} resolved to null`);
        }
        setByPointer(copy, sub.into, value);
      }
      rounds.push(roundToEvents(copy));
      roundMeta.push({ source: `branch:${branch.branch_id}`, round: copy });
    }
  };

  return {
    messages: {
      stream() {
        maybeExtendWithBranch();
        if (cursor >= rounds.length) {
          const err = new Error(
            `strict round consumption: turn ${turnIndex} of ${corpusId} requested stream #${cursor + 1} but only ${rounds.length} round(s) are declared`,
          );
          violations.push(err.message);
          throw err;
        }
        const events = rounds[cursor];
        cursor += 1;
        return mockStream(events);
      },
    },
    get _consumed() {
      return cursor;
    },
    get _declared() {
      return rounds.length;
    },
    get _branchTaken() {
      return branchTaken;
    },
    assertFullyConsumed() {
      if (cursor !== rounds.length) {
        violations.push(
          `strict round consumption: turn ${turnIndex} of ${corpusId} consumed ${cursor}/${rounds.length} declared round(s) (under-consumption)`,
        );
      }
    },
  };
}

/** Replay WS stub per turn (open | closed | throw_on_send). */
function makeTurnWs(mode, onFrame) {
  const sent = [];
  const base = {
    OPEN: 1,
    readyState: mode === 'closed' ? 3 : 1,
    sent,
    send(payload) {
      if (mode === 'throw_on_send') throw new Error('ws send failed (replay throw_on_send)');
      const frame = JSON.parse(payload);
      sent.push(frame);
      onFrame?.(frame);
    },
    on() {},
    off() {},
    removeListener() {},
  };
  return base;
}

function matchDeclaration(declarations, { toolCallId, contextField, contextCircuit, question, reason }, { emitted }) {
  // tool_call_id FIRST; backend-generated asks match the REDUCED tuple only
  // (the registry entry carries no reason/question text).
  for (const d of declarations) {
    if (d.match?.tool_call_id && d.match.tool_call_id === toolCallId) return d;
  }
  for (const d of declarations) {
    const m = d.match ?? {};
    if (m.tool_call_id) continue;
    if (m.context_field !== undefined && m.context_field !== contextField) continue;
    if (m.context_circuit !== undefined && String(m.context_circuit) !== String(contextCircuit)) continue;
    if (emitted) {
      if (m.reason !== undefined && m.reason !== reason) continue;
      if (m.question_contains !== undefined && !String(question ?? '').toLowerCase().includes(String(m.question_contains).toLowerCase())) continue;
    }
    return d;
  }
  return null;
}

/**
 * Run ONE fixture. `modules` = the dynamically imported production modules
 * (session-builder contract) + { runShadowHarness }. `clockCtl` = the
 * replay-clock controller (null in-process). Returns
 * { corpusId, verdict, detail, turnResults, branchLog }.
 */
export async function runFixture({ fixture, modules, clockCtl = null, wallClockNowMs, apiKey }) {
  const rows = [];
  const sink = (level) => (msg, meta) =>
    rows.push({ level, name: typeof msg === 'string' ? msg : msg?.message, meta: meta ?? (typeof msg === 'object' ? msg : undefined) });
  const logger = { info: sink('info'), warn: sink('warn'), error: sink('error'), debug: sink('debug') };

  const built = buildReplaySession({ modules, fixture, logger, apiKey });
  const validateToolInput = await buildToolInputValidator();
  const allFailures = [];
  const turnResults = [];
  const branchLog = [];

  // Expiry against the REAL wall clock, never replay time.
  if (fixture.gate_state === 'expected_red' && fixture.expires_at && wallClockNowMs != null) {
    const chain = resolveExpiryChain(fixture.expires_at, fixture.expiry_extensions ?? []);
    const effective = chain.ok ? chain.effectiveExpiry : fixture.expires_at;
    if (isExpired(effective, wallClockNowMs)) {
      built.teardown();
      return {
        corpusId: fixture.corpus_id,
        // TERMINAL verdict: runCorpus must consume this directly and NOT call
        // evaluateGateState (which would `.filter()` a missing allFailures and
        // crash the whole corpus on the first expired fixture). allFailures is
        // still present + empty so any direct caller stays uniform.
        terminal: {
          verdict: 'fail',
          detail: `expected_red EXPIRED at ${effective} without becoming required_green or a reviewed extension — the deliberate pipeline freeze applies`,
        },
        verdict: 'fail',
        detail: `expected_red EXPIRED at ${effective} without becoming required_green or a reviewed extension — the deliberate pipeline freeze applies`,
        allFailures: [],
        turnResults: [],
        branchLog: [],
        logRows: [],
      };
    }
  }

  try {
    built.session.start(built.fixtureJobState);
    // Keepalive policy (BOTH lanes): cancel immediately after start —
    // mockClient implements no messages.create path, and in the live lane
    // the keepalive would bypass the vendor cap. stop() would deactivate.
    built.session._clearCacheKeepalive?.();

    const turns = [...(fixture.turns ?? [])].sort((a, b) => a.turn_index - b.turn_index);
    for (const turn of turns) {
      const violations = [];
      const turnState = {
        backendAsksObserved: [],
        backendAsksAnswered: [],
        toolResultBindings: new Map(),
        emittedAskIds: new Set(),
        registeredAskIds: new Set(),
      };
      const declaredTimeoutAskIds = new Set();
      const pendingAnswerQueue = [];
      const injectedToolIds = new Set(
        (turn.model_rounds ?? []).flatMap((r) => (r.tool_calls ?? []).map((tc) => tc.id)),
      );
      const askOrigins = new Map();
      const rowStart = rows.length;

      // Inter-turn logical time (captured timing replayed, not discarded).
      if (clockCtl && turn.at_ms != null) {
        const target = clockCtl.startMs != null ? clockCtl.startMs + turn.at_ms : null;
        const delta = target != null ? Math.max(0, target - clockCtl.clock.now) : 0;
        if (delta > 0) await clockCtl.tick(delta);
      }

      const declarations = turn.ask_answers ?? [];

      const ws = makeTurnWs(turn.ws_mode ?? 'open', (frame) => {
        if (frame?.type !== 'ask_user_started' || !frame.tool_call_id) return;
        turnState.emittedAskIds.add(frame.tool_call_id);
        askOrigins.set(
          frame.tool_call_id,
          injectedToolIds.has(frame.tool_call_id) ? 'model_emitted' : 'backend_interceptor',
        );
        if (!injectedToolIds.has(frame.tool_call_id)) {
          turnState.backendAsksObserved.push(frame.tool_call_id);
        }
        const decl = matchDeclaration(
          declarations,
          {
            toolCallId: frame.tool_call_id,
            contextField: frame.context_field,
            contextCircuit: frame.context_circuit,
            question: frame.question,
            reason: frame.reason,
          },
          { emitted: true },
        );
        if (!decl) return; // may still be an EXPECTED-but-unanswered ask (assertion (d))
        if (decl.answer_channel === 'terminal' && decl.terminal_outcome === 'timeout') {
          declaredTimeoutAskIds.add(frame.tool_call_id);
          return; // the clock pump fires the identified timer
        }
        if (decl.answer_channel === 'pending_registry' && decl.answer?.answered) {
          // Schedule via queueMicrotask ONLY — never resolve inside ws.send.
          queueMicrotask(() => {
            pendingAnswerQueue.push({
              toolCallId: frame.tool_call_id,
              user_text: decl.answer.user_text,
              at_ms_after_ask: decl.at_ms_after_ask ?? 0,
            });
          });
        }
      });
      built.entry.ws = ws;

      const onAskRegistered = (toolCallId) => {
        turnState.registeredAskIds.add(toolCallId);
        // POST-REGISTRATION ledger binding for the declared-timeout pump.
        if (clockCtl) {
          for (const [id, entry] of built.entry.pendingAsks.entries()) {
            if (id === toolCallId && entry.timer != null) {
              try {
                clockCtl.bindAskTimeout(toolCallId, entry.timer);
              } catch (err) {
                violations.push(err.message);
              }
            }
          }
        }
        // ONE reconciliation microtask: NON-emitted asks get their declared
        // terminal outcome only after the production fast-fails resolved.
        queueMicrotask(() => {
          if (turnState.emittedAskIds.has(toolCallId)) return; // emitted path owns it
          let stillPending = false;
          let regEntry = null;
          for (const [id, entry] of built.entry.pendingAsks.entries()) {
            if (id === toolCallId) {
              stillPending = true;
              regEntry = entry;
            }
          }
          if (!stillPending) return; // production fast-fail already resolved it
          const decl = matchDeclaration(
            declarations,
            { toolCallId, contextField: regEntry?.contextField, contextCircuit: regEntry?.contextCircuit },
            { emitted: false },
          );
          if (!decl) {
            violations.push(
              `non-emitted ask ${toolCallId} is genuinely pending with NO declaration — fixture must declare an answer or terminal outcome`,
            );
            // Unblock rather than deadlock to the 45s production timeout.
            built.entry.pendingAsks.resolve(toolCallId, { answered: false, reason: 'user_moved_on' });
            return;
          }
          if (decl.answer_channel === 'pending_registry' && decl.answer?.answered) {
            pendingAnswerQueue.push({
              toolCallId,
              user_text: decl.answer.user_text,
              at_ms_after_ask: decl.at_ms_after_ask ?? 0,
            });
          } else if (decl.answer_channel === 'terminal' && decl.terminal_outcome === 'timeout') {
            declaredTimeoutAskIds.add(toolCallId);
          } else if (decl.answer_channel === 'terminal') {
            violations.push(`terminal outcome ${decl.terminal_outcome} is not supported in v1 (unsupported_pending)`);
            built.entry.pendingAsks.resolve(toolCallId, { answered: false, reason: 'user_moved_on' });
          }
        });
        return true;
      };

      const client = makeTurnClient({
        baseRounds: turn.model_rounds ?? [],
        branches: turn.branches ?? [],
        turnState,
        violations,
        corpusId: fixture.corpus_id,
        turnIndex: turn.turn_index,
      });
      built.session.client = client;

      const opts = built.buildTurnOptions({
        turnIndex: turn.turn_index,
        turn,
        ws,
        onAskRegistered,
        signal: new AbortController().signal,
      });

      let result = null;
      let harnessError = null;
      const harnessPromise = modules
        .runShadowHarness(built.session, turn.transcript, turn.regex_results ?? [], opts)
        .then((r) => {
          result = r;
        })
        .catch((err) => {
          harnessError = err;
        });

      // The pump: drain microtasks, process answered asks (advance the
      // logical clock by the bounded offset BEFORE resolving), advance only
      // allowlisted timers, never sleep real time.
      let settled = false;
      harnessPromise.finally(() => {
        settled = true;
      });
      let pumpIterations = 0;
      const PUMP_CAP = 10000;
      while (!settled) {
        pumpIterations += 1;
        if (pumpIterations > PUMP_CAP) {
          violations.push('clock pump exceeded iteration cap — genuinely stuck turn (infrastructure)');
          break;
        }
        if (clockCtl) await clockCtl.drainMicrotasks();
        else await new Promise((res) => setImmediate(res));
        while (pendingAnswerQueue.length > 0) {
          const ans = pendingAnswerQueue.shift();
          if (clockCtl && ans.at_ms_after_ask > 0) await clockCtl.tick(ans.at_ms_after_ask);
          const resolved = built.entry.pendingAsks.resolve(ans.toolCallId, {
            answered: true,
            user_text: ans.user_text,
          });
          if (resolved) {
            turnState.backendAsksAnswered.push({ toolCallId: ans.toolCallId, user_text: ans.user_text });
          }
        }
        if (settled) break;
        if (clockCtl) {
          const pending = clockCtl.pendingEntries();
          if (pending.length > 0) {
            try {
              await clockCtl.advanceNext({ declaredTimeoutAskIds });
            } catch (err) {
              if (err.infrastructure) {
                violations.push(err.message);
                process.stderr.write(`field-replay infrastructure: ${err.message}\n`);
                break;
              }
              throw err;
            }
          } else {
            await new Promise((res) => setImmediate(res));
          }
        }
      }
      if (!settled) {
        // The pump broke on a violation (already latched — the fixture can
        // only resolve infrastructure_error now). UNBLOCK the harness so
        // the run can report instead of deadlocking: reject pending asks,
        // then let production's own timers fire under the fake clock.
        try {
          built.entry.pendingAsks.rejectAll('test_teardown');
        } catch {
          /* documented-safe on empty registry */
        }
        for (let i = 0; i < 50 && !settled; i++) {
          if (clockCtl) {
            try {
              await clockCtl.clock.tickAsync(60_000);
            } catch (err) {
              violations.push(`recovery tick threw: ${err.message}`);
              break;
            }
          }
          await new Promise((res) => setImmediate(res));
        }
        if (!settled) {
          violations.push('harness promise never settled even after recovery — abandoning the turn (infrastructure)');
        }
      }
      if (settled) await harnessPromise;
      if (harnessError) {
        violations.push(`runShadowHarness threw: ${harnessError.message}`);
      }
      // Only assert full round consumption / read the branch marker when the
      // harness actually settled. On the never-settled recovery path a
      // violation is already latched; `assertFullyConsumed()` would THROW on
      // the unconsumed rounds and escape as an uncaught error, discarding the
      // infrastructure_error classification. Skipping it here lets the latched
      // violation flow into `captured.infrastructureViolations` below so the
      // turn resolves as infrastructure_error, never a crash.
      if (settled) {
        client.assertFullyConsumed();
        if (client._branchTaken) {
          branchLog.push({ turn: turn.turn_index, branch: client._branchTaken });
        }
      }

      const captured = {
        result,
        wsFrames: ws.sent,
        logRows: rows.slice(rowStart),
        askOrigins,
        infrastructureViolations: violations,
        validateToolInput,
        // P5 (2026-07-23) — the A2 clear-wire field mapping, DYNAMICALLY
        // injected via `modules` (constructed in importExtractionModules AFTER
        // the fake clock installs). matchOperations needs it to look up the
        // canonicalised field_corrected wire field for a clear_then_write op;
        // absent → the oracle latches INFRASTRUCTURE rather than passing
        // un-checked. Kept off the static import graph on purpose.
        toClearWireField: modules?.toClearWireField ?? null,
      };
      const failures = evaluateTurn(turn, captured);
      turnResults.push({ turn: turn.turn_index, failures, frames: ws.sent.length });
      allFailures.push(...failures);
    }
  } finally {
    built.teardown();
    if (clockCtl) clockCtl.resetLedger();
    // Reset module-level voice-latency finalizer/ack state so a pending
    // finalizer from this fixture cannot bleed into the next (Codex #4).
    try {
      const vl = await import('../../../src/extraction/voice-latency-turn-summary.js');
      vl._resetForTests?.();
    } catch {
      /* module unavailable → nothing to reset */
    }
  }

  return { corpusId: fixture.corpus_id, allFailures, turnResults, branchLog, logRows: rows };
}

/**
 * The corpus orchestrator. `loadFixture(path)` supplied by the CLI (YAML).
 * Empty/absent corpus = PASS with an explicit summary (Foundation ships the
 * blocking step with ZERO fixtures — exit-2-on-empty would deadlock the
 * Foundation PR's own gate).
 */
export async function runCorpus({ corpusRoot, modules, clockCtl, loadFixture, proofState = null, fixtureFilter = null, wallClockNowMs }) {
  const found = discoverFixtures(corpusRoot);
  const summary = { discovered: found.length, executed: 0, passed: 0, failed: 0, unsupported: 0, results: [] };
  if (found.length === 0) {
    summary.message = `0 fixtures discovered under ${corpusRoot} (${FIXTURE_BASENAME}) — field-corpus lane PASS`;
    summary.exitCode = 0;
    return summary;
  }
  const fixtures = found.map((f) => ({ ...f, doc: loadFixture(f.fixturePath) }));
  assertUniqueCorpusIds(fixtures);

  for (const f of fixtures) {
    if (fixtureFilter && f.doc.corpus_id !== fixtureFilter) continue;
    const validation = await validateFixtureDocument(f.doc);
    if (!validation.ok) {
      summary.failed += 1;
      summary.results.push({
        corpusId: f.doc.corpus_id ?? f.fixturePath,
        verdict: 'fail',
        detail: `fixture validation failed: ${validation.errors.map((e) => e.code).join(', ')}`,
      });
      continue;
    }
    // PII scan (raw bytes + parsed) on EVERY blocking invocation — the gate
    // must never merge a fixture leaking a raw session id / private path / real
    // postcode in comments, keys, or values (Codex #5: the blocking runner
    // previously ran ONLY structural validation, so the retained PII scans were
    // absent from CI). Attestation stays optional; PII/structural always block.
    const rawBytes = fs.readFileSync(f.fixturePath);
    const piiFindings = [
      ...scanRawContent(rawBytes, f.fixturePath).findings,
      ...scanParsedFixture(f.doc, f.fixturePath).findings,
    ];
    if (piiFindings.length > 0) {
      summary.failed += 1;
      summary.results.push({
        corpusId: f.doc.corpus_id ?? f.fixturePath,
        verdict: 'fail',
        detail: `PII scan: ${piiFindings.map((x) => `${x.code} "${x.match}"`).join('; ')}`,
      });
      continue;
    }
    if (['unsupported_pending', 'superseded', 'privacy_quarantined'].includes(f.doc.gate_state)) {
      // Validate-but-never-execute states: REPORTED every run.
      summary.unsupported += 1;
      summary.results.push({ corpusId: f.doc.corpus_id, verdict: 'reported', detail: f.doc.gate_state });
      continue;
    }
    summary.executed += 1;
    const run = await runFixture({ fixture: f.doc, modules, clockCtl, wallClockNowMs });
    // A terminal verdict (e.g. an expired expected_red freeze) short-circuits
    // gate evaluation — it never produced an allFailures set to evaluate.
    const gate = run.terminal ?? evaluateGateState(f.doc, run.allFailures, { proofState });
    const pass = gate.verdict === 'pass';
    if (pass) summary.passed += 1;
    else summary.failed += 1;
    summary.results.push({ corpusId: f.doc.corpus_id, verdict: gate.verdict, detail: gate.detail, turns: run.turnResults, branches: run.branchLog });
  }
  summary.exitCode = summary.failed === 0 ? 0 : 1;
  return summary;
}

export { OUTCOME };
