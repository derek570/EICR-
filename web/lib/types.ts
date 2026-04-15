/**
 * TypeScript types for CertMate Desktop Web App
 * Ported from frontend/src/lib/api.ts
 */

// ============= Auth =============

export interface User {
  id: string;
  email: string;
  name: string;
  company_name?: string;
  role?: 'admin' | 'user';
}

// ============= Admin =============

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  company_name: string | null;
  role: 'admin' | 'user';
  is_active: boolean;
  last_login: string | null;
  created_at: string;
  failed_login_attempts: number;
  locked_until: string | null;
}

export interface CreateUserData {
  email: string;
  name: string;
  password: string;
  company_name?: string;
  role?: 'admin' | 'user';
}

export interface UpdateUserData {
  name?: string;
  email?: string;
  company_name?: string;
  role?: 'admin' | 'user';
  is_active?: boolean;
}

// ============= Jobs =============

export type CertificateType = 'EICR' | 'EIC';

export interface Job {
  id: string;
  address: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  created_at: string;
  updated_at?: string;
  certificate_type?: CertificateType;
}

export interface JobDetail extends Job {
  certificate_type: CertificateType;
  circuits: Circuit[];
  observations: Observation[];
  board_info: BoardInfo;
  boards?: Board[];
  installation_details?: InstallationDetails;
  supply_characteristics?: SupplyCharacteristics;
  inspection_schedule?: InspectionSchedule;
  inspector_id?: string;
  extent_and_type?: ExtentAndType;
  design_construction?: DesignConstruction;
}

export interface SaveJobData {
  circuits?: Circuit[];
  observations?: Observation[];
  board_info?: BoardInfo;
  boards?: Board[];
  installation_details?: InstallationDetails;
  supply_characteristics?: SupplyCharacteristics;
  inspection_schedule?: InspectionSchedule;
  inspector_id?: string;
  extent_and_type?: ExtentAndType;
  design_construction?: DesignConstruction;
}

// ============= Circuit =============

export interface Circuit {
  circuit_ref: string;
  circuit_designation: string;
  wiring_type?: string;
  ref_method?: string;
  number_of_points?: string;
  live_csa_mm2?: string;
  cpc_csa_mm2?: string;
  max_disconnect_time_s?: string;
  ocpd_bs_en?: string;
  ocpd_type?: string;
  ocpd_rating_a?: string;
  ocpd_breaking_capacity_ka?: string;
  ocpd_max_zs_ohm?: string;
  rcd_bs_en?: string;
  rcd_type?: string;
  rcd_operating_current_ma?: string;
  ring_r1_ohm?: string;
  ring_rn_ohm?: string;
  ring_r2_ohm?: string;
  r1_r2_ohm?: string;
  r2_ohm?: string;
  ir_test_voltage_v?: string;
  ir_live_live_mohm?: string;
  ir_live_earth_mohm?: string;
  polarity_confirmed?: string;
  measured_zs_ohm?: string;
  rcd_time_ms?: string;
  rcd_button_confirmed?: string;
  afdd_button_confirmed?: string;
  [key: string]: string | undefined;
}

// ============= Observations =============

export interface Observation {
  code: 'C1' | 'C2' | 'C3' | 'FI' | 'NC';
  item_location: string;
  observation_text: string;
  schedule_item?: string;
  schedule_description?: string;
  regulation?: string;
  bpg4_basis?: string;
  suppress_from_report?: boolean;
  photos?: string[];
}

// ============= Photos =============

export interface JobPhoto {
  filename: string;
  url: string;
  thumbnail_url?: string;
  uploaded_at?: string;
}

// ============= Board =============

export interface BoardInfo {
  name?: string;
  location?: string;
  manufacturer?: string;
  phases?: string;
  earthing_arrangement?: string;
  ze?: string;
  zs_at_db?: string;
  ipf_at_db?: string;
}

export interface Board {
  id: string;
  designation: string;
  location: string;
  board_info: BoardInfo;
  circuits: Circuit[];
}

// ============= Installation Details =============

export interface InstallationDetails {
  client_name: string;
  address: string;
  postcode?: string;
  town?: string;
  county?: string;
  // Client address fields (mirrors iOS InstallationDetails.swift)
  client_address?: string;
  client_town?: string;
  client_county?: string;
  client_postcode?: string;
  client_phone?: string;
  client_email?: string;
  occupier_name?: string;
  premises_description: string;
  installation_records_available: boolean;
  evidence_of_additions_alterations: boolean;
  next_inspection_years: number;
  extent?: string;
  agreed_limitations?: string;
  agreed_with?: string;
  operational_limitations?: string;
}

// ============= Supply Characteristics =============

