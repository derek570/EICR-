'use client';

import { useCallback, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { Camera, Cpu, ListOrdered, AlertTriangle, CameraOff } from 'lucide-react';
import { useJob } from '../layout';
import { useRecording } from '@/hooks/use-recording';
import { useRecordingStore } from '@/lib/recording-store';
import { TranscriptBar } from '@/components/recording/transcript-bar';
import { LiveFillView } from '@/components/recording/live-fill-view';
import { RecordingControls } from '@/components/recording/recording-controls';
import { AlertCard } from '@/components/recording/alert-card';
import { CCUUpload } from '@/components/recording/ccu-upload';
import type { Circuit, BoardInfo } from '@/lib/api';

export default function RecordPage() {
  const params = useParams();
  const jobId = params.id as string;
  const { job, user, updateJob, certificateType } = useJob();
  const userId = user?.id ?? '';
  const [showCCU, setShowCCU] = useState(false);

  const recording = useRecording(jobId, userId, job);
  const setCurrentQuestion = useRecordingStore((s) => s.setCurrentQuestion);
  const [showNoBoardPhotoWarning, setShowNoBoardPhotoWarning] = useState(false);

  // Prefer the live job updated by Sonnet extraction; fall back to context job
  const displayJob = recording.job ?? job;

  const doStartRecording = useCallback(async () => {
    try {
      await recording.startRecording();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start recording');
    }
  }, [recording]);

  // Stops recording and syncs the live extraction data back into the job store so
  // the Overview tab shows the latest extracted fields without requiring a page reload.
  const handleStop = useCallback(() => {
    recording.stopRecording();
    const liveJob = recording.job;
    if (liveJob) {
      updateJob({
        circuits: liveJob.circuits,
        observations: liveJob.observations,
        board_info: liveJob.board_info,
        installation_details: liveJob.installation_details ?? undefined,
        supply_characteristics: liveJob.supply_characteristics ?? undefined,
        inspection_schedule: liveJob.inspection_schedule ?? undefined,
      });
    }
  }, [recording, updateJob]);

  const handleStart = useCallback(async () => {
    // Mirror iOS: warn if no circuits exist (no board photo taken yet)
    const hasCircuits = (job?.circuits ?? []).length > 0;
    if (!hasCircuits) {
      setShowNoBoardPhotoWarning(true);
      return;
    }
    await doStartRecording();
  }, [job, doStartRecording]);

  const handleCCUAnalysis = useCallback(
    (analysis: Record<string, unknown>) => {
      const updates: Partial<typeof job> = {};
      if (Array.isArray(analysis.circuits) && analysis.circuits.length > 0) {
        updates.circuits = analysis.circuits as Circuit[];
      }
      if (analysis.board_info && typeof analysis.board_info === 'object') {
        updates.board_info = { ...job.board_info, ...(analysis.board_info as BoardInfo) };
      }
      if (analysis.supply_characteristics && typeof analysis.supply_characteristics === 'object') {
        updates.supply_characteristics = {
          ...(job.supply_characteristics ?? {
            earthing_arrangement: '',
            live_conductors: '',
            number_of_supplies: '',
            nominal_voltage_u: '',
            nominal_voltage_uo: '',
            nominal_frequency: '',
          }),
          ...(analysis.supply_characteristics as Record<string, string>),
        };
      }
      updateJob(updates);
      setShowCCU(false);
      toast.success('CCU analysis applied');
    },
    [job, updateJob]
  );

  // Convert UserQuestion to AlertCard's expected shape
  const question = recording.currentQuestion
    ? {
        field: recording.currentQuestion.fieldKey,
        circuit: recording.currentQuestion.circuitNumber,
        question: recording.currentQuestion.question,
        type: recording.currentQuestion.type,
        value: recording.currentQuestion.value,
      }
    : null;

  return (
    // Pulsing border mirrors iOS RecordingOverlay border animation:
    // green when recording, no border when idle
    <div
      className={`flex flex-col h-[calc(100vh-8rem)] bg-zinc-950 text-white overflow-hidden relative transition-all duration-300 ${
        recording.isRecording ? 'ring-2 ring-inset ring-green-500/60' : ''
      }`}
    >
      {/* No Board Photo warning dialog (mirrors iOS alert) */}
      {showNoBoardPhotoWarning && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-2xl bg-zinc-900 border border-zinc-700 shadow-2xl p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-amber-500/20">
                <CameraOff className="h-5 w-5 text-amber-400" />
              </div>
              <h2 className="text-base font-semibold text-white">No Board Photo</h2>
            </div>
            <p className="text-sm text-zinc-400 mb-5">
              No circuits found. Take a board photo first for best results, or tap Record Anyway to
              continue without one.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowNoBoardPhotoWarning(false)}
                className="flex-1 py-2.5 rounded-xl bg-zinc-800 text-zinc-300 text-sm font-medium hover:bg-zinc-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowNoBoardPhotoWarning(false);
                  doStartRecording();
                }}
                className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-700 transition-colors"
              >
                Record Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Alert card overlay */}
      {question && <AlertCard question={question} onDismiss={() => setCurrentQuestion(null)} />}

      {/* Quick action toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/80 border-b border-zinc-800">
        <button
          onClick={() => setShowCCU(!showCCU)}
          className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            showCCU
              ? 'bg-blue-600 text-white'
              : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
          }`}
        >
          <Camera className="h-3.5 w-3.5" />
          CCU Photo
        </button>
        <Link
          href={`/job/${jobId}/board`}
          className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
        >
          <Cpu className="h-3.5 w-3.5" />
          Board
        </Link>
        <Link
          href={`/job/${jobId}/circuits`}
          className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
        >
          <ListOrdered className="h-3.5 w-3.5" />
          Circuits
        </Link>
        <Link
          href={`/job/${jobId}/observations`}
          className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          Observations
        </Link>
      </div>

      {/* CCU Upload overlay */}
      {showCCU && (
        <div className="p-3 bg-zinc-900 border-b border-zinc-800">
          <CCUUpload onAnalysisComplete={handleCCUAnalysis} />
        </div>
      )}

      {/* Transcript bar */}
      <TranscriptBar
        transcript={recording.transcript}
        interimTranscript={recording.interimTranscript}
        highlight={recording.highlight}
        isRecording={recording.isRecording}
        sleepState={recording.sleepState}
      />

      {/* Scrollable live data fill view */}
      <div className="flex-1 overflow-hidden">
        <LiveFillView
          job={displayJob}
          isRecording={recording.isRecording}
          certificateType={certificateType}
        />
      </div>

      {/* Recording controls bar */}
      <RecordingControls
        isRecording={recording.isRecording}
        duration={recording.duration}
        deepgramState={recording.deepgramState}
        serverConnected={recording.serverConnected}
        sleepState={recording.sleepState}
        vadState={recording.vadState}
        cost={recording.cost}
        extractionError={recording.extractionError}
        processingCount={recording.processingCount}
        onStart={handleStart}
        onStop={handleStop}
      />
    </div>
  );
}
