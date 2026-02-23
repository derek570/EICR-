/**
 * Recording pipeline types — Deepgram, WebSocket, cost tracking, CCU analysis.
 */

export type DeepgramConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  punctuated_word?: string;
}

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
  id?: string;
  type: 'orphaned' | 'out_of_range' | 'unclear';
  fieldKey: string;
  circuitNumber?: number;
  circuitRef?: string;
  question: string;
  value?: string;
}

export type SleepState = 'active' | 'dozing' | 'sleeping';

export interface TranscriptHighlight {
  keyword: string;
  value: string;
  fieldKey: string;
  keywordCandidates: string[];
}

export interface ExtractedReading {
  field: string;
  value: string | number;
  circuit?: number | string;
  source?: string;
  unit?: string;
  confidence?: number;
}

export interface RollingExtractionResult {
  readings?: ExtractedReading[];
  extractedReadings?: ExtractedReading[];
  observations?: Array<{
    code: string;
    text: string;
    location?: string;
    scheduleItem?: string;
  }>;
  questionsForUser?: Array<{
    field: string;
    circuit?: number;
    question: string;
    type: 'orphaned' | 'out_of_range' | 'unclear';
    value?: string;
  }>;
  validationAlerts?: ValidationAlert[];
  contextUpdate?: ContextUpdate;
  regexSuggestions?: RegexSuggestion[];
}

export interface ValidationAlert {
  type: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  suggestedAction?: string;
}

export interface ContextUpdate {
  activeCircuit?: string;
  activeTestType?: string;
}

export interface RegexSuggestion {
  pattern: string;
  field: string;
  description: string;
}

// CCU Photo Analysis

export interface CCUCircuit {
  circuit_number: number;
  label: string | null;
  ocpd_type: string | null;
  ocpd_rating_a: string | null;
  ocpd_bs_en: string | null;
  ocpd_breaking_capacity_ka: string | null;
  is_rcbo: boolean;
  rcd_protected: boolean;
  rcd_rating_ma: string | null;
  rcd_bs_en: string | null;
}

export interface CCUConfidence {
  overall: number;
  image_quality: 'clear' | 'partially_readable' | 'poor';
  uncertain_fields: string[];
  message: string;
}

export interface CCUAnalysisResult {
  board_manufacturer: string | null;
  board_model: string | null;
  main_switch_rating: string | null;
  main_switch_position: 'left' | 'right' | null;
  main_switch_bs_en: string | null;
  main_switch_type: string | null;
  main_switch_poles: string | null;
  main_switch_current: string | null;
  main_switch_voltage: string | null;
  spd_present: boolean;
  spd_bs_en: string | null;
  spd_type: string | null;
  spd_rated_current_a: string | null;
  spd_short_circuit_ka: string | null;
  confidence: CCUConfidence;
  circuits: CCUCircuit[];
}
