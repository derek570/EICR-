/**
 * Data model consumed by the certificate template — a camelCase mirror
 * of the iOS Swift models that `EICRHTMLTemplate.build` receives
 * (`JobDetail`, `InstallationDetails`, `SupplyCharacteristics`,
 * `BoardInfo`, `Circuit`, `JobObservation`, `InspectionSchedule`,
 * `ExtentAndType`, `DesignConstruction`, `Inspector`, `CompanyDetails`).
 *
 * The decoders in `decode.ts` map the backend wire shape (snake_case,
 * exactly the keys in the iOS models' `CodingKeys`) into these structs,
 * so the template body in `eicr-html-template.ts` reads line-for-line
 * like the Swift original. Do NOT add web-only fields here — iOS is
 * canon for what the certificate renders.
 */

export type PdfCertificateType = 'EICR' | 'EIC';

export interface PdfInstallationDetails {
  clientName?: string;
  address?: string;
  postcode?: string;
  town?: string;
  county?: string;
  premisesDescription?: string;
  installationRecordsAvailable?: boolean;
  evidenceOfAdditionsAlterations?: boolean;
  nextInspectionYears?: number;
  extent?: string;
  agreedLimitations?: string;
  agreedWith?: string;
  operationalLimitations?: string;
  clientPhone?: string;
  clientEmail?: string;
  clientAddress?: string;
  clientTown?: string;
  clientCounty?: string;
  clientPostcode?: string;
  reasonForReport?: string;
  occupierName?: string;
  dateOfPreviousInspection?: string;
  previousCertificateNumber?: string;
  estimatedAgeOfInstallation?: string;
  generalConditionOfInstallation?: string;
  dateOfInspection?: Date;
  nextInspectionDueDate?: Date;
}

export interface PdfSupplyCharacteristics {
  earthingArrangement?: string;
  liveConductors?: string;
  numberOfSupplies?: string;
  nominalVoltageU?: string;
  nominalVoltageUo?: string;
  nominalFrequency?: string;
  prospectiveFaultCurrent?: string;
  earthLoopImpedanceZe?: string;
  supplyPolarityConfirmed?: boolean;
  meansEarthingDistributor?: boolean;
  meansEarthingElectrode?: boolean;
  earthElectrodeType?: string;
  earthElectrodeResistance?: string;
  earthElectrodeLocation?: string;
  mainSwitchBsEn?: string;
  mainSwitchPoles?: string;
  mainSwitchVoltage?: string;
  mainSwitchCurrent?: string;
  mainSwitchFuseSetting?: string;
  mainSwitchLocation?: string;
  mainSwitchConductorMaterial?: string;
  mainSwitchConductorCsa?: string;
  rcdOperatingCurrent?: string;
  rcdTimeDelay?: string;
  rcdOperatingTime?: string;
  earthingConductorMaterial?: string;
  earthingConductorCsa?: string;
  earthingConductorContinuity?: string;
  mainBondingMaterial?: string;
  mainBondingCsa?: string;
  mainBondingContinuity?: string;
  bondingWater?: string;
  bondingGas?: string;
  bondingOil?: string;
  bondingStructuralSteel?: string;
  bondingLightning?: string;
  bondingOther?: string;
  bondingOtherNa?: boolean;
  spdBsEn?: string;
  spdTypeSupply?: string;
  spdShortCircuit?: string;
  spdRatedCurrent?: string;
  surgeSpdPresent?: string;
  surgeSpdType?: string;
  surgeSpdBsEn?: string;
  surgeStatusIndicator?: string;
}

export type PdfBoardType = 'main' | 'sub_distribution' | 'sub_main' | 'off_peak';

export interface PdfBoard {
  id: string;
  designation?: string;
  name?: string;
  location?: string;
  manufacturer?: string;
  phases?: string;
  zeAtDb?: string;
  ipfAtDb?: string;
  suppliedFrom?: string;
  polarityConfirmed?: string;
  phasesConfirmed?: string;
  rcdTripTime?: string;
  mainSwitchBsEn?: string;
  voltageRating?: string;
  ratedCurrent?: string;
  ipfRating?: string;
  rcdRatingMa?: string;
  spdType?: string;
  spdStatus?: string;
  overcurrentBsEn?: string;
  overcurrentVoltage?: string;
  overcurrentCurrent?: string;
  notes?: string;
  boardType?: PdfBoardType;
  parentBoardId?: string;
  feedCircuitRef?: string;
  subMainCableMaterial?: string;
  subMainCableCsa?: string;
  subMainCpcCsa?: string;
}

