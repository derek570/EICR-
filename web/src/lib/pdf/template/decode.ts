import type {
  PdfBoard,
  PdfBoardType,
  PdfCircuit,
  PdfCompany,
  PdfDesignConstruction,
  PdfExtentAndType,
  PdfInspectionOutcome,
  PdfInspectionSchedule,
  PdfInspector,
  PdfInstallationDetails,
  PdfJob,
  PdfObservation,
  PdfObservationCode,
  PdfSupplyCharacteristics,
} from './types';
import type { CompanySettings, InspectorProfile, JobDetail } from '@/lib/types';

/**
 * Wire → template-model decoders. Key names are copied from the iOS
 * models' `CodingKeys` (the shared backend wire contract) — see each
 * iOS file cited per decoder. Values the backend stores under other
 * keys deliberately decode to undefined, exactly as they do on iOS.
 *
 * One documented leniency vs the strict Swift decoder: numeric fields
 * (`next_inspection_years`) coerce numeric STRINGS to numbers, and
 * boolean fields coerce 'true'/'false'/'yes'/'no' strings. The backend
 * is permissive about value types and a strict web decode would make
 * the whole certificate fail on one malformed field (iOS has exactly
 * this failure mode — a string next_inspection_years makes the job
 * undecodable on iOS; found on the WS9 EICR fixture, 2026-07-02).
 */

type Raw = Record<string, unknown> | null | undefined;

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return undefined;
}

function int(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return undefined;
}

/** Mirrors the APIClient.decoder date strategy (ISO8601 w/ + w/o
 * fractional seconds, plus DD/MM/YYYY from the extraction pipeline). */
function date(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const s = v.trim();
  const ddmmyyyy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (ddmmyyyy) {
    const d = new Date(Number(ddmmyyyy[3]), Number(ddmmyyyy[2]) - 1, Number(ddmmyyyy[1]));
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** iOS `InstallationDetails` CodingKeys (InstallationDetails.swift:35-57). */
export function decodeInstallationDetails(raw: Raw): PdfInstallationDetails | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    clientName: str(raw['client_name']),
    address: str(raw['address']),
    postcode: str(raw['postcode']),
    town: str(raw['town']),
    county: str(raw['county']),
    premisesDescription: str(raw['premises_description']),
    installationRecordsAvailable: bool(raw['installation_records_available']),
    evidenceOfAdditionsAlterations: bool(raw['evidence_of_additions_alterations']),
    nextInspectionYears: int(raw['next_inspection_years']),
    extent: str(raw['extent']),
    agreedLimitations: str(raw['agreed_limitations']),
    agreedWith: str(raw['agreed_with']),
    operationalLimitations: str(raw['operational_limitations']),
    clientPhone: str(raw['client_phone']),
    clientEmail: str(raw['client_email']),
    clientAddress: str(raw['client_address']),
    clientTown: str(raw['client_town']),
    clientCounty: str(raw['client_county']),
    clientPostcode: str(raw['client_postcode']),
    reasonForReport: str(raw['reason_for_report']),
    occupierName: str(raw['occupier_name']),
    dateOfPreviousInspection: str(raw['date_of_previous_inspection']),
    previousCertificateNumber: str(raw['previous_certificate_number']),
    estimatedAgeOfInstallation: str(raw['estimated_age_of_installation']),
    generalConditionOfInstallation: str(raw['general_condition_of_installation']),
    dateOfInspection: date(raw['date_of_inspection']),
    nextInspectionDueDate: date(raw['next_inspection_due_date']),
  };
}

