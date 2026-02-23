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
 * - Delays: 1s → 2s → 4s (exponential backoff)
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
    const token = getToken();
    await fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  },

  async getMe(): Promise<User> {
    const token = getToken();
    const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async getJobs(userId: string): Promise<Job[]> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/jobs/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async getJob(userId: string, jobId: string): Promise<JobDetail> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/job/${userId}/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async saveJob(userId: string, jobId: string, data: SaveJobData): Promise<{ success: boolean }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/job/${userId}/${jobId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async uploadAndProcess(files: File[], certificateType: string = "EICR"): Promise<{ success: boolean; jobId: string; message: string }> {
    const token = getToken();
    const formData = new FormData();
    formData.append("certificateType", certificateType);
    files.forEach((file) => formData.append("files", file));

    // Note: uploadAndProcess doesn't use fetchWithRetry because it's a long-running
    // operation that shouldn't be retried automatically
    const response = await fetch(`${API_BASE_URL}/api/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    return handleResponse(response);
  },

  async generatePdf(userId: string, jobId: string): Promise<Blob> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/job/${userId}/${jobId}/generate-pdf`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new ApiError(response.status, errorText);
    }

    return response.blob();
  },

  // Settings endpoints
  async getUserDefaults(userId: string): Promise<UserDefaults> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/settings/${userId}/defaults`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async saveUserDefaults(userId: string, defaults: UserDefaults): Promise<{ success: boolean }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/settings/${userId}/defaults`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(defaults),
    });
    return handleResponse(response);
  },

  async getCompanySettings(userId: string): Promise<CompanySettings> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/settings/${userId}/company`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async saveCompanySettings(userId: string, settings: CompanySettings): Promise<{ success: boolean }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/settings/${userId}/company`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(settings),
    });
    return handleResponse(response);
  },

  async getFieldSchema(): Promise<FieldSchema> {
    const response = await fetchWithRetry(`${API_BASE_URL}/api/schema/fields`, {});
    return handleResponse(response);
  },

  async getInspectorProfiles(userId: string): Promise<InspectorProfile[]> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/inspector-profiles/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async saveInspectorProfiles(userId: string, profiles: InspectorProfile[]): Promise<{ success: boolean }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/inspector-profiles/${userId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(profiles),
    });
    return handleResponse(response);
  },

  async uploadSignature(userId: string, file: File): Promise<{ success: boolean; signature_file: string }> {
    const token = getToken();
    const formData = new FormData();
    formData.append("signature", file);

    const response = await fetch(`${API_BASE_URL}/api/inspector-profiles/${userId}/upload-signature`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    return handleResponse(response);
  },

  async createBlankJob(userId: string, certificateType: string): Promise<{ success: boolean; jobId: string }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/jobs/${userId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ certificate_type: certificateType }),
    });
    return handleResponse(response);
  },

  async deleteJob(userId: string, jobId: string): Promise<{ success: boolean }> {
    const token = getToken();
    const response = await fetch(`${API_BASE_URL}/api/job/${userId}/${jobId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  // Photo endpoints for job photos
  async getJobPhotos(userId: string, jobId: string): Promise<JobPhoto[]> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/job/${userId}/${jobId}/photos`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async uploadJobPhoto(userId: string, jobId: string, file: File): Promise<{ success: boolean; photo: JobPhoto }> {
    const token = getToken();
    const formData = new FormData();
    formData.append("photo", file);

    const response = await fetch(`${API_BASE_URL}/api/job/${userId}/${jobId}/photos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    return handleResponse(response);
  },

  async getPhotoUrl(userId: string, jobId: string, filename: string): Promise<string> {
    // Return the direct URL for the photo
    const token = getToken();
    return `${API_BASE_URL}/api/job/${userId}/${jobId}/photos/${encodeURIComponent(filename)}?token=${token}`;
  },

  async getJobHistory(userId: string, jobId: string): Promise<JobVersion[]> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/job/${userId}/${jobId}/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async getJobVersion(userId: string, jobId: string, versionId: string): Promise<JobVersionDetail> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/job/${userId}/${jobId}/history/${versionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async cloneJob(
    userId: string,
    jobId: string,
    newAddress: string,
    clearTestResults: boolean = false
  ): Promise<{ success: boolean; jobId: string; address: string }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/job/${userId}/${jobId}/clone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ newAddress, clearTestResults }),
    });
    return handleResponse(response);
  },

  async bulkDownload(userId: string, jobIds: string[]): Promise<void> {
    const token = getToken();
    const response = await fetch(`${API_BASE_URL}/api/jobs/${userId}/bulk-download`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jobIds }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new ApiError(response.status, errorText);
    }

    // Trigger browser download from the response blob
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Extract filename from Content-Disposition header if available
    const disposition = response.headers.get("Content-Disposition");
    const filenameMatch = disposition?.match(/filename="?([^"]+)"?/);
    a.download = filenameMatch?.[1] || `certificates_${new Date().toISOString().split("T")[0]}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  },

  async exportCSV(userId: string, jobId: string): Promise<void> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/job/${userId}/${jobId}/export/csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new ApiError(response.status, errorText);
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const disposition = response.headers.get("Content-Disposition");
    const filenameMatch = disposition?.match(/filename="?([^"]+)"?/);
    a.download = filenameMatch?.[1] || `circuits_${jobId}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  },

  async exportExcel(userId: string, jobId: string): Promise<void> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/job/${userId}/${jobId}/export/excel`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new ApiError(response.status, errorText);
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const disposition = response.headers.get("Content-Disposition");
    const filenameMatch = disposition?.match(/filename="?([^"]+)"?/);
    a.download = filenameMatch?.[1] || `EICR_${jobId}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  },

  async sendEmail(userId: string, jobId: string, to: string, clientName?: string): Promise<{ ok: boolean }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/job/${userId}/${jobId}/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to, clientName }),
    });
    return handleResponse(response);
  },

  async searchRegulations(query: string): Promise<Regulation[]> {
    const token = getToken();
    const params = query ? `?q=${encodeURIComponent(query)}` : "";
    const response = await fetchWithRetry(`${API_BASE_URL}/api/regulations${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  // ============= CRM: Clients =============

  async getClients(userId: string): Promise<Client[]> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/clients/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async getClient(userId: string, clientId: string): Promise<ClientDetail> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/clients/${userId}/${clientId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async createClient(userId: string, data: CreateClientData): Promise<Client> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/clients/${userId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async updateClient(userId: string, clientId: string, data: Partial<CreateClientData>): Promise<{ success: boolean }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/clients/${userId}/${clientId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async deleteClient(userId: string, clientId: string): Promise<{ success: boolean }> {
    const token = getToken();
    const response = await fetch(`${API_BASE_URL}/api/clients/${userId}/${clientId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  // ============= CRM: Properties =============

  async getProperties(userId: string): Promise<Property[]> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/properties/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async createProperty(userId: string, data: CreatePropertyData): Promise<Property> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/properties/${userId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async getPropertyHistory(userId: string, propertyId: string): Promise<PropertyJob[]> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/properties/${userId}/${propertyId}/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  // ============= OCR Certificate Extraction =============

  async ocrCertificate(file: File): Promise<OcrResult> {
    const token = getToken();
    const formData = new FormData();
    formData.append("file", file);

    // Don't use fetchWithRetry - OCR can take a while and shouldn't be auto-retried
    const response = await fetch(`${API_BASE_URL}/api/ocr/certificate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    return handleResponse(response);
  },

  async createJobFromOcr(
    data: OcrExtractedData,
    certificateType: string = "EICR"
  ): Promise<{ success: boolean; jobId: string; address: string }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/ocr/create-job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ data, certificateType }),
    });
    return handleResponse(response);
  },

  // ============= Billing =============

  async getBillingStatus(userId: string): Promise<BillingStatus> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/billing/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async createCheckout(userId: string, priceId: string): Promise<{ url: string }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/billing/create-checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ priceId }),
    });
    return handleResponse(response);
  },

  async openBillingPortal(userId: string): Promise<{ url: string }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/billing/portal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    return handleResponse(response);
  },

  // ============= Calendar / Scheduling =============

  async getCalendarAuthUrl(): Promise<{ url: string }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/calendar/auth-url`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async calendarCallback(code: string): Promise<{ success: boolean }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/calendar/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code }),
    });
    return handleResponse(response);
  },

  async getCalendarStatus(): Promise<CalendarStatus> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/calendar/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async getCalendarEvents(): Promise<{ events: CalendarEvent[] }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/calendar/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async createJobFromCalendarEvent(event: {
    summary: string;
    location: string;
    start: string;
    description: string;
  }): Promise<{ success: boolean; jobId: string; address: string }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/calendar/create-job-from-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(event),
    });
    return handleResponse(response);
  },

  async disconnectCalendar(): Promise<{ success: boolean }> {
    const token = getToken();
    const response = await fetch(`${API_BASE_URL}/api/calendar/disconnect`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  // ============= WhatsApp =============

  async sendWhatsApp(userId: string, jobId: string, phoneNumber: string): Promise<{ ok: boolean }> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/job/${userId}/${jobId}/whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ phoneNumber }),
    });
    return handleResponse(response);
  },

  async getWhatsAppStatus(): Promise<WhatsAppStatus> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/whatsapp/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  // ============= Analytics =============

  async getAnalytics(userId: string): Promise<AnalyticsData> {
    const token = getToken();
    const response = await fetchWithRetry(`${API_BASE_URL}/api/analytics/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },

  async fetchKeys(): Promise<{ deepgram: string; anthropic?: string; elevenlabs?: string }> {
    const token = getToken();
    const response = await fetch(`${API_BASE_URL}/api/keys`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return handleResponse(response);
  },
};

// Types — re-exported from @/types for backward compatibility
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
