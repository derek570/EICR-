/**
 * Re-export job types from @certmate/shared-types.
 * This file exists so that relative imports (../types/job) resolve correctly.
 */
export type {
  Job,
  JobDetail,
  SaveJobData,
  CertificateType,
  Circuit,
  BoardInfo,
  Board,
  Observation,
  SupplyCharacteristics,
  InstallationDetails,
  InspectionItem,
  InspectionSchedule,
  InspectorProfile,
  ExtentAndType,
  DesignConstruction,
  JobPhoto,
} from "@certmate/shared-types";
