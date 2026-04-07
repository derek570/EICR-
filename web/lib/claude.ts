/**
 * ClaudeService — ported from CertMateUnified/Sources/Services/ClaudeService.swift
 *
 * Anthropic API client for Claude Sonnet rolling extraction and certificate review.
 * POST to https://api.anthropic.com/v1/messages
 * Retry on 429/5xx with exponential backoff.
 * Cost tracking per session.
 */

import type {
  RollingExtractionResult,
  ExtractedReading,
  ValidationAlert,
  UserQuestion,
  ContextUpdate,
} from './types';

// ============= Additional Types =============

export interface ReviewFinding {
  severity: 'error' | 'warning' | 'info' | 'success';
  message: string;
  circuit?: number;
  field?: string;
  suggestedValue?: string;
  suggestedAction?: string;
}

export interface CertificateReviewResult {
  findings: ReviewFinding[];
  completionPercentage?: number;
  summary?: string;
}

export interface ClaudeCostEstimate {
  inputTokens: number;
  outputTokens: number;
  inputCostUSD: number;
  outputCostUSD: number;
  totalCostUSD: number;
}

// ============= Internal API Types =============

interface ClaudeAPIRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: string; content: string }>;
}

interface ClaudeAPIResponse {
  id?: string;
  type?: string;
  content: Array<{ type: string; text?: string }>;
  model?: string;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

// ============= Error =============

export class ClaudeServiceError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'ClaudeServiceError';
  }
}

// ============= Service =============

export class ClaudeService {
  // Configuration
  // Route through backend proxy to avoid CORS and protect API key.
  // Must be absolute so it resolves to the Express backend, not the Next.js server.
  private static readonly ENDPOINT = `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'}/api/proxy/claude`;
  private static readonly MODEL = 'claude-sonnet-4-6';
  private static readonly ANTHROPIC_VERSION = '2023-06-01';
  private static readonly MAX_RETRIES = 3;

  // Cost per million tokens (Sonnet 4.5)
  private static readonly INPUT_COST_PER_MILLION = 3.0;
  private static readonly OUTPUT_COST_PER_MILLION = 15.0;

  private apiKey: string | null = null;

  // Session cost tracking
  private _sessionCostUSD = 0;
  private _sessionCallCount = 0;

  get sessionCostUSD(): number {
    return this._sessionCostUSD;
  }

  get sessionCallCount(): number {
    return this._sessionCallCount;
  }

  get isConfigured(): boolean {
    return this.apiKey != null && this.apiKey.length > 0;
  }

  configure(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /**
   * Mark this service as ready to use the backend proxy at ENDPOINT.
   * No client-side API key is needed — the Express proxy holds the Anthropic key.
   */
  configureForProxy(): void {
    this.apiKey = '__proxy__';
  }

  resetSessionTracking(): void {
    this._sessionCostUSD = 0;
    this._sessionCallCount = 0;
  }

  // ---- Public API ----

  async rollingExtraction(opts: {
    transcriptBuffer: string;
    previousTranscript?: string;
    currentCircuit?: string;
    circuitSchedule: string;
    recentReadings: string;
    debugIssues?: string[];
    fullTranscript?: string;
    askedQuestions?: string[];
  }): Promise<RollingExtractionResult> {
    const userContent = this.buildRollingExtractionUserMessage(opts);

    const maxTokens = opts.debugIssues && opts.debugIssues.length > 0 ? 1792 : 1280;
    const response = await this.callClaudeAPI(
      ClaudeService.ROLLING_EXTRACTION_SYSTEM_PROMPT,
      userContent,
      maxTokens
    );

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock?.text) {
      throw new ClaudeServiceError('No text content in Claude response', 'malformed_response');
    }

    const raw = this.parseJSONFromText<RawRollingExtractionResult>(textBlock.text);
    const result = mapRollingExtractionResult(raw);

    const cost = this.calculateCost(response.usage);
    this._sessionCostUSD += cost.totalCostUSD;
    this._sessionCallCount++;

    return result;
  }

  async fullCertificateReview(certificateData: string): Promise<CertificateReviewResult> {
    const response = await this.callClaudeAPI(
      ClaudeService.FULL_REVIEW_SYSTEM_PROMPT,
      certificateData,
      2048
    );

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock?.text) {
      throw new ClaudeServiceError('No text content in Claude response', 'malformed_response');
    }

