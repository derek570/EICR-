import { ApiError, type Job, type JobDetail, type LoginResponse, type User } from './types';
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