/** iOS `SupplyCharacteristics` CodingKeys (SupplyCharacteristics.swift:72-120). */
export function decodeSupplyCharacteristics(raw: Raw): PdfSupplyCharacteristics | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    earthingArrangement: str(raw['earthing_arrangement']),
    liveConductors: str(raw['live_conductors']),
    numberOfSupplies: str(raw['number_of_supplies']),
    nominalVoltageU: str(raw['nominal_voltage_u']),
    nominalVoltageUo: str(raw['nominal_voltage_uo']),
    nominalFrequency: str(raw['nominal_frequency']),
    prospectiveFaultCurrent: str(raw['prospective_fault_current']),
    earthLoopImpedanceZe: str(raw['earth_loop_impedance_ze']),
    supplyPolarityConfirmed: bool(raw['supply_polarity_confirmed']),
    meansEarthingDistributor: bool(raw['means_earthing_distributor']),
    meansEarthingElectrode: bool(raw['means_earthing_electrode']),
    earthElectrodeType: str(raw['earth_electrode_type']),
    earthElectrodeResistance: str(raw['earth_electrode_resistance']),
    earthElectrodeLocation: str(raw['earth_electrode_location']),
    mainSwitchBsEn: str(raw['main_switch_bs_en']),
    mainSwitchPoles: str(raw['main_switch_poles']),
    mainSwitchVoltage: str(raw['main_switch_voltage']),
    mainSwitchCurrent: str(raw['main_switch_current']),
    mainSwitchFuseSetting: str(raw['main_switch_fuse_setting']),
    mainSwitchLocation: str(raw['main_switch_location']),
    mainSwitchConductorMaterial: str(raw['main_switch_conductor_material']),
    mainSwitchConductorCsa: str(raw['main_switch_conductor_csa']),
    rcdOperatingCurrent: str(raw['rcd_operating_current']),
    rcdTimeDelay: str(raw['rcd_time_delay']),
    rcdOperatingTime: str(raw['rcd_operating_time']),
    earthingConductorMaterial: str(raw['earthing_conductor_material']),
    earthingConductorCsa: str(raw['earthing_conductor_csa']),
    earthingConductorContinuity: str(raw['earthing_conductor_continuity']),
    mainBondingMaterial: str(raw['main_bonding_material']),
    mainBondingCsa: str(raw['main_bonding_csa']),
    mainBondingContinuity: str(raw['main_bonding_continuity']),
    bondingWater: str(raw['bonding_water']),
    bondingGas: str(raw['bonding_gas']),
    bondingOil: str(raw['bonding_oil']),
    bondingStructuralSteel: str(raw['bonding_structural_steel']),
    bondingLightning: str(raw['bonding_lightning']),
    bondingOther: str(raw['bonding_other']),
    bondingOtherNa: bool(raw['bonding_other_na']),
    spdBsEn: str(raw['spd_bs_en']),
    spdTypeSupply: str(raw['spd_type_supply']),
    spdShortCircuit: str(raw['spd_short_circuit']),
    spdRatedCurrent: str(raw['spd_rated_current']),
    surgeSpdPresent: str(raw['surge_spd_present']),
    surgeSpdType: str(raw['surge_spd_type']),
    surgeSpdBsEn: str(raw['surge_spd_bs_en']),
    surgeStatusIndicator: str(raw['surge_status_indicator']),
  };
}

const BOARD_TYPES: PdfBoardType[] = ['main', 'sub_distribution', 'sub_main', 'off_peak'];

/** iOS `BoardInfo` CodingKeys (BoardInfo.swift:71-98). */
export function decodeBoard(raw: Raw): PdfBoard | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const id = str(raw['id']);
  if (!id) return undefined;
  const boardTypeRaw = str(raw['board_type']);
  return {
    id,
    designation: str(raw['designation']),
    name: str(raw['name']),
    location: str(raw['location']),
    manufacturer: str(raw['manufacturer']),
    phases: str(raw['phases']),
    zeAtDb: str(raw['ze_at_db']),
    ipfAtDb: str(raw['ipf_at_db']),
    suppliedFrom: str(raw['supplied_from']),
    polarityConfirmed: str(raw['polarity_confirmed']),
    phasesConfirmed: str(raw['phases_confirmed']),
    rcdTripTime: str(raw['rcd_trip_time']),
    mainSwitchBsEn: str(raw['main_switch_bs_en']),
    voltageRating: str(raw['voltage_rating']),
    ratedCurrent: str(raw['rated_current']),
    ipfRating: str(raw['ipf_rating']),
    rcdRatingMa: str(raw['rcd_rating_ma']),
    spdType: str(raw['spd_type']),
    spdStatus: str(raw['spd_status']),
    overcurrentBsEn: str(raw['overcurrent_bs_en']),
    overcurrentVoltage: str(raw['overcurrent_voltage']),
    overcurrentCurrent: str(raw['overcurrent_current']),
    notes: str(raw['notes']),
    boardType: BOARD_TYPES.includes(boardTypeRaw as PdfBoardType)
      ? (boardTypeRaw as PdfBoardType)
      : undefined,
    parentBoardId: str(raw['parent_board_id']),
    feedCircuitRef: str(raw['feed_circuit_ref']),
    subMainCableMaterial: str(raw['sub_main_cable_material']),
    subMainCableCsa: str(raw['sub_main_cable_csa']),
    subMainCpcCsa: str(raw['sub_main_cpc_csa']),
  };
}

