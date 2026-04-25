/**
 * Core job types — Job, JobDetail, SaveJobData, LocalJob.
 */

import type { Circuit, Board, BoardInfo } from './circuit';
import type { Observation } from './observation';
import type { SupplyCharacteristics } from './supply';

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
  // EIC-specific
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
  premises_description: string;
  installation_records_available: boolean;
  evidence_of_additions_alterations: boolean;
  next_inspection_years: number;
  extent?: string;
  agreed_limitations?: string;
  agreed_with?: string;
  operational_limitations?: string;
  // Report overview fields (mirrors iOS generalConditionOfInstallation / reasonForReport)
  general_condition?: string;
  reason_for_report?: string;
  occupier_name?: string;
  // Inspection date fields (mirrors iOS InstallationTab Inspection Dates section)
  date_of_inspection?: string;
  date_of_previous_inspection?: string;
  next_inspection_due?: string;
  previous_certificate_number?: string;
  estimated_age_of_installation?: string;
}

export interface InspectionItem {
  outcome: 'tick' | 'N/A' | 'C1' | 'C2' | 'C3' | 'LIM';
  observation_text?: string;
}

export interface InspectionSchedule {
  items: Record<string, InspectionItem>;
  // Wire keys match iOS `InspectionSchedule.swift` CodingKeys (snake_case)
  // so a job round-trips losslessly between iOS and PWA. Earlier camelCase
  // names here did not match what iOS encoded — the actual wire shape is
  // snake_case (the camelCase forms are Swift property names that get
  // remapped at encode time).
  has_microgeneration?: boolean;
  is_tt_earthing?: boolean;
  mark_section7_na?: boolean;
}

export interface ExtentAndType {
  extent: string;
  installation_type: 'new_installation' | 'addition' | 'alteration';
  comments?: string;
}

export interface DesignConstruction {
  departures_from_bs7671: string;
  departure_details?: string;
}

export interface InspectorProfile {
  id: string;
  name: string;
  organisation?: string;
  enrolment_number?: string;
  signature_file?: string;
  position?: string;
}

export interface JobPhoto {
  filename: string;
  url: string;
  thumbnail_url?: string;
  uploaded_at?: string;
}
