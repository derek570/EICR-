/**
 * API client for CertMate Desktop Web App
 * Ported from frontend/src/lib/api.ts
 */

import type {
  User,
  Job,
  JobDetail,
  SaveJobData,
  UserDefaults,
  CompanySettings,
  FieldSchema,
  InspectorProfile,
  JobPhoto,
  JobVersion,
  JobVersionDetail,
  Regulation,
  Client,
  ClientDetail,
  CreateClientData,
  Property,
  CreatePropertyData,
  PropertyJob,
  OcrResult,
  OcrExtractedData,
  CCUAnalysisResult,
  BillingStatus,
  CalendarStatus,
  CalendarEvent,
  WhatsAppStatus,
  AnalyticsData,
} from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  const method = (options.method ?? 'GET').toUpperCase();
  const canRetry = IDEMPOTENT_METHODS.has(method);
  const effectiveRetries = canRetry ? maxRetries : 0;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.status >= 400 && response.status < 500) {
        return response;
      }

      if (response.status >= 500) {
        throw new Error(`Server error: ${response.status}`);
      }

      return response;
    } catch (error) {
      lastError = error as Error;

      if (attempt < effectiveRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Request failed after retries');
}

function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetchWithRetry(url, { ...options, headers });
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new ApiError(response.status, errorText);
  }
  return response.json();
}

