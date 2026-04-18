/**
 * Adapter boundary — barrel export.
 *
 * Anything that validates a wire-level payload goes here. Call sites
 * outside `api-client.ts` should never import zod directly for HTTP
 * shapes — the point of this layer is that internal code trusts its
 * TypeScript types, and runtime checks happen exactly once on ingress.
 *
 * Type aliases mirror the existing exports in `../types.ts` so the
 * migration is a mechanical `import { ... } from '@/lib/adapters'`
 * swap when the next wave is ready to collapse the duplicate
 * declarations. Until then, both surfaces co-exist — `types.ts`
 * remains the compile-time source; these schemas are the runtime
 * source.
 */

export { parseOrWarn, parseOrThrow } from './validate';

export { UserSchema, LoginResponseSchema } from './auth';
export {
  CircuitRowSchema,
  ObservationRowSchema,
  InspectorInfoSchema,
  JobSchema,
  JobListSchema,
  JobDetailSchema,
  CreateJobResponseSchema,
  DeleteJobResponseSchema,
  SaveJobResponseSchema,
  DeepgramKeyResponseSchema,
} from './job';
export { CCUAnalysisSchema, CCUAnalysisCircuitSchema } from './ccu';
export {
  DocumentExtractionCircuitSchema,
  DocumentExtractionObservationSchema,
  DocumentExtractionFormDataSchema,
  DocumentExtractionResponseSchema,
} from './document';
export {
  InspectorProfileSchema,
  InspectorProfileListSchema,
  CompanySettingsSchema,
  UploadSignatureResponseSchema,
  UploadLogoResponseSchema,
  UpdateSettingsResponseSchema,
} from './settings';
export {
  CompanyMemberSchema,
  CompanyMemberListSchema,
  CompanyJobRowSchema,
  CompanyJobListSchema,
  CompanyStatsSchema,
  InviteEmployeeResponseSchema,
  paginatedSchema,
} from './company';
export {
  AdminUserSchema,
  AdminUserListSchema,
  AdminSuccessResponseSchema,
  CompanyLiteSchema,
  CompanyLiteListSchema,
} from './admin';
export {
  UploadObservationPhotoResponseSchema,
  DeleteObservationPhotoResponseSchema,
} from './photos';
