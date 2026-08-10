#!/usr/bin/env node
/**
 * cache-ttl-renewal-probe.mjs — does a GPT-5.6 prompt-cache READ renew the TTL?
 *
 * WHY THIS EXISTS (Plan 01 §5, voice-latency wave 2026-07-31)
 * ----------------------------------------------------------
 * Plan 01 proposed a ~25-minute forced Terra cache re-warm timer. Whether that
 * timer can EVER pay for itself turns on one undocumented fact:
 *
 *   - If an ordinary cache READ renews the 30-minute lifetime, a keep-alive is
 *     a read. Terra read rate is $0.20/M, so refreshing the 35,276-token stable
 *     prefix costs ~$0.0071 per tick (~$0.017/hour). It only has to prevent one
 *     cold Terra turn per hour to break even (a cold turn writes the prefix at
 *     the $2.50/M write rate = ~$0.0882, vs ~$0.0071 warm — a $0.0811 swing).
 *
 *   - If a READ does NOT renew, a keep-alive has to be a WRITE: ~$0.0882 every
 *     30 minutes (~$0.212/hour) whether or not Terra is used again. That is
 *     strictly dominated by simply paying the cold write on the next real Terra
 *     turn, which costs the same and only when the turn actually happens. In
 *     that world the timer must never be built.
 *
 * OpenAI documents "a cached prefix remains eligible for reuse for at least 30
 * minutes, but OpenAI may retain it longer" and does not state whether a read
 * extends that window. `prompt_cache_retention: "24h"` — the other lever Plan 01
 * considered — is documented as DEPRECATED for GPT-5.6 and later model families,
 * and `prompt_cache_options.ttl` currently accepts only `30m`. So this is the
 * only remaining open question, and it is empirical.
 *
 * WHY A CONTROL ARM
 * -----------------
 * A warm read at T+50 does not by itself prove renewal, because the docs
 * explicitly reserve the right to retain a prefix beyond the 30-minute floor.
 * Two independent cache keys are therefore written at T+0:
 *
 *   TEST    — written at T+0, READ at T+25, checked at T+50
 *   CONTROL — written at T+0, left untouched,  checked at T+50
 *
 *   TEST warm + CONTROL cold  -> the read renewed the TTL.        RENEWS
 *   TEST cold + CONTROL cold  -> reads do not renew.               NO_RENEW
 *   both warm                 -> retention exceeded 30m on its own; renewal
 *                                neither shown nor excluded.       INCONCLUSIVE
 *   TEST cold + CONTROL warm  -> incoherent; rerun.                ANOMALOUS
 *
 * WHY IT PROBES LUNA, NOT TERRA
 * -----------------------------
 * The question is a GPT-5.6 *platform* behaviour, not a per-model one, and Luna
 * bills the same shape at roughly a tenth of Terra's rate — the whole probe
 * costs about $0.02 instead of $0.20. Pass --model to override if you want the
 * answer confirmed on the model that actually motivated it. The generalisation
 * from Luna to Terra is an assumption, and the report labels it as one.
 *
 * SAFETY
 * ------
 * Non-production. Sends synthetic filler only — never a real prompt, snapshot,
 * transcript, address or any other inspection data. Emits model/tier, usage
 * token buckets, timings and a truncated key digest; never prompt text, never
 * the API key, never a full cache key. Makes no writes to RDS, S3 or ECS.
 *
 * USAGE
 *   OPENAI_API_KEY=… node scripts/model-ab/cache-ttl-renewal-probe.mjs
 *   OPENAI_API_KEY=… node scripts/model-ab/cache-ttl-renewal-probe.mjs \
 *     --model gpt-5.6-terra --read-at 25 --check-at 50
 *   … --dry-run     # print the plan, the cost estimate and exit
 *
 * Runs ~50 minutes by default. Writes a JSON report to --out (default
 * ./cache-ttl-renewal-probe.json) after EVERY phase, so a probe that is
 * interrupted at minute 40 still leaves the phases it completed on disk.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import OpenAI from 'openai';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const MODEL = flag('model', 'gpt-5.6-luna');
const READ_AT_MIN = Number(flag('read-at', '25'));
const CHECK_AT_MIN = Number(flag('check-at', '50'));
const PREFIX_TOKENS = Number(flag('prefix-tokens', '35000'));
const OUT = flag('out', './cache-ttl-renewal-probe.json');
const DRY = has('dry-run');

if (!(READ_AT_MIN > 0 && CHECK_AT_MIN > READ_AT_MIN)) {
  console.error('cache-ttl-renewal-probe: need 0 < --read-at < --check-at');
  process.exit(2);
}
if (CHECK_AT_MIN <= 30) {
  console.error(
    `cache-ttl-renewal-probe: --check-at ${CHECK_AT_MIN} is inside the documented 30m floor, ` +
      'so a warm read proves nothing. Use a value > 30.'
  );
  process.exit(2);
}

/**
 * Deterministic synthetic filler. Content is irrelevant to the question — only
 * its stability and length matter — so it is generated rather than drawn from
 * any real prompt, which keeps inspection data out of the probe entirely.
 * ~4 chars/token is the usual English approximation; exact size does not matter
 * provided it comfortably clears the caching minimum and is byte-identical
 * across phases.
 */
