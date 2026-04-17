import {
  ApiError,
  type CCUAnalysis,
  type DocumentExtractionResponse,
  type Job,
  type JobDetail,
  type LoginResponse,
  type User,
} from './types';
import { getToken } from './auth';

/**
 * Thin typed wrapper around the Node.js backend.
 *
 * Design notes:
 * - Base URL from `NEXT_PUBLIC_API_URL` (defaults to localhost:3000 for dev).
 * - Retries only idempotent methods — the legacy client retried everything,
 *   which caused duplicate POSTs on flaky networks.
 * - Throws `ApiError` on non-2xx so callers can branch on `.status`.
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
        // Retry 5xx on idempotent methods only.
        throw new ApiError(res.status, `Server error ${res.status}`);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ApiError(res.status, body || res.statusText);
      }

      // 204 No Content — return as-is.
      if (res.status === 204) return undefined as T;

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        return (await res.json()) as T;
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

export const api = {
  baseUrl: API_BASE_URL,

  login(email: string, password: string): Promise<LoginResponse> {
    return request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  logout(): Promise<void> {
    return request<void>('/api/auth/logout', { method: 'POST' });
  },

  me(): Promise<User> {
    return request<User>('/api/auth/me');
  },

  jobs(userId: string): Promise<Job[]> {
    return request<Job[]>(`/api/jobs/${encodeURIComponent(userId)}`);
  },

  createJob(userId: string, certificateType: 'EICR' | 'EIC'): Promise<{ id: string }> {
    return request<{ id: string }>(`/api/jobs/${encodeURIComponent(userId)}`, {
      method: 'POST',
      body: JSON.stringify({ certificate_type: certificateType }),
    });
  },

  deleteJob(userId: string, jobId: string): Promise<{ success: boolean }> {
    return request(`/api/job/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
    });
  },

  /** Full job detail payload — all tabs worth of data. */
  job(userId: string, jobId: string): Promise<JobDetail> {
    return request<JobDetail>(
      `/api/job/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}`
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
      `/api/deepgram-proxy?sessionId=${encodeURIComponent(sessionId)}`
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
    return request<CCUAnalysis>('/api/analyze-ccu', {
      method: 'POST',
      body: form,
    });
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
    return request<DocumentExtractionResponse>('/api/analyze-document', {
      method: 'POST',
      body: form,
    });
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
    return request(`/api/job/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}/photos`, {
      method: 'POST',
      body: form,
    });
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
      { method: 'DELETE' }
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
      const body = await res.text().catch(() => '');
      throw new ApiError(res.status, body || res.statusText);
    }
    return res.blob();
  },

  /**
   * Partial update. Backend merges with the persisted doc, so callers
   * only need to send the fields that changed.
   */
  saveJob(
    userId: string,
    jobId: string,
    updates: Partial<JobDetail>
  ): Promise<{ success: boolean }> {
    return request(`/api/job/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },
};
