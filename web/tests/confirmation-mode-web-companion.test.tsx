/**
 * PLAN-D (feedback-2026-08-11 wave) — D2 web companion (ids 122, 124).
 *
 * Covers the four web tests the plan names, beyond the
 * confirmation-mode-persistence default-flip tests already in
 * phase-8-tts.test.ts (absent → true; explicit false preserved):
 *
 *   1. recording-chrome.tsx speaks the unified cue on BOTH toggle
 *      directions (not just ON, which is all it did before this plan).
 *   2. recording-context.tsx speaks the one-shot start warning when a
 *      fresh session starts with confirmations already off, and stays
 *      silent when they're on.
 *   3. The start warning is wired to the PHYSICAL start() path only —
 *      not handleWake() (sleep/doze auto-resume) or resume() (manual
 *      pause-resume) — so it never re-fires on a wake-from-sleep cycle
 *      within the same session.
 *
 * Test (1) and (3) use a source-adjacency assertion (the established
 * house pattern for RecordingProvider-adjacent wiring that isn't cheaply
 * unit-mountable in isolation — see ws7-haptic-call-sites.test.tsx's own
 * comment: "the RecordingProvider is not unit-mountable... so this is a
 * source-adjacency assertion on the real recording-context.tsx"). Test
 * (2) mounts the REAL RecordingProvider via the B0 harness recipe
 * (b0-provider-mount.test.tsx) and drives a real start() — recording-
 * context.tsx has no test hook for forcing a sleep→wake cycle without
 * synthesising real audio levels through SleepManager (which no existing
 * harness models — fake-services.ts's fakeMicCaptureFactory never feeds
 * audio samples at all), so the "does not re-fire on wake" half of
 * requirement (3) is proven structurally instead: the warning call
 * appears in the source exactly once, physically inside start()'s body,
 * and is textually absent from handleWake()'s and resume()'s bodies.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { vi } from 'vitest';
import { JobProvider } from '@/lib/job-context';
import { RecordingProvider, useRecording } from '@/lib/recording-context';
import { __setRecordingTestServices } from '@/lib/recording/test-services';
import { setDiagnosticTap } from '@/lib/recording/client-diagnostic';
import { __resetForTests as resetTtsQueue } from '@/lib/recording/tts-queue';
import { setConfirmationModeEnabled } from '@/lib/recording/tts';
import { buildHarnessServices } from './harness/fake-services';
import type { JobDetail } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeJob(): JobDetail {
  return {
    id: 'job_harness_d2',
    job_id: 'job_harness_d2',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: '1 Harness Way',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits: [],
  } as unknown as JobDetail;
}

type RecordingApi = ReturnType<typeof useRecording>;

function Probe({ apiRef }: { apiRef: { current: RecordingApi | null } }) {
  apiRef.current = useRecording();
  return null;
}

const HERE = dirname(fileURLToPath(import.meta.url));

// ── (1) + (3) — source-adjacency wiring proofs ───────────────────────────

describe('recording-chrome.tsx — toggle-flip cue wiring (structural, PLAN-D id 122/124)', () => {
  const src = readFileSync(resolve(HERE, '../src/components/recording/recording-chrome.tsx'), 'utf8');

  it('imports the unified cue constants from tts.ts', () => {
    expect(src).toMatch(/CONFIRMATION_MODE_OFF_CUE/);
    expect(src).toMatch(/CONFIRMATION_MODE_ON_CUE/);
  });

  it('speaks the correct cue on BOTH directions via one force:true call, no dedupeKey', () => {
    // Both directions route through the SAME speakConfirmation call with a
    // ternary — proves there's no longer a one-directional (ON-only) gate,
    // and that no dedupeKey is passed (dedupe bypass, per the plan).
    expect(src).toMatch(
      /speakConfirmation\(next \? CONFIRMATION_MODE_ON_CUE : CONFIRMATION_MODE_OFF_CUE,\s*\{\s*\n\s*force: true,\s*\n\s*\}\)/
    );
  });

  it('logs a diagnostic on every flip', () => {
    expect(src).toMatch(/clientDiagnostic\('confirmation_mode_flipped', \{ enabled: next \}\)/);
  });

  it('no longer contains the retired ON-only "Confirmations on." string', () => {
    expect(src).not.toContain('Confirmations on.');
  });
});

describe('recording-context.tsx — session-start warning wiring (structural, PLAN-D id 122/124)', () => {
  const src = readFileSync(resolve(HERE, '../src/lib/recording-context.tsx'), 'utf8');

  it('imports CONFIRMATION_MODE_START_WARNING from tts.ts', () => {
    expect(src).toMatch(/CONFIRMATION_MODE_START_WARNING/);
  });

  it('the warning call appears in the source EXACTLY ONCE (import + one call site = 2 occurrences of the identifier)', () => {
    const occurrences = src.match(/CONFIRMATION_MODE_START_WARNING/g) ?? [];
    // One in the import list, one in the actual speakConfirmation(...) call.
    expect(occurrences).toHaveLength(2);
  });

  it('is wired adjacent to buildSleepManager()/setState(\'active\') — the PHYSICAL start() path', () => {
    expect(src).toMatch(
      /buildSleepManager\(\);\s*\n\s*setState\('active'\);\s*\n[\s\S]*?if \(!getConfirmationModeEnabled\(\)\) \{\s*\n\s*speakConfirmation\(CONFIRMATION_MODE_START_WARNING, \{ force: true \}\);\s*\n\s*\}\s*\n\s*beginTick\(\);/
    );
  });

  it('is textually ABSENT from the file before the start() function begins (i.e. not near handleWake\'s earlier setState(\'active\'))', () => {
    // handleWake's own setState('active')/beginTick() pair appears earlier
    // in the file (before start()'s "buildSleepManager()" anchor). Confirm
    // the ONE occurrence of the warning call comes after that earlier pair,
    // not interleaved with it.
    const earlierActiveIdx = src.indexOf("setState('active');\n        beginTick();");
    const warningCallIdx = src.indexOf('speakConfirmation(CONFIRMATION_MODE_START_WARNING');
    expect(earlierActiveIdx).toBeGreaterThan(-1);
    expect(warningCallIdx).toBeGreaterThan(-1);
    expect(warningCallIdx).toBeGreaterThan(earlierActiveIdx);
  });

  it('never appears near resume()\'s setState(\'active\') either (the last setState(\'active\') in the file)', () => {
    const lastActiveIdx = src.lastIndexOf("setState('active');\n      beginTick();");
    const warningCallIdx = src.indexOf('speakConfirmation(CONFIRMATION_MODE_START_WARNING');
    // The warning's OWN setState('active') pair is not the last one in the
    // file (resume()'s is, since resume() is declared after start()) — so
    // the warning call must sit BEFORE the last occurrence, proving it is
    // not resume()'s block.
    expect(warningCallIdx).toBeLessThan(lastActiveIdx);
  });
});

// ── (2) — behavioural: the warning actually plays (or doesn't) on a real start() ──

describe('recording-context.tsx — session-start warning behaviour (B0 harness)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetTtsQueue();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network disabled in harness')));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    __setRecordingTestServices(null);
    setDiagnosticTap(null);
    resetTtsQueue();
    vi.unstubAllGlobals();
  });

  async function mountAndStart() {
    const harness = buildHarnessServices();
    __setRecordingTestServices(harness.services);
    setDiagnosticTap(harness.services.diagnosticTap!);
    const apiRef: { current: RecordingApi | null } = { current: null };
    await act(async () => {
      root.render(
        <JobProvider initial={makeJob()}>
          <RecordingProvider>
            <Probe apiRef={apiRef} />
          </RecordingProvider>
        </JobProvider>
      );
    });
    expect(apiRef.current).not.toBeNull();
    await act(async () => {
      await apiRef.current!.start();
    });
    return { harness, apiRef };
  }

  it('speaks the one-shot warning once when the session starts with confirmations OFF', async () => {
    setConfirmationModeEnabled(false);
    const { harness, apiRef } = await mountAndStart();
    expect(apiRef.current!.state).toBe('active');
    const warnings = harness.tts.played.filter(
      (p) => p.text === 'Heads up — voice read-backs are off.'
    );
    expect(warnings).toHaveLength(1);
  });

  it('stays silent (no warning) when the session starts with confirmations ON', async () => {
    setConfirmationModeEnabled(true);
    const { harness, apiRef } = await mountAndStart();
    expect(apiRef.current!.state).toBe('active');
    const warnings = harness.tts.played.filter(
      (p) => p.text === 'Heads up — voice read-backs are off.'
    );
    expect(warnings).toHaveLength(0);
  });
});
