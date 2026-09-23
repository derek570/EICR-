/**
 * PLAN-E-TERM test 5 (frozen surfaces) + wiring — source-adjacency
 * assertions on the real files (the provider is not unit-mountable; the
 * established house pattern, see `uplink-loss-recording-context-wiring`).
 *
 *  - `stop()`, `pause()`, `resume()`, `handleWake()` carry NO E-TERM edit —
 *    the plan adds not a byte to the stop path; `cancelSpeech` in tts.ts
 *    is byte-for-byte free of it too.
 *  - the binder is constructed at `start()` with INJECTED identity and
 *    bound to the ledger's `onSourceEvidence` + telemetry stream;
 *  - the wall-clock map is fed at the tagging boundary in `onSamples`;
 *  - the banner mounts BENEATH RecordingProvider; the PDF page clears at
 *    the REAL success point (after `setPdfBlob(blob)`) with the active set;
 *  - `clearAuth` → `purgeUnresolvedAudio()` is the SOLE purge owner.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');
const SRC = read('../src/lib/recording-context.tsx');
const TTS = read('../src/lib/recording/tts.ts');
const LAYOUT = read('../src/app/job/[id]/layout.tsx');
const PDF = read('../src/app/job/[id]/pdf/page.tsx');
const CACHE = read('../src/lib/pwa/job-cache.ts');
const NL_BRACE = '\n}\n';

function fnBody(src: string, name: string): string {
  const start = `const ${name} = React.useCallback(`;
  const s = src.indexOf(start);
  expect(s, `anchor missing: ${start}`).toBeGreaterThan(-1);
  const rest = src.slice(s + start.length);
  const next = rest.search(/= React\.use(Callback|Effect)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('test 5 — frozen surfaces carry no E-TERM edit', () => {
  it('stop / pause / resume / handleWake contain no TERM identifiers', () => {
    for (const fn of ['stop', 'pause', 'handleWake']) {
      const body = fnBody(SRC, fn);
      expect(body, fn).not.toContain('PLAN-E-TERM');
      expect(body, fn).not.toContain('UnresolvedAudio');
      expect(body, fn).not.toContain('unresolvedAudio');
      expect(body, fn).not.toContain('captureWallClock');
    }
  });

  it('`cancelSpeech` in tts.ts is byte-for-byte free of E-TERM', () => {
    const s = TTS.indexOf('export function cancelSpeech(');
    expect(s).toBeGreaterThan(-1);
    const body = TTS.slice(s, TTS.indexOf('\n}\n', s));
    expect(body).not.toContain('PLAN-E-TERM');
    expect(body).not.toContain('uplinkLossCompletionObserver');
  });

  it('the session id is exposed as a read-only getter over the ref (no stop() edit needed)', () => {
    expect(SRC).toContain(
      'const getClientSessionId = React.useCallback(() => sessionIdRef.current, []);'
    );
  });
});

describe('start() wiring — injected identity, ledger seams, wall-clock', () => {
  it('the binder is built with getUser()/jobRef identity and bound to onSourceEvidence + telemetry + the completion observer', () => {
    const start = fnBody(SRC, 'start');
    expect(start).toContain('new UnresolvedAudioBinder({');
    expect(start).toContain('userId: recordUserId');
    expect(start).toContain('jobId: recordJobId');
    expect(start).toContain('binder?.onLedgerTelemetry(event, payload)');
    expect(start).toContain('binder.onSourceEvidence(sourceId, evidence)');
    expect(start).toContain('setUplinkLossDisclosureCompletionObserver(');
    expect(start).toContain('new CaptureWallClock()');
    expect(start).toContain('port: createUnresolvedAudioPort()');
    expect(start).toContain('endActiveSessionAnnouncementRef.current = announceActiveSession(');
    expect(start).toContain(
      'endActiveSessionAnnouncementRef.current?.(); // a replaced session ends its lease'
    );
    // The lease ends on any terminal state and on unmount (never in stop()).
    expect(SRC).toContain(
      "if (state === 'idle' || state === 'error') {\n      endActiveSessionAnnouncementRef.current?.();"
    );
    expect(start).toContain('primeUnresolvedAudioStore();');
  });

  it('the wall-clock map is fed at the tagging boundary in onSamples, AFTER the TTS-discard guard', () => {
    // PLAN-D D7 — the tagging boundary is `ingestCapturedBlock`, which the
    // live path calls only after the TTS guard and the post-TTS drain calls
    // once per held block. The observe call lives inside it.
    const ingestStart = SRC.indexOf('const ingestCapturedBlock = (');
    const ingestEnd = SRC.indexOf('ingestCapturedBlockRef.current = ingestCapturedBlock;');
    const guard = SRC.indexOf('if (ttsActiveRef.current) {');
    const liveCall = SRC.indexOf(
      'ingestCapturedBlock(samples, handle.sampleRate, performance.now());'
    );
    const observe = SRC.indexOf('captureWallClockRef.current?.observe(');
    expect(guard).toBeGreaterThan(-1);
    expect(liveCall).toBeGreaterThan(guard);
    expect(observe).toBeGreaterThan(ingestStart);
    expect(observe).toBeLessThan(ingestEnd);
    expect(SRC.match(/captureWallClockRef\.current\?\.observe\(/g)?.length).toBe(1);
    // The anchor is the INGRESS instant (`capturedAt`, stamped before the
    // resample), never a post-processing `Date.now()`.
    expect(SRC.slice(observe, observe + 200)).toContain('performance.timeOrigin + capturedAt');
    expect(SRC.slice(observe, observe + 200)).not.toContain('Date.now()');
  });

  it('declared discontinuities force an anchor: TTS-gate release and resume()', () => {
    // PLAN-D D7 — the discontinuity is marked at the START of the release
    // timer, before the held post-TTS blocks are observed and before the
    // gate flag clears (the held run starts at audio-end).
    const release = SRC.lastIndexOf('ttsActiveRef.current = false;');
    const timerOpen = SRC.lastIndexOf('ttsResumeTimerRef.current = setTimeout(() => {', release);
    const mark = SRC.indexOf('captureWallClockRef.current?.markDiscontinuity();', timerOpen);
    const drain = SRC.indexOf(
      'ingest(block.samples, block.sampleRate, block.capturedAt)',
      timerOpen
    );
    expect(timerOpen).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(timerOpen);
    expect(drain).toBeGreaterThan(mark);
    expect(release).toBeGreaterThan(drain);
    expect(fnBody(SRC, 'resume')).toContain('captureWallClockRef.current?.markDiscontinuity();');
  });

  it('the disclosure ledger reports natural completion through onCompleted → the observer', () => {
    expect(TTS).toContain('onCompleted: (token) =>');
    expect(TTS).toContain(
      'uplinkLossCompletionObserver?.(token.sessionId, token.coveredLossSourceIds)'
    );
  });
});

describe('surfacing — banner beneath RecordingProvider; PDF-success clear; purge', () => {
  it('the banner mounts inside <RecordingProvider> and above the tab content', () => {
    const provider = LAYOUT.indexOf('<RecordingProvider>');
    const banner = LAYOUT.indexOf('<UnresolvedAudioBanner />');
    const children = LAYOUT.indexOf('{children}');
    expect(provider).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(provider);
    expect(children).toBeGreaterThan(banner);
  });

  it('the PDF page clears ONLY after setPdfBlob(blob), passing the active-session set', () => {
    const success = PDF.indexOf('setPdfBlob(blob);');
    const clear = PDF.indexOf('await clearUnresolvedAudioForCertificate(activeSessionIds)');
    expect(success).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(success);
    expect(PDF.slice(success, clear)).toContain(
      'getActiveSessionIds(getActiveRecordingSessionId())'
    );
  });

  it('purgeUnresolvedAudio is the SOLE owner: clearAuth calls it; clearJobCache does NOT touch the store', () => {
    const AUTH = read('../src/lib/auth.ts');
    expect(AUTH).toContain('void purgeUnresolvedAudio();');
    const s = CACHE.indexOf('export async function clearJobCache(');
    const body = CACHE.slice(s, CACHE.indexOf(NL_BRACE, s));
    expect(body).not.toContain('tx.objectStore(STORE_UNRESOLVED_AUDIO).clear();');
  });
});