/** iOS `Circuit` CodingKeys (Circuit.swift:45-78). */
export function decodeCircuit(raw: Raw): PdfCircuit | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    id: str(raw['local_id']) ?? str(raw['id']) ?? '',
    boardId: str(raw['board_id']),
    circuitRef: str(raw['circuit_ref']),
    circuitDesignation: str(raw['circuit_designation']),
    wiringType: str(raw['wiring_type']),
    refMethod: str(raw['ref_method']),
    numberOfPoints: str(raw['number_of_points']),
    liveCsaMm2: str(raw['live_csa_mm2']),
    cpcCsaMm2: str(raw['cpc_csa_mm2']),
    maxDisconnectTimeS: str(raw['max_disconnect_time_s']),
    ocpdBsEn: str(raw['ocpd_bs_en']),
    ocpdType: str(raw['ocpd_type']),
    ocpdRatingA: str(raw['ocpd_rating_a']),
    ocpdBreakingCapacityKa: str(raw['ocpd_breaking_capacity_ka']),
    ocpdMaxZsOhm: str(raw['ocpd_max_zs_ohm']),
    rcdBsEn: str(raw['rcd_bs_en']),
    rcdType: str(raw['rcd_type']),
    rcdOperatingCurrentMa: str(raw['rcd_operating_current_ma']),
    rcdRatingA: str(raw['rcd_rating_a']),
    ringR1Ohm: str(raw['ring_r1_ohm']),
    ringRnOhm: str(raw['ring_rn_ohm']),
    ringR2Ohm: str(raw['ring_r2_ohm']),
    r1R2Ohm: str(raw['r1_r2_ohm']),
    r2Ohm: str(raw['r2_ohm']),
    irTestVoltageV: str(raw['ir_test_voltage_v']),
    irLiveLiveMohm: str(raw['ir_live_live_mohm']),
    irLiveEarthMohm: str(raw['ir_live_earth_mohm']),
    polarityConfirmed: str(raw['polarity_confirmed']),
    measuredZsOhm: str(raw['measured_zs_ohm']),
    rcdTimeMs: str(raw['rcd_time_ms']),
    rcdButtonConfirmed: str(raw['rcd_button_confirmed']),
    afddButtonConfirmed: str(raw['afdd_button_confirmed']),
  };
}

const OBS_CODES: PdfObservationCode[] = ['C1', 'C2', 'C3', 'FI'];

/** iOS `JobObservation` CodingKeys (Observation.swift:65-77). Rows with
 * an unknown/missing code are dropped, matching the iOS decode failure
 * mode for an invalid enum rawValue. */
export function decodeObservation(raw: Raw): PdfObservation | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const code = str(raw['code']);
  if (!OBS_CODES.includes(code as PdfObservationCode)) return undefined;
  return {
    code: code as PdfObservationCode,
    itemLocation: str(raw['item_location']),
    observationText: str(raw['observation_text']),
    regulation: str(raw['regulation']),
  };
}

const OUTCOMES: PdfInspectionOutcome[] = ['tick', 'N/A', 'C1', 'C2', 'C3', 'LIM', 'NV'];

/** iOS `InspectionSchedule` CodingKeys (InspectionSchedule.swift:45-49). */
export function decodeInspectionSchedule(raw: Raw): PdfInspectionSchedule | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const itemsRaw = raw['items'];
  const items: PdfInspectionSchedule['items'] = {};
  if (itemsRaw && typeof itemsRaw === 'object') {
    for (const [ref, entry] of Object.entries(itemsRaw as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const outcome = str((entry as Record<string, unknown>)['outcome']);
      items[ref] = {
        outcome: OUTCOMES.includes(outcome as PdfInspectionOutcome)
          ? (outcome as PdfInspectionOutcome)
          : undefined,
      };
    }
  }
  return {
    items,
    hasMicrogeneration: bool(raw['has_microgeneration']),
    isTTEarthing: bool(raw['is_tt_earthing']),
    markSection7NA: bool(raw['mark_section7_na']),
  };
}

/** iOS `ExtentAndType` CodingKeys (ExtentAndType.swift:9-10). */
export function decodeExtentAndType(raw: Raw): PdfExtentAndType | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    extent: str(raw['extent']),
    installationType: str(raw['installation_type']),
    comments: str(raw['comments']),
  };
}

