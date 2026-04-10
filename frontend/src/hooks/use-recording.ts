'use client';

import { useCallback, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import type { JobDetail, SaveJobData } from '../lib/api';
import { DeepgramService } from '../lib/recording/deepgram-service';
import type { DeepgramWord } from '../lib/recording/deepgram-service';
import {
  ServerWebSocketService,
  type RollingExtractionResult,
  type ServerCostUpdate as WsCostUpdate,
  type UserQuestion,
} from '../lib/recording/server-ws-service';
import { SleepDetector } from '../lib/recording/sleep-detector';
import type { SleepState } from '../lib/recording/sleep-detector';
import { AlertManager } from '../lib/recording/alert-manager';
import { normalise } from '../lib/recording/number-normaliser';
import { generateKeywordBoosts } from '../lib/recording/keyword-boost-generator';
import { useRecordingStore } from '../lib/recording-store';
import type { ServerCostUpdate as StoreCostUpdate } from '../lib/recording-store';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const SAVE_DEBOUNCE_MS = 2000;

/** Fire-and-forget POST to /api/recording/:sessionId/sleep-log for telemetry. */
function logSleepEvent(event: string, detail: string, sessionId?: string): void {
  if (sessionId) {
    api.logSleepEvent(sessionId, event, detail);
  }
}

// ---------------------------------------------------------------------------
// Field category sets — based on eicr-extraction-session.js Sonnet prompt
// ---------------------------------------------------------------------------

const SUPPLY_FIELDS = new Set([
  'ze',
  'pfc',
  'earthing_arrangement',
  'main_earth_conductor_csa',
  'main_bonding_conductor_csa',
  'bonding_water',
  'bonding_gas',
  'earth_electrode_type',
  'earth_electrode_resistance',
  'supply_voltage',
  'supply_frequency',
  'supply_polarity_confirmed',
  'nominal_voltage_u',
  'nominal_voltage_uo',
  'nominal_frequency',
  'prospective_fault_current',
  'earth_loop_impedance_ze',
  'zs_at_db',
  'manufacturer',
  'main_switch_bs_en',
  'main_switch_poles',
  'main_switch_voltage',
  'main_switch_current',
  'main_switch_fuse_setting',
  'main_switch_location',
  'main_switch_conductor_material',
  'main_switch_conductor_csa',
  'earthing_conductor_material',
  'earthing_conductor_csa',
  'earthing_conductor_continuity',
  'bonding_conductor_material',
  'bonding_conductor_csa',
  'bonding_conductor_continuity',
  'rcd_operating_current',
  'rcd_time_delay',
  'rcd_operating_time',
]);

const INSTALLATION_FIELDS = new Set([
  'client_name',
  'address',
  'postcode',
  'town',
  'county',
  'premises_description',
  'next_inspection_years',
  'reason_for_report',
  'occupier_name',
  'client_phone',
  'client_email',
  'date_of_previous_inspection',
  'previous_certificate_number',
  'estimated_age_of_installation',
  'general_condition',
  'installation_records_available',
  'evidence_of_additions_alterations',
  'extent',
  'agreed_limitations',
  'agreed_with',
  'operational_limitations',
]);

const BOARD_FIELDS = new Set(['location', 'phases', 'name']);

// ---------------------------------------------------------------------------
// Sonnet field name → JobDetail field name mapping
// Some Sonnet extraction field names differ from the JobDetail property names.
// ---------------------------------------------------------------------------

const SUPPLY_FIELD_MAP: Record<string, string> = {
  ze: 'earth_loop_impedance_ze',
  pfc: 'prospective_fault_current',
  supply_voltage: 'nominal_voltage_u',
  supply_frequency: 'nominal_frequency',
  main_earth_conductor_csa: 'earthing_conductor_csa',
  main_bonding_conductor_csa: 'bonding_conductor_csa',
};

const CIRCUIT_FIELD_MAP: Record<string, string> = {
  ocpd_type: 'ocpd_type',
  ocpd_rating: 'ocpd_rating_a',
  cable_size: 'live_csa_mm2',
  cable_size_earth: 'cpc_csa_mm2',
  wiring_type: 'wiring_type',
  ref_method: 'ref_method',
  circuit_description: 'circuit_designation',
  zs: 'measured_zs_ohm',
  insulation_resistance_l_l: 'ir_live_live_mohm',
  insulation_resistance_l_e: 'ir_live_earth_mohm',
  r1_plus_r2: 'r1_r2_ohm',
  ring_continuity_r1: 'ring_r1_ohm',
  ring_continuity_rn: 'ring_rn_ohm',
  ring_continuity_r2: 'ring_r2_ohm',
  r2: 'r2_ohm',
  rcd_trip_time: 'rcd_time_ms',
  rcd_rating_a: 'rcd_operating_current_ma',
  polarity: 'polarity_confirmed',
  number_of_points: 'number_of_points',
  rcd_button_confirmed: 'rcd_button_confirmed',
  afdd_button_confirmed: 'afdd_button_confirmed',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildServerWSURL(): string {
  const base = API_BASE_URL.replace(/^http/, 'ws');
  return `${base}/api/sonnet-stream`;
}

function mapCostUpdate(ws: WsCostUpdate): StoreCostUpdate {
  return {
    deepgramCost: ws.deepgram?.cost ?? 0,
    sonnetCost: ws.sonnet?.cost ?? 0,
    totalSessionCost: (ws.deepgram?.cost ?? 0) + (ws.sonnet?.cost ?? 0),
    totalJobCost: ws.totalJobCost ?? 0,
    deepgramMinutes: ws.deepgram?.minutes ?? 0,
    sonnetCalls: ws.sonnet?.turns ?? 0,
    cacheReadTokens: ws.sonnet?.cacheReads ?? 0,
    cacheWriteTokens: ws.sonnet?.cacheWrites ?? 0,
    inputTokens: ws.sonnet?.input ?? 0,
    outputTokens: ws.sonnet?.output ?? 0,
  };
}

function buildJobState(job: JobDetail): Record<string, unknown> {
  return {
    installation_details: job.installation_details ?? {},
    supply_characteristics: job.supply_characteristics ?? {},
    board_info: job.board_info ?? {},
    circuits: (job.circuits ?? []).map((c) => ({
      circuit_ref: c.circuit_ref,
      circuit_designation: c.circuit_designation,
    })),
    observations: job.observations ?? [],
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRecording(jobId: string, userId: string, initialJob: JobDetail | null = null) {
  // --- Zustand store ---
  const store = useRecordingStore();

  // --- Refs for service instances ---
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const deepgramRef = useRef<DeepgramService | null>(null);
  const serverWSRef = useRef<ServerWebSocketService | null>(null);
  const sleepDetectorRef = useRef<SleepDetector | null>(null);
  const alertManagerRef = useRef<AlertManager | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef<string>('');

  // --- Mutable state refs ---
  const jobRef = useRef<JobDetail | null>(initialJob);
  const deepgramKeyRef = useRef<string>('');
  const keywordsRef = useRef<Array<[string, number]>>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRecordingRef = useRef(false);

  // Keep jobRef in sync with prop changes
  useEffect(() => {
    if (initialJob) {
      jobRef.current = initialJob;
    }
  }, [initialJob]);

  // --- Debounced save ---
  const debouncedSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      const job = jobRef.current;
      if (!job) return;

      const data: SaveJobData = {
        circuits: job.circuits,
        observations: job.observations,
        board_info: job.board_info,
        installation_details: job.installation_details,
        supply_characteristics: job.supply_characteristics,
        inspection_schedule: job.inspection_schedule,
      };
      api.saveJob(userId, jobId, data).catch((err) => {
        console.error('[useRecording] save failed:', err);
      });
    }, SAVE_DEBOUNCE_MS);
  }, [userId, jobId]);

  // --- Apply Sonnet readings to job ---
  const applySonnetReadings = useCallback(
    (result: RollingExtractionResult) => {
      const job = jobRef.current;
      if (!job) {
        console.warn(
          '[useRecording] applySonnetReadings: jobRef is null — extraction results discarded'
        );
        return;
      }

      // Clone the top-level sections we may mutate
      const updatedJob: JobDetail = {
        ...job,
        installation_details: job.installation_details
          ? { ...job.installation_details }
          : undefined,
        supply_characteristics: job.supply_characteristics
          ? { ...job.supply_characteristics }
          : undefined,
        board_info: { ...job.board_info },
        circuits: job.circuits.map((c) => ({ ...c })),
        observations: [...(job.observations ?? [])],
      };

      let lastHighlightField = '';
      let lastHighlightValue = '';

      for (const reading of result.readings) {
        const { field, value, circuit } = reading;

        // Determine which section this field belongs to
        if (circuit !== undefined && circuit !== null && circuit > 0) {
          // Circuit-level field
          const mappedField = CIRCUIT_FIELD_MAP[field] ?? field;
          const idx = updatedJob.circuits.findIndex(
            (c) => String(c.circuit_ref) === String(circuit)
          );
          if (idx >= 0) {
            (updatedJob.circuits[idx] as Record<string, string | undefined>)[mappedField] = value;
          }
          lastHighlightField = `circuit_${circuit}_${mappedField}`;
          lastHighlightValue = value;
        } else if (SUPPLY_FIELDS.has(field)) {
          // Supply characteristic
          if (!updatedJob.supply_characteristics) {
            updatedJob.supply_characteristics = {
              earthing_arrangement: '',
              live_conductors: '',
              number_of_supplies: '',
              nominal_voltage_u: '',
              nominal_voltage_uo: '',
              nominal_frequency: '',
            };
          }
          const mappedField = SUPPLY_FIELD_MAP[field] ?? field;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (updatedJob.supply_characteristics as any)[mappedField] = value;
          lastHighlightField = mappedField;
          lastHighlightValue = value;
        } else if (INSTALLATION_FIELDS.has(field)) {
          // Installation detail
          if (!updatedJob.installation_details) {
            updatedJob.installation_details = {
              client_name: '',
              address: '',
              premises_description: '',
              installation_records_available: false,
              evidence_of_additions_alterations: false,
              next_inspection_years: 5,
            };
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (updatedJob.installation_details as any)[field] = value;
          lastHighlightField = field;
          lastHighlightValue = value;
        } else if (BOARD_FIELDS.has(field)) {
          // Board info
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (updatedJob.board_info as any)[field] = value;
          lastHighlightField = field;
          lastHighlightValue = value;
        } else if (circuit === 0 || circuit === undefined || circuit === null) {
          // Sonnet circuit=0 means supply-level — also try supply mapping
          if (!updatedJob.supply_characteristics) {
            updatedJob.supply_characteristics = {
              earthing_arrangement: '',
              live_conductors: '',
              number_of_supplies: '',
              nominal_voltage_u: '',
              nominal_voltage_uo: '',
              nominal_frequency: '',
            };
          }
          const mappedField = SUPPLY_FIELD_MAP[field] ?? field;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (updatedJob.supply_characteristics as any)[mappedField] = value;
          lastHighlightField = mappedField;
          lastHighlightValue = value;
        }
      }

      // Append observations
      if (result.observations && result.observations.length > 0) {
        for (const obs of result.observations) {
          updatedJob.observations.push({
            code: obs.code as 'C1' | 'C2' | 'C3' | 'FI',
            observation_text: obs.text,
            item_location: obs.location ?? '',
            schedule_item: obs.scheduleItem,
          });
        }
      }

      // Update highlight in store
      if (lastHighlightField && lastHighlightValue) {
        store.setHighlight({
          keyword: lastHighlightField,
          value: lastHighlightValue,
          fieldKey: lastHighlightField,
          keywordCandidates: [lastHighlightField],
        });
      }

      jobRef.current = updatedJob;
      store.setLiveJob(updatedJob);
      debouncedSave();
    },
    [debouncedSave, store]
  );

  // --- Start Recording ---
  const startRecording = useCallback(async () => {
    if (isRecordingRef.current) return;

    // Reset sleep state immediately on press — before any async work.
    // This ensures the UI shows 'active' even during the 3-10s setup phase,
    // not a stale 'dozing'/'sleeping' state from a previous session.
    store.setSleepState('active');

    try {
      // 1. Fetch short-lived Deepgram streaming key (secure temp key, 600s TTL)
      const deepgramKey = await api.fetchDeepgramStreamingKey();
      deepgramKeyRef.current = deepgramKey;

      // 2. Build server WS URL
      const serverWSURL = buildServerWSURL();

      // 3. Get mic access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: { ideal: 16000 },
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // 4. Create AudioContext
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      const actualSampleRate = audioContext.sampleRate;
      if (actualSampleRate !== 16000) {
        console.warn(
          `[useRecording] AudioContext sample rate is ${actualSampleRate}Hz (not 16kHz) — will resample`
        );
      } else {
        console.log(`[useRecording] AudioContext sample rate: ${actualSampleRate}Hz`);
      }

      // Resume AudioContext if suspended (iOS Safari autoplay policy).
      // On mobile, AudioContext starts in 'suspended' state even from a user
      // gesture if the gesture flows through an async chain. When suspended,
      // the AudioWorklet never fires — no PCM reaches Deepgram, the 10s
      // silence timer fires, and recording enters dozing immediately.
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      // 5. Create media stream source
      const source = audioContext.createMediaStreamSource(stream);

      // 6-8. Set up audio capture — try AudioWorklet first, fall back to ScriptProcessor
      let workletNode: AudioWorkletNode | null = null;
      let scriptNode: ScriptProcessorNode | null = null;

      try {
        await audioContext.audioWorklet.addModule('/audio-worklet-processor.js');
        workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor');
        workletNodeRef.current = workletNode;
        source.connect(workletNode);
      } catch (workletErr) {
        console.warn(
          '[useRecording] AudioWorklet failed, using ScriptProcessor fallback:',
          workletErr
        );
        // ScriptProcessorNode fallback — onaudioprocess only fires when connected to destination.
        // eslint-disable-next-line deprecation/deprecation
        scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
        scriptNodeRef.current = scriptNode;
        source.connect(scriptNode);
        scriptNode.connect(audioContext.destination);
      }

      // 10. Generate session ID
      const sessionId = crypto.randomUUID();
      sessionIdRef.current = sessionId;

      // 11. Create AlertManager
      const alertManager = new AlertManager({
        onQuestionDisplayed: (q) => {
          store.setCurrentQuestion({
            id: `${q.field}:${q.circuit ?? 'supply'}`,
            type: q.type,
            fieldKey: q.field,
            circuitNumber: q.circuit,
            question: q.question,
            value: q.value,
          });
          sleepDetectorRef.current?.onQuestionAsked();
        },
        onQuestionDismissed: () => {
          store.setCurrentQuestion(null);
        },
        onTTSSpeakingChange: (speaking) => {
          store.setTTSSpeaking(speaking);
          if (speaking) {
            sleepDetectorRef.current?.onTTSStarted();
          } else {
            sleepDetectorRef.current?.onTTSFinished();
          }
        },
      });
      alertManagerRef.current = alertManager;

      // 12. Create DeepgramService
      const deepgram = new DeepgramService({
        onInterimTranscript: (text: string, _confidence: number) => {
          store.setInterimTranscript(text);
        },
        onFinalTranscript: (text: string, _confidence: number, _words: DeepgramWord[]) => {
          // Clear interim
          store.setInterimTranscript('');

          // Echo suppression: skip if TTS is speaking
          if (alertManagerRef.current?.isTTSSpeaking) return;

          // Normalise and append
          const normalised = normalise(text);
          store.appendTranscript(normalised);

          // Send to server WS
          serverWSRef.current?.sendTranscript(normalised);

          // Reset sleep silence timer
          sleepDetectorRef.current?.onSpeechActivity();
        },
        onUtteranceEnd: () => {
          // No-op for now — could gate questions here later
        },
        onError: (error: Error) => {
          console.error('[useRecording] Deepgram error:', error);
        },
        onConnectionStateChange: (state) => {
          store.setDeepgramState(state);
        },
      });
      deepgramRef.current = deepgram;

      // 13. Create ServerWebSocketService
      const serverWS = new ServerWebSocketService({
        onExtraction: (result: RollingExtractionResult) => {
          store.setExtractionError(null);
          applySonnetReadings(result);
        },
        onQuestion: (question: UserQuestion) => {
          // Wake sleep detector if dozing/sleeping to deliver the question
          sleepDetectorRef.current?.wakeForQuestion();
          alertManagerRef.current?.enqueueQuestion(question);
        },
        onCostUpdate: (cost: WsCostUpdate) => {
          store.setCost(mapCostUpdate(cost));
        },
        onError: (msg: string, recoverable: boolean) => {
          console.error(`[useRecording] Server WS error (recoverable=${recoverable}):`, msg);
          store.setExtractionError(msg);
        },
        onSessionAck: (status: string) => {
          console.log('[useRecording] session_ack:', status);
          // Flush any buffered messages after server confirms session
          serverWSRef.current?.flushPendingMessages();
        },
        onConnect: () => {
          store.setServerConnected(true);
          // Send session_start here (not after connect()) to avoid race condition:
          // connect() is async — the WS isn't open yet when connect() returns.
          // Sending session_start before onopen would cause it to be dropped.
          const sid = sessionIdRef.current;
          const job = jobRef.current;
          if (sid && serverWSRef.current) {
            serverWSRef.current.sendSessionStart(
              sid,
              jobId,
              buildJobState(job ?? ({} as JobDetail))
            );
          }
        },
        onDisconnect: () => {
          store.setServerConnected(false);
        },
      });
      serverWSRef.current = serverWS;

      // 14. Create SleepDetector (RMS energy-based — no Silero VAD dependency)
      const sleepDetector = new SleepDetector({
        onEnterDozing: () => {
          store.setSleepState('dozing');
          deepgramRef.current?.pauseAudioStream();
          serverWSRef.current?.sendPause();
        },
        onEnterSleeping: () => {
          store.setSleepState('sleeping');
          deepgramRef.current?.disconnect();
        },
        onWake: (fromState: SleepState) => {
          store.setSleepState('active');

          if (fromState === 'sleeping') {
            // Reconnect Deepgram and replay ring buffer
            if (deepgramKeyRef.current) {
              deepgramRef.current?.connect(
                deepgramKeyRef.current,
                keywordsRef.current.map(([kw, boost]: [string, number]) => ({ keyword: kw, boost }))
              );
            }
            const bufferedData = sleepDetectorRef.current?.ringBuffer.drain();
            if (bufferedData && bufferedData.byteLength > 0) {
              // Wait briefly for Deepgram to connect before replaying
              setTimeout(() => {
                deepgramRef.current?.replayBuffer(bufferedData);
              }, 500);
            }
          } else if (fromState === 'dozing') {
            deepgramRef.current?.resumeAudioStream();
            const bufferedData = sleepDetectorRef.current?.ringBuffer.drain();
            if (bufferedData && bufferedData.byteLength > 0) {
              deepgramRef.current?.replayBuffer(bufferedData);
            }
          }

          serverWSRef.current?.sendResume();
        },
        onLog: (event: string, detail: string) => {
          logSleepEvent(event, detail, sessionId);
        },
      });
      sleepDetectorRef.current = sleepDetector;

      // 15. Generate keyword boosts from job data
      const job = jobRef.current;
      const boostTuples = generateKeywordBoosts(job?.board_info, job?.circuits);
      const keywords = boostTuples.map(([keyword, boost]) => ({
        keyword,
        boost,
      }));
      keywordsRef.current = boostTuples;

      // 16. Connect Deepgram — pass actual AudioContext sample rate for resampling
      //     Provide proxy fallback URL + auth token in case temp token is rejected
      const proxyBase = API_BASE_URL.replace(/^http/, 'ws');
      const authToken = typeof window !== 'undefined' ? (localStorage.getItem('token') ?? '') : '';
      deepgram.connect(deepgramKey, keywords, actualSampleRate, {
        proxyUrl: `${proxyBase}/api/recording/stream`,
        authToken,
      });

      // 17. Connect Server WS
      const token = typeof window !== 'undefined' ? (localStorage.getItem('token') ?? '') : '';
      serverWS.connect(serverWSURL, token);

      // 18. session_start is now sent from onConnect callback (above)

      // 19. Wire audio output → Deepgram + SleepDetector
      if (workletNode) {
        // AudioWorklet posts { samples: Float32Array } — destructure correctly.
        workletNode.port.onmessage = (event: MessageEvent) => {
          const samples = (event.data as { samples: Float32Array }).samples;
          if (!samples || samples.length === 0) return;

          deepgramRef.current?.sendSamples(samples);
          sleepDetectorRef.current?.processAudioChunk(samples);
        };
      } else if (scriptNode) {
        // ScriptProcessor fallback — convert Float32 to the same format
        scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
          const samples = new Float32Array(event.inputBuffer.getChannelData(0));
          if (!samples || samples.length === 0) return;

          deepgramRef.current?.sendSamples(samples);
          sleepDetectorRef.current?.processAudioChunk(samples);
        };
      }

      // 20. Start sleep detector
      sleepDetector.start();

      // 21. Start duration counter
      const startTime = Date.now();
      durationIntervalRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        store.setDuration(elapsed);
      }, 1000);

      // 22. Update store
      isRecordingRef.current = true;
      store.setRecording(true);
      store.setSleepState('active');
      store.setDeepgramState('connecting');
      store.setLiveJob(jobRef.current);
    } catch (err) {
      console.error('[useRecording] startRecording failed:', err);
      // Clean up anything that was partially created
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (audioContextRef.current?.state !== 'closed') {
        audioContextRef.current?.close().catch(() => {});
      }
      audioContextRef.current = null;
      throw err;
    }
  }, [jobId, userId, store, applySonnetReadings]);

  // --- Stop Recording ---
  const stopRecording = useCallback(() => {
    if (!isRecordingRef.current) return;
    isRecordingRef.current = false;

    // 1. Stop duration counter
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }

    // 2. Stop sleep detector
    sleepDetectorRef.current?.stop();

    // 3. Send session_stop
    serverWSRef.current?.sendStop();

    // 4. Disconnect Deepgram
    deepgramRef.current?.disconnect();

    // 5. Disconnect Server WS (after a brief delay to let session_stop send)
    setTimeout(() => {
      serverWSRef.current?.disconnect();
    }, 500);

    // 6. Stop AlertManager
    alertManagerRef.current?.stopAll();

    // 7. Stop audio tracks
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    // 8. Disconnect worklet
    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    // 8b. Disconnect ScriptProcessor fallback
    if (scriptNodeRef.current) {
      scriptNodeRef.current.onaudioprocess = null;
      scriptNodeRef.current.disconnect();
      scriptNodeRef.current = null;
    }

    // 9. Close AudioContext
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
    }
    audioContextRef.current = null;

    // 10. Update store
    store.setRecording(false);
    // Reset sleep/vad state so next session starts clean, not in stale dozing/sleeping.
    store.setSleepState('active');
    store.setVadState('idle');

    // 11. Reset alert dedup
    alertManagerRef.current?.resetDedup();

    // 12. Flush any pending save
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      // Do a final save
      const job = jobRef.current;
      if (job) {
        const data: SaveJobData = {
          circuits: job.circuits,
          observations: job.observations,
          board_info: job.board_info,
          installation_details: job.installation_details,
          supply_characteristics: job.supply_characteristics,
          inspection_schedule: job.inspection_schedule,
        };
        api.saveJob(userId, jobId, data).catch((err) => {
          console.error('[useRecording] final save failed:', err);
        });
      }
    }
  }, [userId, jobId, store]);

  // --- Cleanup on unmount ---
  useEffect(() => {
    return () => {
      if (isRecordingRef.current) {
        // Force stop without state updates to avoid state-after-unmount
        if (durationIntervalRef.current) {
          clearInterval(durationIntervalRef.current);
          durationIntervalRef.current = null;
        }
        sleepDetectorRef.current?.stop();
        deepgramRef.current?.destroy();
        serverWSRef.current?.destroy();
        alertManagerRef.current?.destroy();
        streamRef.current?.getTracks().forEach((t) => t.stop());
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
          audioContextRef.current.close().catch(() => {});
        }
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
        }
        isRecordingRef.current = false;
      }
    };
  }, []);

  return {
    // Store state
    isRecording: store.isRecording,
    duration: store.duration,
    transcript: store.transcript,
    interimTranscript: store.interimTranscript,
    deepgramState: store.deepgramState,
    serverConnected: store.serverConnected,
    sleepState: store.sleepState,
    vadState: store.vadState,
    cost: store.cost,
    currentQuestion: store.currentQuestion,
    isTTSSpeaking: store.isTTSSpeaking,
    highlight: store.highlight,

    // Actions
    startRecording,
    stopRecording,

    // Current job (reactive — updated by Sonnet extraction via store)
    job: store.liveJob,
  };
}
