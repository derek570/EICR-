import { type ZodTypeAny } from 'zod';
import {
  type AdminUser,
  ApiError,
  type CCUAnalysis,
  type CompanyJobRow,
  type CompanyMember,
  type CompanySettings,
  type CompanyStats,
  type DocumentExtractionResponse,
  type InspectorProfile,
  type InviteEmployeeResponse,
  type Job,
  type JobDetail,
  type LoginResponse,
  type Paginated,
  type User,
} from './types';
import {
  AdminSuccessResponseSchema,
  AdminUserListSchema,
  AdminUserSchema,
  CCUAnalysisSchema,
  CompanyJobListSchema,
  CompanyMemberListSchema,
  CompanySettingsSchema,
  CompanyStatsSchema,
  CreateJobResponseSchema,
  DeepgramKeyResponseSchema,
  DeleteJobResponseSchema,
  DeleteObservationPhotoResponseSchema,
  DocumentExtractionResponseSchema,
  InspectorProfileListSchema,
  InviteEmployeeResponseSchema,
  JobDetailSchema,
  JobListSchema,
  LoginResponseSchema,
  SaveJobResponseSchema,
  UpdateSettingsResponseSchema,
  UploadLogoResponseSchema,
  UploadObservationPhotoResponseSchema,
  UploadSignatureResponseSchema,
  UserSchema,
  parseOrWarn,
  parseOrThrow,
  CompanyLiteListSchema,
} from './adapters';
import type { CompanyLite } from './types';
import { getToken } from './auth';

/**
 * Thin typed wrapper around the Node.js backend.
 *
 * Design notes:
 * - Base URL from `NEXT_PUBLIC_API_URL` (defaults to localhost:3000 for dev).
 * - Retries only idempotent methods — the legacy client retried everything,
 *   which caused duplicate POSTs on flaky networks.
 * - Throws `ApiError` on non-2xx so callers can branch on `.status`.
 * - **Wave 2b:** every successful response is routed through a zod schema
 *   from `./adapters`. Validation is intentionally non-throwing (`parseOrWarn`
 *   logs a console warning and falls back to the raw payload on drift) so
 *   prompt / DB evolution on the backend doesn't block the inspector mid-
 *   certificate. See `./adapters/validate.ts` for the rationale.
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Low-level fetch. Responsible for auth, retries, error envelope parsing.
 * Does NOT validate the response — that's the adapter's job. Callers should
 * prefer the typed `api.*` helpers which wrap this in `parseOrWarn(...)`.
 *
 * The schema is optional so routes that return opaque bodies (JWT-mint
 * responses the caller consumes as-is, HTML error pages on proxy failure)
 * can skip validation without fighting the type system.
 */
/**
 * Wave 4 batch 2 (D12 tail): a handful of endpoints earn a strict-parse
 * contract. When `options.strict === true`, a schema mismatch throws
 * `ApiError('Response shape invalid')` instead of falling back to the
 * raw payload. See `./adapters/validate.ts#parseOrThrow` for the full
 * rationale — short version, login + admin writes where silent drift is
 * unsafe.
 */
interface RequestOptions {
  strict?: boolean;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  schema?: ZodTypeAny,
  options: RequestOptions = {}
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const maxAttempts = IDEMPOTENT.has(method) ? 3 : 1;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(`${API_BASE_URL}${path}`, {
        ...init,
        method,
        headers,
        // Always include credentials so cookie-based auth works alongside
        // Authorization header (backend accepts either).
        credentials: 'include',
      });

      if (res.status >= 500) {
        // Retry 5xx on idempotent methods only. Parse the body so
        // callers still get `ApiError.body` once retries are exhausted;
        // skip it here and let the shared non-ok branch (below) handle
        // the final 5xx on non-idempotent / last-attempt paths.
        if (IDEMPOTENT.has(method) && attempt < maxAttempts - 1) {
          throw new ApiError(res.status, `Server error ${res.status}`);
        }
        // Fall through to the non-ok branch so we get structured body
        // parsing on the final attempt / non-idempotent methods.
      }

      if (!res.ok) {
        const { message, body } = await parseErrorBody(res);
        throw new ApiError(res.status, message, body);
      }

