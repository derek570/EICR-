'use client';

import { useParams } from 'next/navigation';
import { useJob } from '../layout';
import { useRecording } from '@/hooks/use-recording';
import { useRecordingStore } from '@/lib/recording-store';
import { TranscriptBar } from '@/components/recording/transcript-bar';
import { LiveFillView } from '@/components/recording/live-fill-view';
import { RecordingControls } from '@/components/recording/recording-controls';
import { AlertCard } from '@/components/recording/alert-card';

export default function RecordPage() {
  const params = useParams();
  const jobId = params.id as string;
  const { job, user } = useJob();
  const userId = user?.id ?? '';

  const recording = useRecording(jobId, userId, job);
  const setCurrentQuestion = useRecordingStore((s) => s.setCurrentQuestion);

  // Prefer the live job updated by Sonnet extraction; fall back to context job
  const displayJob = recording.job ?? job;

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
        onStart={recording.startRecording}
        onStop={recording.stopRecording}
      />
    </div>
  );
}