export interface PdfCircuit {
  id: string;
  boardId?: string;
  circuitRef?: string;
  circuitDesignation?: string;
  wiringType?: string;
  refMethod?: string;
  numberOfPoints?: string;
  liveCsaMm2?: string;
  cpcCsaMm2?: string;
  maxDisconnectTimeS?: string;
  ocpdBsEn?: string;
  ocpdType?: string;
  ocpdRatingA?: string;
  ocpdBreakingCapacityKa?: string;
  ocpdMaxZsOhm?: string;
  rcdBsEn?: string;
  rcdType?: string;
  rcdOperatingCurrentMa?: string;
  rcdRatingA?: string;
  ringR1Ohm?: string;
  ringRnOhm?: string;
  ringR2Ohm?: string;
  r1R2Ohm?: string;
  r2Ohm?: string;
  irTestVoltageV?: string;
  irLiveLiveMohm?: string;
  irLiveEarthMohm?: string;
  polarityConfirmed?: string;
  measuredZsOhm?: string;
  rcdTimeMs?: string;
  rcdButtonConfirmed?: string;
  afddButtonConfirmed?: string;
}

export type PdfObservationCode = 'C1' | 'C2' | 'C3' | 'FI';

export interface PdfObservation {
  code: PdfObservationCode;
  itemLocation?: string;
  observationText?: string;
  regulation?: string;
}

export type PdfInspectionOutcome = 'tick' | 'N/A' | 'C1' | 'C2' | 'C3' | 'LIM' | 'NV';

export interface PdfInspectionSchedule {
  items: Record<string, { outcome?: PdfInspectionOutcome }>;
  hasMicrogeneration?: boolean;
  isTTEarthing?: boolean;
  markSection7NA?: boolean;
}

export interface PdfExtentAndType {
  extent?: string;
  installationType?: string;
  comments?: string;
}

export interface PdfDesignConstruction {
  departuresFromBs7671?: string;
  departureDetails?: string;
}

/** Mirror of iOS `Inspector` (GRDB row) resolved from the web
 * `InspectorProfile` wire shape + a fetched signature data URI. */
export interface PdfInspector {
  fullName?: string;
  position?: string;
  /** data: URI, already fetched + encoded by the data layer. */
  signatureDataURI?: string;
  mftSerialNumber?: string;
  mftCalibrationDate?: string;
  continuitySerialNumber?: string;
  continuityCalibrationDate?: string;
  insulationSerialNumber?: string;
  insulationCalibrationDate?: string;
  earthFaultSerialNumber?: string;
  earthFaultCalibrationDate?: string;
  rcdSerialNumber?: string;
  rcdCalibrationDate?: string;
}

/** Mirror of what the iOS template reads off `CompanyDetails`, resolved
 * from the shared `CompanySettings` wire blob (company_address is a
 * single pre-joined string on the wire — see decode.ts). */
export interface PdfCompany {
  companyName?: string;
  /** Pre-assembled single-line address (wire `company_address`). */
  address?: string;
  phoneNumber?: string;
  website?: string;
  enrolmentNumber?: string;
  /** data: URI, already fetched + encoded by the data layer. */
  logoDataURI?: string;
}

/** Mirror of iOS `JobDetail` as consumed by the template. */
export interface PdfJob {
  id: string;
  createdAt: Date;
  certificateType?: PdfCertificateType;
  installationDetails?: PdfInstallationDetails;
  supplyCharacteristics?: PdfSupplyCharacteristics;
  boards: PdfBoard[];
  circuits: PdfCircuit[];
  observations: PdfObservation[];
  inspectionSchedule?: PdfInspectionSchedule;
  extentAndType?: PdfExtentAndType;
  designConstruction?: PdfDesignConstruction;
  inspectorId?: string;
  authorisedById?: string;
  designerId?: string;
  constructorId?: string;
}