      // 204 No Content — return as-is.
      if (res.status === 204) return undefined as T;

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const raw = (await res.json()) as unknown;
        if (schema) {
          // Strict mode throws ApiError on drift (login + admin writes);
          // default is parseOrWarn which logs + returns raw for graceful
          // degradation on read paths.
          if (options.strict) {
            return parseOrThrow(schema, raw, `${method} ${path}`, res.status) as T;
          }
          return parseOrWarn(schema, raw, `${method} ${path}`) as T;
        }
        return raw as T;
      }
      return (await res.text()) as unknown as T;
    } catch (err) {
      lastError = err;
      if (
        attempt < maxAttempts - 1 &&
        (err instanceof TypeError || // network error
          (err instanceof ApiError && err.status >= 500))
      ) {
        await wait(2 ** attempt * 500);
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error('Request failed');
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pull a human-friendly message + the structured body out of a non-2xx
 * response. The backend uses two shapes:
 *   - JSON: `{error: "...", code?, details?}` for most error paths.
 *   - plain text / HTML: upstream proxies + some legacy routes.
 *
 * Pre-Wave 2 this function inlined `await res.text()` and surfaced the
 * raw JSON blob to users ("{\"error\":\"invalid\"}"). Now the JSON
 * envelope's `error` field becomes the friendly message and the parsed
 * payload is available on `ApiError.body` for callers that want
 * structured access.
 */
async function parseErrorBody(res: Response): Promise<{ message: string; body: unknown }> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const parsed = (await res.json()) as unknown;
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const errValue = (parsed as { error: unknown }).error;
        if (typeof errValue === 'string' && errValue.length > 0) {
          return { message: errValue, body: parsed };
        }
      }
      // Parsed but no recognised `error` field — fall back to statusText
      // rather than stringifying the whole object back into the message.
      return { message: res.statusText || `HTTP ${res.status}`, body: parsed };
    } catch {
      // JSON content-type but unparseable — fall through to text below.
    }
  }
  const text = await res.text().catch(() => '');
  return { message: text || res.statusText || `HTTP ${res.status}`, body: text };
}

