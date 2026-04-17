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