    const raw = this.parseJSONFromText<RawCertificateReviewResult>(textBlock.text);
    const result = mapCertificateReviewResult(raw);

    const cost = this.calculateCost(response.usage);
    this._sessionCostUSD += cost.totalCostUSD;
    this._sessionCallCount++;

    return result;
  }

  async fullTranscriptExtraction(
    transcript: string,
    circuitSchedule: string
  ): Promise<RollingExtractionResult> {
    const userContent = `Full recording transcript:\n${transcript}\n\nCircuit schedule:\n${circuitSchedule}`;

    const response = await this.callClaudeAPI(
      ClaudeService.FULL_TRANSCRIPT_EXTRACTION_SYSTEM_PROMPT,
      userContent,
      4096
    );

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock?.text) {
      throw new ClaudeServiceError('No text content in Claude response', 'malformed_response');
    }

    const raw = this.parseJSONFromText<RawRollingExtractionResult>(textBlock.text);
    const result = mapRollingExtractionResult(raw);

    const cost = this.calculateCost(response.usage);
    this._sessionCostUSD += cost.totalCostUSD;
    this._sessionCallCount++;

    return result;
  }

  // ---- Core API Call ----

  private async callClaudeAPI(
    systemPrompt: string,
    userContent: string,
    maxTokens: number
  ): Promise<ClaudeAPIResponse> {
    if (!this.apiKey || this.apiKey.length === 0) {
      throw new ClaudeServiceError('Claude API key not configured', 'not_configured');
    }

    const requestBody: ClaudeAPIRequest = {
      model: ClaudeService.MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < ClaudeService.MAX_RETRIES; attempt++) {
      try {
        const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
        const res = await fetch(ClaudeService.ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(requestBody),
        });

        // Success
        if (res.ok) {
          return (await res.json()) as ClaudeAPIResponse;
        }

        // Rate limited -- retry
        if (res.status === 429) {
          const retryAfterHeader = res.headers.get('retry-after');
          const delay = retryAfterHeader
            ? parseFloat(retryAfterHeader)
            : this.backoffDelay(attempt);
          await this.sleep(delay * 1000);
          lastError = new ClaudeServiceError('Rate limited', 'rate_limited', 429);
          continue;
        }

        // Server error -- retry
        if (res.status >= 500) {
          const errorMsg = await this.parseErrorMessage(res);
          const delay = this.backoffDelay(attempt);
          await this.sleep(delay * 1000);
          lastError = new ClaudeServiceError(
            errorMsg ?? `Server error ${res.status}`,
            'server_error',
            res.status
          );
          continue;
        }

        // Client error -- do not retry
        const errorMsg = await this.parseErrorMessage(res);
        throw new ClaudeServiceError(
          errorMsg ?? `Client error ${res.status}`,
          'client_error',
          res.status
        );
      } catch (error) {
        if (error instanceof ClaudeServiceError) {
          // Re-throw non-retryable errors immediately
          if (
            error.code === 'client_error' ||
            error.code === 'not_configured' ||
            error.code === 'malformed_response'
          ) {
            throw error;
          }
          lastError = error;
        } else {
          // Network errors -- retry
          const delay = this.backoffDelay(attempt);
          await this.sleep(delay * 1000);
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }

    throw lastError ?? new ClaudeServiceError('Max retries exceeded', 'max_retries_exceeded');
  }

  // ---- JSON Parsing ----

  private parseJSONFromText<T>(text: string): T {
    const cleaned = this.extractJSON(text);

    try {
      return JSON.parse(cleaned) as T;
    } catch (error) {
      const preview = cleaned.slice(0, 500);
      throw new ClaudeServiceError(
        `JSON decode failed: ${error instanceof Error ? error.message : String(error)}\nResponse preview: ${preview}`,
        'decoding_error'
      );
    }
  }

  private extractJSON(text: string): string {
    const trimmed = text.trim();

    // Try to extract from ```json ... ``` or ``` ... ```
    const fenceStart =
      trimmed.indexOf('```json') !== -1 ? trimmed.indexOf('```json') : trimmed.indexOf('```');
    if (fenceStart !== -1) {
      const contentStart =
        trimmed.indexOf('\n', fenceStart) !== -1
          ? trimmed.indexOf('\n', fenceStart) + 1
          : fenceStart + (trimmed.startsWith('```json', fenceStart) ? 7 : 3);
      const fenceEnd = trimmed.indexOf('```', contentStart);
      if (fenceEnd !== -1) {
        return trimmed.slice(contentStart, fenceEnd).trim();
      }
    }

    // If the text starts with { or [, assume raw JSON
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return trimmed;
    }

    // Last resort: find first { and last }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return trimmed.slice(firstBrace, lastBrace + 1);
    }

    return trimmed;
  }

  // ---- Error Parsing ----

  private async parseErrorMessage(res: Response): Promise<string | null> {
    try {
      const body = await res.json();
      return body?.error?.message ?? null;
    } catch {
      try {
        return await res.text();
      } catch {
        return null;
      }
    }
  }

  // ---- Helpers ----

  private backoffDelay(attempt: number): number {
    // Exponential backoff: 1s, 2s, 4s (with jitter)
    const baseDelay = Math.pow(2, attempt);
    const jitter = Math.random() * 0.5;
    return baseDelay + jitter;
  }

  private calculateCost(
    usage?: { input_tokens: number; output_tokens: number } | null
  ): ClaudeCostEstimate {
    if (!usage) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        inputCostUSD: 0,
        outputCostUSD: 0,
        totalCostUSD: 0,
      };
    }
    const inputCost = (usage.input_tokens * ClaudeService.INPUT_COST_PER_MILLION) / 1_000_000;
    const outputCost = (usage.output_tokens * ClaudeService.OUTPUT_COST_PER_MILLION) / 1_000_000;
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      inputCostUSD: inputCost,
      outputCostUSD: outputCost,
      totalCostUSD: inputCost + outputCost,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---- User Message Builder ----

  private buildRollingExtractionUserMessage(opts: {
    transcriptBuffer: string;
    previousTranscript?: string;
    currentCircuit?: string;
    circuitSchedule: string;
    recentReadings: string;
    debugIssues?: string[];
    fullTranscript?: string;
    askedQuestions?: string[];
  }): string {
    const parts: string[] = [];

    if (opts.previousTranscript && opts.previousTranscript.length > 0) {
      parts.push(
        `Previous transcript (context only, already processed \u2014 do NOT re-extract): ${opts.previousTranscript}`
      );
    }
    parts.push(`NEW transcript buffer (extract from THIS): ${opts.transcriptBuffer}`);
    if (opts.currentCircuit) {
      parts.push(`Current circuit: ${opts.currentCircuit}`);
    }
    parts.push(
      `Circuit schedule (CONFIRMED values \u2014 do NOT question these): ${opts.circuitSchedule}`
    );
    parts.push(`Recent readings: ${opts.recentReadings}`);

    if (opts.debugIssues && opts.debugIssues.length > 0) {
      const issueList = opts.debugIssues.map((i) => `- ${i}`).join('\n');
      parts.push(
        `USER REPORTED ISSUES (spoken during recording):\n${issueList}\nLook specifically for these issues. Search the FULL TRANSCRIPT below for any values that match these fields but were not captured. The user likely already spoke the values earlier in the session. Extract them even if they appeared much earlier in the transcript.`
      );
      if (opts.fullTranscript && opts.fullTranscript.length > 0) {
        parts.push(
          `Full session transcript (search this for missed values):\n${opts.fullTranscript}`
        );
      }
    }

    if (opts.askedQuestions && opts.askedQuestions.length > 0) {
      parts.push(`Already asked (skip): ${opts.askedQuestions.join('; ')}`);
    }

    return parts.join('\n');
  }

  // ---- System Prompts ----

  private static readonly ROLLING_EXTRACTION_SYSTEM_PROMPT = `Extract EICR readings from electrician speech. Return ONLY JSON. \
Only extract from "NEW transcript buffer"; use "Previous transcript" for context only.

CIRCUIT FIELDS: insulation_resistance_l_e, insulation_resistance_l_l, ring_continuity_r1, \
ring_continuity_rn, ring_continuity_r2, r1_r2, r2, zs, rcd_trip_time, rcd_rating_a, polarity, \
cable_size, ocpd_rating, ocpd_type, number_of_points, wiring_type, ref_method, \
rcd_button_confirmed ("OK"), afdd_button_confirmed ("OK").
CIRCUIT 0 (supply/install/board): ze, pfc, earthing_arrangement, main_earth_conductor_csa, \
main_bonding_conductor_csa, bonding_water ("Yes"), bonding_gas ("Yes"), \
earth_electrode_type (rod|plate|tape|mat|other), earth_electrode_resistance (RA ohms), \
supply_polarity_confirmed ("Yes"), manufacturer, zs_at_db, address, \
client_name, client_phone, client_email, reason_for_report, occupier_name, \
date_of_previous_inspection, previous_certificate_number, \
estimated_age_of_installation, general_condition, \
next_inspection_years (int 1-10), premises_description (Residential|Commercial|Industrial|Agricultural|Other).

RULES:
- "circuit N" sets active circuit; subsequent readings go there. Split if buffer spans circuits.
- Ring continuity (R1/Rn/R2/lives/neutrals/earths) ONLY on ring/socket circuits, NEVER lighting. \
Ring data on lighting circuit \u2192 ask user to confirm circuit number.
- "earths" in ring context = ring_continuity_r2, NOT insulation_resistance_l_e.
- "live to live"/"light to live" = insulation_resistance_l_l, NOT l_e.
- cable_size = LIVE conductor mm\u00B2 (not earth). "lives 2.5, earths 1.5" \u2192 cable_size=2.5.
- "type B 32" = ocpd_type B + ocpd_rating 32. ocpd_type = B/C/D (MCB/RCBO type).
- "wiring type A"/"cable type A" = wiring_type (A-G). NOT ocpd_type.
- "ref method C"/"wiring method C" = ref_method (A-G). NOT ocpd_type.
- PFC: "nought 88" = 0.88 kA (NOT 88). Range 0.1-20 kA.
- IR "greater than 200" = ">200". Always include > prefix.
- Silently correct obvious mishearings ("nought point free"=0.3, "said he"=CD).
- Streaming splits numbers: "0.3 0" = 0.30, "1.2 5" = 1.25. Reconstruct decimals.
- Ignore customer conversation; only extract EICR data.

QUESTIONS (questions_for_user): ONLY for orphaned values (no clear circuit/field). \
Never question confirmed values, missing fields, or in-range readings. \
Keep short (spoken aloud via TTS). Include field + circuit.

{"extracted_readings":[{"circuit":int,"field":"str","value":num/str,"unit":"str|null","confidence":0-1}],\
"validation_alerts":[{"type":"str","severity":"warning|error|info","message":"str",\
"suggested_action":"str|null","from_circuit":int|null,"to_circuit":int|null,"field":"str|null"}],\
"questions_for_user":[{"question":"str","field":"str|null","circuit":int|null,"heard_value":"str|null","type":"orphaned|out_of_range|unclear"}],\
"context_update":{"active_circuit":int|null,"active_test_type":"str|null"}}`;

  private static readonly FULL_REVIEW_SYSTEM_PROMPT = `You are an expert electrical inspector reviewing a completed UK Electrical Installation Condition Report \
(EICR) to BS 7671 (18th Edition). You have been given the full certificate data including all circuits, \
test results, supply characteristics, and observations.

Perform a comprehensive review and check for:

1. SUSPICIOUS PATTERNS:
   - Are all insulation resistance values suspiciously identical? (e.g., all exactly 200 megohms \u2014 \
this suggests fabricated data)
   - Are Zs values following an expected pattern? They should generally increase with cable length \
and decrease with cable size.
   - Are R1+R2 values reasonable for the cable sizes listed? (e.g., 1.0mm2 twin+earth has \
~36.2 ohm/km for R1+R2)

2. MATHEMATICAL CHECKS:
   - Zs should approximately equal Ze + (R1+R2). Flag deviations beyond 20%.
   - Ring final circuit continuity: R1, Rn, R2 should be consistent. R1 and Rn should be similar. \
R2 should be higher (CPC is typically smaller CSA).
   - Prospective fault current (Ipf) should be consistent with Ze.

3. MISSING DATA:
   - Every circuit should have: IR Live-Earth, polarity confirmation.
   - Ring finals should also have: ring continuity (R1, Rn, R2), Zs.
   - Radials should have: R1+R2, Zs.
   - Lighting circuits should have: R1+R2, Zs, IR.
   - RCD-protected circuits should have: RCD trip time.
   - Check for missing observations that should accompany certain findings.

4. REGULATORY COMPLIANCE:
   - IR values must be >= 1.0 megohm (warning) or >= 0.5 megohm (minimum acceptable with C3).
   - Zs must not exceed maximum Zs for the OCPD type and rating (BS 7671 Table 41.3/41.4).
   - RCD trip times must be <= 200ms for 30mA (300ms for non-additional protection types).
   - Check disconnection times: 0.4s for socket outlets, 5s for fixed equipment (TN systems).

5. OVERALL COMPLETENESS:
   - Estimate what percentage of the certificate is complete.
   - Flag any sections that are entirely missing.

RESPONSE FORMAT:
Return ONLY valid JSON (no markdown, no explanation) with this exact structure:
{
  "findings": [
    {
      "severity": "error" | "warning" | "info" | "success",
      "message": "<human-readable finding>",
      "circuit": <int or null>,
      "field": "<field or null>",
      "suggested_value": "<value or null>",
      "suggested_action": "<action or null>"
    }
  ],
  "completion_percentage": <0-100>,
  "summary": "<brief overall assessment>"
}

Be thorough but practical. Focus on findings that genuinely matter for electrical safety and \
certificate accuracy. Order findings by severity (errors first, then warnings, then info).`;

  private static readonly FULL_TRANSCRIPT_EXTRACTION_SYSTEM_PROMPT = `Extract ALL EICR test readings from a complete electrician recording transcript. Return ONLY JSON.
This is a full recording \u2014 extract every reading mentioned throughout the entire transcript.

FIELDS: insulation_resistance_l_e, insulation_resistance_l_l, ring_continuity_r1, \
ring_continuity_rn, ring_continuity_r2, r1_r2, r2, zs, rcd_trip_time, rcd_rating_a, polarity, \
cable_size, ocpd_rating, ocpd_type, number_of_points, wiring_type, ref_method, \
rcd_button_confirmed, afdd_button_confirmed, \
main_earth_conductor_csa, main_bonding_conductor_csa, bonding_water, bonding_gas, \
earth_electrode_type, earth_electrode_resistance, \
supply_polarity_confirmed, manufacturer, zs_at_db, \
address, circuit_description, client_name, client_phone, client_email, reason_for_report, \
occupier_name, date_of_previous_inspection, previous_certificate_number, \
estimated_age_of_installation, general_condition, \
next_inspection_years, premises_description. \
Circuit 0 = supply fields (ze, pfc, earthing_arrangement, main_earth_conductor_csa, \
main_bonding_conductor_csa, bonding_water, bonding_gas, earth_electrode_type, \
earth_electrode_resistance, supply_polarity_confirmed, address) AND installation \
fields (client_name, client_phone, client_email, reason_for_report, occupier_name, \
date_of_previous_inspection, previous_certificate_number, \
estimated_age_of_installation, general_condition, \
next_inspection_years, premises_description) AND board \
fields (manufacturer, zs_at_db).

CIRCUIT RULES:
- "circuit N" or "socket circuit N" sets active circuit. ALL subsequent readings go to that circuit.
- Ring continuity (R1/Rn/R2/lives/neutrals/earths) ONLY on socket/ring circuits, NEVER lighting. If ring data is spoken for a lighting circuit, ask the user to confirm the circuit number.
- "earths" after ring context = ring_continuity_r2, NOT insulation_resistance_l_e.
- "live to live" (or "light to live") = insulation_resistance_l_l, NOT l_e.
- If transcript moves between circuits, split readings to correct circuits.

VALUE RULES:
- "Nought 88" or "nought eight eight" for PFC means 0.88 kA (value is 0.88, NOT 88).
- PFC values are typically 0.1\u201320 kA. If you see a raw number like 88, it should be 0.88.
- "greater than 200" for insulation resistance means >200 M\u03A9. Always include the > prefix.

CABLE & PROTECTION:
- cable_size = LIVE conductor CSA (mm\u00B2). If "lives 2.5mm, earths 1.5mm", cable_size is 2.5.
- "32 amp MCB" or "type B 32" = ocpd_rating + ocpd_type. ocpd_type is the MCB/RCBO type (B, C, D).
- "wiring type A" or "cable type A" = wiring_type (A-G). NOT ocpd_type.
- "reference method C" or "wiring method C" or "ref method C" = ref_method (A-G). NOT ocpd_type.
- "number of points" or "X points" = number_of_points (integer).
- address = full property address. Circuit 0 field.

BONDING:
- "bonding to water" or "water bonding confirmed" = bonding_water ("Yes").
- "bonding to gas" or "gas bonding confirmed" = bonding_gas ("Yes").
- These are supply fields (circuit 0).

{"extracted_readings":[{"circuit":int,"field":"str","value":num/str,"unit":"str|null","confidence":0-1}],\
"validation_alerts":[{"type":"str","severity":"warning|error|info","message":"str",\
"suggested_action":"str|null","from_circuit":int|null,"to_circuit":int|null,"field":"str|null"}],\
"context_update":null}`;
}

