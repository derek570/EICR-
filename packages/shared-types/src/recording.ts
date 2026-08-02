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

export interface PromptCacheEconomicsTotals {
  cacheReadCost: number;
  cacheWriteCost: number;
  uncachedInputCost: number;
  outputCost: number;
  actualInputCost: number;
  actualCost: number;
  noCacheInputCost: number;
  noCacheCost: number;
  netSavings: number;
  netSavingsPercent: number;
}

export interface PromptCacheEconomics extends PromptCacheEconomicsTotals {
  perModel?: Record<string, PromptCacheEconomicsTotals>;
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
  /** Additive backend wire detail; older consumers safely ignore it. */
  sonnet?: {
    cacheEconomics?: PromptCacheEconomics;
    [key: string]: unknown;
  };
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
  /**
   * A2 (2026-07-28) — the backend stamps this when the write superseded a
   * same-turn `clear_reading` for the identical circuit slot that the server
   * then dropped from the wire (P5 same-turn collapse, 2026-07-23). Consumers
   * treat it as "the server already cleared this cell", so overwriting a
   * populated cell is a replacement rather than a priority regression.
   * OMITTED (never `false`) on ordinary writes.
   */
  replaces_cleared?: boolean;
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
