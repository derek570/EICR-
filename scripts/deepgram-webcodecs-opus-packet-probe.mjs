#!/usr/bin/env node
/**
 * PLAN-E1B2 item 1 — WebCodecs AudioEncoder packet-multiplicity live probe.
 *
 * Pins the exact output multiplicity and timestamp behavior of the REAL
 * browser `AudioEncoder` for the exact config `opus-encoder.ts`'s
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
 * METHODOLOGY NOTE (why this probe drives a SEQUENCE, not one isolated
 * `encode()` + `flush()` call): an earlier version of this probe drove one
 * `encode()` call per fresh encoder instance, immediately followed by
 * `flush()`. That measured a consistent "N+1 packets" result for every
 * input length — which turned out to be an artifact of flushing
 * immediately, not evidence about steady-state behavior: `flush()` alone
 * drains ~1 frame of algorithmic/lookahead delay that a continuously-used
 * encoder only pays ONCE, at genuine teardown. Production never does this —
 * `deepgram-service.ts` constructs ONE encoder per connection generation and
 * calls `encode()` many times across the connection's life, calling
 * `flush()` only once, at teardown. This probe instead drives ONE encoder
 * through a SEQUENCE of `encode()` calls (mirroring real dispatch), because
 * that is the shape that actually determines whether a per-input packet
 * count can be attributed reliably.
 *
 * Two scenarios are driven:
 *   - ALIGNED: every submitted input is an exact multiple of 320 samples
 *     (20ms @ 16kHz) — the encoder's own internal frame size. This is the
 *     common-case Flux full-frame (1,280 samples / 80ms).
 *   - UNALIGNED: interleaves non-320-multiple short-tail inputs (1, 100,
 *     500, 1,279 samples) between full frames — the genuinely reachable
 *     shape of `flushFluxAccumulator`'s scope-boundary flush and
 *     `disconnect()`'s graceful-teardown flush, which submit "whatever is
 *     currently held" (anywhere from 1 to 1,279 samples), not just
 *     multiples of 320.
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

/**
 * Playwright's default `chromium.launch()` resolves to its
 * `chromium_headless_shell` build. On this machine that build's cached
 * revision doesn't match the installed `chromium` package version (a local
 * environment issue, not a WebCodecs behavior difference), so this probe
 * falls back to launching the full "Chrome for Testing" binary directly
 * when Playwright's own default resolution fails to find an executable —
 * both are genuine Chromium builds and expose the identical `AudioEncoder`
 * implementation this probe needs to observe.
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
    // fall through — return undefined, let Playwright's default resolution
    // try (and fail with its own actionable error) instead.
  }
  return undefined;
}

// Runs inside the real browser via page.evaluate — this IS
// `realOpusEncoderFactory`'s exact encoder configuration, driven through a
// sequence of `encode()` calls with a real (non-silent) tone so DTX-style
// silence compression can't make every packet look identical.
async function runSequence(lens) {
  const events = [];
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      events.push({ kind: 'output', timestamp: chunk.timestamp, duration: chunk.duration, byteLength: chunk.byteLength });
    },
    error: (e) => events.push({ kind: 'error', message: String(e) }),
  });
  encoder.configure({ codec: 'opus', sampleRate: 16000, numberOfChannels: 1, bitrate: 28000 });

  let ts = 0;
  for (let i = 0; i < lens.length; i++) {
    const len = lens[i];
    const samples = new Int16Array(len);
    for (let j = 0; j < len; j++) {
      samples[j] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (ts / 1e6 + j / 16000)) % (2 * Math.PI)));
    }
    const data = new AudioData({
      format: 's16',
      sampleRate: 16000,
      numberOfFrames: len,
      numberOfChannels: 1,
      timestamp: ts,
      data: samples.buffer,
    });
    events.push({ kind: 'encode', callIndex: i, len, ts });
    try {
      encoder.encode(data);
    } finally {
      data.close();
    }
    ts += Math.round((len / 16000) * 1e6);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5));
  }
  events.push({ kind: 'flush-start' });
  await encoder.flush();
  events.push({ kind: 'flush-end' });
  encoder.close();
  return events;
}

/** Groups the flat event stream into "packets that arrived between one
 *  encode() call and the next" — this is exactly the bookkeeping a
 *  production completion-signal implementation would need to perform, so
 *  reproducing it here is what proves (or disproves) that it's possible. */
function batchByCall(events) {
  const batches = [];
  let current = { marker: null, packets: [] };
  for (const e of events) {
    if (e.kind === 'output') {
      current.packets.push(e);
    } else {
      batches.push(current);
      current = { marker: e, packets: [] };
    }
  }
  batches.push(current);
  return batches.filter((b) => b.marker !== null || b.packets.length > 0);
}