export interface SupplyCharacteristics {
  earthing_arrangement: string;
  live_conductors: string;
  number_of_supplies: string;
  nominal_voltage_u: string;
  nominal_voltage_uo: string;
  nominal_frequency: string;
  prospective_fault_current?: string;
  earth_loop_impedance_ze?: string;
  supply_polarity_confirmed?: string;
  spd_bs_en?: string;
  spd_type_supply?: string;
  spd_short_circuit?: string;
  spd_rated_current?: string;
  means_earthing_distributor?: boolean;
  means_earthing_electrode?: boolean;
  main_switch_bs_en?: string;
  main_switch_poles?: string;
  main_switch_voltage?: string;
  main_switch_current?: string;
  main_switch_fuse_setting?: string;
  main_switch_location?: string;
  main_switch_conductor_material?: string;
  main_switch_conductor_csa?: string;
  rcd_operating_current?: string;
  rcd_time_delay?: string;
  rcd_operating_time?: string;
  rcd_operating_current_test?: string;
  rcd_time_delay_test?: string;
  rcd_operating_time_test?: string;
  earthing_conductor_material?: string;
  earthing_conductor_csa?: string;
  earthing_conductor_continuity?: string;
  bonding_conductor_material?: string;
  bonding_conductor_csa?: string;
  bonding_conductor_continuity?: string;
  bonding_water?: string;
  bonding_gas?: string;
  bonding_oil?: string;
  bonding_structural_steel?: string;
  bonding_lightning?: string;
  bonding_other?: string;
  bonding_other_na?: boolean;
  electrode_type?: string;
  electrode_resistance?: string;
  electrode_location?: string;
}

// ============= Inspection Schedule =============

export interface InspectionItem {
  outcome: 'tick' | 'N/A' | 'C1' | 'C2' | 'C3' | 'LIM';
  observation_text?: string;
}

export interface InspectionSchedule {
  items: Record<string, InspectionItem>;
  hasMicrogeneration?: boolean;
  isTTEarthing?: boolean;
  markSection7NA?: boolean;
}

// ============= Inspector =============

export interface InspectorProfile {
  id: string;
  name: string;
  organisation?: string;
  enrolment_number?: string;
  signature_file?: string;
  position?: string;
}

// ============= EIC-specific =============

export interface ExtentAndType {
  extent: string;
  installation_type: 'new_installation' | 'addition' | 'alteration';
  comments?: string;
}

export interface DesignConstruction {
  departures_from_bs7671: string;
  departure_details?: string;
}

// ============= Settings =============

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

// ============= Schema =============

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

// ============= History =============

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

// ============= Regulations =============

export interface Regulation {
  ref: string;
  section: string;
  title: string;
  description: string;
  common_observations: string[];
  recommended_action: string;
}

// ============= CRM =============

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

// ============= Billing =============

export interface BillingStatus {
  plan: string;
  status: string;
  stripe_subscription_id?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  billing_configured: boolean;
}

// ============= OCR =============

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

// ============= Calendar =============

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

// ============= WhatsApp =============

export interface WhatsAppStatus {
  configured: boolean;
}

// ============= Analytics =============

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

// ============= CCU Analysis =============

export interface CCUCircuit {
  circuit_number: number;
  label: string | null;
  ocpd_type: string | null;
  ocpd_rating_a: string | null;
  ocpd_bs_en: string | null;
  ocpd_breaking_capacity_ka: string | null;
  is_rcbo: boolean;
  rcd_protected: boolean;
  rcd_rating_ma: string | null;
  rcd_bs_en: string | null;
}

export interface CCUConfidence {
  overall: number;
  image_quality: 'clear' | 'partially_readable' | 'poor';
  uncertain_fields: string[];
  message: string;
}

export interface CCUAnalysisResult {
  board_manufacturer: string | null;
  board_model: string | null;
  main_switch_rating: string | null;
  main_switch_position: 'left' | 'right' | null;
  main_switch_bs_en: string | null;
  main_switch_type: string | null;
  main_switch_poles: string | null;
  main_switch_current: string | null;
  main_switch_voltage: string | null;
  spd_present: boolean;
  spd_bs_en: string | null;
  spd_type: string | null;
  spd_rated_current_a: string | null;
  spd_short_circuit_ka: string | null;
  confidence: CCUConfidence;
  circuits: CCUCircuit[];
}

// ============= Recording Pipeline =============

export interface RollingExtractionResult {
  extractedReadings: ExtractedReading[];
  validationAlerts: ValidationAlert[];
  questionsForUser: UserQuestion[];
  contextUpdate?: ContextUpdate;
  regexSuggestions?: RegexSuggestion[];
}

export interface ExtractedReading {
  circuit?: string;
  field: string;
  value: string | number;
  unit?: string;
  confidence: number;
}

export interface ValidationAlert {
  type: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  suggestedAction?: string;
}

export interface UserQuestion {
  question: string;
  fieldKey: string;
  circuitRef?: string;
  heardValue?: string;
  type:
    | 'orphaned'
    | 'out_of_range'
    | 'unclear'
    | 'tt_confirmation'
    | 'circuit_disambiguation'
    | 'observation_confirmation';
}

export interface ContextUpdate {
  activeCircuit?: string;
  activeTestType?: string;
}

export interface RegexSuggestion {
  pattern: string;
  field: string;
  description: string;
}