export const api = {
  baseUrl: API_BASE_URL,

  // ============= Health =============

  async health(): Promise<{ status: string }> {
    const response = await fetch(`${API_BASE_URL}/api/health`);
    return handleResponse(response);
  },

  // ============= Auth =============

  async login(email: string, password: string): Promise<{ token: string; user: User }> {
    const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return handleResponse(response);
  },

  async logout(): Promise<void> {
    const token = getToken();
    await fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
  },

  async getMe(): Promise<User> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/auth/me`);
    return handleResponse(response);
  },

  // ============= Jobs =============

  async getJobs(userId: string): Promise<Job[]> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/jobs/${userId}`);
    return handleResponse(response);
  },

  async getJob(userId: string, jobId: string): Promise<JobDetail> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}`);
    return handleResponse(response);
  },

  async saveJob(userId: string, jobId: string, data: SaveJobData): Promise<{ success: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async createBlankJob(
    userId: string,
    certificateType: string
  ): Promise<{ success: boolean; jobId: string }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/jobs/${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ certificate_type: certificateType }),
    });
    // Backend returns { id: '...' } not { jobId: '...' } — normalise
    const data = await handleResponse<Record<string, unknown>>(response);
    return {
      success: true,
      jobId: (data.jobId as string) || (data.id as string),
    };
  },

  async deleteJob(userId: string, jobId: string): Promise<{ success: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}`, {
      method: 'DELETE',
    });
    return handleResponse(response);
  },

  async cloneJob(
    userId: string,
    jobId: string,
    newAddress: string,
    clearTestResults: boolean = false
  ): Promise<{ success: boolean; jobId: string; address: string }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newAddress, clearTestResults }),
    });
    return handleResponse(response);
  },

  // ============= Upload & Process =============

  async uploadAndProcess(
    files: File[],
    certificateType: string = 'EICR'
  ): Promise<{ success: boolean; jobId: string; message: string }> {
    const token = getToken();
    const formData = new FormData();
    formData.append('certificateType', certificateType);
    files.forEach((file) => formData.append('files', file));

    const response = await fetch(`${API_BASE_URL}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    return handleResponse(response);
  },

  // ============= PDF =============

  async generatePdf(userId: string, jobId: string): Promise<Blob> {
    const response = await fetchWithAuth(
      `${API_BASE_URL}/api/job/${userId}/${jobId}/generate-pdf`,
      { method: 'POST' }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new ApiError(response.status, errorText);
    }

    return response.blob();
  },

  // ============= Settings =============

  async getUserDefaults(userId: string): Promise<UserDefaults> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/settings/${userId}/defaults`);
    return handleResponse(response);
  },

  async saveUserDefaults(userId: string, defaults: UserDefaults): Promise<{ success: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/settings/${userId}/defaults`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(defaults),
    });
    return handleResponse(response);
  },

  async getCompanySettings(userId: string): Promise<CompanySettings> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/settings/${userId}/company`);
    return handleResponse(response);
  },

  async saveCompanySettings(
    userId: string,
    settings: CompanySettings
  ): Promise<{ success: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/settings/${userId}/company`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    return handleResponse(response);
  },

  async getFieldSchema(): Promise<FieldSchema> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/schema/fields`);
    return handleResponse(response);
  },

  // ============= Inspector Profiles =============

  async getInspectorProfiles(userId: string): Promise<InspectorProfile[]> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/inspector-profiles/${userId}`);
    return handleResponse(response);
  },

  async saveInspectorProfiles(
    userId: string,
    profiles: InspectorProfile[]
  ): Promise<{ success: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/inspector-profiles/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profiles),
    });
    return handleResponse(response);
  },

  async uploadSignature(
    userId: string,
    file: File
  ): Promise<{ success: boolean; signature_file: string }> {
    const token = getToken();
    const formData = new FormData();
    formData.append('signature', file);

    const response = await fetch(
      `${API_BASE_URL}/api/inspector-profiles/${userId}/upload-signature`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      }
    );
    return handleResponse(response);
  },

  // ============= Photos =============

  async getJobPhotos(userId: string, jobId: string): Promise<JobPhoto[]> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/photos`);
    return handleResponse(response);
  },

  async uploadJobPhoto(
    userId: string,
    jobId: string,
    file: File
  ): Promise<{ success: boolean; photo: JobPhoto }> {
    const token = getToken();
    const formData = new FormData();
    formData.append('photo', file);

    const response = await fetch(`${API_BASE_URL}/api/job/${userId}/${jobId}/photos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    return handleResponse(response);
  },

  async getPhotoBlob(userId: string, jobId: string, filename: string): Promise<string> {
    const response = await fetchWithAuth(
      `${API_BASE_URL}/api/job/${userId}/${jobId}/photos/${encodeURIComponent(filename)}`
    );
    if (!response.ok) {
      throw new ApiError(response.status, 'Failed to load photo');
    }
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  },

  // ============= History =============

  async getJobHistory(userId: string, jobId: string): Promise<JobVersion[]> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/history`);
    return handleResponse(response);
  },

  async getJobVersion(userId: string, jobId: string, versionId: string): Promise<JobVersionDetail> {
    const response = await fetchWithAuth(
      `${API_BASE_URL}/api/job/${userId}/${jobId}/history/${versionId}`
    );
    return handleResponse(response);
  },

  // ============= Export =============

  async bulkDownload(userId: string, jobIds: string[]): Promise<void> {
    const token = getToken();
    const response = await fetch(`${API_BASE_URL}/api/jobs/${userId}/bulk-download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jobIds }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new ApiError(response.status, errorText);
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const disposition = response.headers.get('Content-Disposition');
    const filenameMatch = disposition?.match(/filename="?([^"]+)"?/);
    a.download = filenameMatch?.[1] || `certificates_${new Date().toISOString().split('T')[0]}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  },

  async exportCSV(userId: string, jobId: string): Promise<void> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/export/csv`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new ApiError(response.status, errorText);
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const disposition = response.headers.get('Content-Disposition');
    const filenameMatch = disposition?.match(/filename="?([^"]+)"?/);
    a.download = filenameMatch?.[1] || `circuits_${jobId}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  },

  async exportExcel(userId: string, jobId: string): Promise<void> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/export/excel`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new ApiError(response.status, errorText);
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const disposition = response.headers.get('Content-Disposition');
    const filenameMatch = disposition?.match(/filename="?([^"]+)"?/);
    a.download = filenameMatch?.[1] || `EICR_${jobId}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  },

  // ============= Email / WhatsApp =============

  async sendEmail(
    userId: string,
    jobId: string,
    to: string,
    clientName?: string
  ): Promise<{ ok: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, clientName }),
    });
    return handleResponse(response);
  },

  async sendWhatsApp(userId: string, jobId: string, phoneNumber: string): Promise<{ ok: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber }),
    });
    return handleResponse(response);
  },

  async getWhatsAppStatus(): Promise<WhatsAppStatus> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/whatsapp/status`);
    return handleResponse(response);
  },

  // ============= Regulations =============

  async searchRegulations(query: string): Promise<Regulation[]> {
    const params = query ? `?q=${encodeURIComponent(query)}` : '';
    const response = await fetchWithAuth(`${API_BASE_URL}/api/regulations${params}`);
    return handleResponse(response);
  },

  // ============= CRM: Clients =============

  async getClients(userId: string): Promise<Client[]> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/clients/${userId}`);
    return handleResponse(response);
  },

  async getClient(userId: string, clientId: string): Promise<ClientDetail> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/clients/${userId}/${clientId}`);
    return handleResponse(response);
  },

  async createClient(userId: string, data: CreateClientData): Promise<Client> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/clients/${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async updateClient(
    userId: string,
    clientId: string,
    data: Partial<CreateClientData>
  ): Promise<{ success: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/clients/${userId}/${clientId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async deleteClient(userId: string, clientId: string): Promise<{ success: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/clients/${userId}/${clientId}`, {
      method: 'DELETE',
    });
    return handleResponse(response);
  },

  // ============= CRM: Properties =============

  async getProperties(userId: string): Promise<Property[]> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/properties/${userId}`);
    return handleResponse(response);
  },

  async createProperty(userId: string, data: CreatePropertyData): Promise<Property> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/properties/${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async getPropertyHistory(userId: string, propertyId: string): Promise<PropertyJob[]> {
    const response = await fetchWithAuth(
      `${API_BASE_URL}/api/properties/${userId}/${propertyId}/history`
    );
    return handleResponse(response);
  },

  // ============= OCR =============

  async ocrCertificate(file: File): Promise<OcrResult> {
    const token = getToken();
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${API_BASE_URL}/api/ocr/certificate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    return handleResponse(response);
  },

  async createJobFromOcr(
    data: OcrExtractedData,
    certificateType: string = 'EICR'
  ): Promise<{ success: boolean; jobId: string; address: string }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/ocr/create-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, certificateType }),
    });
    return handleResponse(response);
  },

  // ============= Billing =============

  async getBillingStatus(): Promise<BillingStatus> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/billing/status`);
    return handleResponse(response);
  },

  async createCheckout(_userId: string, priceId: string): Promise<{ url: string }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/billing/create-checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceId }),
    });
    return handleResponse(response);
  },

  async openBillingPortal(): Promise<{ url: string }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/billing/portal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return handleResponse(response);
  },

  // ============= Calendar =============

  async getCalendarAuthUrl(): Promise<{ url: string }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/calendar/auth-url`);
    return handleResponse(response);
  },

  async calendarCallback(code: string): Promise<{ success: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/calendar/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    return handleResponse(response);
  },

  async getCalendarStatus(): Promise<CalendarStatus> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/calendar/status`);
    return handleResponse(response);
  },

  async getCalendarEvents(): Promise<{ events: CalendarEvent[] }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/calendar/events`);
    return handleResponse(response);
  },

  async createJobFromCalendarEvent(event: {
    summary: string;
    location: string;
    start: string;
    description: string;
  }): Promise<{ success: boolean; jobId: string; address: string }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/calendar/create-job-from-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    return handleResponse(response);
  },

  async disconnectCalendar(): Promise<{ success: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/calendar/disconnect`, {
      method: 'DELETE',
    });
    return handleResponse(response);
  },

  // ============= Analytics =============

  async getAnalytics(userId: string): Promise<AnalyticsData> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/analytics/${userId}`);
    return handleResponse(response);
  },

  // ============= Document Extraction =============

  async analyzeDocument(file: File): Promise<{
    success: boolean;
    formData: {
      circuits: Array<Record<string, string>>;
      observations: Array<{
        code: string;
        observation_text: string;
        item_location?: string;
        schedule_item?: string;
        regulation?: string;
      }>;
      installation_details: Record<string, string>;
      supply_characteristics: Record<string, string>;
      board_info: Record<string, string>;
    };
  }> {
    const token = getToken();
    const formData = new FormData();
    formData.append('photo', file);

    const response = await fetch(`${API_BASE_URL}/api/analyze-document`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    return handleResponse(response);
  },

  // ============= CCU Photo Analysis =============

  async analyzeCcu(file: File): Promise<CCUAnalysisResult> {
    const token = getToken();
    const formData = new FormData();
    formData.append('photo', file);

    const response = await fetch(`${API_BASE_URL}/api/analyze-ccu`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    return handleResponse(response);
  },

  // ============= Recording Pipeline =============

  /**
   * Fetch a short-lived Deepgram temp token (30s TTL) via backend proxy.
   * The master Deepgram key never leaves the server — only a scoped,
   * time-limited token is returned to the client.
   */
  async fetchDeepgramStreamingKey(): Promise<string> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/proxy/deepgram-streaming-key`, {
      method: 'POST',
    });
    const data = await handleResponse<{ key: string }>(response);
    if (!data.key) throw new Error('No Deepgram streaming key returned');
    return data.key;
  },

  /**
   * Log a sleep detector event (fire-and-forget).
   * POST /api/recording/:sessionId/sleep-log
   */
  async logSleepEvent(sessionId: string, event: string, detail?: string): Promise<void> {
    fetchWithAuth(`${API_BASE_URL}/api/recording/${sessionId}/sleep-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, detail }),
    }).catch(() => {
      /* fire-and-forget — don't break recording on log failure */
    });
  },
};
