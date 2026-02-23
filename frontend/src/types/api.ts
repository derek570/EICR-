/**
 * Re-export API types from @certmate/shared-types.
 * This file exists so that relative imports (../types/api) resolve correctly.
 */
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
} from "@certmate/shared-types";