// ============= Raw API Response Shapes (snake_case from Claude) =============

interface RawExtractedReading {
  circuit?: number;
  field: string;
  value: string | number | boolean;
  unit?: string | null;
  confidence: number;
}

interface RawValidationAlert {
  type: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  suggested_action?: string | null;
  from_circuit?: number | null;
  to_circuit?: number | null;
  field?: string | null;
}

interface RawUserQuestion {
  question: string;
  field?: string | null;
  circuit?: number | null;
  heard_value?: string | null;
  type:
    | 'orphaned'
    | 'out_of_range'
    | 'unclear'
    | 'tt_confirmation'
    | 'circuit_disambiguation'
    | 'observation_confirmation';
}

interface RawContextUpdate {
  active_circuit?: number | null;
  active_test_type?: string | null;
}

interface RawRollingExtractionResult {
  extracted_readings: RawExtractedReading[];
  validation_alerts: RawValidationAlert[];
  questions_for_user?: RawUserQuestion[];
  context_update?: RawContextUpdate | null;
}

interface RawReviewFinding {
  severity: 'error' | 'warning' | 'info' | 'success';
  message: string;
  circuit?: number | null;
  field?: string | null;
  suggested_value?: string | null;
  suggested_action?: string | null;
}

interface RawCertificateReviewResult {
  findings: RawReviewFinding[];
  completion_percentage?: number;
  summary?: string;
}

