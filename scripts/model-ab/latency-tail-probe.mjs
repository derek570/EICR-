#!/usr/bin/env node
/**
 * latency-tail-probe.mjs — repeat ONE corpus fixture's turn N times through
 * the REAL Stage 6 harness (same call path as run-lane.mjs) and report the
 * latency distribution, instead of a single sample.
 *
 * WHY THIS EXISTS: the first Luna A/B (run-lane.mjs) reported a ~3x slower
 * mean latency vs Haiku (9707ms vs 3263ms). Two follow-up checks — (1) an
 * isolated single-turn re-run of the SAME fixture completed in ~4s, not
 * 17.7s, and (2) 10 back-to-back + concurrent calls of the identical prompt
 * all landed 1.6-3.0s with zero degradation under load (ruling out
 * queueing/rate-limiting) — pointed at TAIL latency rather than a uniform
 * slowdown. This script confirms it: repeating one fixture 4x through the
 * real harness produced 3 fast runs (~3-3.5s, parity with Haiku) and ONE
 * spike to 14.7s. That is a fundamentally different problem than "3x
 * slower" — it's "usually parity, occasionally a 5-10x latency spike on the
 * exact same input" — and for a hands-free voice UX (Audio-First #3), an
 * unpredictable multi-second dead-air spike is arguably WORSE than
 * consistent-but-slower, because the user can't anticipate it.
 *
 * Use this to characterize tail-latency risk on any fixture/prompt before
 * drawing latency conclusions from a single-sample corpus run (which is
 * exactly what produced the misleading "3x slower" headline the first time).
 *
 * Usage:
 *   OPENAI_API_KEY=… node scripts/model-ab/latency-tail-probe.mjs \
 *     --fixture=frc_85ace7677d0e1c4a7b2f3609e5d1a8c4 --repeats=10
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

function parseArgs(argv) {
  const out = { fixture: null, repeats: 8, model: 'gpt-5.6-luna' };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--fixture=')) out.fixture = a.slice(10);
    else if (a.startsWith('--repeats=')) out.repeats = Number(a.slice(10));
    else if (a.startsWith('--model=')) out.model = a.slice(8);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.fixture) {
    process.stderr.write('usage: latency-tail-probe.mjs --fixture=<corpus_id> [--repeats=N] [--model=<id>]\n');
    process.exit(2);
  }
  const fixturePath = path.join(CORPUS, args.fixture, 'fixture.yaml');
  if (!fs.existsSync(fixturePath)) {
    process.stderr.write(`fixture not found: ${fixturePath}\n`);
    process.exit(2);
  }
  const fixture = yaml.load(fs.readFileSync(fixturePath, 'utf8'));
  const transcript = fixture.turns?.[0]?.transcript;
  if (!transcript) {
    process.stderr.write('fixture has no turns[0].transcript\n');
    process.exit(2);
  }

  process.env.SONNET_EXTRACT_MODEL = args.model;
  process.env.SONNET_TOOL_CALLS = 'live';
  process.env.VOICE_LATENCY_LOADED_BARREL = 'false';
  process.env.OBSERVATION_TIER_ROUTING = 'false';

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
  for (const t of [...projectLoggerModule.default.transports]) projectLoggerModule.default.remove(t);

  async function runOnce(i) {
    const sessionId = `tailprobe_${randomUUID().slice(0, 8)}`;
    const session = new EICRExtractionSession(process.env.ANTHROPIC_API_KEY || 'sk-unused', sessionId, 'eicr', {
      toolCallsMode: 'live',
    });
    activeSessions.set(sessionId, {
      session,
      voiceLatency: { flags: { loadedBarrel: false, suppression: false } },
    });
    session.start({
      boards: (fixture.job_state?.boards ?? []).map((b) => ({ ...b })),
      circuits: (fixture.job_state?.circuits ?? []).map((c) => ({ ...c })),
      certificateType: fixture.job_state?.certificateType ?? 'eicr',
    });
    const pendingAsks = createPendingAsksRegistry();
    let rounds = null;
    const ws = {
      readyState: 1,
      OPEN: 1,
      send: (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'ask_user_started' && msg.tool_call_id) {
          setTimeout(() => {
            try {
              pendingAsks.resolve(msg.tool_call_id, { answered: false, reason: 'user_moved_on' });
            } catch {
              /* already resolved */
            }
          }, 150);
        }
      },
    };
    const logger = {
      info: (m, meta) => {
        if (m === 'voice_latency.turn_core_summary') rounds = meta.rounds;
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    const t0 = performance.now();
    let errored = null;
    try {
      await runShadowHarness(session, transcript, fixture.turns[0].regex_results ?? [], {
        confirmationsEnabled: fixture.turns[0].confirmations_enabled?.value !== false,
        pendingAsks,
        ws,
        rawInspectorTranscript: transcript,
        chimeObserved: fixture.turns[0].chime_observed === true,
        generationId: randomUUID(),
        logger,
      });
    } catch (err) {
      errored = err?.message ?? String(err);
    }
    const ms = Math.round(performance.now() - t0);
    process.stderr.write(`  repeat ${i}: ${ms}ms  rounds=${rounds ?? '?'}${errored ? `  ERR:${errored}` : ''}\n`);
    try {
      session._clearCacheKeepalive?.();
      if (session.isActive) session.stop?.();
    } catch {
      /* teardown best-effort */
    }
    activeSessions.delete(sessionId);
    return ms;
  }

  process.stderr.write(`latency-tail-probe: ${args.fixture} × ${args.repeats} on ${args.model}\n"${transcript}"\n`);
  const results = [];
  for (let i = 1; i <= args.repeats; i++) results.push(await runOnce(i));

  const sorted = [...results].sort((a, b) => a - b);
  const mean = Math.round(results.reduce((a, b) => a + b, 0) / results.length);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  const summary = {
    fixture: args.fixture,
    model: args.model,
    transcript,
    repeats: args.repeats,
    samples_ms: results,
    min_ms: sorted[0],
    median_ms: median,
    p90_ms: p90,
    max_ms: sorted[sorted.length - 1],
    mean_ms: mean,
    // A crude tail-spike flag: anything > 2x the median is a candidate outlier.
    spikes: results.filter((r) => r > median * 2).length,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`latency-tail-probe FATAL: ${err?.stack || err}\n`);
  process.exit(1);
});
