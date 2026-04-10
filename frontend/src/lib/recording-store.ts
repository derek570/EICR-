// recording-store.ts
// Zustand store for recording session state — separate from the job store.

import { create } from 'zustand';
import type { DeepgramConnectionState } from './recording/deepgram-service';
import type { JobDetail } from './api';

// ---------------------------------------------------------------------------
// Types (inline — will consolidate with server-ws-service.ts later)
// ---------------------------------------------------------------------------

export interface ServerCostUpdate {
  deepgramCost: number;
  sonnetCost: number;
  totalSessionCost: number;
  totalJobCost: number;
  deepgramMinutes: number;
  sonnetCalls: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UserQuestion {
  id: string;
  type: 'orphaned' | 'out_of_range' | 'unclear';
  fieldKey: string;
  circuitNumber?: number;
  question: string;
  value?: string;
}

export type SleepState = 'active' | 'dozing' | 'sleeping';
export type VadState = 'idle' | 'listening' | 'speaking' | 'trailing';

export interface TranscriptHighlight {
  keyword: string;
  value: string;
  fieldKey: string;
  keywordCandidates: string[];
}

// ---------------------------------------------------------------------------
// Store State + Actions
// ---------------------------------------------------------------------------

interface RecordingState {
  // State
  isRecording: boolean;
  duration: number;
  transcript: string;
  interimTranscript: string;
  deepgramState: DeepgramConnectionState;
  serverConnected: boolean;
  sleepState: SleepState;
  vadState: VadState;
  cost: ServerCostUpdate | null;
  currentQuestion: UserQuestion | null;
  isTTSSpeaking: boolean;
  highlight: TranscriptHighlight | null;
  liveJob: JobDetail | null;
  extractionError: string | null;

  // Actions
  setRecording: (isRecording: boolean) => void;
  setDuration: (duration: number) => void;
  setInterimTranscript: (text: string) => void;
  setDeepgramState: (state: DeepgramConnectionState) => void;
  setServerConnected: (connected: boolean) => void;
  setSleepState: (state: SleepState) => void;
  setVadState: (state: VadState) => void;
  setCost: (cost: ServerCostUpdate | null) => void;
  setCurrentQuestion: (question: UserQuestion | null) => void;
  setTTSSpeaking: (speaking: boolean) => void;
  setHighlight: (highlight: TranscriptHighlight | null) => void;
  setLiveJob: (job: JobDetail | null) => void;
  setExtractionError: (error: string | null) => void;
  appendTranscript: (text: string) => void;
  reset: () => void;
}

const initialState = {
  isRecording: false,
  duration: 0,
  transcript: '',
  interimTranscript: '',
  deepgramState: 'disconnected' as DeepgramConnectionState,
  serverConnected: false,
  sleepState: 'active' as SleepState,
  vadState: 'idle' as VadState,
  cost: null as ServerCostUpdate | null,
  currentQuestion: null as UserQuestion | null,
  isTTSSpeaking: false,
  highlight: null as TranscriptHighlight | null,
  liveJob: null as JobDetail | null,
  extractionError: null as string | null,
};

export const useRecordingStore = create<RecordingState>((set) => ({
  ...initialState,

  setRecording: (isRecording) => set({ isRecording }),
  setDuration: (duration) => set({ duration }),
  setInterimTranscript: (interimTranscript) => set({ interimTranscript }),
  setDeepgramState: (deepgramState) => set({ deepgramState }),
  setServerConnected: (serverConnected) => set({ serverConnected }),
  setSleepState: (sleepState) => set({ sleepState }),
  setVadState: (vadState) => set({ vadState }),
  setCost: (cost) => set({ cost }),
  setCurrentQuestion: (currentQuestion) => set({ currentQuestion }),
  setTTSSpeaking: (isTTSSpeaking) => set({ isTTSSpeaking }),
  setHighlight: (highlight) => set({ highlight }),
  setLiveJob: (liveJob) => set({ liveJob }),
  setExtractionError: (extractionError) => set({ extractionError }),

  appendTranscript: (text) =>
    set((state) => ({
      transcript: state.transcript ? `${state.transcript} ${text}` : text,
    })),

  reset: () => set(initialState),
}));
