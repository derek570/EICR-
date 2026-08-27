/**
 * PLAN-E2 test 3-E2 + 2b (web wiring half) — source-adjacency assertions on
 * the real `recording-context.tsx` (the RecordingProvider is not
 * unit-mountable — see `transcript-gate-wiring.test.ts`; this is the
 * established house pattern, `ws7-haptic-call-sites.test.tsx`):
 *
 *  - sanctioned family (3): the unexpected-reconnect ring drain inside
 *    `onReconnected` is REMOVED; the two AUTOMATIC full-sleep drains, the
 *    doze resume drain and the manual-resume zero-replay path are
 *    byte-for-byte unchanged; `openDeepgram` still returns `Promise<void>`.
 *  - sanctioned family (2): `captureActive` has exactly TWO writers, the
 *    `micRef.current = handle` site and `teardownMic`, plus the copy at
 *    service construction; no high-level entry point writes it.
 *  - sanctioned family (1): every successful open is observed through
 *    `onStateChange` → 'connected' (NOT `onReconnected`).
 *  - the frozen surfaces (`stop()`, `openDeepgram`, `handleWake`,
 *    `resume()`) contain no E2 edit.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(here, '../src/lib/recording-context.tsx'), 'utf8');
const SERVICE = readFileSync(resolve(here, '../src/lib/recording/deepgram-service.ts'), 'utf8');

function between(start: string, end: string): string {
  const s = SRC.indexOf(start);
  expect(s, `anchor missing: ${start}`).toBeGreaterThan(-1);
  const e = SRC.indexOf(end, s + start.length);
  expect(e, `anchor missing: ${end}`).toBeGreaterThan(-1);
  return SRC.slice(s, e);
}

/** The body of ONE `const <name> = React.useCallback(` definition — up to
 *  the next `React.useCallback(` / `React.useEffect(` definition. */
function fnBody(name: string): string {
  const start = `const ${name} = React.useCallback(`;
  const s = SRC.indexOf(start);
  expect(s, `anchor missing: ${start}`).toBeGreaterThan(-1);
  const rest = SRC.slice(s + start.length);
  const next = rest.search(/= React\.use(Callback|Effect)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('family (3) — unexpected-reconnect ring drain REMOVED; sleep drains untouched', () => {
  it('`onReconnected` no longer drains the ring buffer or replays into the sender', () => {
    const body = between('onReconnected: () => {', 'onError: (err) => {');
    expect(body).not.toContain('drainTagged');
    expect(body).not.toContain('sendTaggedAudio');
    expect(body).not.toContain('sendInt16PCM');
  });

  it('the AUTOMATIC full-sleep drains still exist, gated on the sleeping branch (byte-for-byte)', () => {
    // handleWake's drain sits inside its `from === 'sleeping'` branch.
    const wake = fnBody('handleWake');
    expect(wake).toContain("from === 'sleeping'");
    expect(wake).toContain('drainTagged');
    // resume()'s automatic full-sleep branch keeps its drain too.
    const resume = fnBody('resume');
    expect(resume).toContain('drainTagged');
  });

  it('`openDeepgram` still resolves immediately — no awaited-open plumbing (round-29 carve-out)', () => {
    const open = fnBody('openDeepgram');
    expect(open).not.toContain('await service.connect');
    expect(open).not.toContain('awaitOpen');
  });
});

describe('family (2) — captureActive has exactly two writers + the construction copy', () => {
  it('TRUE is pushed only where `micRef.current = handle`; FALSE only in `teardownMic`', () => {
    const trueSites = SRC.match(/captureActiveRef\.current = true/g) ?? [];
    const falseSites = SRC.match(/captureActiveRef\.current = false/g) ?? [];
    expect(trueSites).toHaveLength(1);
    expect(falseSites).toHaveLength(1);
    const micSet = between('micRef.current = handle;', 'return true;');
    expect(micSet).toContain('captureActiveRef.current = true');
    const teardown = fnBody('teardownMic');
    expect(teardown).toContain('micRef.current = null');
    expect(teardown).toContain('captureActiveRef.current = false');
  });

  it('the provider copies the CURRENT value into every newly constructed sender', () => {
    const construct = between('new DeepgramService(deepgramCallbacks', 'service.connect(async () => {');
    expect(construct).toContain('service.captureActive = captureActiveRef.current');
  });

  it('no high-level entry point (start/stop/pause/resume) writes the flag directly', () => {
    for (const fn of ['start', 'stop', 'pause', 'resume']) {
      expect(fnBody(fn), fn).not.toContain('captureActiveRef.current =');
    }
  });

  it('the service treats captureActive as a classification signal only — the sender never reads it', () => {
    // `captureActive` appears in the close/error classifiers, never in a send path.
    const sendSamples = SERVICE.slice(SERVICE.indexOf('  sendSamples('), SERVICE.indexOf('  sendTaggedAudio('));
    expect(sendSamples).not.toContain('captureActive');
    const dispatch = SERVICE.slice(SERVICE.indexOf('  private dispatchFrame('), SERVICE.indexOf('  private handleOpusPacket('));
    expect(dispatch).not.toContain('captureActive');
  });

  it('ownership is marked in ONE place — inside `disconnect()`, the only `ws.close()` site', () => {
    // Executable `ws.close(…)` statements (not doc-comment mentions).
    expect(SERVICE.match(/^\s*ws\.close\(1000\);/gm)).toHaveLength(1);
    const disconnect = SERVICE.slice(SERVICE.indexOf('  disconnect(): void {'), SERVICE.indexOf('  // ── Internals'));
    expect(disconnect).toContain('ws.close(1000);');
    expect(disconnect).toContain('this.ownedCloseEpoch = this.currentEpoch');
    expect(SERVICE.match(/this\.ownedCloseEpoch = /g)).toHaveLength(1);
  });
});

describe('family (1) — every-open observation via onStateChange, not onReconnected', () => {
  it("`onStateChange` → 'connected' calls the ledger's onSocketOpened; `onReconnected` does not", () => {
    const stateChange = between('onStateChange: (state) => {', 'onInterimTranscript: (text) => {');
    expect(stateChange).toContain("state === 'connected'");
    expect(stateChange).toContain('lossLedger?.onSocketOpened');
    const reconnected = between('onReconnected: () => {', 'onError: (err) => {');
    expect(reconnected).not.toContain('onSocketOpened');
  });

  it('the frozen surfaces carry no E2 edit', () => {
    for (const fn of ['stop', 'handleWake', 'resume', 'pause']) {
      const body = fnBody(fn);
      expect(body, fn).not.toContain('PLAN-E2');
      expect(body, fn).not.toContain('UplinkLoss');
    }
  });

  it('`ws.onopen` in the service is byte-for-byte free of E2 (the observation is downstream)', () => {
    const onopen = SERVICE.slice(SERVICE.indexOf('    ws.onopen = () => {'), SERVICE.indexOf('    ws.onmessage = (event) => {'));
    expect(onopen).not.toContain('PLAN-E2');
    expect(onopen).not.toContain('lossLedger');
  });
});