export const api = {
  baseUrl: API_BASE_URL,

  login(email: string, password: string): Promise<LoginResponse> {
    // Strict parse — a malformed LoginResponse would silently persist
    // a broken `token` / `user` into localStorage and the follow-up
    // `/api/auth/me` would read as "not authenticated" in a way that's
    // indistinguishable from a wrong-password failure. Throwing here
    // surfaces the server-side shape bug cleanly in the login form's
    // existing `catch (err) { setError(err.message) }` path.
    return request<LoginResponse>(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      },
      LoginResponseSchema,
      { strict: true }
    );
  },

  logout(): Promise<void> {
    return request<void>('/api/auth/logout', { method: 'POST' });
  },

  me(): Promise<User> {
    return request<User>('/api/auth/me', {}, UserSchema);
  },

  jobs(userId: string): Promise<Job[]> {
    return request<Job[]>(`/api/jobs/${encodeURIComponent(userId)}`, {}, JobListSchema);
  },

  createJob(userId: string, certificateType: 'EICR' | 'EIC'): Promise<{ id: string }> {
    return request<{ id: string }>(
      `/api/jobs/${encodeURIComponent(userId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ certificate_type: certificateType }),
      },
      CreateJobResponseSchema
    );
  },

  deleteJob(userId: string, jobId: string): Promise<{ success: boolean }> {
    return request(
      `/api/job/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}`,
      { method: 'DELETE' },
      DeleteJobResponseSchema
    );
  },

  /** Full job detail payload — all tabs worth of data. */
  job(userId: string, jobId: string): Promise<JobDetail> {
    return request<JobDetail>(
      `/api/job/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}`,
      {},
      JobDetailSchema
    );
  },

  /**
   * Fetch a short-lived Deepgram Nova-3 API key scoped to a single
   * recording session. Backend mints the token via the Deepgram
   * Management API and returns `{ key: string }`. Token is typically
   * valid for ~10 minutes — callers should re-request on reconnect.
   */
  deepgramKey(sessionId: string): Promise<{ key: string }> {
    return request<{ key: string }>(
      `/api/deepgram-proxy?sessionId=${encodeURIComponent(sessionId)}`,
      {},
      DeepgramKeyResponseSchema
    );
  },

  /**
   * Analyse a consumer-unit photo via GPT Vision + optional RCD-type
   * web-search pass. Backend returns board metadata, main-switch +
   * SPD fields, a circuits array, and `questionsForInspector`. Single
   * multipart upload under the field name "photo"; max ~20MB.
   *
   * Response shape is permissive on purpose — Sonnet occasionally adds
   * new fields and the merge helper (`apply-ccu-analysis.ts`) picks
   * only the keys it knows about. Callers should treat unknown fields
   * as informational.
   */
  analyzeCCU(photo: Blob | File): Promise<CCUAnalysis> {
    const form = new FormData();
    form.append('photo', photo);
    return request<CCUAnalysis>(
      '/api/analyze-ccu',
      { method: 'POST', body: form },
      CCUAnalysisSchema
    );
  },

  /**
   * Extract EICR/EIC form data from a photo of a prior certificate,
   * handwritten test sheet, or typed record. Backend uses GPT Vision
   * and returns the full formData envelope (installation, supply,
   * board, circuits, observations). Image only — PDFs not supported
   * because the backend hard-codes the `image/jpeg` data URL
   * (`src/routes/extraction.js:1425`).
   *
   * Same multipart shape as `analyzeCCU` — single file under the
   * field name "photo". Merge helper
   * (`apply-document-extraction.ts`) handles the 3-tier priority
   * guard and section routing.
   */
  analyzeDocument(photo: Blob | File): Promise<DocumentExtractionResponse> {
    const form = new FormData();
    form.append('photo', photo);
    return request<DocumentExtractionResponse>(
      '/api/analyze-document',
      { method: 'POST', body: form },
      DocumentExtractionResponseSchema
    );
  },

  /**
   * Upload a single observation photo. Multipart POST to
   * `/api/job/:userId/:jobId/photos` with the file under the field
   * name "photo" (matches iOS `APIClient.uploadObservationPhoto`).
   *
   * The backend generates the final filename server-side
   * (`photo_{timestamp}.{ext}`), writes to S3, and returns the canonical
   * URLs. Callers should append the returned `filename` to the
   * observation's `photos` array and persist via `saveJob`.
   *
   * Images only — the backend accepts image/jpeg, png, gif, webp, heic
   * (see `src/routes/photos.js` `IMAGE_MIMES`). Don't pre-convert HEIC
   * on iOS Safari; the server handles it.
   */
  uploadObservationPhoto(
    userId: string,
    jobId: string,
    photo: Blob | File
  ): Promise<{
    success: true;
    photo: { filename: string; url: string; thumbnail_url: string; uploaded_at: string };
  }> {
    const form = new FormData();
    form.append('photo', photo);
    return request(
      `/api/job/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}/photos`,
      { method: 'POST', body: form },
      UploadObservationPhotoResponseSchema
    );
  },

  /**
   * Delete a single photo from the backend. The handler (at
   * `src/routes/photos.js:193`) walks a handful of S3 paths to find the
   * file, so callers just pass the filename returned by
   * `uploadObservationPhoto`. After the request resolves, remove the
   * filename from the observation's `photos` array and persist.
   */
  deleteObservationPhoto(
    userId: string,
    jobId: string,
    filename: string
  ): Promise<{ success: true }> {
    return request(
      `/api/job/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}/photos/${encodeURIComponent(filename)}`,
      { method: 'DELETE' },
      DeleteObservationPhotoResponseSchema
    );
  },

  /**
   * Fetch a photo as a Blob with the bearer token attached. We can't
   * use a plain `<img src>` for these URLs because the browser doesn't
   * attach our Authorization header; instead, fetch the bytes here and
   * the caller wraps the result in `URL.createObjectURL` (and revokes
   * on unmount to avoid leaking blob URLs).
   */
  async fetchPhotoBlob(
    userId: string,
    jobId: string,
    filename: string,
    opts: { thumbnail?: boolean } = {}
  ): Promise<Blob> {
    const token = getToken();
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const qs = opts.thumbnail ? '?thumbnail=true' : '';
    const res = await fetch(
      `${API_BASE_URL}/api/job/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}/photos/${encodeURIComponent(filename)}${qs}`,
      { headers, credentials: 'include' }
    );
    if (!res.ok) {
      const { message, body } = await parseErrorBody(res);
      throw new ApiError(res.status, message, body);
    }
    return res.blob();
  },

  /**
   * Partial update. Backend merges with the persisted doc, so callers
   * only need to send the fields that changed.
   *
   * Uses PUT to match the route registered at `src/routes/jobs.js:651`
   * (`router.put('/job/:userId/:jobId', …)`). The backend performs a
   * server-side merge, so a PUT with a partial body still behaves like
   * a patch from the caller's perspective.
   */
  saveJob(
    userId: string,
    jobId: string,
    updates: Partial<JobDetail>
  ): Promise<{ success: boolean }> {
    return request(
      `/api/job/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(updates),
      },
      SaveJobResponseSchema
    );
  },

  // ----------------------------------------------------------------
  // Settings — inspector profiles + signatures (Phase 6a)
  // ----------------------------------------------------------------

  /**
   * Fetch inspector profiles. The backend stores a single JSON array per
   * user; we return it as-is so the caller can own the ordering /
   * default-flag logic. Missing file returns `[]`.
   */
  inspectorProfiles(userId: string): Promise<InspectorProfile[]> {
    return request<InspectorProfile[]>(
      `/api/inspector-profiles/${encodeURIComponent(userId)}`,
      {},
      InspectorProfileListSchema
    );
  },

  /**
   * Replace the full inspector profiles array. Not a PATCH — the backend
   * has no per-profile endpoint and we always send the full list. Matches
   * iOS `APIClient.updateInspectorProfiles`. Concurrency model is
   * last-writer-wins, same as iOS.
   */
  updateInspectorProfiles(
    userId: string,
    profiles: InspectorProfile[]
  ): Promise<{ success: true }> {
    return request(
      `/api/inspector-profiles/${encodeURIComponent(userId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(profiles),
      },
      UpdateSettingsResponseSchema
    );
  },

  /**
   * Upload a signature PNG. Returns `{ signature_file }` where
   * `signature_file` is the full S3 key the caller stores on the
   * inspector profile. Two-step: the caller then PUTs the full
   * profiles array with the key merged in. We never inline base64
   * — keeps the profiles blob small and reads cacheable.
   *
   * Multipart field name is "signature" (backend multer config in
   * `src/routes/settings.js`). PNG or JPEG; 10MB cap.
   */
  uploadSignature(
    userId: string,
    blob: Blob | File
  ): Promise<{ success: true; signature_file: string }> {
    const form = new FormData();
    // Name the part so multer writes a sensible on-disk filename; the
    // final S3 filename is regenerated server-side anyway.
    const file =
      blob instanceof File ? blob : new File([blob], 'signature.png', { type: 'image/png' });
    form.append('signature', file);
    return request(
      `/api/inspector-profiles/${encodeURIComponent(userId)}/upload-signature`,
      { method: 'POST', body: form },
      UploadSignatureResponseSchema
    );
  },

  /**
   * Fetch a signature image as a Blob. The stored `signature_file` on
   * a profile is the full S3 key
   * (`settings/{userId}/signatures/{filename}`); we only care about the
   * basename for the route. Browsers can't attach our bearer header to
   * a raw S3 URL, so this streams through an auth'd backend endpoint
   * (`GET /api/settings/:userId/signatures/:filename`). Wrap the
   * returned Blob in `URL.createObjectURL` and revoke on unmount —
   * identical pattern to `fetchPhotoBlob`.
   */
  async fetchSignatureBlob(userId: string, signatureFile: string): Promise<Blob> {
    const filename = signatureFile.split('/').pop() ?? signatureFile;
    const token = getToken();
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(
      `${API_BASE_URL}/api/settings/${encodeURIComponent(userId)}/signatures/${encodeURIComponent(filename)}`,
      { headers, credentials: 'include' }
    );
    if (!res.ok) {
      const { message, body } = await parseErrorBody(res);
      throw new ApiError(res.status, message, body);
    }
    return res.blob();
  },

  // ----------------------------------------------------------------
  // Settings — company branding + logo (Phase 6b)
  // ----------------------------------------------------------------

  /**
   * Fetch the company branding JSON. The backend returns sensible empty
   * defaults when no blob exists (so the form always has something to
   * render), matching the shape we type as `CompanySettings`.
   */
  companySettings(userId: string): Promise<CompanySettings> {
    return request<CompanySettings>(
      `/api/settings/${encodeURIComponent(userId)}/company`,
      {},
      CompanySettingsSchema
    );
  },

  /**
   * Persist company branding. Backend does a full-blob write (no merge
   * on the server side), so pass the full object. The caller owns
   * merging partial edits — we don't shadow that decision here.
   */
  updateCompanySettings(userId: string, settings: CompanySettings): Promise<{ success: true }> {
    return request(
      `/api/settings/${encodeURIComponent(userId)}/company`,
      {
        method: 'PUT',
        body: JSON.stringify(settings),
      },
      UpdateSettingsResponseSchema
    );
  },

  /**
   * Upload a company logo. Two-step flow mirrors `uploadSignature`:
   * POST the bytes, get back an S3 key, merge onto `company_settings.logo_file`,
   * then PUT the settings blob. If we PUT first and upload failed, the
   * branding would point at a non-existent key — so order matters.
   *
   * Multipart field name is "logo" (backend multer config). PNG / JPEG
   * only, 10MB cap. No SVG — the PDF generator inlines images raw and
   * SVGs are a script-injection vector.
   */
  uploadCompanyLogo(
    userId: string,
    blob: Blob | File
  ): Promise<{ success: true; logo_file: string }> {
    const form = new FormData();
    // Wrap raw Blob in a File so multer gets a usable on-disk filename;
    // the server regenerates the final S3 filename anyway.
    const file = blob instanceof File ? blob : new File([blob], 'logo.png', { type: 'image/png' });
    form.append('logo', file);
    return request(
      `/api/settings/${encodeURIComponent(userId)}/logo`,
      { method: 'POST', body: form },
      UploadLogoResponseSchema
    );
  },

  /**
   * Fetch a logo image as a Blob. Same pattern as `fetchSignatureBlob`
   * — strip the S3 key down to its basename, hit the auth'd GET route,
   * wrap in `URL.createObjectURL` on the caller side and revoke on
   * unmount. We can't use a plain `<img src>` because the browser
   * won't attach the bearer token.
   */
  async fetchLogoBlob(userId: string, logoFile: string): Promise<Blob> {
    const filename = logoFile.split('/').pop() ?? logoFile;
    const token = getToken();
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(
      `${API_BASE_URL}/api/settings/${encodeURIComponent(userId)}/logo/${encodeURIComponent(filename)}`,
      { headers, credentials: 'include' }
    );
    if (!res.ok) {
      const { message, body } = await parseErrorBody(res);
      throw new ApiError(res.status, message, body);
    }
    return res.blob();
  },

  // ----------------------------------------------------------------
  // Companies — company-admin dashboard (Phase 6b)
  // ----------------------------------------------------------------

  /**
   * List all users in a company. Gated by `requireCompanyAdmin` on the
   * backend; callers should role-check before rendering the link that
   * hits this so non-admins never trigger the 403.
   */
  companyUsers(companyId: string): Promise<CompanyMember[]> {
    return request<CompanyMember[]>(
      `/api/companies/${encodeURIComponent(companyId)}/users`,
      {},
      CompanyMemberListSchema
    );
  },

  /**
   * List jobs across a company. Always paginated from the web client
   * (we pass `limit` + `offset`) so the dashboard can page instead of
   * slurping everything. The backend only enables pagination if *some*
   * query param is present; we always send both to keep the response
   * shape consistent (`Paginated<CompanyJobRow>`).
   */
  companyJobs(
    companyId: string,
    params: { limit?: number; offset?: number; employeeId?: string } = {}
  ): Promise<Paginated<CompanyJobRow>> {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (params.employeeId) qs.set('employee_id', params.employeeId);
    return request<Paginated<CompanyJobRow>>(
      `/api/companies/${encodeURIComponent(companyId)}/jobs?${qs.toString()}`,
      {},
      CompanyJobListSchema
    );
  },

  /** Company-level counts envelope (see `CompanyStats`). */
  companyStats(companyId: string): Promise<CompanyStats> {
    return request<CompanyStats>(
      `/api/companies/${encodeURIComponent(companyId)}/stats`,
      {},
      CompanyStatsSchema
    );
  },

  /**
   * Invite a new employee. The backend creates a user with a random
   * temporary password and returns the plaintext string in the
   * response — the admin is expected to copy it and hand it off
   * manually (no email sending). Callers MUST show the password once
   * and never persist it past the modal close. See
   * `InviteEmployeeResponse` for the exact shape.
   */
  inviteEmployee(
    companyId: string,
    body: { name: string; email: string }
  ): Promise<InviteEmployeeResponse> {
    return request<InviteEmployeeResponse>(
      `/api/companies/${encodeURIComponent(companyId)}/invite`,
      { method: 'POST', body: JSON.stringify(body) },
      InviteEmployeeResponseSchema
    );
  },

  // ----------------------------------------------------------------
  // Admin — system-admin user management (Phase 6c)
  // ----------------------------------------------------------------

  /**
   * Paginated user list. We always pass `limit` + `offset` so the backend
   * returns the `Paginated<AdminUser>` envelope (it falls back to a bare
   * array if no pagination params are present). Same pattern as
   * `companyJobs` in 6b — keeps the response shape consistent so callers
   * don't need a union type.
   */
  adminListUsers(params: { limit?: number; offset?: number } = {}): Promise<Paginated<AdminUser>> {
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return request<Paginated<AdminUser>>(
      `/api/admin/users?${qs.toString()}`,
      {},
      AdminUserListSchema
    );
  },

  /**
   * Create a user as a system admin. Unlike `inviteEmployee` (which
   * generates a temporary password server-side), the admin chooses the
   * initial password here — backend validates ≥ 8 chars. Returns the
   * fully-hydrated `AdminUser` on success, 409 on duplicate email.
   */
  adminCreateUser(body: {
    email: string;
    name: string;
    password: string;
    company_name?: string;
    role?: 'admin' | 'user';
    company_id?: string;
    company_role?: 'owner' | 'admin' | 'employee';
  }): Promise<AdminUser> {
    return request<AdminUser>(
      '/api/admin/users',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      AdminUserSchema
    );
  },

  /**
   * Patch a user row. Backend accepts any subset of
   * `{name, email, company_name, role, is_active, company_id, company_role}`;
   * unknown fields are ignored. The backend enforces self-demotion /
   * self-deactivation / self-reassignment guards (400 on any of them)
   * so the client-side disabling on the edit form is purely UX — the
   * server is the source of truth.
   *
   * Wave 4 batch 2: strict parse — a malformed success response would
   * silently read as "update landed" and hide real backend regressions.
   */
  adminUpdateUser(
    userId: string,
    patch: {
      name?: string;
      email?: string;
      /**
       * Pass `null` to clear the company name on the backend. Passing
       * an empty string persists the literal `""` and causes silent
       * data corruption (the row still looks "unassigned" but every
       * search and join treats it as a valid company name).
       */
      company_name?: string | null;
      role?: 'admin' | 'user';
      is_active?: boolean;
      /**
       * Null clears the company assignment entirely; a UUID string
       * moves the user into that company. Must match a row in
       * `companies.id` — no FK check here, the backend enforces via
       * the reference on write.
       */
      company_id?: string | null;
      /**
       * Null clears the company role; the enum values match the
       * three-tier model enforced server-side.
       */
      company_role?: 'owner' | 'admin' | 'employee' | null;
    }
  ): Promise<{ success: true }> {
    return request(
      `/api/admin/users/${encodeURIComponent(userId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(patch),
      },
      AdminSuccessResponseSchema,
      { strict: true }
    );
  },

  /**
   * Reset another user's password. Backend hashes, persists, and
   * increments the user's token version so every live JWT they hold
   * is invalidated on the next API call. Caller should surface the
   * "existing sessions signed out" note so the admin knows.
   *
   * Wave 4 batch 2: strict parse — destructive action; "silent drift
   * reads as success" would hide a real backend failure.
   */
  adminResetPassword(userId: string, password: string): Promise<{ success: true }> {
    return request(
      `/api/admin/users/${encodeURIComponent(userId)}/reset-password`,
      {
        method: 'POST',
        body: JSON.stringify({ password }),
      },
      AdminSuccessResponseSchema,
      { strict: true }
    );
  },

  /**
   * Clear a lockout. Backend resets `failed_login_attempts` +
   * `locked_until` so the user can attempt login again immediately.
   * No-op if the user isn't locked — callers should gate the button
   * on `locked_until > now` so a naive double-click doesn't fire a
   * pointless POST.
   *
   * Wave 4 batch 2: strict parse for the same reason as the other
   * admin writes.
   */
  adminUnlockUser(userId: string): Promise<{ success: true }> {
    return request(
      `/api/admin/users/${encodeURIComponent(userId)}/unlock`,
      { method: 'POST' },
      AdminSuccessResponseSchema,
      { strict: true }
    );
  },

  /**
   * Lightweight `{id, name}[]` company list for the admin-user edit
   * page's company picker. Read path, so uses the default
   * `parseOrWarn` — a drifting name/id field shouldn't block the admin
   * editing a user.
   */
  adminListCompanies(): Promise<CompanyLite[]> {
    return request<CompanyLite[]>('/api/admin/users/companies/list', {}, CompanyLiteListSchema);
  },
};
