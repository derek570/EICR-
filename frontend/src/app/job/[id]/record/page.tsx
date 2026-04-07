'use client';

import { useCallback, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { Camera, Cpu, ListOrdered, AlertTriangle } from 'lucide-react';
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
  const { job, user, updateJob } = useJob();
  const userId = user?.id ?? '';
  const [showCCU, setShowCCU] = useState(false);

  const recording = useRecording(jobId, userId, job);
  const setCurrentQuestion = useRecordingStore((s) => s.setCurrentQuestion);

  // Prefer the live job updated by Sonnet extraction; fall back to context job
  const displayJob = recording.job ?? job;

  const handleStart = useCallback(async () => {
    try {
      await recording.startRecording();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start recording');
    }
  }, [recording]);

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
    <div className="flex flex-col h-[calc(100vh-8rem)] bg-zinc-950 text-white overflow-hidden">
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
        <LiveFillView job={displayJob} isRecording={recording.isRecording} />
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
        onStart={handleStart}
        onStop={recording.stopRecording}
      />
    </div>
  );
}