// ============= Mappers (snake_case -> camelCase) =============

function mapRollingExtractionResult(raw: RawRollingExtractionResult): RollingExtractionResult {
  return {
    extractedReadings: (raw.extracted_readings ?? []).map(
      (r): ExtractedReading => ({
        circuit: r.circuit != null ? String(r.circuit) : undefined,
        field: r.field,
        value: typeof r.value === 'boolean' ? String(r.value) : r.value,
        unit: r.unit ?? undefined,
        confidence: r.confidence,
      })
    ),
    validationAlerts: (raw.validation_alerts ?? []).map(
      (a): ValidationAlert => ({
        type: a.type,
        severity: a.severity,
        message: a.message,
        suggestedAction: a.suggested_action ?? undefined,
      })
    ),
    questionsForUser: (raw.questions_for_user ?? []).map(
      (q): UserQuestion => ({
        question: q.question,
        fieldKey: q.field ?? '',
        circuitRef: q.circuit != null ? String(q.circuit) : undefined,
        heardValue: q.heard_value ?? undefined,
        type: q.type,
      })
    ),
    contextUpdate: raw.context_update
      ? {
          activeCircuit:
            raw.context_update.active_circuit != null
              ? String(raw.context_update.active_circuit)
              : undefined,
          activeTestType: raw.context_update.active_test_type ?? undefined,
        }
      : undefined,
  };
}

function mapCertificateReviewResult(raw: RawCertificateReviewResult): CertificateReviewResult {
  return {
    findings: (raw.findings ?? []).map(
      (f): ReviewFinding => ({
        severity: f.severity,
        message: f.message,
        circuit: f.circuit ?? undefined,
        field: f.field ?? undefined,
        suggestedValue: f.suggested_value ?? undefined,
        suggestedAction: f.suggested_action ?? undefined,
      })
    ),
    completionPercentage: raw.completion_percentage,
    summary: raw.summary,
  };
}
