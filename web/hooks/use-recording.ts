'use client';

/**
 * useRecording — orchestrator hook for the CertMate v2 recording pipeline.
 *
 * Wires together: AudioCapture -> DeepgramService -> NumberNormaliser ->
 *   TranscriptFieldMatcher -> ClaudeService (Sonnet extraction) -> AlertManager
 *
 * Manages field priority: pre-existing (CCU/manual) > Sonnet > Regex
 *
 * Supports two audio sources:
 * - "local" (default): captures from browser microphone via AudioCapture
 * - "companion": receives PCM audio from phone companion via Socket.IO
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { AudioCapture, type AudioCaptureDelegate } from '@/lib/audio-capture';
import {
  DeepgramService,
  type DeepgramDelegate,
  type DeepgramConnectionState,
  type DeepgramWord,
} from '@/lib/deepgram';
import { ClaudeService } from '@/lib/claude';
import { TranscriptFieldMatcher } from '@/lib/transcript-field-matcher';
import { normalise } from '@/lib/number-normaliser';
import { generateKeywordBoosts } from '@/lib/keyword-boost-generator';
import { AlertManager, type AlertManagerDelegate } from '@/lib/alert-manager';
import { DebugLogger } from '@/lib/debug-logger';
import { api } from '@/lib/api-client';
import { getToken } from '@/lib/auth';
import { applyDefaultsToCircuit } from '@/lib/apply-defaults';
import type {
  JobDetail,
  Circuit,
  BoardInfo,
  RollingExtractionResult,
  ValidationAlert,
  UserDefaults,
} from '@/lib/types';

// ============= Types =============

export type AudioSource = 'local' | 'companion';

/** A transcript highlight created when Sonnet extraction confirms a value into the UI. */
export interface TranscriptHighlight {
  /** The extracted value to search for in the transcript (e.g., "0.35") */
  value: string;
  /** Full field path for dedup (e.g., "supply.ze", "circuit.1.measured_zs_ohm") */
  fieldKey: string;
  /** Timestamp when the highlight was created */
  timestamp: number;
}

export interface RecordingState {
  isRecording: boolean;
  connectionState: DeepgramConnectionState;
  transcript: string;
  interimTranscript: string;
  isSpeaking: boolean;
  isTTSSpeaking: boolean;
  currentAlert: ValidationAlert | null;
  alertQueueCount: number;
  regexMatchCount: number;
  sonnetCallCount: number;
  sonnetCostUSD: number;
  discrepancyCount: number;
  fieldSources: Record<string, 'regex' | 'sonnet' | 'preExisting'>;
  /** Highlights for transcript values confirmed by Sonnet extraction. */
  highlights: TranscriptHighlight[];
  /** Fields recently updated by extraction — fieldKey → timestamp. */
  recentlyUpdatedFields: Record<string, number>;
  sessionDuration: number;
  companionConnected: boolean;
  audioSource: AudioSource;
  error: string | null;
}

export interface RecordingActions {
  startRecording: (source?: AudioSource) => Promise<void>;
  stopRecording: () => void;
  handleAlertResponse: (accepted: boolean) => void;
  dismissAlert: () => void;
  setAudioSource: (source: AudioSource) => void;
}

// ============= Constants =============

const SONNET_DEBOUNCE_MS = 3000;
const SONNET_COOLDOWN_MS = 5000;
const KEEP_ALIVE_INTERVAL_MS = 8000;
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

// Key mappings: TranscriptFieldMatcher returns camelCase, but our types use snake_case
const CIRCUIT_KEY_MAP: Record<string, string> = {
  measuredZsOhm: 'measured_zs_ohm',
  r1R2Ohm: 'r1_r2_ohm',
  ringR1Ohm: 'ring_r1_ohm',
  ringRnOhm: 'ring_rn_ohm',
  ringR2Ohm: 'ring_r2_ohm',
  irLiveEarthMohm: 'ir_live_earth_mohm',
  irLiveLiveMohm: 'ir_live_live_mohm',
  rcdTimeMs: 'rcd_time_ms',
  ocpdRatingA: 'ocpd_rating_a',
  ocpdType: 'ocpd_type',
  polarityConfirmed: 'polarity_confirmed',
  rcdButtonConfirmed: 'rcd_button_confirmed',
  afddButtonConfirmed: 'afdd_button_confirmed',
  liveCsaMm2: 'live_csa_mm2',
  numberOfPoints: 'number_of_points',
  wiringType: 'wiring_type',
  refMethod: 'ref_method',
};

