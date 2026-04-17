/**
 * Shared domain types. Kept minimal — only the shapes Phase 1–2 need;
 * per-tab detail types land in later phases when their screens do.
 */

export interface User {
  id: string;
  email: string;
  name: string;
  company_name?: string;
  role?: 'admin' | 'user';
}

export type CertificateType = 'EICR' | 'EIC';

export interface Job {
  id: string;
  address: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  created_at: string;
  updated_at?: string;
  certificate_type?: CertificateType;
}

/**
 * Full job detail payload returned by GET /api/job/:userId/:jobId.
 * Structure mirrors the iOS `JobFormData` Swift struct (lifted here as
 * Partial<> so we can add fields per-tab as phases land without breaking
 * the rest of the app).
 *
 * Each section below is a free-form record of string/bool values — the
 * backend has historically been permissive about keys. Tab-specific
 * schemas tighten these up when the relevant phase lands.
 */
export interface JobDetail extends Job {
  // Mirror fields of the list-view Job, plus every tab's data bag:
  installation?: Record<string, unknown>;
  extent?: Record<string, unknown>;
  supply?: Record<string, unknown>;
  board?: Record<string, unknown>;
  circuits?: CircuitRow[];
  observations?: ObservationRow[];
  inspection?: Record<string, unknown>;
  design?: Record<string, unknown>;
  inspector?: InspectorInfo;
  // CCU analysis output — populated once a consumer-unit photo is uploaded.
  ccu_analysis?: Record<string, unknown>;
  /** Most recent recording session id (for resume/review). */
  last_session_id?: string;
}

export interface CircuitRow {
  id: string;
  number?: string;
  description?: string;
  [key: string]: unknown;
}

export interface ObservationRow {
  id: string;
  code?: 'C1' | 'C2' | 'C3' | 'FI';
  description?: string;
  location?: string;
  remedial?: string;
  /**
   * Filenames of photos attached to this observation. The backend stores
   * bytes in S3 under `jobs/{userId}/{folderName}/photos/{filename}` and
   * renders at `/api/job/:userId/:jobId/photos/:filename`. Matches the
   * iOS `Observation.photos` field (serialised under the same JSON key)
   * so a job round-trips losslessly between clients.
   */
  photos?: string[];
}

export interface InspectorInfo {
  id?: string;
  name?: string;
  position?: string;
  enrolment_number?: string;
  signature_key?: string;
  organisation?: string;
}

/**
 * Response from POST /api/analyze-ccu. Claude Sonnet 4.6 analyses a
 * consumer-unit photo and returns board-level metadata, main-switch +
 * SPD fields, a circuits array (one per device in order), a
 * free-form `questionsForInspector` list, and a usage/cost breakdown.
 *
 * Kept permissive — the backend prompt evolves and occasionally adds
 * new keys. `apply-ccu-analysis.ts` picks only the fields it knows
 * about, so unknown additions are inert until wired up.
 */
export interface CCUAnalysisCircuit {
  circuit_number: number;
  label?: string | null;
  ocpd_type?: 'B' | 'C' | 'D' | null;
  ocpd_rating_a?: string | null;
  ocpd_bs_en?: string | null;
  ocpd_breaking_capacity_ka?: string | null;
  is_rcbo?: boolean;
  rcd_protected?: boolean;
  rcd_type?: 'AC' | 'A' | 'B' | 'F' | 'S' | null;
  rcd_rating_ma?: string | null;
  rcd_bs_en?: string | null;
}

export interface CCUAnalysis {
  board_manufacturer?: string | null;
  board_model?: string | null;
  main_switch_rating?: string | null;
  main_switch_bs_en?: string | null;
  main_switch_type?: string | null;
  main_switch_poles?: string | null;
  main_switch_current?: string | null;
  main_switch_voltage?: string | null;
  main_switch_position?: 'left' | 'right' | null;
  spd_present?: boolean;
  spd_bs_en?: string | null;
  spd_type?: string | null;
  spd_rated_current_a?: string | null;
  spd_short_circuit_ka?: string | null;
  /** Supply-section fallbacks derived from main switch. */
  spd_rated_current?: string | null;
  spd_type_supply?: string | null;
  circuits?: CCUAnalysisCircuit[];
  questionsForInspector?: string[];
  confidence?: {
    overall?: number;
    image_quality?: 'clear' | 'partially_readable' | 'poor';
    uncertain_fields?: string[];
    message?: string;
  };
  gptVisionCost?: {
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    image_count: number;
  };
  // geometric, etc. are passed through but unused by the merge helper.
  [key: string]: unknown;
}

/**
 * Response from POST /api/analyze-document. GPT Vision extracts EICR/EIC
 * certificate data from an image (typed cert, handwritten test sheet,
 * phone snap). Unlike CCU, doc extraction returns structured data only —
 * no `questionsForInspector`.
 *
 * Field keys match the backend prompt schema in
 * `src/routes/extraction.js:1349-1420` 1:1 so the merge helper can copy
 * straight onto JobDetail section bags. Kept permissive (all optional +
 * index signature) so prompt additions don't break the client.
 */
export interface DocumentExtractionCircuit {
  circuit_ref?: string;
  circuit_designation?: string;
  live_csa_mm2?: string;
  cpc_csa_mm2?: string;
  wiring_type?: string;
  ref_method?: string;
  number_of_points?: string;
  ocpd_type?: string;
  ocpd_rating_a?: string;
  ocpd_bs_en?: string;
  ocpd_breaking_capacity_ka?: string;
  rcd_type?: string;
  rcd_operating_current_ma?: string;
  rcd_bs_en?: string;
  ring_r1_ohm?: string;
  ring_rn_ohm?: string;
  ring_r2_ohm?: string;
  r1_r2_ohm?: string;
  r2_ohm?: string;
  ir_live_live_mohm?: string;
  ir_live_earth_mohm?: string;
  measured_zs_ohm?: string;
  polarity_confirmed?: string;
  rcd_time_ms?: string;
  rcd_button_confirmed?: string;
  [key: string]: unknown;
}

export interface DocumentExtractionObservation {
  code?: string;
  observation_text?: string;
  item_location?: string;
  schedule_item?: string;
  regulation?: string;
  [key: string]: unknown;
}

export interface DocumentExtractionFormData {
  installation_details?: Record<string, unknown>;
  supply_characteristics?: Record<string, unknown>;
  board_info?: Record<string, unknown>;
  circuits?: DocumentExtractionCircuit[];
  observations?: DocumentExtractionObservation[];
}

export interface DocumentExtractionResponse {
  success: boolean;
  formData: DocumentExtractionFormData;
}

/** Envelope used by POST /api/auth/login. */
export interface LoginResponse {
  token: string;
  user: User;
}

/** Client-side API error surface. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
