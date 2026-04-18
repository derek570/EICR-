/**
 * Zustand store for recording session state that must survive tab navigation.
 *
 * Local useState in useRecording resets to '' when the record page unmounts
 * (user navigates to another tab and back). This store persists the transcript
 * across navigation so the transcript bar shows accumulated content on re-open.
 *
 * Transcript is cleared explicitly on startRecording so new sessions start fresh.
 */

import { create } from 'zustand';

interface RecordingSessionState {
  transcript: string;
  setTranscript: (t: string) => void;
  clearTranscript: () => void;
}

export const useRecordingSessionStore = create<RecordingSessionState>((set) => ({
  transcript: '',
  setTranscript: (transcript) => set({ transcript }),
  clearTranscript: () => set({ transcript: '' }),
}));