const SUPPLY_KEY_MAP: Record<string, string> = {
  ze: 'earth_loop_impedance_ze',
  pfc: 'prospective_fault_current',
  earthingArrangement: 'earthing_arrangement',
  supplyPolarityConfirmed: 'supply_polarity_confirmed',
  mainEarthCsa: 'earthing_conductor_csa',
  bondingCsa: 'bonding_conductor_csa',
  bondingWater: 'bonding_water',
  bondingGas: 'bonding_gas',
  earthElectrodeType: 'means_earthing_electrode',
  earthElectrodeResistance: 'earth_loop_impedance_ze',
};

const BOARD_KEY_MAP: Record<string, string> = {
  manufacturer: 'manufacturer',
  zsAtDb: 'zs_at_db',
};

const INSTALL_KEY_MAP: Record<string, string> = {
  clientName: 'client_name',
  address: 'address',
  premisesDescription: 'premises_description',
  nextInspectionYears: 'next_inspection_years',
  clientPhone: 'client_phone',
  clientEmail: 'client_email',
  reasonForReport: 'reason_for_report',
  occupierName: 'occupier_name',
  dateOfPreviousInspection: 'date_of_previous_inspection',
  previousCertificateNumber: 'previous_certificate_number',
  estimatedAgeOfInstallation: 'estimated_age_of_installation',
  generalConditionOfInstallation: 'general_condition',
};

function mapKey(key: string, map: Record<string, string>): string {
  return map[key] ?? key;
}

// ============= Hook =============