function buildStablePrefix(arm) {
  const unit =
    `Reference block ${arm}. This is synthetic filler used solely to occupy a ` +
    `cacheable prompt prefix of a realistic size. It carries no instructions, ` +
    `no schema and no data. `;
  const targetChars = PREFIX_TOKENS * 4;
  return unit.repeat(Math.ceil(targetChars / unit.length)).slice(0, targetChars);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

/**
 * One probe request. Uses the same explicit-breakpoint shape the production
 * adapter sends (src/extraction/openai-responses-adapter.js) so the result
 * describes the caching path we actually use, not a different one.
 */
async function probe(client, { arm, phase, stablePrefix, cacheKey }) {
  const startedAt = Date.now();
  const res = await client.responses.create({
    model: MODEL,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: stablePrefix }] },
      // Volatile tail: sits AFTER the breakpoint, exactly as in production, and
      // is varied per phase so no phase can be served from a whole-request cache.
      { role: 'user', content: [{ type: 'input_text', text: `Reply with OK. (${phase})` }] },
    ],
    max_output_tokens: 16,
    reasoning: { effort: 'low' },
    prompt_cache_key: cacheKey,
    prompt_cache_options: { mode: 'explicit' },
  });
  const elapsedMs = Date.now() - startedAt;

  const u = res.usage || {};
  const details = u.input_tokens_details || {};
  const cachedTokens = details.cached_tokens ?? 0;
  const cacheWriteTokens = details.cache_write_tokens ?? u.cache_write_tokens ?? 0;

  return {
    arm,
    phase,
    at: nowIso(),
    elapsed_ms: elapsedMs,
    model: res.model || MODEL,
    service_tier: res.service_tier ?? null,
    input_tokens: u.input_tokens ?? 0,
    cached_tokens: cachedTokens,
    cache_write_tokens: cacheWriteTokens,
    output_tokens: u.output_tokens ?? 0,
    // A hit is a substantive cached read, not a token or two of incidental
    // overlap — the prefix is ~35k, so anything below half of it is noise.
    warm: cachedTokens > PREFIX_TOKENS / 2,
  };
}

function classify(testCheck, controlCheck) {
  if (testCheck.warm && !controlCheck.warm) return 'RENEWS';
  if (!testCheck.warm && !controlCheck.warm) return 'NO_RENEW';
  if (testCheck.warm && controlCheck.warm) return 'INCONCLUSIVE';
  return 'ANOMALOUS';
}

