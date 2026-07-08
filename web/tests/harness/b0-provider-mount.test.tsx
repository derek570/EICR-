/**
 * B0 provider-mount spike (pwa-replay-harness Wave 2) — the go/no-go
 * gate for the harness architecture: mount the REAL RecordingProvider in
 * jsdom with the B1 injection seams, prove `start()` reaches the
 * recording state with zero real network / mic / audio, and prove one
 * end-to-end utterance flows dispatchFinal → gate → send → extraction →
 * FIFO read-back through REAL pipeline code.
 *
 * This file doubles as the harness's canonical mount recipe (Wave 3's
 * runner builds on it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { JobProvider } from '@/lib/job-context';
import { RecordingProvider, useRecording } from '@/lib/recording-context';
import { __setRecordingTestServices } from '@/lib/recording/test-services';
import { setDiagnosticTap } from '@/lib/recording/client-diagnostic';
import { __resetForTests as resetTtsQueue } from '@/lib/recording/tts-queue';
import { setConfirmationModeEnabled } from '@/lib/recording/tts';
import { buildHarnessServices } from './fake-services';
import type { JobDetail } from '@/lib/types';

// IMPORTANT: React 18+ act() environment flag.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeJob(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job_harness_1',
    job_id: 'job_harness_1',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: '1 Harness Way',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits: [{ id: 'row-1', circuit_ref: '1', designation: 'Lighting' }],
    ...over,
  } as unknown as JobDetail;
}

type RecordingApi = ReturnType<typeof useRecording>;

function Probe({ apiRef }: { apiRef: { current: RecordingApi | null } }) {
  apiRef.current = useRecording();
  return null;
}

describe('B0 — RecordingProvider mounts and records headlessly (jsdom)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetTtsQueue();
    // No real network anywhere: every fetch rejects; all fetch-consuming
    // paths in the provider are fire-and-forget with catch handlers, and
    // the load-bearing fetches (runtime-config, deepgram key, sonnet WS)
    // are behind the B1 seams.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network disabled in harness')));
    setConfirmationModeEnabled(true); // read-backs ON (iOS parity default in the field)
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

  it('mounts, start() reaches the active recording state, fakes are constructed', async () => {
    const { harness, apiRef } = await mountAndStart();
    expect(apiRef.current!.state).toBe('active');
    expect(harness.refs.deepgram).not.toBeNull();
    expect(harness.refs.sonnet).not.toBeNull();
    expect(harness.refs.deepgram!.model).toBe('flux');
  });

  it('drives one utterance end-to-end: gate PASS → chime → sonnet send → extraction → read-back plays', async () => {
    vi.useFakeTimers();
    const { harness } = await mountAndStart();
    const dg = harness.refs.deepgram!;
    const sonnet = harness.refs.sonnet!;

    // Inspector speaks a reading (Flux-shaped event sequence). Finals sit
    // in the 500ms burst buffer before dispatchFinal — flush it.
    await act(async () => {
      dg.emitSpeechStarted();
      dg.emitInterim('zed s on circuit one is');
      dg.emitEndOfTurn('Zs on circuit one is 0.35.');
      vi.advanceTimersByTime(600);
    });

    // Real TranscriptGate passed (reading-shaped), real chime hook fired,
    // transcript reached the (fake) backend.
    expect(harness.chimes.count).toBe(1);
    // NumberNormaliser ran (real pipeline): "circuit one" → "circuit 1".
    expect(sonnet.sentTranscripts.map((t) => t.text)).toEqual(['Zs on circuit 1 is 0.35.']);

    // Backend replies with an applied reading + confirmation.
    await act(async () => {
      sonnet.emitExtraction({
        readings: [{ circuit: 1, field: 'measured_zs_ohm', value: '0.35' }],
        confirmations: [
          { field: 'measured_zs_ohm', circuit: 1, text: 'Zs for circuit 1, 0.35 ohms' },
        ],
      });
    });

    // The job-state observer saw the extraction apply...
    expect(harness.jobChanges.some((c) => c.source === 'extraction')).toBe(true);
    // ...and the read-back played through the REAL FIFO (inspector is not
    // speaking — utterance-end already fired — so no defer).
    expect(harness.tts.played.filter((p) => p.kind === 'confirmation')).toHaveLength(1);
    expect(harness.tts.played[0].text).toContain('0.35');
  });

  it('chitchat is gate-blocked: no chime, no send (real gate + real freshness layer)', async () => {
    vi.useFakeTimers();
    const { harness } = await mountAndStart();
    const dg = harness.refs.deepgram!;
    await act(async () => {
      dg.emitSpeechStarted();
      dg.emitInterim('what do');
      dg.emitEndOfTurn('What do you mean?');
      vi.advanceTimersByTime(600);
    });
    expect(harness.chimes.count).toBe(0);
    expect(harness.refs.sonnet!.sentTranscripts).toHaveLength(0);
    expect(harness.diagnostics.some((d) => d.category === 'transcript_gate_blocked')).toBe(true);
  });

  it('A1 composition in the FULL provider: confirmation deferred mid-utterance resumes on EndOfTurn', async () => {
    const { harness } = await mountAndStart();
    const dg = harness.refs.deepgram!;
    const sonnet = harness.refs.sonnet!;

    // First utterance completes a full turn.
    await act(async () => {
      dg.emitSpeechStarted();
      dg.emitInterim('customer is');
      dg.emitEndOfTurn('Customer is Michael Payden.');
    });
    // Inspector starts the NEXT utterance; extraction for turn 1 lands
    // mid-utterance → the read-back must defer (don't talk over them).
    await act(async () => {
      dg.emitSpeechStarted();
      dg.emitInterim('and the next');
      sonnet.emitExtraction({
        readings: [{ circuit: null, field: 'client_name', value: 'Michael Payden' }],
        confirmations: [
          { field: 'client_name', circuit: null, text: 'customer name Michael Payden' },
        ],
      });
    });
    expect(harness.tts.played).toHaveLength(0); // deferred, not played
    expect(harness.diagnostics.some((d) => d.category === 'tts_queue_deferred')).toBe(true);

    // Utterance ends → the deferred head must resume (the A1 fix under
    // the full provider wiring).
    await act(async () => {
      dg.emitEndOfTurn('And the next circuit is two.');
    });
    expect(harness.tts.played.filter((p) => p.kind === 'confirmation')).toHaveLength(1);
    expect(harness.tts.played[0].text).toContain('Michael Payden');
  });

  it('A2 in the FULL provider: section reading never asks "which circuit" (2s timer)', async () => {
    vi.useFakeTimers();
    try {
      const { harness } = await mountAndStart();
      const dg = harness.refs.deepgram!;
      const sonnet = harness.refs.sonnet!;
      await act(async () => {
        dg.emitSpeechStarted();
        dg.emitInterim('customer is');
        dg.emitEndOfTurn('Customer is Michael Payden.');
      });
      await act(async () => {
        sonnet.emitExtraction({
          readings: [{ circuit: null, field: 'client_name', value: 'Michael Payden' }],
          confirmations: [
            { field: 'client_name', circuit: null, text: 'customer name Michael Payden' },
          ],
        });
      });
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(harness.diagnostics.some((d) => d.category === 'pending_readings_ask')).toBe(false);
      expect(
        harness.diagnostics.some((d) => d.category === 'non_circuit_field_rescued_from_buffer')
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