async function main() {
  const server = http.createServer((req, res) => res.end('<html><body>probe</body></html>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const fallbackExecutable = findFallbackChromeExecutable();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    if (!fallbackExecutable) throw err;
    console.warn(
      `Playwright's default chromium_headless_shell launch failed (${err.message.split('\n')[0]}); falling back to ${fallbackExecutable}`
    );
    browser = await chromium.launch({ headless: true, executablePath: fallbackExecutable });
  }

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);

    const secure = await page.evaluate(() => window.isSecureContext && 'AudioEncoder' in window);
    if (!secure) {
      throw new Error('BLOCKER: AudioEncoder unavailable in this browser context — cannot run the live probe.');
    }
    console.log(`Browser: ${await browser.version()}\n`);

    // ── Scenario 1: ALIGNED — every input is a multiple of 320 samples ──
    const alignedLens = [1280, 1280, 640, 1280, 1280]; // matches FULL + a 320-multiple short tail
    const alignedEvents = await page.evaluate(runSequence, alignedLens);
    const alignedBatches = batchByCall(alignedEvents);
    console.log('── Scenario 1: ALIGNED inputs (multiples of 320 samples) ──');
    let alignedClean = true;
    for (const b of alignedBatches) {
      if (b.marker?.kind === 'encode') {
        const expectedPackets = b.marker.len / 320;
        console.log(`  after ENCODE(len=${b.marker.len}): ${b.packets.length} packets (expected ${expectedPackets})`);
        if (b.packets.length !== expectedPackets) alignedClean = false;
      } else if (b.marker?.kind === 'flush-end' || (b.marker === null && b.packets.length)) {
        console.log(`  flush drain: ${b.packets.length} packet(s) (algorithmic-delay residue, expected)`);
      }
    }
    console.log(`  verdict: ${alignedClean ? 'clean per-call N=len/320 split' : 'NOT clean'}\n`);

    // ── Scenario 2: UNALIGNED — genuinely reachable short-tail sizes ───
    // Run TWICE (independent encoder instances) to check flush-drain
    // repeatability as well as per-call attribution — a mapping rule must
    // hold on EVERY run, not just be self-consistent within one.
    const unalignedLens = [1280, 500, 1280, 100, 1280, 1279, 1280, 1];
    console.log('── Scenario 2: UNALIGNED inputs (genuinely reachable flush-tail sizes) ──');
    let anyUnalignedCallGotZeroImmediatePackets = false;
    const flushDrainCounts = [];
    for (let run = 0; run < 2; run++) {
      // eslint-disable-next-line no-await-in-loop
      const unalignedEvents = await page.evaluate(runSequence, unalignedLens);
      const unalignedBatches = batchByCall(unalignedEvents);
      console.log(`  run ${run + 1}:`);
      for (const b of unalignedBatches) {
        if (b.marker?.kind === 'encode') {
          const isAligned = b.marker.len % 320 === 0;
          console.log(
            `    after ENCODE(len=${b.marker.len}${isAligned ? '' : ', UNALIGNED'}): ${b.packets.length} packet(s)`
          );
          // A short-tail (unaligned) call that produces ZERO packets before
          // the NEXT call's own packets start arriving means its audio, if
          // it appears at all, is folded into a LATER packet this probe
          // cannot attribute back to this specific call from timestamp/
          // duration data alone — the disqualifying condition itself.
          if (!isAligned && b.packets.length === 0) anyUnalignedCallGotZeroImmediatePackets = true;
        } else if (b.marker?.kind === 'flush-end' || (b.marker === null && b.packets.length)) {
          console.log(`    flush drain: ${b.packets.length} packet(s)`);
          flushDrainCounts.push(b.packets.length);
        }
      }
    }
    const flushDrainStable = new Set(flushDrainCounts).size === 1;
    console.log(`  flush-drain counts across runs: [${flushDrainCounts.join(', ')}] (stable: ${flushDrainStable})\n`);

    const unalignedClean = !anyUnalignedCallGotZeroImmediatePackets && flushDrainStable;
    if (!unalignedClean) {
      console.log(
        '  verdict: NOT clean — at least one unaligned call produced zero immediately-attributable\n' +
          '  packets (its audio is only recoverable, if at all, folded into a later batch this probe\n' +
          "  cannot decompose) and/or the flush-time drain wasn't stable across equivalent runs.\n"
      );
    }

    // ── final verdict ────────────────────────────────────────────────
    const verdict = alignedClean && unalignedClean ? 'CLEAN_1_TO_1_OR_DETERMINISTIC_SPLIT' : 'NON_DETERMINISTIC';

    console.log(`═══ VERDICT: ${verdict} ═══`);
    if (verdict === 'NON_DETERMINISTIC') {
      console.log(
        'The full-frame (aligned) case resolves to a clean, immediate N=len/320 split, but the\n' +
          'short-tail (unaligned) case — genuinely reachable via flushFluxAccumulator/disconnect() —\n' +
          'does not track encode() call boundaries: packets from one call can arrive batched with a\n' +
          "later call's packets, or be held back entirely until a subsequent call. Per PLAN-E1B2-\n" +
          "final.md item 1's outcome matrix, this is the disabled outcome: web Opus stays off\n" +
          '(resolveUplinkURLConfig forces linear16 unconditionally), since no single mapping rule\n' +
          'holds across the full reachable input space.'
      );
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('PROBE FAILED:', err);
  process.exitCode = 1;
});