/** iOS `DesignConstruction` CodingKeys (DesignConstruction.swift:8-9). */
export function decodeDesignConstruction(raw: Raw): PdfDesignConstruction | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    departuresFromBs7671: str(raw['departures_from_bs7671']),
    departureDetails: str(raw['departure_details']),
  };
}

/**
 * Decode the full job-detail wire payload into the template model.
 * Mirrors iOS `JobDetail.init(from:)` (Job.swift:116-171) including the
 * legacy `board_info` → single-board fallback used when `boards` is
 * absent (iOS decodes a legacy `board_info` bag into `boards[0]`).
 */
export function decodePdfJob(detail: JobDetail): PdfJob {
  const raw = detail as unknown as Record<string, unknown>;

  let boards = Array.isArray(detail.boards)
    ? detail.boards.map(decodeBoard).filter((b): b is PdfBoard => b !== undefined)
    : [];
  if (boards.length === 0) {
    // Legacy single-board fallback (Job.swift:154 LegacyKeys.boardInfo):
    // a populated flat `board_info` bag renders as one unnamed board.
    const bi = raw['board_info'];
    if (bi && typeof bi === 'object' && Object.keys(bi as object).length > 0) {
      const legacy = decodeBoard({ id: 'board-legacy', ...(bi as Record<string, unknown>) });
      if (legacy) boards = [legacy];
    }
  }

  return {
    id: detail.id,
    createdAt: date(raw['created_at']) ?? new Date(0),
    certificateType:
      detail.certificate_type === 'EIC' || detail.certificate_type === 'EICR'
        ? detail.certificate_type
        : undefined,
    installationDetails: decodeInstallationDetails(detail.installation_details),
    supplyCharacteristics: decodeSupplyCharacteristics(detail.supply_characteristics),
    boards,
    circuits: Array.isArray(detail.circuits)
      ? detail.circuits.map(decodeCircuit).filter((c): c is PdfCircuit => c !== undefined)
      : [],
    observations: Array.isArray(detail.observations)
      ? detail.observations
          .map((o) => decodeObservation(o as unknown as Record<string, unknown>))
          .filter((o): o is PdfObservation => o !== undefined)
      : [],
    inspectionSchedule: decodeInspectionSchedule(detail.inspection_schedule),
    extentAndType: decodeExtentAndType(detail.extent_and_type),
    designConstruction: decodeDesignConstruction(detail.design_construction),
    inspectorId: str(raw['inspector_id']),
    authorisedById: str(raw['authorised_by_id']),
    designerId: str(raw['designer_id']),
    constructorId: str(raw['constructor_id']),
  };
}

/** Resolve a web `InspectorProfile` (+ pre-fetched signature data URI)
 * into the template's inspector shape (iOS `Inspector` mirror). */
export function inspectorFromProfile(
  profile: InspectorProfile | undefined,
  signatureDataURI?: string
): PdfInspector | undefined {
  if (!profile) return undefined;
  return {
    fullName: profile.name,
    position: profile.position,
    signatureDataURI,
    mftSerialNumber: profile.mft_serial_number,
    mftCalibrationDate: profile.mft_calibration_date,
    continuitySerialNumber: profile.continuity_serial_number,
    continuityCalibrationDate: profile.continuity_calibration_date,
    insulationSerialNumber: profile.insulation_serial_number,
    insulationCalibrationDate: profile.insulation_calibration_date,
    earthFaultSerialNumber: profile.earth_fault_serial_number,
    earthFaultCalibrationDate: profile.earth_fault_calibration_date,
    rcdSerialNumber: profile.rcd_serial_number,
    rcdCalibrationDate: profile.rcd_calibration_date,
  };
}

/** Resolve the shared `CompanySettings` wire blob (+ pre-fetched logo
 * data URI) into the template's company shape. `company_registration`
 * is the wire field both platforms use for the enrolment number. */
export function companyFromSettings(
  settings: CompanySettings | undefined,
  logoDataURI?: string
): PdfCompany | undefined {
  if (!settings) return undefined;
  const empty = (v?: string | null) => (typeof v === 'string' && v.trim() ? v : undefined);
  return {
    companyName: empty(settings.company_name),
    address: empty(settings.company_address),
    phoneNumber: empty(settings.company_phone),
    website: empty(settings.company_website),
    enrolmentNumber: empty(settings.company_registration),
    logoDataURI,
  };
}