export function useRecording(
  job: JobDetail | null,
  onJobUpdate: (updates: Partial<JobDetail>) => void
): [RecordingState, RecordingActions] {
  // State
  const [isRecording, setIsRecording] = useState(false);
  const [connectionState, setConnectionState] = useState<DeepgramConnectionState>('disconnected');
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isTTSSpeaking, setIsTTSSpeaking] = useState(false);
  const [currentAlert, setCurrentAlert] = useState<ValidationAlert | null>(null);
  const [alertQueueCount, setAlertQueueCount] = useState(0);
  const [regexMatchCount, setRegexMatchCount] = useState(0);
  const [sonnetCallCount, setSonnetCallCount] = useState(0);
  const [sonnetCostUSD, setSonnetCostUSD] = useState(0);
  const [discrepancyCount, setDiscrepancyCount] = useState(0);
  const [fieldSources, setFieldSources] = useState<
    Record<string, 'regex' | 'sonnet' | 'preExisting'>
  >({});
  const [highlights, setHighlights] = useState<TranscriptHighlight[]>([]);
  const [recentlyUpdatedFields, setRecentlyUpdatedFields] = useState<Record<string, number>>({});
  const highlightsRef = useRef<TranscriptHighlight[]>([]);
  const recentlyUpdatedFieldsRef = useRef<Record<string, number>>({});
  const [sessionDuration, setSessionDuration] = useState(0);
  const [companionConnected, setCompanionConnected] = useState(false);
  const [audioSource, setAudioSource] = useState<AudioSource>('local');
  const [error, setError] = useState<string | null>(null);

  // Refs for services (persist across renders, not state-driven)
  const audioCapture = useRef<AudioCapture | null>(null);
  const deepgram = useRef<DeepgramService | null>(null);
  const claude = useRef<ClaudeService | null>(null);
  const matcher = useRef<TranscriptFieldMatcher>(new TranscriptFieldMatcher());
  const alertManager = useRef<AlertManager | null>(null);
  const debugLogger = useRef<DebugLogger>(new DebugLogger());
  const companionSocket = useRef<Socket | null>(null);

  // Mutable state refs (avoid stale closures)
  const transcriptRef = useRef('');
  const previousTranscriptRef = useRef('');
  const fieldSourcesRef = useRef<Record<string, 'regex' | 'sonnet' | 'preExisting'>>({});
  const jobRef = useRef<JobDetail | null>(null);
  const sonnetDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSonnetCallTime = useRef(0);
  const keepAliveTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRecordingRef = useRef(false);
  const regexMatchCountRef = useRef(0);
  const discrepancyCountRef = useRef(0);
  const audioSourceRef = useRef<AudioSource>('local');
  const userDefaultsRef = useRef<UserDefaults>({});

  // Eagerly load user defaults so they're ready when new circuits are created
  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (!storedUser) return;
    try {
      const userData = JSON.parse(storedUser);
      api
        .getUserDefaults(userData.id)
        .then((d) => {
          userDefaultsRef.current = d;
        })
        .catch(() => {
          /* non-critical — defaults just won't be applied */
        });
    } catch {
      /* ignore */
    }
  }, []);

  // Keep job ref updated
  useEffect(() => {
    jobRef.current = job;
  }, [job]);

  // ---- Alert Manager Setup ----

  useEffect(() => {
    const delegate: AlertManagerDelegate = {
      onAlertPresented(alert) {
        setCurrentAlert(alert);
      },
      onAlertDismissed() {
        setCurrentAlert(null);
      },
      onAlertQueueChanged(count) {
        setAlertQueueCount(count);
      },
      onTTSSpeakingChanged(speaking) {
        setIsTTSSpeaking(speaking);
      },
    };

    const mgr = new AlertManager(delegate);
    mgr.setCallbacks({
      onAlertAccepted: (alert) => {
        debugLogger.current.info('user', 'alert_accepted', {
          type: alert.type,
          message: alert.message,
        });
      },
      onAlertRejected: (alert) => {
        debugLogger.current.info('user', 'alert_rejected', {
          type: alert.type,
          message: alert.message,
        });
      },
      onCorrectionReceived: (field, circuit, value) => {
        debugLogger.current.info('user', 'correction_applied', {
          field: field ?? '',
          circuit: circuit ?? 0,
          value,
        });
      },
    });
    alertManager.current = mgr;

    return () => {
      mgr.destroy();
    };
  }, []);

  // ---- Apply Regex Results ----

  const applyRegexResults = useCallback(
    (result: ReturnType<TranscriptFieldMatcher['match']>) => {
      if (!jobRef.current) return;
      const currentJob = jobRef.current;
      let matchCount = 0;
      const batchUpdate: Partial<JobDetail> = {};

      // Supply updates — map camelCase → snake_case
      if (Object.keys(result.supplyUpdates).length > 0) {
        const supply = { ...currentJob.supply_characteristics };
        for (const [key, value] of Object.entries(result.supplyUpdates)) {
          if (value === undefined) continue;
          const snakeKey = mapKey(key, SUPPLY_KEY_MAP);
          const fieldKey = `supply.${snakeKey}`;
          if (fieldSourcesRef.current[fieldKey] === 'preExisting') continue;
          (supply as Record<string, unknown>)[snakeKey] = value;
          fieldSourcesRef.current[fieldKey] = 'regex';
          matchCount++;
        }
        batchUpdate.supply_characteristics =
          supply as unknown as JobDetail['supply_characteristics'];
      }

      // Board updates — map camelCase → snake_case
      if (Object.keys(result.boardUpdates).length > 0) {
        const board = { ...currentJob.board_info };
        for (const [key, value] of Object.entries(result.boardUpdates)) {
          if (value === undefined) continue;
          const snakeKey = mapKey(key, BOARD_KEY_MAP);
          const fieldKey = `board.${snakeKey}`;
          if (fieldSourcesRef.current[fieldKey] === 'preExisting') continue;
          (board as Record<string, unknown>)[snakeKey] = value;
          fieldSourcesRef.current[fieldKey] = 'regex';
          matchCount++;
        }
        batchUpdate.board_info = board;
      }

      // Installation updates — map camelCase → snake_case
      if (Object.keys(result.installationUpdates).length > 0) {
        const install = { ...currentJob.installation_details };
        for (const [key, value] of Object.entries(result.installationUpdates)) {
          if (value === undefined) continue;
          const snakeKey = mapKey(key, INSTALL_KEY_MAP);
          const fieldKey = `install.${snakeKey}`;
          if (fieldSourcesRef.current[fieldKey] === 'preExisting') continue;
          (install as Record<string, unknown>)[snakeKey] = value;
          fieldSourcesRef.current[fieldKey] = 'regex';
          matchCount++;
        }
        batchUpdate.installation_details = install as unknown as JobDetail['installation_details'];
      }

      // Circuit updates — map camelCase → snake_case
      let circuits = [...(currentJob.circuits ?? [])];
      let circuitsChanged = false;

      for (const [circuitRef, updates] of Object.entries(result.circuitUpdates)) {
        if (!updates) continue;
        const idx = circuits.findIndex((c) => c.circuit_ref === circuitRef);
        if (idx === -1) continue;

        const circuit = { ...circuits[idx] };
        for (const [key, value] of Object.entries(updates)) {
          if (value === undefined) continue;
          const snakeKey = mapKey(key, CIRCUIT_KEY_MAP);
          const fieldKey = `circuit.${circuitRef}.${snakeKey}`;
          if (fieldSourcesRef.current[fieldKey] === 'preExisting') continue;
          (circuit as Record<string, unknown>)[snakeKey] = value;
          fieldSourcesRef.current[fieldKey] = 'regex';
          matchCount++;
        }
        circuits[idx] = circuit;
        circuitsChanged = true;
      }

      // New circuits — apply user defaults to fill configuration fields
      for (const nc of result.newCircuits) {
        const exists = circuits.some((c) => c.circuit_ref === nc.circuitRef);
        if (exists) continue;
        const scaffold: Circuit = {
          circuit_ref: nc.circuitRef,
          circuit_designation: nc.designation,
        };
        circuits = [...circuits, applyDefaultsToCircuit(scaffold, userDefaultsRef.current)];
        circuitsChanged = true;
        matchCount++;
      }

      if (circuitsChanged) {
        batchUpdate.circuits = circuits;
      }

      // Single batched update instead of multiple onJobUpdate calls
      if (matchCount > 0) {
        onJobUpdate(batchUpdate);
        regexMatchCountRef.current += matchCount;
        setRegexMatchCount(regexMatchCountRef.current);
        setFieldSources({ ...fieldSourcesRef.current });
      }
    },
    [onJobUpdate]
  );

  // ---- Apply Sonnet Results ----

  const applySonnetResults = useCallback(
    (result: RollingExtractionResult) => {
      if (!jobRef.current) return;
      const currentJob = jobRef.current;
      const now = Date.now();
      const newHighlights: TranscriptHighlight[] = [];
      const fieldUpdates: Record<string, number> = {};

      for (const reading of result.extractedReadings) {
        const circuitRef = reading.circuit;
        const field = reading.field;
        const value = String(reading.value);

        if (circuitRef === '0' || circuitRef === undefined) {
          // Route circuit-0 fields to the correct section
          const BOARD_FIELDS = new Set(['manufacturer', 'zs_at_db', 'location', 'phases']);
          const INSTALL_FIELDS = new Set([
            'client_name',
            'client_phone',
            'client_email',
            'address',
            'premises_description',
            'next_inspection_years',
            'reason_for_report',
            'occupier_name',
            'date_of_previous_inspection',
            'previous_certificate_number',
            'estimated_age_of_installation',
            'general_condition',
            'agreed_limitations',
            'agreed_with',
            'operational_limitations',
            'extent',
          ]);

          let section: string;
          if (BOARD_FIELDS.has(field)) {
            section = 'board';
          } else if (INSTALL_FIELDS.has(field)) {
            section = 'installation';
          } else {
            section = 'supply';
          }

          const fieldKey = `${section}.${field}`;
          const currentSource = fieldSourcesRef.current[fieldKey];
          if (currentSource === 'preExisting') continue;
          if (currentSource === 'regex') {
            discrepancyCountRef.current++;
            setDiscrepancyCount(discrepancyCountRef.current);
            debugLogger.current.info('sonnet', 'discrepancy_overwrite', {
              field,
              section,
              oldSource: 'regex',
            });
          }
          fieldSourcesRef.current[fieldKey] = 'sonnet';

          if (section === 'board') {
            const board = { ...currentJob.board_info } as Record<string, unknown>;
            board[field] = value;
            onJobUpdate({ board_info: board as BoardInfo });
          } else if (section === 'installation') {
            const install = { ...currentJob.installation_details } as Record<string, unknown>;
            install[field] = value;
            onJobUpdate({
              installation_details: install as unknown as JobDetail['installation_details'],
            });
          } else {
            const supply = { ...currentJob.supply_characteristics } as Record<string, unknown>;
            supply[field] = value;
            onJobUpdate({
              supply_characteristics: supply as unknown as JobDetail['supply_characteristics'],
            });
          }

          // Track highlight for transcript and blue flash for field
          newHighlights.push({ value, fieldKey, timestamp: now });
          fieldUpdates[fieldKey] = now;
        } else {
          // Circuit field
          const fieldKey = `circuit.${circuitRef}.${field}`;
          const currentSource = fieldSourcesRef.current[fieldKey];
          if (currentSource === 'preExisting') continue;
          if (currentSource === 'regex') {
            discrepancyCountRef.current++;
            setDiscrepancyCount(discrepancyCountRef.current);
            debugLogger.current.info('sonnet', 'discrepancy_overwrite', {
              field,
              circuit: circuitRef,
              oldSource: 'regex',
            });
          }
          fieldSourcesRef.current[fieldKey] = 'sonnet';

          const circuits = [...(currentJob.circuits ?? [])];
          const idx = circuits.findIndex((c) => c.circuit_ref === circuitRef);
          if (idx >= 0) {
            const circuit = { ...circuits[idx] } as Record<string, unknown>;
            circuit[field] = value;
            circuits[idx] = circuit as Circuit;
            onJobUpdate({ circuits });

            // Track highlight for transcript and blue flash for field
            newHighlights.push({ value, fieldKey, timestamp: now });
            fieldUpdates[fieldKey] = now;
          }
        }
      }

      setFieldSources({ ...fieldSourcesRef.current });

      // Update transcript highlights (dedup by fieldKey, keeping latest)
      if (newHighlights.length > 0) {
        const merged = [...highlightsRef.current];
        for (const h of newHighlights) {
          const idx = merged.findIndex((e) => e.fieldKey === h.fieldKey);
          if (idx >= 0) {
            merged[idx] = h;
          } else {
            merged.push(h);
          }
        }
        highlightsRef.current = merged;
        setHighlights([...merged]);

        recentlyUpdatedFieldsRef.current = {
          ...recentlyUpdatedFieldsRef.current,
          ...fieldUpdates,
        };
        setRecentlyUpdatedFields({ ...recentlyUpdatedFieldsRef.current });
      }

      // Queue validation alerts
      for (const alert of result.validationAlerts) {
        alertManager.current?.queueAlert(alert);
      }

      // Queue user questions
      if (result.questionsForUser) {
        for (const question of result.questionsForUser) {
          alertManager.current?.queueQuestion(question);
        }
      }
    },
    [onJobUpdate]
  );

  // ---- Sonnet Extraction ----

  const triggerSonnetExtraction = useCallback(async () => {
    if (!claude.current?.isConfigured || !jobRef.current) return;
    if (!isRecordingRef.current) return;

    const now = Date.now();
    if (now - lastSonnetCallTime.current < SONNET_COOLDOWN_MS) return;
    lastSonnetCallTime.current = now;

    const buffer = transcriptRef.current;
    if (!buffer.trim()) return;

    const currentJob = jobRef.current;
    const circuitSchedule = JSON.stringify(currentJob.circuits ?? []);
    const recentReadings = JSON.stringify(fieldSourcesRef.current);
    const askedDescs = alertManager.current?.getAskedQuestionDescriptions() ?? [];

    debugLogger.current.info('sonnet', 'sonnet_input', {
      bufferLength: buffer.length,
    });

    try {
      const result = await claude.current.rollingExtraction({
        transcriptBuffer: buffer,
        previousTranscript: previousTranscriptRef.current || undefined,
        currentCircuit: matcher.current.activeCircuitRef ?? undefined,
        circuitSchedule,
        recentReadings,
        askedQuestions: askedDescs,
      });

      debugLogger.current.info('sonnet', 'sonnet_output', {
        readings: result.extractedReadings.length,
        alerts: result.validationAlerts.length,
        questions: result.questionsForUser?.length ?? 0,
      });

      applySonnetResults(result);

      // Rotate buffer
      previousTranscriptRef.current = buffer;

      setSonnetCallCount(claude.current.sessionCallCount);
      setSonnetCostUSD(claude.current.sessionCostUSD);
    } catch (err) {
      debugLogger.current.error('sonnet', 'sonnet_error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [applySonnetResults]);

  // ---- Reset Sonnet Debounce ----

  const resetSonnetDebounce = useCallback(() => {
    if (sonnetDebounceTimer.current) {
      clearTimeout(sonnetDebounceTimer.current);
    }
    sonnetDebounceTimer.current = setTimeout(() => {
      triggerSonnetExtraction();
    }, SONNET_DEBOUNCE_MS);
  }, [triggerSonnetExtraction]);

  // ---- Connect Companion Socket ----

  const connectCompanionSocket = useCallback((jobId: string, dgService: DeepgramService) => {
    const token = getToken();
    if (!token) return;

    const socket = io(API_BASE_URL, {
      auth: { token },
      transports: ['websocket'],
    });

    socket.on('connect', () => {
      socket.emit('join-recording', { jobId });
      debugLogger.current.info('companion', 'socket_connected', {});
    });

    socket.on('companion-joined', () => {
      setCompanionConnected(true);
      debugLogger.current.info('companion', 'phone_connected', {});
    });

    socket.on('companion-left', () => {
      setCompanionConnected(false);
      debugLogger.current.info('companion', 'phone_disconnected', {});
    });

    socket.on('audio-chunk', ({ chunk }: { chunk: ArrayBuffer }) => {
      // Convert received ArrayBuffer to Int16Array and send to Deepgram
      const pcmInt16 = new Int16Array(chunk);
      dgService.sendAudio(pcmInt16);
    });

    socket.on('disconnect', () => {
      setCompanionConnected(false);
    });

    companionSocket.current = socket;
  }, []);

  // ---- Disconnect Companion Socket ----

  const disconnectCompanionSocket = useCallback(() => {
    if (companionSocket.current) {
      const jobId = jobRef.current?.id;
      if (jobId) {
        companionSocket.current.emit('leave-recording', { jobId });
      }
      companionSocket.current.disconnect();
      companionSocket.current = null;
    }
    setCompanionConnected(false);
  }, []);

  // ---- Start Recording ----

  const startRecording = useCallback(
    async (source?: AudioSource) => {
      if (isRecordingRef.current) return;
      setError(null);

      const effectiveSource = source ?? audioSourceRef.current;
      audioSourceRef.current = effectiveSource;
      setAudioSource(effectiveSource);

      try {
        // Fetch API keys
        const keys = await api.getAPIKeys();

        // Configure Claude
        const claudeService = new ClaudeService();
        claudeService.configure(keys.anthropicKey);
        claudeService.resetSessionTracking();
        claude.current = claudeService;

        // Reset state
        transcriptRef.current = '';
        previousTranscriptRef.current = '';
        fieldSourcesRef.current = {};
        regexMatchCountRef.current = 0;
        discrepancyCountRef.current = 0;
        setTranscript('');
        setInterimTranscript('');
        setRegexMatchCount(0);
        setSonnetCallCount(0);
        setSonnetCostUSD(0);
        setDiscrepancyCount(0);
        setFieldSources({});
        setSessionDuration(0);
        matcher.current = new TranscriptFieldMatcher();
        alertManager.current?.clearAll();
        alertManager.current?.resetQuestionTracking();

        // Start debug logger
        const sessionId = `web_${Date.now()}`;
        debugLogger.current.startSession(sessionId);

        // Generate keyword boosts
        const keywords = generateKeywordBoosts(job?.board_info, job?.circuits);

        // Create Deepgram delegate
        const dgDelegate: DeepgramDelegate = {
          onInterimTranscript(text: string) {
            setInterimTranscript(text);
            setIsSpeaking(true);
          },
          onFinalTranscript(text: string, confidence: number, _words: DeepgramWord[]) {
            if (alertManager.current?.isTTSSpeaking) {
              debugLogger.current.debug('deepgram', 'tts_echo_suppressed', {
                text: text.slice(0, 100),
              });
              return;
            }

            setInterimTranscript('');

            // Normalise numbers
            const normalised = normalise(text);
            transcriptRef.current += (transcriptRef.current ? ' ' : '') + normalised;
            setTranscript(transcriptRef.current);

            debugLogger.current.info('deepgram', 'transcript_utterance', {
              text: normalised,
              confidence,
            });

            // Run regex matching
            if (jobRef.current) {
              const result = matcher.current.match(transcriptRef.current, jobRef.current);
              applyRegexResults(result);

              debugLogger.current.debug('regex', 'regex_attempt', {
                matches:
                  Object.keys(result.circuitUpdates).length +
                  Object.keys(result.supplyUpdates).length +
                  Object.keys(result.boardUpdates).length,
              });
            }

            // Process for alert responses
            alertManager.current?.processTranscriptForResponse(normalised);

            // Trigger Sonnet debounce
            resetSonnetDebounce();
          },
          onUtteranceEnd() {
            setIsSpeaking(false);
          },
          onError(err: Error) {
            debugLogger.current.error('deepgram', 'connection_error', {
              error: err.message,
            });
            setError(err.message);
          },
          onConnectionStateChange(state: DeepgramConnectionState) {
            setConnectionState(state);
            debugLogger.current.info('deepgram', 'connection_state', {
              state,
            });
          },
        };

        // Create and connect Deepgram
        const dgService = new DeepgramService(dgDelegate);
        deepgram.current = dgService;
        dgService.connect(keys.deepgramKey, keywords);

        // Set up audio source
        if (effectiveSource === 'companion') {
          // Companion mode: connect Socket.IO and join recording room
          // Audio will arrive via "audio-chunk" events from the phone
          if (job?.id) {
            connectCompanionSocket(job.id, dgService);
          }
        } else {
          // Local mode: capture from browser microphone
          const acDelegate: AudioCaptureDelegate = {
            onAudioData(pcmInt16: Int16Array) {
              dgService.sendAudio(pcmInt16);
            },
            onError(err: Error) {
              setError(`Microphone error: ${err.message}`);
              debugLogger.current.error('session', 'audio_error', {
                error: err.message,
              });
            },
          };

          const ac = new AudioCapture(acDelegate);
          audioCapture.current = ac;
          await ac.start();
        }

        // Keep-alive timer
        keepAliveTimer.current = setInterval(() => {
          dgService.sendKeepAlive();
        }, KEEP_ALIVE_INTERVAL_MS);

        // Duration timer
        const startTime = Date.now();
        durationTimer.current = setInterval(() => {
          setSessionDuration(Math.floor((Date.now() - startTime) / 1000));
        }, 1000);

        isRecordingRef.current = true;
        setIsRecording(true);

        debugLogger.current.info('session', 'recording_started', {
          keywords: keywords.length,
          audioSource: effectiveSource,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        debugLogger.current.error('session', 'start_failed', { error: msg });
      }
    },
    [job, applyRegexResults, resetSonnetDebounce, connectCompanionSocket]
  );

  // ---- Stop Recording ----

  const stopRecording = useCallback(() => {
    isRecordingRef.current = false;
    setIsRecording(false);

    // Clear timers
    if (sonnetDebounceTimer.current) {
      clearTimeout(sonnetDebounceTimer.current);
      sonnetDebounceTimer.current = null;
    }
    if (keepAliveTimer.current) {
      clearInterval(keepAliveTimer.current);
      keepAliveTimer.current = null;
    }
    if (durationTimer.current) {
      clearInterval(durationTimer.current);
      durationTimer.current = null;
    }

    // Stop services
    audioCapture.current?.stop();
    audioCapture.current = null;
    deepgram.current?.disconnect();
    deepgram.current = null;
    disconnectCompanionSocket();
    alertManager.current?.clearAll();

    // Log session summary BEFORE ending session (HIGH-4: must log before endSession clears state)
    debugLogger.current.info('session', 'final_transcript', {
      length: transcriptRef.current.length,
      text: transcriptRef.current.slice(0, 500),
    });
    debugLogger.current.info('session', 'field_sources_snapshot', {
      count: Object.keys(fieldSourcesRef.current).length,
    });
    debugLogger.current.info('session', 'recording_stopped', {
      regexMatches: regexMatchCountRef.current,
      sonnetCalls: claude.current?.sessionCallCount ?? 0,
      sonnetCost: claude.current?.sessionCostUSD ?? 0,
      discrepancies: discrepancyCountRef.current,
    });

    // Upload debug analytics before ending session (HIGH-5)
    const token = getToken();
    if (token) {
      debugLogger.current
        .uploadToBackend(
          API_BASE_URL,
          token,
          fieldSourcesRef.current as Record<string, string>,
          {
            source: 'web',
            regexMatches: regexMatchCountRef.current,
            sonnetCalls: claude.current?.sessionCallCount ?? 0,
            sonnetCost: claude.current?.sessionCostUSD ?? 0,
            discrepancies: discrepancyCountRef.current,
          },
          jobRef.current ? (jobRef.current as unknown as Record<string, unknown>) : undefined
        )
        .catch(() => {
          // Non-critical — best-effort upload
        });
    }

    debugLogger.current.endSession();

    setConnectionState('disconnected');
    setIsSpeaking(false);
    setInterimTranscript('');
  }, [disconnectCompanionSocket]);

  // ---- Cleanup on unmount ----

  useEffect(() => {
    return () => {
      if (isRecordingRef.current) {
        audioCapture.current?.stop();
        deepgram.current?.disconnect();
        companionSocket.current?.disconnect();
        if (keepAliveTimer.current) clearInterval(keepAliveTimer.current);
        if (durationTimer.current) clearInterval(durationTimer.current);
        if (sonnetDebounceTimer.current) clearTimeout(sonnetDebounceTimer.current);
        debugLogger.current.endSession();
      }
    };
  }, []);

  // ---- Alert Handlers ----

  const handleAlertResponse = useCallback((accepted: boolean) => {
    alertManager.current?.handleTapResponse(accepted);
  }, []);

  const dismissAlert = useCallback(() => {
    alertManager.current?.dismissCurrentAlert();
  }, []);

  // ---- Audio Source Setter ----

  const changeAudioSource = useCallback((source: AudioSource) => {
    audioSourceRef.current = source;
    setAudioSource(source);
  }, []);

  // ---- Return ----

  const state: RecordingState = {
    isRecording,
    connectionState,
    transcript,
    interimTranscript,
    isSpeaking,
    isTTSSpeaking,
    currentAlert,
    alertQueueCount,
    regexMatchCount,
    sonnetCallCount,
    sonnetCostUSD,
    discrepancyCount,
    fieldSources,
    highlights,
    recentlyUpdatedFields,
    sessionDuration,
    companionConnected,
    audioSource,
    error,
  };

  const actions: RecordingActions = {
    startRecording,
    stopRecording,
    handleAlertResponse,
    dismissAlert,
    setAudioSource: changeAudioSource,
  };

  return [state, actions];
}
