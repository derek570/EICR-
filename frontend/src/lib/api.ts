/**
 * API client for EICR-oMatic 3000
 */

import type { Job, JobDetail, SaveJobData, JobPhoto, InspectorProfile } from "../types/job";
import type {
  User,
  UserDefaults,
  CompanySettings,
  FieldSchema,
  JobVersion,
  JobVersionDetail,
  Regulation,
  Client,
  ClientDetail,
  Property,
  PropertyJob,
  CreateClientData,
  CreatePropertyData,
  BillingStatus,
  OcrResult,
  OcrExtractedData,
  CalendarStatus,
  CalendarEvent,
  WhatsAppStatus,
  AnalyticsData,
} from "../types/api";
import { downloadBlob } from "@certmate/shared-utils";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

// Debug: log the API URL on load
if (typeof window !== "undefined") {
  console.log("[API] Base URL:", API_BASE_URL);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

/**
 * Fetch with automatic retry for network/server errors.
 * - Retries on: 5xx errors, network errors, timeouts
 * - Never retries: 4xx errors (client errors)
 * - Never retries: non-idempotent methods (POST)
 * - Delays: 1s, 2s, 4s (exponential backoff)
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  const method = (options.method || "GET").toUpperCase();
  const canRetry = IDEMPOTENT_METHODS.has(method);
  const effectiveMaxRetries = canRetry ? maxRetries : 0;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Don't retry client errors (4xx)
      if (response.status >= 400 && response.status < 500) {
        return response;
      }

      // Retry server errors (5xx) only for idempotent methods
      if (response.status >= 500) {
        throw new Error(`Server error: ${response.status}`);
      }

      return response;
    } catch (error) {
      lastError = error as Error;

      if (attempt < effectiveMaxRetries) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Request failed after retries');
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new ApiError(response.status, errorText);
  }
  return response.json();
}

/**
 * Centralized auth wrapper. Injects Authorization header automatically.
 * Uses fetchWithRetry for idempotent methods, plain fetch otherwise.
 */
function fetchWithAuth(
  url: string,
  options: RequestInit & { retry?: boolean } = {}
): Promise<Response> {
  const token = getToken();
  const { retry = true, headers: extraHeaders, ...rest } = options;
  const headers: Record<string, string> = { ...extraHeaders as Record<string, string> };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const fetchFn = retry ? fetchWithRetry : fetch;
  return fetchFn(url, { ...rest, headers });
}

/** Auth fetch + JSON body shorthand */
function fetchJsonWithAuth(
  url: string,
  options: RequestInit & { retry?: boolean } = {}
): Promise<Response> {
  const headers = (options.headers || {}) as Record<string, string>;
  headers["Content-Type"] = "application/json";
  return fetchWithAuth(url, { ...options, headers });
}

export const api = {
  baseUrl: API_BASE_URL,

  async health(): Promise<{ status: string }> {
    const response = await fetch(`${API_BASE_URL}/api/health`);
    return handleResponse(response);
  },

  async login(email: string, password: string): Promise<{ token: string; user: User }> {
    const url = `${API_BASE_URL}/api/auth/login`;
    console.log("[API] Login request to:", url);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      console.log("[API] Login response status:", response.status);
      return handleResponse(response);
    } catch (error) {
      console.error("[API] Login fetch error:", error);
      throw error;
    }
  },

  async logout(): Promise<void> {
    await fetchJsonWithAuth(`${API_BASE_URL}/api/auth/logout`, { method: "POST", retry: false });
  },

  async getMe(): Promise<User> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/auth/me`, { retry: false });
    return handleResponse(response);
  },

  async getJobs(userId: string): Promise<Job[]> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/jobs/${userId}`);
    return handleResponse(response);
  },

  async getJob(userId: string, jobId: string): Promise<JobDetail> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}`);
    return handleResponse(response);
  },

  async saveJob(userId: string, jobId: string, data: SaveJobData): Promise<{ success: boolean }> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async uploadAndProcess(files: File[], certificateType: string = "EICR"): Promise<{ success: boolean; jobId: string; message: string }> {
    const formData = new FormData();
    formData.append("certificateType", certificateType);
    files.forEach((file) => formData.append("files", file));

    // Don't use retry - long-running upload shouldn't be auto-retried
    const response = await fetchWithAuth(`${API_BASE_URL}/api/upload`, {
      method: "POST",
      body: formData,
      retry: false,
    });
    return handleResponse(response);
  },

  async generatePdf(userId: string, jobId: string): Promise<Blob> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/generate-pdf`, {
      method: "POST",
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new ApiError(response.status, errorText);
    }

    return response.blob();
  },

  // Settings endpoints
  async getUserDefaults(userId: string): Promise<UserDefaults> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/settings/${userId}/defaults`);
    return handleResponse(response);
  },

  async saveUserDefaults(userId: string, defaults: UserDefaults): Promise<{ success: boolean }> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/settings/${userId}/defaults`, {
      method: "PUT",
      body: JSON.stringify(defaults),
    });
    return handleResponse(response);
  },

  async getCompanySettings(userId: string): Promise<CompanySettings> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/settings/${userId}/company`);
    return handleResponse(response);
  },

  async saveCompanySettings(userId: string, settings: CompanySettings): Promise<{ success: boolean }> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/settings/${userId}/company`, {
      method: "PUT",
      body: JSON.stringify(settings),
    });
    return handleResponse(response);
  },

  async getFieldSchema(): Promise<FieldSchema> {
    const response = await fetchWithRetry(`${API_BASE_URL}/api/schema/fields`, {});
    return handleResponse(response);
  },

  async getInspectorProfiles(userId: string): Promise<InspectorProfile[]> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/inspector-profiles/${userId}`);
    return handleResponse(response);
  },

  async saveInspectorProfiles(userId: string, profiles: InspectorProfile[]): Promise<{ success: boolean }> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/inspector-profiles/${userId}`, {
      method: "PUT",
      body: JSON.stringify(profiles),
    });
    return handleResponse(response);
  },

  async uploadSignature(userId: string, file: File): Promise<{ success: boolean; signature_file: string }> {
    const formData = new FormData();
    formData.append("signature", file);

    const response = await fetchWithAuth(`${API_BASE_URL}/api/inspector-profiles/${userId}/upload-signature`, {
      method: "POST",
      body: formData,
      retry: false,
    });
    return handleResponse(response);
  },

  async createBlankJob(userId: string, certificateType: string): Promise<{ success: boolean; jobId: string }> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/jobs/${userId}`, {
      method: "POST",
      body: JSON.stringify({ certificate_type: certificateType }),
    });
    return handleResponse(response);
  },

  async deleteJob(userId: string, jobId: string): Promise<{ success: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}`, {
      method: "DELETE",
      retry: false,
    });
    return handleResponse(response);
  },

  // Photo endpoints for job photos
  async getJobPhotos(userId: string, jobId: string): Promise<JobPhoto[]> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/photos`);
    return handleResponse(response);
  },

  async uploadJobPhoto(userId: string, jobId: string, file: File): Promise<{ success: boolean; photo: JobPhoto }> {
    const formData = new FormData();
    formData.append("photo", file);

    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/photos`, {
      method: "POST",
      body: formData,
      retry: false,
    });
    return handleResponse(response);
  },

  async getPhotoBlob(userId: string, jobId: string, filename: string): Promise<Blob> {
    const response = await fetchWithAuth(
      `${API_BASE_URL}/api/job/${userId}/${jobId}/photos/${encodeURIComponent(filename)}`
    );
    if (!response.ok) {
      throw new ApiError(response.status, "Failed to load photo");
    }
    return response.blob();
  },

  // Deprecated: leaks token in URL. Use getPhotoBlob() instead.
  async getPhotoUrl(userId: string, jobId: string, filename: string): Promise<string> {
    const token = getToken();
    return `${API_BASE_URL}/api/job/${userId}/${jobId}/photos/${encodeURIComponent(filename)}?token=${token}`;
  },

  async getJobHistory(userId: string, jobId: string): Promise<JobVersion[]> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/history`);
    return handleResponse(response);
  },

  async getJobVersion(userId: string, jobId: string, versionId: string): Promise<JobVersionDetail> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/history/${versionId}`);
    return handleResponse(response);
  },

  async cloneJob(
    userId: string,
    jobId: string,
    newAddress: string,
    clearTestResults: boolean = false
  ): Promise<{ success: boolean; jobId: string; address: string }> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/clone`, {
      method: "POST",
      body: JSON.stringify({ newAddress, clearTestResults }),
    });
    return handleResponse(response);
  },

  async bulkDownload(userId: string, jobIds: string[]): Promise<void> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/jobs/${userId}/bulk-download`, {
      method: "POST",
      body: JSON.stringify({ jobIds }),
      retry: false,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new ApiError(response.status, errorText);
    }

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition");
    downloadBlob(blob, `certificates_${new Date().toISOString().split("T")[0]}.zip`, disposition);
  },

  async exportCSV(userId: string, jobId: string): Promise<void> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/export/csv`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new ApiError(response.status, errorText);
    }

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition");
    downloadBlob(blob, `circuits_${jobId}.csv`, disposition);
  },

  async exportExcel(userId: string, jobId: string): Promise<void> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/export/excel`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new ApiError(response.status, errorText);
    }

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition");
    downloadBlob(blob, `EICR_${jobId}.xlsx`, disposition);
  },

  async sendEmail(userId: string, jobId: string, to: string, clientName?: string): Promise<{ ok: boolean }> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/email`, {
      method: "POST",
      body: JSON.stringify({ to, clientName }),
    });
    return handleResponse(response);
  },

  async searchRegulations(query: string): Promise<Regulation[]> {
    const params = query ? `?q=${encodeURIComponent(query)}` : "";
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
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/clients/${userId}`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async updateClient(userId: string, clientId: string, data: Partial<CreateClientData>): Promise<{ success: boolean }> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/clients/${userId}/${clientId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async deleteClient(userId: string, clientId: string): Promise<{ success: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/clients/${userId}/${clientId}`, {
      method: "DELETE",
      retry: false,
    });
    return handleResponse(response);
  },

  // ============= CRM: Properties =============

  async getProperties(userId: string): Promise<Property[]> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/properties/${userId}`);
    return handleResponse(response);
  },

  async createProperty(userId: string, data: CreatePropertyData): Promise<Property> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/properties/${userId}`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async getPropertyHistory(userId: string, propertyId: string): Promise<PropertyJob[]> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/properties/${userId}/${propertyId}/history`);
    return handleResponse(response);
  },

  // ============= OCR Certificate Extraction =============

  async ocrCertificate(file: File): Promise<OcrResult> {
    const formData = new FormData();
    formData.append("file", file);

    // Don't use retry - OCR can take a while and shouldn't be auto-retried
    const response = await fetchWithAuth(`${API_BASE_URL}/api/ocr/certificate`, {
      method: "POST",
      body: formData,
      retry: false,
    });
    return handleResponse(response);
  },

  async createJobFromOcr(
    data: OcrExtractedData,
    certificateType: string = "EICR"
  ): Promise<{ success: boolean; jobId: string; address: string }> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/ocr/create-job`, {
      method: "POST",
      body: JSON.stringify({ data, certificateType }),
    });
    return handleResponse(response);
  },

  // ============= Billing =============

  async getBillingStatus(userId: string): Promise<BillingStatus> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/billing/status`);
    return handleResponse(response);
  },

  async createCheckout(userId: string, priceId: string): Promise<{ url: string }> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/billing/create-checkout`, {
      method: "POST",
      body: JSON.stringify({ priceId }),
    });
    return handleResponse(response);
  },

  async openBillingPortal(userId: string): Promise<{ url: string }> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/billing/portal`, {
      method: "POST",
    });
    return handleResponse(response);
  },

  // ============= Calendar / Scheduling =============

  async getCalendarAuthUrl(): Promise<{ url: string }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/calendar/auth-url`);
    return handleResponse(response);
  },

  async calendarCallback(code: string): Promise<{ success: boolean }> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/calendar/callback`, {
      method: "POST",
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
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/calendar/create-job-from-event`, {
      method: "POST",
      body: JSON.stringify(event),
    });
    return handleResponse(response);
  },

  async disconnectCalendar(): Promise<{ success: boolean }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/calendar/disconnect`, {
      method: "DELETE",
      retry: false,
    });
    return handleResponse(response);
  },

  // ============= WhatsApp =============

  async sendWhatsApp(userId: string, jobId: string, phoneNumber: string): Promise<{ ok: boolean }> {
    const response = await fetchJsonWithAuth(`${API_BASE_URL}/api/job/${userId}/${jobId}/whatsapp`, {
      method: "POST",
      body: JSON.stringify({ phoneNumber }),
    });
    return handleResponse(response);
  },

  async getWhatsAppStatus(): Promise<WhatsAppStatus> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/whatsapp/status`);
    return handleResponse(response);
  },

  // ============= Analytics =============

  async getAnalytics(userId: string): Promise<AnalyticsData> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/analytics/${userId}`);
    return handleResponse(response);
  },

  async fetchKeys(): Promise<{ deepgram: string; anthropic?: string; elevenlabs?: string }> {
    const response = await fetchWithAuth(`${API_BASE_URL}/api/keys`, { retry: false });
    return handleResponse(response);
  },
};

// Types -- re-exported from @/types for backward compatibility
export type {
  Job,
  JobDetail,
  SaveJobData,
  Circuit,
  Observation,
  JobPhoto,
  BoardInfo,
  Board,
  InstallationDetails,
  SupplyCharacteristics,
  InspectionItem,
  InspectionSchedule,
  InspectorProfile,
  ExtentAndType,
  DesignConstruction,
  CertificateType,
} from "../types/job";

export type {
  User,
  UserDefaults,
  CompanySettings,
  FieldSchema,
  FieldDefinition,
  JobVersion,
  JobVersionDetail,
  Regulation,
  Client,
  ClientDetail,
  PropertyWithJobs,
  Property,
  PropertyJob,
  CreateClientData,
  CreatePropertyData,
  BillingStatus,
  OcrResult,
  OcrExtractedData,
  CalendarStatus,
  CalendarEvent,
  WhatsAppStatus,
  AnalyticsStats,
  AnalyticsWeekly,
  AnalyticsTiming,
  AnalyticsData,
} from "../types/api";
