#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * PLAN-E1B2 item 1 — WebCodecs AudioEncoder packet-multiplicity live probe.
 *
 * Pins the exact output multiplicity and timestamp/duration behavior of the
 * REAL browser `AudioEncoder` for the exact config `opus-encoder.ts`'s
 * `realOpusEncoderFactory` uses (16kHz mono opus, 28kbps), before any
 * packet-to-source-sample mapping rule is written into production code.
 * See PLAN-E1B2-final.md item 1's "A live probe must pin the exact output
 * multiplicity..." requirement.
 *
 * `scripts/deepgram-flux-encoding-probe.mjs` (E0) exercises ffmpeg's libopus
 * over an Ogg container against Deepgram directly — it says nothing about
 * the BROWSER's own `AudioEncoder` output shape, which is what this probe
 * covers. This is a dedicated probe rather than an E0 extension because E0
 * has no browser runtime at all (it's pure Node + ffmpeg).
 *
 * WebCodecs is only available in a secure context, so `about:blank` (an
 * opaque origin) doesn't expose `AudioEncoder` even in a real Chromium
 * build — this probe serves the test page from `http://127.0.0.1` (a
 * browser-trusted secure-context origin) via a throwaway local HTTP server.
 *
 * WHAT IS MEASURED (the plan's actual rule — timestamp-domain mapping, not
 * arrival order): every submitted `AudioData` occupies the input range
 * [timestamp, timestamp + numberOfFrames/16000 s) in the encoder's
 * timestamp domain, and every emitted `EncodedAudioChunk` reports its own
 * [timestamp, timestamp + duration). A per-input completion signal is only
 * buildable if each output chunk's range lies WITHIN exactly one input's
 * range (so it can be attributed to that `encode()` call) and each input's
 * range is fully tiled by such chunks. A chunk whose range STRADDLES two
 * inputs, or a chunk with no owning input, cannot be attributed to a
 * single call from the observable data — that is the disqualifying
 * condition. Arrival grouping ("packets seen between two encode() calls")
 * is reported alongside as secondary evidence only.
 *
 * METHODOLOGY NOTE (why a SEQUENCE, not one `encode()` + `flush()`): an
 * earlier draft drove one `encode()` per fresh encoder followed by an
 * immediate `flush()` and saw "N+1 packets" for every length — an artifact
 * of `flush()` draining ~1 frame of algorithmic delay that a continuously
 * used encoder pays once, at teardown. Production (`deepgram-service.ts`)
 * builds ONE encoder per connection generation, calls `encode()` many
 * times, and flushes once at teardown; this probe mirrors that.
 *
 * Scenarios (each run twice on independent encoders for repeatability):
 *   - ALIGNED: inputs that are exact multiples of 320 samples (20 ms @
 *     16 kHz) — the steady-state Flux frame (1,280) and a 320-multiple tail.
 *   - UNALIGNED: non-320-multiple short-tail inputs (500, 100, 1,279, 1)
 *     interleaved between full frames — the genuinely reachable shape of
 *     `flushFluxAccumulator`'s scope-boundary flush and `disconnect()`'s
 *     graceful-teardown flush, which submit whatever is held (1–1,279
 *     samples).
 *   - CONSECUTIVE UNALIGNED: back-to-back short inputs at leading, middle
 *     and teardown positions — repeated scope-boundary flushes before any
 *     full frame accumulates.
 * Input timestamps come from a cumulative SAMPLE cursor (never per-input
 * rounded durations, which drift); tiling is checked with a strict sorted
 * cursor per input (no gaps, no overlaps, exact end); overhang, orphan,
 * straddle, or an encoder error each disqualify.
 *
 * Usage: node scripts/deepgram-webcodecs-opus-packet-probe.mjs
 * Read-only, offline — no Deepgram/network calls, no credentials.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const SAMPLE_RATE = 16000;
const RUNS_PER_SCENARIO = 2;

/**
 * Playwright's default `chromium.launch()` resolves to its
 * `chromium_headless_shell` build. On this machine that build's cached
 * revision doesn't match the installed `chromium` package version (a local
 * environment issue, not a WebCodecs behavior difference), so this probe
 * falls back to the full "Chrome for Testing" binary when Playwright's own
 * resolution fails — both are genuine Chromium builds with the identical
 * `AudioEncoder` implementation.
 */
function findFallbackChromeExecutable() {
  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  try {
    const entries = execSync(`ls "${cacheDir}"`, { encoding: 'utf8' })
      .split('\n')
      .filter((d) => /^chromium-\d+$/.test(d));
    for (const dir of entries) {
      const candidate = path.join(
        cacheDir,
        dir,
        'chrome-mac-arm64',
        'Google Chrome for Testing.app',
        'Contents',
        'MacOS',
        'Google Chrome for Testing'
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // fall through — let Playwright's default resolution report its own error.
  }
  return undefined;
}

// Runs INSIDE the browser via page.evaluate — this IS
// `realOpusEncoderFactory`'s exact encoder configuration, driven through a
// sequence of `encode()` calls with a real (non-silent) tone so DTX-style
// silence compression can't make every packet look identical. Returns the
// flat event trace: encode markers (with the input's timestamp range) and
// output chunks (with their own timestamp range).
async function runSequence(lens) {
  /* global AudioEncoder, AudioData */
  const events = [];
  const encoder = new AudioEncoder({
    output: (chunk) => {
      events.push({
        kind: 'output',
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        byteLength: chunk.byteLength,
      });
    },
    error: (e) => events.push({ kind: 'error', message: String(e) }),
  });
  encoder.configure({ codec: 'opus', sampleRate: 16000, numberOfChannels: 1, bitrate: 28000 });

  // Sample-domain cursor: each input's [start, end) is derived from the
  // CUMULATIVE sample count, never from independently rounded per-input
  // durations (1,279 + 1 samples must total exactly 80,000 us, not 80,001).
  let totalSamples = 0;
  for (let i = 0; i < lens.length; i++) {
    const len = lens[i];
    const samples = new Int16Array(len);
    for (let j = 0; j < len; j++) {
      samples[j] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (totalSamples + j)) / 16000));
    }
    const ts = Math.round((totalSamples * 1e6) / 16000);
    const tsEnd = Math.round(((totalSamples + len) * 1e6) / 16000);
    const durationUs = tsEnd - ts;
    const data = new AudioData({
      format: 's16',
      sampleRate: 16000,
      numberOfFrames: len,
      numberOfChannels: 1,
      timestamp: ts,
      data: samples.buffer,
    });
    events.push({ kind: 'encode', callIndex: i, len, timestamp: ts, duration: durationUs });
    try {
      encoder.encode(data);
    } finally {
      data.close();
    }
    totalSamples += len;
    await new Promise((r) => setTimeout(r, 5));
  }
  events.push({ kind: 'flush-start' });
  await encoder.flush();
  events.push({ kind: 'flush-end' });
  encoder.close();
  return events;
}

