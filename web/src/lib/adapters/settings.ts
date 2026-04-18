/**
 * Settings wire schemas — inspector profiles, signatures, company
 * branding, logo. Paired with Phase 6a/6b routes under
 * `/api/inspector-profiles/*` and `/api/settings/:userId/*`.
 *
 * Profiles round-trip iOS ↔ web (the equipment block mirrors
 * `Inspector.swift` 1:1), so the field list here is the union of both
 * clients. Backend persists the blob verbatim, so forward-compat
 * additions round-trip untouched via `.passthrough()`.
 */

import { z } from 'zod';

export const InspectorProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    position: z.string().optional(),
    organisation: z.string().optional(),
    enrolment_number: z.string().optional(),
    signature_file: z.string().optional(),
    is_default: z.boolean().optional(),
    mft_serial_number: z.string().optional(),
    mft_calibration_date: z.string().optional(),
    continuity_serial_number: z.string().optional(),
    continuity_calibration_date: z.string().optional(),
    insulation_serial_number: z.string().optional(),
    insulation_calibration_date: z.string().optional(),
    earth_fault_serial_number: z.string().optional(),
    earth_fault_calibration_date: z.string().optional(),
    rcd_serial_number: z.string().optional(),
    rcd_calibration_date: z.string().optional(),
  })
  .passthrough();

export const InspectorProfileListSchema = z.array(InspectorProfileSchema);

/**
 * The backend returns sensible empty defaults when no blob exists, so
 * every field is optional at the wire level; the form always has
 * something to render. Logo is an S3 key (or `null` to clear).
 */
export const CompanySettingsSchema = z
  .object({
    company_name: z.string().optional(),
    company_address: z.string().optional(),
    company_phone: z.string().optional(),
    company_email: z.string().optional(),
    company_website: z.string().optional(),
    company_registration: z.string().optional(),
    logo_file: z.string().nullable().optional(),
  })
  .passthrough();

export const UploadSignatureResponseSchema = z.object({
  success: z.literal(true),
  signature_file: z.string(),
});

export const UploadLogoResponseSchema = z.object({
  success: z.literal(true),
  logo_file: z.string(),
});

export const UpdateSettingsResponseSchema = z.object({ success: z.literal(true) });
