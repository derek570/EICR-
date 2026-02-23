/**
 * API-specific types — auth, settings, billing, calendar, CRM, OCR, analytics.
 */

import type { InstallationDetails, JobPhoto } from './job';
import type { SupplyCharacteristics } from './supply';
import type { BoardInfo, Circuit } from './circuit';
import type { Observation } from './observation';

// Auth
export interface User {
  id: string;
  email: string;
  name: string;
  company_name?: string;
}

// Settings
export interface UserDefaults {
  [fieldKey: string]: string;
}

export interface CompanySettings {
  company_name: string;
  company_address: string;
  company_phone: string;
  company_email: string;
  company_website: string;
  company_registration: string;
  logo_file: string | null;
}

export interface FieldSchema {
  version: string;
  description: string;
  circuit_fields: Record<string, FieldDefinition>;
  board_fields: Record<string, FieldDefinition>;
  installation_fields: Record<string, FieldDefinition>;
  observation_fields: Record<string, FieldDefinition>;
  field_groups: Array<{ name: string; fields: string[] }>;
}

export interface FieldDefinition {
  label: string;
  type: 'text' | 'select';
  options?: string[];
  default?: string;
  description: string;
  ai_guidance?: string;
  pdf_column?: string;
  group?: string;
  defaults_by_circuit?: Record<string, string>;
}

// History
export interface JobVersion {
  id: string;
  version_number: number;
  user_id: string;
  changes_summary: string;
  created_at: string;
}

export interface JobVersionDetail extends JobVersion {
  job_id: string;
  data_snapshot: Record<string, unknown>;
}

// Regulations
export interface Regulation {
  ref: string;
  section: string;
  title: string;
  description: string;
  common_observations: string[];
  recommended_action: string;
}

// CRM
export interface Client {
  id: string;
  user_id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientDetail extends Client {
  properties: PropertyWithJobs[];
}

export interface PropertyWithJobs extends Property {
  jobs: PropertyJob[];
}

export interface Property {
  id: string;
  client_id?: string | null;
  user_id: string;
  address: string;
  postcode?: string | null;
  property_type?: string | null;
  notes?: string | null;
  client_name?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PropertyJob {
  id: string;
  address: string;
  status: string;
  certificate_type?: string;
  created_at: string;
  completed_at?: string;
}

export interface CreateClientData {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  notes?: string;
}

export interface CreatePropertyData {
  address: string;
  postcode?: string;
  property_type?: string;
  client_id?: string;
  notes?: string;
}

// Billing
export interface BillingStatus {
  plan: string;
  status: string;
  stripe_subscription_id?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  billing_configured: boolean;
}

// OCR
export interface OcrResult {
  success: boolean;
  data: OcrExtractedData;
  meta: {
    model: string;
    tokens: number;
    source_file: string;
  };
}

export interface OcrExtractedData {
  installation_details: InstallationDetails;
  supply_characteristics: SupplyCharacteristics;
  board_info: BoardInfo;
  circuits: Circuit[];
  observations: Observation[];
}

// Calendar
export interface CalendarStatus {
  configured: boolean;
  connected: boolean;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location: string;
  description: string;
}

// WhatsApp
export interface WhatsAppStatus {
  configured: boolean;
}

// Analytics
export interface AnalyticsStats {
  total: number;
  completed: number;
  processing: number;
  failed: number;
  eicr_count: number;
  eic_count: number;
}

export interface AnalyticsWeekly {
  week_start: string;
  job_count: number;
}

export interface AnalyticsTiming {
  avg_minutes: number;
  min_minutes: number;
  max_minutes: number;
}

export interface AnalyticsData {
  stats: AnalyticsStats;
  weekly: AnalyticsWeekly[];
  timing: AnalyticsTiming;
}