/** Timestamp-domain attribution: for every output chunk, which input(s)
 *  does its [timestamp, timestamp+duration) range overlap? */
function attributeByTimestamp(events) {
  const inputs = events.filter((e) => e.kind === 'encode');
  const chunks = events.filter((e) => e.kind === 'output');
  const lastInputEnd = inputs.length
    ? inputs[inputs.length - 1].timestamp + inputs[inputs.length - 1].duration
    : 0;
  const rows = chunks.map((c) => {
    const cStart = c.timestamp;
    const cEnd = c.timestamp + c.duration;
    // A chunk lying entirely PAST the final input's end is the encoder's
    // flush-time padding frame — it carries no submitted samples, so it is
    // benign for attribution (there is nothing to attribute) and is
    // reported separately rather than counted as an orphan.
    if (cStart >= lastInputEnd) {
      return { cStart, cEnd, owners: [], kind: 'padding' };
    }
    const owners = [];
    inputs.forEach((inp, i) => {
      const iStart = inp.timestamp;
      const iEnd = inp.timestamp + inp.duration;
      if (cStart < iEnd && cEnd > iStart) owners.push(i);
    });
    let kind;
    if (owners.length === 1) {
      const inp = inputs[owners[0]];
      const within = cStart >= inp.timestamp && cEnd <= inp.timestamp + inp.duration;
      kind = within ? 'within' : 'overhang'; // overhang = past the last input's end
    } else if (owners.length === 0) {
      kind = 'orphan';
    } else {
      kind = 'straddle';
    }
    return { cStart, cEnd, owners, kind };
  });
  // Exact-tiling check per input: sort that input's within-chunks and walk a
  // cursor — the first must start AT the input start, each next must start
  // exactly where the previous ended (no overlap, no gap), and the cursor
  // must finish exactly at the input end.
  const untiledInputs = inputs
    .map((inp, i) => {
      const mine = rows
        .filter((r) => r.kind === 'within' && r.owners[0] === i)
        .sort((a, b) => a.cStart - b.cStart);
      const iStart = inp.timestamp;
      const iEnd = inp.timestamp + inp.duration;
      let cursor = iStart;
      let reason = null;
      for (const r of mine) {
        if (r.cStart !== cursor) {
          reason = r.cStart < cursor ? `overlap at ${r.cStart}` : `gap [${cursor}, ${r.cStart})`;
          break;
        }
        cursor = r.cEnd;
      }
      if (!reason && cursor !== iEnd) reason = `ends at ${cursor}, input ends ${iEnd}`;
      return { i, len: inp.len, reason };
    })
    .filter((r) => r.reason !== null);
  return { inputs, chunks, rows, untiledInputs };
}

/** Secondary evidence: packets that ARRIVED between one encode() call and
 *  the next (what a naive per-call counter would see). */
