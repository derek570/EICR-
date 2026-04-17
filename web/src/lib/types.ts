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
  photo_keys?: string[];
}

export interface InspectorInfo {
  id?: string;
  name?: string;
  position?: string;
  enrolment_number?: string;
  signature_key?: string;
  organisation?: string;
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
