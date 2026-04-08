'use client';

import { cn } from '@/lib/utils';
import type { RecordingState, RecordingActions } from '@/hooks/use-recording';
import { RecordingControls } from './recording-controls';
import { TranscriptDisplay } from './transcript-display';
import { AlertCard } from './alert-card';
import { DebugDashboard } from './debug-dashboard';

interface RecordingStripProps {
  state: RecordingState;
  actions: RecordingActions;
}

/**
 * Full recording panel that sits above the job editor tabs.
 * Shows: controls, transcript, alerts, debug dashboard.
 */
export function RecordingStrip({ state, actions }: RecordingStripProps) {
  return (
    <div
      className={cn(
        'space-y-3 rounded-lg border p-4 transition-colors',
        state.isRecording ? 'border-red-200 bg-red-50/30' : 'border-gray-200 bg-gray-50'
      )}
    >
      {/* Controls row */}
      <RecordingControls
        isRecording={state.isRecording}
        connectionState={state.connectionState}
        isSpeaking={state.isSpeaking}
        sleepState={state.sleepState}
        sessionDuration={state.sessionDuration}
        error={state.error}
        onStart={actions.startRecording}
        onStop={actions.stopRecording}
      />

      {/* Transcript (always visible when recording or when there's a transcript) */}
      {(state.isRecording || state.transcript) && (
        <TranscriptDisplay
          transcript={state.transcript}
          interimTranscript={state.interimTranscript}
          isRecording={state.isRecording}
          fieldSources={state.fieldSources}
          highlights={state.highlights}
        />
      )}

      {/* Alert card */}
      {state.currentAlert && (
        <AlertCard
          alert={state.currentAlert}
          queueCount={state.alertQueueCount}
          onAccept={() => actions.handleAlertResponse(true)}
          onReject={() => actions.handleAlertResponse(false)}
          onDismiss={actions.dismissAlert}
        />
      )}

      {/* Debug dashboard (collapsible) */}
      <DebugDashboard state={state} />
    </div>
  );
}