const VERDICT_MEANING = {
  RENEWS:
    'A read renewed the TTL. A read-based keep-alive is viable; size it against ' +
    'OBSERVED Terra gaps in real field sessions before building it (Plan 01 §5 fork 2).',
  NO_RENEW:
    'Reads do not renew. A keep-alive would have to be a WRITE every 30 minutes, ' +
    'which is strictly dominated by paying the cold write on the next real turn. ' +
    'Close the 25-minute timer proposal permanently.',
  INCONCLUSIVE:
    'Both arms stayed warm past the 30m floor, so retention alone explains it and ' +
    'renewal is neither shown nor excluded. Rerun with a larger --check-at.',
  ANOMALOUS:
    'Control warm but test cold — incoherent. Rerun; suspect key collision or an ' +
    'unrelated platform change.',
};

async function main() {
  const runId = createHash('sha256')
    .update(`${MODEL}:${nowIso()}:${process.pid}`)
    .digest('hex')
    .slice(0, 12);

  // Distinct keys per run so a rerun cannot be served by the previous run's
  // entries, and distinct per arm so the control is genuinely independent.
  const keys = {
    test: `ttlprobe-${runId}-test`,
    control: `ttlprobe-${runId}-control`,
  };
  const prefixes = {
    test: buildStablePrefix('T'),
    control: buildStablePrefix('C'),
  };

  const report = {
    run_id: runId,
    model: MODEL,
    prefix_tokens_target: PREFIX_TOKENS,
    read_at_min: READ_AT_MIN,
    check_at_min: CHECK_AT_MIN,
    key_digest: {
      test: createHash('sha256').update(keys.test).digest('hex').slice(0, 12),
      control: createHash('sha256').update(keys.control).digest('hex').slice(0, 12),
    },
    started_at: nowIso(),
    phases: [],
    verdict: null,
    verdict_meaning: null,
    note: 'Synthetic filler only. No prompt text, inspection data or credentials recorded.',
  };

  const flush = () => writeFileSync(OUT, JSON.stringify(report, null, 2));

  if (DRY) {
    report.verdict = 'DRY_RUN';
    report.verdict_meaning = `Would run ${CHECK_AT_MIN} minutes: write both arms now, read TEST at T+${READ_AT_MIN}, check both at T+${CHECK_AT_MIN}.`;
    flush();
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // ---- T+0: write both arms -------------------------------------------
  for (const arm of ['test', 'control']) {
    report.phases.push(
      await probe(client, {
        arm,
        phase: 'write',
        stablePrefix: prefixes[arm],
        cacheKey: keys[arm],
      })
    );
    flush();
  }
  console.error(`[T+0] both arms written (run ${runId})`);

  // ---- T+READ_AT: read the TEST arm only -------------------------------
  await sleep(READ_AT_MIN * 60_000);
  const testRead = await probe(client, {
    arm: 'test',
    phase: 'read',
    stablePrefix: prefixes.test,
    cacheKey: keys.test,
  });
  report.phases.push(testRead);
  flush();
  console.error(`[T+${READ_AT_MIN}] test read warm=${testRead.warm}`);

  // A cold TEST read here means the entry did not survive even to the read
  // point, so the renewal question is unanswerable for this run. Bail rather
  // than let the T+CHECK phase produce a confident-looking NO_RENEW that is
  // really "the write never took".
  if (!testRead.warm) {
    report.verdict = 'ANOMALOUS';
    report.verdict_meaning =
      `TEST arm was already cold at T+${READ_AT_MIN}, inside the documented 30m floor. ` +
      'The write did not take or the key was not honoured. Rerun before drawing any conclusion.';
    flush();
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // ---- T+CHECK_AT: check both arms -------------------------------------
  await sleep((CHECK_AT_MIN - READ_AT_MIN) * 60_000);
  const checks = {};
  for (const arm of ['test', 'control']) {
    checks[arm] = await probe(client, {
      arm,
      phase: 'check',
      stablePrefix: prefixes[arm],
      cacheKey: keys[arm],
    });
    report.phases.push(checks[arm]);
    flush();
  }

  report.verdict = classify(checks.test, checks.control);
  report.verdict_meaning = VERDICT_MEANING[report.verdict];
  report.finished_at = nowIso();
  flush();
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(`cache-ttl-renewal-probe: ${err?.message || err}`);
  process.exit(1);
});
