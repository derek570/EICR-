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
  /** System-wide tenant membership. Nullable for legacy users not yet bound to a company. */
  company_id?: string;
  /** Role within a company. `owner`/`admin` grant company-admin privileges; `employee` is rank-and-file. */
  company_role?: 'owner' | 'admin' | 'employee';
}

/**
 * Inspector profile — the API shape stored as one JSON array per user at
 * `settings/{userId}/inspector_profiles.json`. The backend persists the
 * blob verbatim so we can add forward-compat fields (equipment block) by
 * just shipping them in the PUT body; unknown keys round-trip untouched.
 *
 * Signature storage: when an inspector draws a new signature, the client
 * POSTs the PNG as multipart to `upload-signature` which returns the S3
 * key. That key is saved on the profile as `signature_file`. Reading back
 * goes via `GET /api/settings/:userId/signatures/:filename` as auth'd
 * bytes — browsers cannot attach the bearer token to a bare S3 URL.
 *
 * The equipment fields mirror iOS `Inspector.swift` — 5 devices × serial
 * + calibration date. They're rendered as a collapsible section; empty
 * strings are persisted as-is because the schema is permissive.
 */
export interface InspectorProfile {
  id: string;
  name: string;
  position?: string;
  organisation?: string;
  enrolment_number?: string;
  signature_file?: string;
  is_default?: boolean;
  // Equipment (mirrors iOS Inspector.swift)
  mft_serial_number?: string;
  mft_calibration_date?: string;
  continuity_serial_number?: string;
  continuity_calibration_date?: string;
  insulation_serial_number?: string;
  insulation_calibration_date?: string;
  earth_fault_serial_number?: string;
  earth_fault_calibration_date?: string;
  rcd_serial_number?: string;
  rcd_calibration_date?: string;
}

/**
 * Company branding settings — one JSON blob per user at
 * `settings/{userId}/company_settings.json`. Used by the PDF generators
 * to stamp the header on every certificate. Logo is an S3 key
 * (uploaded separately — see Phase 6b).
 */
export interface CompanySettings {
  company_name?: string;
  company_address?: string;
  company_phone?: string;
  company_email?: string;
  company_website?: string;
  company_registration?: string;
  logo_file?: string | null;
}

/**
 * Admin-tier user view — includes operational flags (active,
 * lockout, last-login) only system admins can see. Returned by
 * `GET /api/admin/users`. Extends the public User with lifecycle
 * metadata; treat as read-mostly + mutate via dedicated endpoints
 * (update / reset-password / unlock).
 */
export interface AdminUser extends User {
  is_active?: boolean;
  last_login?: string | null;
  locked_until?: string | null;
  failed_login_attempts?: number;
  created_at?: string;
}

/**
 * Minimal company row used by the admin-user edit page company picker
 * (`GET /api/admin/users/companies/list`). Full CompanySchema is
 * overkill for a dropdown — we only need to render `{id, name}` pairs.
 */
export interface CompanyLite {
  id: string;
  name: string;
}

/**
 * Member of a company — the shape returned by
 * `GET /api/companies/:companyId/users`. Thin read-only projection of
 * the underlying user row: enough to render the team list in the
 * company admin dashboard (role pill, last-login hint, active badge)
 * without exposing system-admin-only fields.
 */
export interface CompanyMember {
  id: string;
  email: string;
  name: string;
  role?: 'admin' | 'user';
  company_role?: 'owner' | 'admin' | 'employee';
  is_active?: boolean;
  last_login?: string | null;
  created_at?: string;
}

/**
 * Company-scoped job row from `GET /api/companies/:companyId/jobs`.
 * Note `user_id` / `employee_*` fields — the admin dashboard needs to
 * show who owns each job (the employee, not just the address). Not a
 * subclass of `Job` because the company listing carries extra
 * per-employee metadata and omits the full tab bags.
 */
export interface CompanyJobRow {
  id: string;
  address: string | null;
  status: 'pending' | 'processing' | 'done' | 'failed';
  created_at: string;
  updated_at?: string;
  certificate_type?: CertificateType;
  user_id?: string;
  employee_name?: string | null;
  employee_email?: string | null;
}

/**
 * Response envelope from `GET /api/companies/:companyId/stats`. Shape
 * comes from `db.getCompanyStats` — status counts + two derived totals.
 * We surface these as a tiny grid on the dashboard (no charts in 6b
 * per the handoff's scope exclusions).
 */
export interface CompanyStats {
  company?: {
    id: string;
    name: string;
    is_active?: boolean;
    created_at?: string;
  };
  jobs_by_status?: Record<string, number>;
  total_jobs?: number;
  active_employees?: number;
  jobs_last_7_days?: number;
}

/**
 * Invite response. The backend returns the *plaintext* temporary
 * password exactly once — we show it to the admin in the invite sheet
 * with a "copy once" notice and never retain it in state after the
 * modal closes. Treat the field as secret-adjacent PII.
 */
export interface InviteEmployeeResponse {
  userId: string;
  email: string;
  name: string;
  temporaryPassword: string;
}

/**
 * Paginated envelope used by the company jobs list. Matches
 * `utils/pagination.js#paginatedResponse` on the backend. Generic on
 * the row type so we can reuse it if admin surfaces need pagination
 * later.
 */
export interface Paginated<T> {
  data: T[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
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
  // `ccu_analysis` is the most-recent flat copy (kept for legacy debug
  // panels and single-board jobs); `ccu_analysis_by_board` is the per-
  // board authoritative map, keyed by `board.id`. Writing both keeps
  // existing consumers working while preventing the multi-board cross-
  // bleed the single flat field caused.
  ccu_analysis?: Record<string, unknown>;
  ccu_analysis_by_board?: Record<string, Record<string, unknown>>;
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

/**
 * Client-side API error surface.
 *
 * Fields:
 *   - `status`: HTTP status code from the response (or 0 for network errors).
 *   - `message`: human-friendly string — the backend's `error` field if it
 *     sent a `{error: "..."}` JSON envelope, otherwise the raw body text,
 *     falling back to `statusText`. Safe to show verbatim in a toast.
 *   - `body`: the parsed JSON payload when the response was
 *     `application/json`, or the raw string otherwise. Lets callers reach
 *     past the friendly `message` for structured fields like
 *     `{error, code, details}` without re-parsing.
 *
 * Pre-Wave 2, `message` was `await res.text()` verbatim which surfaced raw
 * JSON blobs (`{"error":"..."}`) in user-facing banners. Callers should
 * branch on `.status`, not on substring matches against `.message`.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
