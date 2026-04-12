'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { api, type JobDetail } from '@/lib/api';
import { useRecordingStore } from '@/lib/recording-store';
import { useRecording } from '@/hooks/use-recording';
import { LiveFillView } from '@/components/recording/live-fill-view';
import { TranscriptBar } from '@/components/recording/transcript-bar';
import { RecordingControls } from '@/components/recording/recording-controls';
import { AlertCard } from '@/components/recording/alert-card';

// ============================================================================
// RecordPageContent (wrapped in Suspense for useSearchParams)
// ============================================================================

function RecordPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const jobId = searchParams.get('jobId') ?? '';
  const certificateType = searchParams.get('type') === 'EIC' ? 'EIC' : 'EICR';

  // Auth
  const [userId, setUserId] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // Job loading
  const [job, setJob] = useState<JobDetail | null>(null);
  const [jobLoading, setJobLoading] = useState(true);
  const [jobError, setJobError] = useState<string | null>(null);

  // Recording store state
  const isRecording = useRecordingStore((s) => s.isRecording);
  const duration = useRecordingStore((s) => s.duration);
  const transcript = useRecordingStore((s) => s.transcript);
  const interimTranscript = useRecordingStore((s) => s.interimTranscript);
  const deepgramState = useRecordingStore((s) => s.deepgramState);
  const serverConnected = useRecordingStore((s) => s.serverConnected);
  const sleepState = useRecordingStore((s) => s.sleepState);
  const vadState = useRecordingStore((s) => s.vadState);
  const cost = useRecordingStore((s) => s.cost);
  const currentQuestion = useRecordingStore((s) => s.currentQuestion);
  const highlight = useRecordingStore((s) => s.highlight);
  const extractionError = useRecordingStore((s) => s.extractionError);
  const processingCount = useRecordingStore((s) => s.processingCount);

  // Recording hook (pass loaded job as initial data)
  const recording = useRecording(jobId, userId ?? '', job);

  // --------------------------------------------------------------------------
  // Auth check
  // --------------------------------------------------------------------------
  useEffect(() => {
    const token = localStorage.getItem('token');
    const storedUser = localStorage.getItem('user');

    if (!token || !storedUser) {
      router.push('/login');
      return;
    }

    try {
      const userData = JSON.parse(storedUser) as { id: string };
      setUserId(userData.id);
    } catch {
      router.push('/login');
      return;
    }

    setAuthChecked(true);
  }, [router]);

  // --------------------------------------------------------------------------
  // Load job data
  // --------------------------------------------------------------------------
  const loadJob = useCallback(async () => {
    if (!userId || !jobId) return;

    setJobLoading(true);
    setJobError(null);

    try {
      const data = await api.getJob(userId, jobId);
      setJob(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load job';
      setJobError(message);
      toast.error(message);
    } finally {
      setJobLoading(false);
    }
  }, [userId, jobId]);

  useEffect(() => {
    if (authChecked && userId && jobId) {
      loadJob();
    }
  }, [authChecked, userId, jobId, loadJob]);

  // Sync job from recording hook when it updates
  useEffect(() => {
    if (recording.job) {
      setJob(recording.job);
    }
  }, [recording.job]);

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------
  const handleBack = useCallback(() => {
    if (isRecording) {
      const confirmed = window.confirm(
        'Recording is in progress. Are you sure you want to leave? Your session will be stopped.'
      );
      if (!confirmed) return;
      recording.stopRecording();
    }

    if (jobId) {
      router.push(`/job/${jobId}`);
    } else {
      router.push('/dashboard');
    }
  }, [isRecording, jobId, router, recording]);

  const handleStart = useCallback(async () => {
    try {
      await recording.startRecording();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start recording');
    }
  }, [recording]);

  const handleStop = useCallback(() => {
    const confirmed = window.confirm('Stop recording?');
    if (!confirmed) return;

    recording.stopRecording();

    if (jobId) {
      router.push(`/job/${jobId}`);
    }
  }, [recording, jobId, router]);

  const handleDismissQuestion = useCallback(() => {
    useRecordingStore.getState().setCurrentQuestion(null);
  }, []);

  // --------------------------------------------------------------------------
  // Loading state
  // --------------------------------------------------------------------------
  if (!authChecked || (jobLoading && !job)) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-950">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
          <p className="text-sm text-zinc-500">Loading job...</p>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // Error state
  // --------------------------------------------------------------------------
  if (jobError && !job) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-950 p-6">
        <div className="w-full max-w-sm rounded-2xl bg-zinc-900 p-6 text-center">
          <AlertTriangle className="mx-auto mb-4 h-12 w-12 text-amber-500" />
          <h2 className="mb-2 text-xl font-bold text-zinc-100">Failed to Load Job</h2>
          <p className="mb-6 text-sm text-zinc-400">{jobError}</p>
          <div className="flex gap-3">
            <button
              onClick={() => router.push(jobId ? `/job/${jobId}` : '/dashboard')}
              className="flex-1 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Go Back
            </button>
            <button
              onClick={loadJob}
              className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              <RefreshCw className="mr-1.5 inline h-4 w-4" />
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // Main render
  // --------------------------------------------------------------------------
  return (
    <>
      {/* Red pulsing border during recording */}
      {isRecording && (
        <div
          className="pointer-events-none fixed inset-0 z-50 border-2 border-red-500"
          style={{ animation: 'record-pulse 2s ease-in-out infinite' }}
        />
      )}

      <style jsx>{`
        @keyframes record-pulse {
          0%,
          100% {
            border-color: rgba(239, 68, 68, 1);
          }
          50% {
            border-color: rgba(239, 68, 68, 0.3);
          }
        }
      `}</style>

      <div className="flex min-h-dvh flex-col bg-zinc-950">
        {/* ================================================================ */}
        {/* Top Bar                                                          */}
        {/* ================================================================ */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/95 px-4">
          {/* Left: back button */}
          <button
            onClick={handleBack}
            className="flex items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Back</span>
          </button>

          {/* Center: certificate type badge */}
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              certificateType === 'EIC'
                ? 'bg-emerald-600/80 text-white'
                : 'bg-blue-600/80 text-white'
            }`}
          >
            {certificateType}
          </span>

          {/* Right: REC indicator or spacer */}
          {isRecording ? (
            <div className="flex items-center gap-2 rounded-full bg-red-600/90 px-3 py-1">
              <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
              <span className="font-mono text-xs font-bold text-white">REC</span>
            </div>
          ) : (
            <div className="w-16" />
          )}
        </header>

        {/* ================================================================ */}
        {/* Main scrollable area: LiveFillView                               */}
        {/* ================================================================ */}
        <main className="flex-1 overflow-y-auto">
          <LiveFillView job={job} isRecording={isRecording} />
        </main>

        {/* ================================================================ */}
        {/* Alert Card (above transcript bar)                                */}
        {/* ================================================================ */}
        {currentQuestion && (
          <AlertCard
            question={{
              field: currentQuestion.fieldKey,
              circuit: currentQuestion.circuitNumber,
              question: currentQuestion.question,
              type: currentQuestion.type,
              value: currentQuestion.value,
            }}
            onDismiss={handleDismissQuestion}
          />
        )}

        {/* ================================================================ */}
        {/* Transcript Bar                                                   */}
        {/* ================================================================ */}
        <TranscriptBar
          transcript={transcript}
          interimTranscript={interimTranscript}
          highlight={highlight}
          isRecording={isRecording}
          sleepState={sleepState}
        />

        {/* ================================================================ */}
        {/* Recording Controls                                               */}
        {/* ================================================================ */}
        <RecordingControls
          isRecording={isRecording}
          duration={duration}
          deepgramState={deepgramState}
          serverConnected={serverConnected}
          sleepState={sleepState}
          vadState={vadState}
          cost={cost}
          extractionError={extractionError}
          processingCount={processingCount}
          onStart={handleStart}
          onStop={handleStop}
        />
      </div>
    </>
  );
}

// ============================================================================
// Default export with Suspense boundary
// ============================================================================

export default function RecordPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center bg-zinc-950">
          <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
        </div>
      }
    >
      <RecordPageContent />
    </Suspense>
  );
}
