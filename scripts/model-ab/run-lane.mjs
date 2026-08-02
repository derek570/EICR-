#!/usr/bin/env node
/**
 * run-lane.mjs — run the field-replay corpus transcripts LIVE through the real
 * Stage 6 extraction harness for ONE model, and emit a JSON result the
 * `compare.mjs` orchestrator diffs across models.
 *
 * WHY a separate per-model subprocess: `stage6-shadow-harness.js` LATCHES
 * SHADOW_MODEL from process.env.SONNET_EXTRACT_MODEL at MODULE EVALUATION, and
 * EICRExtractionSession picks its provider (Anthropic vs the OpenAI adapter) at
 * construction from the same var. So a fair A/B needs the env var set BEFORE any
 * import — one clean process per model. `compare.mjs` spawns this twice.
 *
 * WHAT it runs: every fixture under tests/fixtures/field-replay-corpus/ — those
 * are REAL captured field utterances + seed job_state. We IGNORE each fixture's
 * frozen `model_rounds` (that's the recorded lane, which pins a single model's
 * response) and instead let the configured model actually respond — the LIVE
 * lane. Per turn we capture: the spoken read-back(s), the readings written, the
 * tool calls, rounds, wall-clock latency, and token usage → $ cost.
 *
 * This is a "could Luna do the extraction as well, cheaper, faster" probe — NOT
 * a merge gate. It calls the real vendor APIs; run it with real keys.
 *
 * Usage:
 *   SONNET_EXTRACT_MODEL=claude-haiku-4-5-20251001 ANTHROPIC_API_KEY=… \
 *     node scripts/model-ab/run-lane.mjs --out=/tmp/lane-haiku.json
 *   SONNET_EXTRACT_MODEL=gpt-5.6-luna OPENAI_API_KEY=… ANTHROPIC_API_KEY=… \
 *     node scripts/model-ab/run-lane.mjs --out=/tmp/lane-luna.json
 *   node scripts/model-ab/run-lane.mjs --dry-run   # load fixtures, no API calls
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const CORPUS = path.join(REPO, 'tests', 'fixtures', 'field-replay-corpus');

// Per-model $/1M token rates. Both platforms use the SAME cache convention:
// cache READ ~= 0.1x input (90% off), cache WRITE ~= 1.25x input (verified for
// Anthropic in cost-tracker.js's HAIKU_RATES; verified for OpenAI live
// 2026-08-02 via developers.openai.com/api/docs/pricing AND a live cache-cold/
// cache-warm probe pair). This standalone lane deliberately keeps a tiny local
// table so it has no dependency on the mutable session ledger, but the same
// rates are pinned in CostTracker tests and must stay in sync.
//
// Luna's OFFICIAL pricing (developers.openai.com/api/docs/models/gpt-5.6-luna,
// effective 2026-07-30 and verified 2026-08-02 — NOT third-party
// aggregators list): input $0.20, output $1.20, cached input $0.02 (90% off).
const RATES = {
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-haiku-4-5': { in: 1.0, out: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-5.6-luna': { in: 0.2, out: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
};
function rateFor(model) {
  if (RATES[model]) return RATES[model];
  // Fallback: unknown model → treat input-cache at 10% of input.
  return { in: 1.0, out: 5.0, cacheRead: 0.1, cacheWrite: 1.25 };
}

function parseArgs(argv) {
  const out = { out: null, dryRun: false, filter: null };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a.startsWith('--filter=')) out.filter = a.slice(9);
  }
  return out;
}

function loadFixtures(filter) {
  if (!fs.existsSync(CORPUS)) return [];
  const dirs = fs
    .readdirSync(CORPUS)
    .filter((d) => d.startsWith('frc_'))
    .filter((d) => !filter || d.includes(filter));
  const fixtures = [];
  for (const d of dirs) {
    const p = path.join(CORPUS, d, 'fixture.yaml');
    if (!fs.existsSync(p)) continue;
    const doc = yaml.load(fs.readFileSync(p, 'utf8'));
    fixtures.push(doc);
  }
  return fixtures;
}

async function main() {
  const args = parseArgs(process.argv);
  const model = (process.env.SONNET_EXTRACT_MODEL || 'claude-sonnet-4-6').trim();
  const fixtures = loadFixtures(args.filter);

  if (args.dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          model,
          fixtures_found: fixtures.length,
          fixtures: fixtures.map((f) => ({
            corpus_id: f.corpus_id,
            turns: (f.turns ?? []).length,
            transcripts: (f.turns ?? []).map((t) => t.transcript),
          })),
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  // --- Env setup BEFORE any extraction import (SHADOW_MODEL latches at import) ---
  // Keep the A/B a CLEAN single-model probe: no Loaded Barrel (ElevenLabs), no
  // observation-tier cross-provider escalation, no round-1 override.
  process.env.SONNET_TOOL_CALLS = 'live';
  process.env.VOICE_LATENCY_LOADED_BARREL = 'false';
  process.env.OBSERVATION_TIER_ROUTING = 'false';
  delete process.env.OBSERVATION_EXTRACT_MODEL;
  delete process.env.VOICE_LATENCY_ROUND1_MODEL;

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const isGpt = model.toLowerCase().startsWith('gpt-');
  if (isGpt && !process.env.OPENAI_API_KEY) {
    process.stderr.write('run-lane: SONNET_EXTRACT_MODEL is gpt-* but OPENAI_API_KEY is unset\n');
    process.exit(2);
  }
  if (!anthropicKey) {
    // Anthropic key is still needed as the EICRExtractionSession ctor arg even
    // when the OpenAI adapter is used (it's only consumed on the Anthropic path,
    // but the ctor signature requires it). A placeholder is fine on the gpt lane.
    if (!isGpt) {
      process.stderr.write('run-lane: ANTHROPIC_API_KEY is required for a claude-* lane\n');
      process.exit(2);
    }
  }
  const ctorKey = anthropicKey || 'sk-anthropic-unused-on-gpt-lane';

  const { EICRExtractionSession } = await import(
    new URL('../../src/extraction/eicr-extraction-session.js', import.meta.url).href
  );
  const { runShadowHarness } = await import(
    new URL('../../src/extraction/stage6-shadow-harness.js', import.meta.url).href
  );
  const { createPendingAsksRegistry } = await import(
    new URL('../../src/extraction/stage6-pending-asks-registry.js', import.meta.url).href
  );
  const { activeSessions } = await import(
    new URL('../../src/extraction/active-sessions.js', import.meta.url).href
  );
  const projectLoggerModule = await import(new URL('../../src/logger.js', import.meta.url).href);
  const projectLogger = projectLoggerModule.default;
  // Silence winston to stderr-only so stdout stays clean JSON.
  for (const t of [...projectLogger.transports]) projectLogger.remove(t);

  // A capturing logger for tool-call + usage telemetry.
  const captureBucket = [];
  const capturingLogger = {
    info: (msg, meta) => captureBucket.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => captureBucket.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => captureBucket.push({ level: 'error', msg, meta }),
    debug: () => {},
  };

  const laneResults = [];
  const startedAt = Date.now();

  for (const fixture of fixtures) {
    const corpusId = fixture.corpus_id;
    const sessionId = `ab_${model.replace(/[^a-z0-9]/gi, '')}_${randomUUID().slice(0, 8)}`;
    const session = new EICRExtractionSession(
      ctorKey,
      sessionId,
      fixture.job_state?.certificateType ?? 'eicr',
      {
        toolCallsMode: 'live',
      }
    );
    const capsList = fixture.client_capabilities?.value ?? [];
    activeSessions.set(sessionId, {
      session,
      voiceLatency: {
        flags: { loadedBarrel: false, suppression: false },
        capabilities: {
          voice_latency: { version: 1, supports: Array.isArray(capsList) ? capsList : [] },
        },
      },
    });

    const jobState = {
      boards: (fixture.job_state?.boards ?? []).map((b) => ({ ...b })),
      circuits: (fixture.job_state?.circuits ?? []).map((c) => ({ ...c })),
      certificateType: fixture.job_state?.certificateType ?? 'eicr',
    };
    session.start(jobState);

    const pendingAsks = createPendingAsksRegistry();
    // Auto-resolve any ask quickly as "moved on" so a model that ASKS doesn't
    // hang the lane on the 45s production timeout. The ask itself is recorded
    // as a divergence signal (readings==0 + an ask emitted).
    const ws = {
      readyState: 1,
      OPEN: 1,
      send: (raw) => {
        try {
          const msg = JSON.parse(raw);
          if (msg?.type === 'ask_user_started' && msg.tool_call_id) {
            setTimeout(() => {
              try {
                pendingAsks.resolve(msg.tool_call_id, { answered: false, reason: 'user_moved_on' });
              } catch {
                /* already resolved */
              }
            }, 150);
          }
        } catch {
          /* non-JSON frame */
        }
      },
    };

    const fixtureOut = { corpus_id: corpusId, provider: session.extractionProvider, turns: [] };
    const costBefore = { ...session.costTracker.sonnet };

    for (const [i, turn] of (fixture.turns ?? []).entries()) {
      const transcriptText = turn.transcript;
      const t0 = performance.now();
      let result;
      let errored = null;
      // Per-turn hard timeout — an ask-flow turn that never resolves (the ws
      // stub answers "moved on", but a model can re-ask) must not hang the lane.
      // Abort the in-flight extraction via the harness's AbortController seam
      // and record the turn as timed out.
      const TURN_TIMEOUT_MS = 25000;
      const ac = new AbortController();
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          try {
            ac.abort();
          } catch {
            /* noop */
          }
          resolve('__TURN_TIMEOUT__');
        }, TURN_TIMEOUT_MS);
      });
      try {
        const raced = await Promise.race([
          runShadowHarness(session, transcriptText, turn.regex_results ?? [], {
            confirmationsEnabled: turn.confirmations_enabled?.value !== false,
            pendingAsks,
            ws,
            rawInspectorTranscript: transcriptText,
            chimeObserved: turn.chime_observed === true,
            inResponseTo: turn.in_response_to?.value === true,
            generationId: randomUUID(),
            signal: ac.signal,
            logger: capturingLogger,
          }),
          timeout,
        ]);
        if (raced === '__TURN_TIMEOUT__') {
          errored = `turn_timeout_${TURN_TIMEOUT_MS}ms`;
          process.stderr.write(`    ⏱ turn ${i + 1} timed out (${corpusId})\n`);
        } else {
          result = raced;
        }
      } catch (err) {
        errored = err?.message ?? String(err);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const ms = Math.round(performance.now() - t0);

      const readings = (result?.extracted_readings ?? []).map((r) => ({
        circuit: r.circuit,
        field: r.field,
        value: r.value,
      }));
      const confirmations = (result?.confirmations ?? []).map((c) => c.text);
      const asks = captureBucket.filter(
        (e) => e.msg === 'stage6.ask_user' || e.meta?.tool_name === 'ask_user'
      ).length;

      fixtureOut.turns.push({
        turn: i + 1,
        transcript: transcriptText,
        latency_ms: ms,
        errored,
        readings,
        readings_count: readings.length,
        asks_emitted: asks,
        confirmations,
        spoken_response: result?.spoken_response ?? null,
      });
      // reset per-turn ask capture window
      captureBucket.length = 0;
    }

    const costAfter = { ...session.costTracker.sonnet };
    fixtureOut.usage = {
      input_tokens: (costAfter.inputTokens || 0) - (costBefore.inputTokens || 0),
      output_tokens: (costAfter.outputTokens || 0) - (costBefore.outputTokens || 0),
      cache_read_tokens: (costAfter.cacheReadTokens || 0) - (costBefore.cacheReadTokens || 0),
      cache_write_tokens: (costAfter.cacheWriteTokens || 0) - (costBefore.cacheWriteTokens || 0),
    };
    laneResults.push(fixtureOut);

    try {
      session._clearCacheKeepalive?.();
      if (session.isActive) session.stop?.();
    } catch {
      /* teardown best-effort */
    }
    activeSessions.delete(sessionId);
  }

  // Aggregate cost.
  const rate = rateFor(model);
  let totIn = 0;
  let totOut = 0;
  let totCacheRead = 0;
  let totCacheWrite = 0;
  let totLatency = 0;
  let turnCount = 0;
  for (const f of laneResults) {
    totIn += f.usage.input_tokens;
    totOut += f.usage.output_tokens;
    totCacheRead += f.usage.cache_read_tokens;
    totCacheWrite += f.usage.cache_write_tokens;
    for (const t of f.turns) {
      totLatency += t.latency_ms;
      turnCount += 1;
    }
  }
  const costUsd =
    (totIn / 1e6) * rate.in +
    (totOut / 1e6) * rate.out +
    (totCacheRead / 1e6) * rate.cacheRead +
    (totCacheWrite / 1e6) * rate.cacheWrite;

  const summary = {
    model,
    provider: laneResults[0]?.provider ?? (isGpt ? 'openai' : 'anthropic'),
    fixtures: laneResults.length,
    turns: turnCount,
    wall_ms_total: Date.now() - startedAt,
    latency_ms_total: totLatency,
    latency_ms_mean: turnCount ? Math.round(totLatency / turnCount) : 0,
    usage: {
      input_tokens: totIn,
      output_tokens: totOut,
      cache_read_tokens: totCacheRead,
      cache_write_tokens: totCacheWrite,
    },
    est_cost_usd: Number(costUsd.toFixed(6)),
    rate_per_1m: rate,
    results: laneResults,
  };

  const json = JSON.stringify(summary, null, 2);
  if (args.out) {
    fs.writeFileSync(args.out, json + '\n');
    process.stderr.write(
      `run-lane[${model}]: wrote ${args.out} (${laneResults.length} fixtures, ${turnCount} turns, $${summary.est_cost_usd})\n`
    );
  } else {
    process.stdout.write(json + '\n');
  }
}

main().catch((err) => {
  process.stderr.write(`run-lane FATAL: ${err?.stack || err}\n`);
  process.exit(1);
});
