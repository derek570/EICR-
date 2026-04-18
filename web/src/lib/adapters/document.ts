/**
 * Document extraction response — `/api/analyze-document`.
 *
 * GPT Vision extracts EICR/EIC form data from a photo (typed cert,
 * handwritten sheet, phone snap). Field keys match the backend prompt
 * schema (`src/routes/extraction.js:1349-1420`) 1:1 so the merge helper
 * (`apply-document-extraction.ts`) can copy straight onto the JobDetail
 * sections.
 *
 * Unlike CCU, no `questionsForInspector` here — the extraction path is
 * best-effort and the inspector reviews the filled tabs directly.
 */

import { z } from 'zod';

export const DocumentExtractionCircuitSchema = z
  .object({
    circuit_ref: z.string().optional(),
    circuit_designation: z.string().optional(),
    live_csa_mm2: z.string().optional(),
    cpc_csa_mm2: z.string().optional(),
    wiring_type: z.string().optional(),
    ref_method: z.string().optional(),
    number_of_points: z.string().optional(),
    ocpd_type: z.string().optional(),
    ocpd_rating_a: z.string().optional(),
    ocpd_bs_en: z.string().optional(),
    ocpd_breaking_capacity_ka: z.string().optional(),
    rcd_type: z.string().optional(),
    rcd_operating_current_ma: z.string().optional(),
    rcd_bs_en: z.string().optional(),
    ring_r1_ohm: z.string().optional(),
    ring_rn_ohm: z.string().optional(),
    ring_r2_ohm: z.string().optional(),
    r1_r2_ohm: z.string().optional(),
    r2_ohm: z.string().optional(),
    ir_live_live_mohm: z.string().optional(),
    ir_live_earth_mohm: z.string().optional(),
    measured_zs_ohm: z.string().optional(),
    polarity_confirmed: z.string().optional(),
    rcd_time_ms: z.string().optional(),
    rcd_button_confirmed: z.string().optional(),
  })
  .passthrough();

export const DocumentExtractionObservationSchema = z
  .object({
    code: z.string().optional(),
    observation_text: z.string().optional(),
    item_location: z.string().optional(),
    schedule_item: z.string().optional(),
    regulation: z.string().optional(),
  })
  .passthrough();

export const DocumentExtractionFormDataSchema = z
  .object({
    installation_details: z.record(z.string(), z.unknown()).optional(),
    supply_characteristics: z.record(z.string(), z.unknown()).optional(),
    board_info: z.record(z.string(), z.unknown()).optional(),
    circuits: z.array(DocumentExtractionCircuitSchema).optional(),
    observations: z.array(DocumentExtractionObservationSchema).optional(),
  })
  .passthrough();

export const DocumentExtractionResponseSchema = z.object({
  success: z.boolean(),
  formData: DocumentExtractionFormDataSchema,
});
