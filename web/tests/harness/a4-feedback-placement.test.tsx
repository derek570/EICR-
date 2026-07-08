/**
 * A4 — feedback capture PLACEMENT + upload + ack under the FULL provider
 * (pwa-replay-harness Wave 6).
 *
 * Placement rule (plan §4 A4, load-bearing): the feedback branch runs in
 * dispatchFinal AFTER the local voice-command short-circuit and BEFORE the
 * cumulative-transcript append, regex, TranscriptGate, chime and
 * sonnet_send. Trigger/capture/exit finals return immediately and must not
 * poison the next utterance's regex window.
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

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function makeJob(): JobDetail {
  return {
    id: 'job_feedback_1',
    job_id: 'job_feedback_1',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: '1 Harness Way',
    address: '1 Harness Way',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits: [{ id: 'row-1', circuit_ref: '1', designation: 'Lighting' }],
  } as unknown as JobDetail;
}

type RecordingApi = ReturnType<typeof useRecording>;
function Probe({ apiRef }: { apiRef: { current: RecordingApi | null } }) {
  apiRef.current = useRecording();
  return null;
}

describe('A4 — feedback capture in the full provider', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetTtsQueue();
    // Default: reject everything; individual tests override /api/debug-report.
    fetchMock = vi.fn().mockRejectedValue(new TypeError('network disabled in harness'));
    vi.stubGlobal('fetch', fetchMock);
    setConfirmationModeEnabled(true);
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
    await act(async () => {
      await apiRef.current!.start();
    });
    return { harness, apiRef };
  }

  function allowDebugReport() {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/debug-report')) {
        return Promise.resolve(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      return Promise.reject(new TypeError('network disabled in harness'));
    });
  }

  async function speakFinal(
    harness: ReturnType<typeof buildHarnessServices>,
    text: string
  ): Promise<void> {
    await act(async () => {
      harness.refs.deepgram!.emitSpeechStarted();
      harness.refs.deepgram!.emitInterim(text.split(' ').slice(0, 2).join(' '));
      harness.refs.deepgram!.emitEndOfTurn(text);
      vi.advanceTimersByTime(700); // burst-buffer flush
    });
  }

  it('trigger/capture/exit finals never reach regex, chime, or Sonnet; upload + ack fire once on exit', async () => {
    vi.useFakeTimers();
    try {
      allowDebugReport();
      const { harness } = await mountAndStart();
      const sonnet = harness.refs.sonnet!;

      // Pre-trigger context (normal utterance feeds the rolling window;
      // gate-blocked chitchat is fine for that purpose).
      await speakFinal(harness, 'Right then.');

      await speakFinal(harness, 'Feedback.');
      await speakFinal(harness, 'The chime is far too loud in AirPods.');
      await speakFinal(harness, 'End feedback.');
      // Let the upload promise settle (small advance — NOT
      // runOnlyPendingTimersAsync, which would fire the 60s auto-sleep
      // timer and rebuild the fake session mid-test).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Placement: none of the three feedback finals reached Sonnet or chimed.
      expect(sonnet.sentTranscripts.map((t) => t.text)).toEqual([]);
      expect(harness.chimes.count).toBe(0);
      const cats = harness.diagnostics.map((d) => d.category);
      expect(cats).toContain('feedback_capture_started');
      expect(cats).toContain('feedback_capture_continuing');
      expect(cats).toContain('feedback_issue_captured');
      expect(cats.filter((c) => c === 'feedback_marker_uploaded')).toHaveLength(1);
      // No phantom regex applies from the feedback finals.
      const regexApplied = harness.diagnostics.filter(
        (d) => d.category === 'pipeline_regex_applied' && Number(d.payload.changedKeysCount) > 0
      );
      expect(regexApplied).toEqual([]);

      // POST body shape (iOS uploadDebugReport contract).
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/debug-report'))!;
      expect(call).toBeTruthy();
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.issueText).toBe('. The chime is far too loud in AirPods.'); // iOS-verbatim leading dot
      expect(body.sessionId).toMatch(/^sess_/);
      expect(body.jobId).toBe('job_feedback_1');
      // Pre-trigger rolling window attached (the normal utterance).
      expect(Array.isArray(body.lastTranscriptWindow)).toBe(true);
      expect(body.lastTranscriptWindow[0].text).toBe('Right then.');

      // TTS ack — iOS parity "Feedback logged" through the gated FIFO.
      expect(
        harness.tts.played.some((p) => p.kind === 'confirmation' && p.text === 'Feedback logged')
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('feedback monologue does not poison the next utterance regex window', async () => {
    vi.useFakeTimers();
    try {
      allowDebugReport();
      const { harness } = await mountAndStart();
      const sonnet = harness.refs.sonnet!;
      // Feedback capture mentioning a client name — must NOT enter the
      // cumulative regex buffer.
      await speakFinal(harness, 'Feedback. Customer is Michael Payden. End feedback.');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      // Next utterance: pure chitchat. If the feedback text had fed the
      // cumulative window, the client-name pattern would re-match and
      // phantom-pass the gate (the A3 class).
      await speakFinal(harness, 'What do you mean?');
      expect(sonnet.sentTranscripts.map((t) => t.text)).toEqual([]);
      expect(
        harness.diagnostics.some(
          (d) => d.category === 'pipeline_regex_applied' && Number(d.payload.changedKeysCount) > 0
        )
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('session stop auto-closes an open capture and uploads it (performStopCleanup parity)', async () => {
    vi.useFakeTimers();
    try {
      allowDebugReport();
      const { harness, apiRef } = await mountAndStart();
      await speakFinal(harness, 'Feedback. The gate ate my reading');
      await act(async () => {
        apiRef.current!.stop();
        await vi.advanceTimersByTimeAsync(100);
      });
      const cats = harness.diagnostics.map((d) => d.category);
      expect(cats).toContain('feedback_issue_auto_closed');
      expect(cats.filter((c) => c === 'feedback_marker_uploaded')).toHaveLength(1);
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/debug-report'))!;
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.issueText).toBe('. The gate ate my reading'); // iOS-verbatim leading dot
    } finally {
      vi.useRealTimers();
    }
  });

  it('upload failure is non-fatal: no ack, failure diagnostic, recording continues', async () => {
    vi.useFakeTimers();
    try {
      // fetch stays reject-all — the upload fails.
      const { harness } = await mountAndStart();
      await speakFinal(harness, 'Feedback. Something broke. End feedback.');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const cats = harness.diagnostics.map((d) => d.category);
      expect(cats).toContain('feedback_upload_failed');
      expect(cats).not.toContain('feedback_marker_uploaded');
      expect(harness.tts.played.some((p) => p.text === 'Feedback logged')).toBe(false);
      // Pipeline still alive: a reading flows normally afterwards.
      await speakFinal(harness, 'Circuit 1 Zs is 0.35.');
      expect(harness.refs.sonnet!.sentTranscripts.map((t) => t.text)).toEqual([
        'Circuit 1 Zs is 0.35.',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
