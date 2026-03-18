/**
 * DebugLogger — ported from CertMateUnified/Sources/Services/DebugLogger.swift
 *
 * JSONL debug logger for the CertMate v2 recording pipeline (web version).
 * Stores log entries in memory during a session. On session end, provides
 * the full JSONL content for upload to POST /api/session/:sessionId/analytics.
 */

// ============= Types =============

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type LogCategory =
  | "deepgram"
  | "regex"
  | "sonnet"
  | "user"
  | "session"
  | "companion";

export type LogValue = string | number | boolean | null;

export interface DebugLogEntry {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  event: string;
  data?: Record<string, LogValue>;
}

export interface SessionSummary {
  sessionId: string;
  durationSeconds: number;
  totalEntries: number;
  errorCount: number;
  eventCountsByCategory: Record<string, number>;
}

// ============= Service =============

export class DebugLogger {
  // Session state
  private _isSessionActive = false;
  private _currentSessionId = "";
  private _entries: DebugLogEntry[] = [];
  private sessionStartTime: number | null = null;
  private categoryCounts: Record<string, number> = {};
  private errorCount = 0;

  get isSessionActive(): boolean {
    return this._isSessionActive;
  }

  get currentSessionId(): string {
    return this._currentSessionId;
  }

  get entryCount(): number {
    return this._entries.length;
  }

  // ---- Session Lifecycle ----

  startSession(sessionId: string): void {
    // Close any existing session
    if (this._isSessionActive) {
      this.endSession();
    }

    this._currentSessionId = sessionId;
    this._isSessionActive = true;
    this._entries = [];
    this.sessionStartTime = Date.now();
    this.categoryCounts = {};
    this.errorCount = 0;

    this.info("session", "session_start", { sessionId });
  }

  endSession(): SessionSummary | null {
    if (!this._isSessionActive) return null;

    const durationSeconds = this.sessionStartTime
      ? (Date.now() - this.sessionStartTime) / 1000
      : 0;
    const totalEntries = this._entries.length;

    const summaryData: Record<string, LogValue> = {
      durationSeconds: Math.round(durationSeconds * 1000) / 1000,
      totalEntries,
      errorCount: this.errorCount,
    };
    for (const [category, count] of Object.entries(this.categoryCounts)) {
      summaryData[`count_${category}`] = count;
    }

    this.writeEntry("INFO", "session", "session_end", summaryData);

    const summary: SessionSummary = {
      sessionId: this._currentSessionId,
      durationSeconds: Math.round(durationSeconds * 1000) / 1000,
      totalEntries,
      errorCount: this.errorCount,
      eventCountsByCategory: { ...this.categoryCounts },
    };

    this._isSessionActive = false;
    this._currentSessionId = "";
    this.sessionStartTime = null;

    return summary;
  }

  // ---- Logging Methods ----

  log(
    level: LogLevel,
    category: LogCategory,
    event: string,
    data?: Record<string, LogValue>,
  ): void {
    this.writeEntry(level, category, event, data);
  }

  debug(
    category: LogCategory,
    event: string,
    data?: Record<string, LogValue>,
  ): void {
    this.writeEntry("DEBUG", category, event, data);
  }

  info(
    category: LogCategory,
    event: string,
    data?: Record<string, LogValue>,
  ): void {
    this.writeEntry("INFO", category, event, data);
  }

  warn(
    category: LogCategory,
    event: string,
    data?: Record<string, LogValue>,
  ): void {
    this.writeEntry("WARN", category, event, data);
  }

  error(
    category: LogCategory,
    event: string,
    data?: Record<string, LogValue>,
  ): void {
    this.writeEntry("ERROR", category, event, data);
  }

  // ---- Data Access ----

  /**
   * Get all entries as a JSONL string (one JSON object per line).
   */
  toJSONL(): string {
    return this._entries.map((entry) => JSON.stringify(entry)).join("\n");
  }

  /**
   * Get all entries as a Blob for upload.
   */
  toBlob(): Blob {
    return new Blob([this.toJSONL()], { type: "application/x-ndjson" });
  }

  /**
   * Get all entries as an array.
   */
  getEntries(): ReadonlyArray<DebugLogEntry> {
    return this._entries;
  }

  /**
   * Get entries filtered by category.
   */
  getEntriesByCategory(category: LogCategory): DebugLogEntry[] {
    return this._entries.filter((e) => e.category === category);
  }

  /**
   * Get entries filtered by event name.
   */
  getEntriesByEvent(event: string): DebugLogEntry[] {
    return this._entries.filter((e) => e.event === event);
  }

  // ---- Upload ----

  /**
   * Upload session analytics to backend.
   * POST /api/session/:sessionId/analytics (multipart/form-data)
   */
  async uploadToBackend(
    baseUrl: string,
    token: string,
    fieldSources?: Record<string, string>,
    manifest?: Record<string, LogValue>,
    jobSnapshot?: Record<string, unknown>,
  ): Promise<boolean> {
    if (this._entries.length === 0) return false;

    const sessionId = this._currentSessionId || "unknown";
    const formData = new FormData();

    // Debug log JSONL
    formData.append(
      "debug_log",
      this.toBlob(),
      `debug_log_${sessionId}.jsonl`,
    );

    // Field sources
    if (fieldSources) {
      formData.append(
        "field_sources",
        new Blob([JSON.stringify(fieldSources)], {
          type: "application/json",
        }),
        "field_sources.json",
      );
    }

    // Manifest
    if (manifest) {
      formData.append(
        "manifest",
        new Blob([JSON.stringify(manifest)], { type: "application/json" }),
        "manifest.json",
      );
    }

    // Job snapshot
    if (jobSnapshot) {
      formData.append(
        "job_snapshot",
        new Blob([JSON.stringify(jobSnapshot)], {
          type: "application/json",
        }),
        "job_snapshot.json",
      );
    }

    try {
      const res = await fetch(
        `${baseUrl}/api/session/${sessionId}/analytics`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  // ---- Private ----

  private writeEntry(
    level: LogLevel,
    category: string,
    event: string,
    data?: Record<string, LogValue>,
  ): void {
    // Update counters
    this.categoryCounts[category] = (this.categoryCounts[category] ?? 0) + 1;
    if (level === "ERROR") {
      this.errorCount++;
    }

    const entry: DebugLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category: category as LogCategory,
      event,
      ...(data !== undefined && { data }),
    };

    this._entries.push(entry);
  }
}