function arrivalGroups(events) {
  const groups = [];
  let current = null;
  for (const e of events) {
    if (e.kind === 'output') {
      if (current) current.packets += 1;
    } else if (e.kind === 'encode') {
      current = { len: e.len, packets: 0 };
      groups.push(current);
    } else if (e.kind === 'flush-start') {
      current = { len: 'flush', packets: 0 };
      groups.push(current);
    }
  }
  return groups;
}

function reportScenario(label, events) {
  const { rows, untiledInputs } = attributeByTimestamp(events);
  const counts = { within: 0, straddle: 0, orphan: 0, overhang: 0, padding: 0 };
  for (const r of rows) counts[r.kind] += 1;
  console.log(`  ${label}:`);
  console.log(
    `    arrival groups (len→packets seen before next call): ${arrivalGroups(events)
      .map((g) => `${g.len}→${g.packets}`)
      .join(', ')}`
  );
  console.log(
    `    timestamp attribution: within=${counts.within} straddle=${counts.straddle} orphan=${counts.orphan} overhang=${counts.overhang} flush-padding=${counts.padding}`
  );
  for (const r of rows.filter((x) => x.kind !== 'within' && x.kind !== 'padding')) {
    console.log(`      chunk [${r.cStart}, ${r.cEnd}) us — ${r.kind}, overlaps inputs ${JSON.stringify(r.owners)}`);
  }
  if (untiledInputs.length) {
    console.log(
      `    inputs NOT exactly tiled by within-chunks: ${untiledInputs
        .map((u) => `#${u.i}(len=${u.len}: ${u.reason})`)
        .join(', ')}`
    );
  }
  const errors = events.filter((e) => e.kind === 'error');
  if (errors.length) console.log(`    encoder errors: ${JSON.stringify(errors)}`);
  const attributable =
    counts.straddle === 0 &&
    counts.orphan === 0 &&
    counts.overhang === 0 &&
    errors.length === 0 &&
    untiledInputs.length === 0;
  return { attributable, counts, untiledInputs: untiledInputs.length };
}

async function withBrowser(fn) {
  const server = http.createServer((req, res) => res.end('<html><body>probe</body></html>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let browser = null;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      const fallbackExecutable = findFallbackChromeExecutable();
      if (!fallbackExecutable) throw err;
      console.warn(
        `Playwright's default chromium_headless_shell launch failed (${err.message.split('\n')[0]}); falling back to ${fallbackExecutable}`
      );
      browser = await chromium.launch({ headless: true, executablePath: fallbackExecutable });
    }
    return await fn(browser, port);
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      server.close();
    }
  }
}

async function main() {
  await withBrowser(async (browser, port) => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const secure = await page.evaluate(
      () => globalThis.isSecureContext === true && 'AudioEncoder' in globalThis
    );
    if (!secure) {
      throw new Error('BLOCKER: AudioEncoder unavailable in this browser context — cannot run the live probe.');
    }
    console.log(`Browser: ${await browser.version()} — ${SAMPLE_RATE} Hz mono opus @ 28 kbps\n`);

    const scenarios = [
      { name: 'ALIGNED (multiples of 320 samples)', lens: [1280, 1280, 640, 1280, 1280] },
      { name: 'UNALIGNED (reachable flush-tail sizes)', lens: [1280, 500, 1280, 100, 1280, 1279, 1280, 1] },
      {
        // Repeated scope-boundary flushes before any full frame accumulates:
        // adjacent short inputs at leading, middle, and teardown positions.
        name: 'CONSECUTIVE UNALIGNED (back-to-back scope flushes)',
        lens: [500, 100, 1279, 1, 1280, 100, 500],
      },
    ];
    const verdicts = {};
    for (const s of scenarios) {
      console.log(`── ${s.name} ──`);
      const runResults = [];
      for (let run = 1; run <= RUNS_PER_SCENARIO; run++) {
        const events = await page.evaluate(runSequence, s.lens);
        runResults.push(reportScenario(`run ${run}`, events));
      }
      const attributable = runResults.every((r) => r.attributable);
      const consistent =
        new Set(runResults.map((r) => JSON.stringify([r.counts, r.untiledInputs]))).size === 1;
      verdicts[s.name] = { attributable, consistent };
      console.log(`  → attributable on every run: ${attributable}; runs consistent: ${consistent}\n`);
    }

    const enabled = Object.values(verdicts).every((v) => v.attributable && v.consistent);
    const verdict = enabled ? 'CLEAN_1_TO_1_OR_DETERMINISTIC_SPLIT' : 'NON_DETERMINISTIC';
    console.log(`═══ VERDICT: ${verdict} ═══`);
    if (!enabled) {
      console.log(
        'At least one scenario produced output chunks whose timestamp/duration range straddles two\n' +
          'submitted inputs (or leaves an input un-tiled), so no per-encode()-call subrange can be\n' +
          "computed from the observable data. Per PLAN-E1B2-final.md item 1's outcome matrix this is\n" +
          'the disabled outcome: web Opus stays off (resolveUplinkURLConfig forces linear16).'
      );
    }
  });
}

main().catch((err) => {
  console.error('PROBE FAILED:', err);
  process.exitCode = 1;
});
