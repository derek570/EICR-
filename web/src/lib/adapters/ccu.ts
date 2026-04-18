/**
 * CCU analysis response — `/api/analyze-ccu`.
 *
 * Claude Sonnet 4.6 analyses a consumer-unit photo and returns board
 * metadata + main-switch + SPD + a circuits array. The backend prompt
 * evolves and occasionally adds new keys; `apply-ccu-analysis.ts` picks
 * only the fields it knows about, so we keep the envelope permissive
 * (`.passthrough()`).
 *
 * Every field on a CCU circuit entry is nullable at the source — Sonnet
 * returns `null` when a value isn't legible, and the UI treats `null`
 * and missing the same way. We model that as `.nullable().optional()`
 * rather than flipping each to `.optional()` alone, because the merge
 * helper does care about the difference when deciding whether to
 * overwrite a regex-filled field.
 */

import { z } from 'zod';

const nstr = z.string().nullable().optional();

export const CCUAnalysisCircuitSchema = z
  .object({
    circuit_number: z.number(),
    label: nstr,
    ocpd_type: z.enum(['B', 'C', 'D']).nullable().optional(),
    ocpd_rating_a: nstr,
    ocpd_bs_en: nstr,
    ocpd_breaking_capacity_ka: nstr,
    is_rcbo: z.boolean().optional(),
    rcd_protected: z.boolean().optional(),
    rcd_type: z.enum(['AC', 'A', 'B', 'F', 'S']).nullable().optional(),
    rcd_rating_ma: nstr,
    rcd_bs_en: nstr,
  })
  .passthrough();

export const CCUAnalysisSchema = z
  .object({
    board_manufacturer: nstr,
    board_model: nstr,
    main_switch_rating: nstr,
    main_switch_bs_en: nstr,
    main_switch_type: nstr,
    main_switch_poles: nstr,
    main_switch_current: nstr,
    main_switch_voltage: nstr,
    main_switch_position: z.enum(['left', 'right']).nullable().optional(),
    spd_present: z.boolean().optional(),
    spd_bs_en: nstr,
    spd_type: nstr,
    spd_rated_current_a: nstr,
    spd_short_circuit_ka: nstr,
    spd_rated_current: nstr,
    spd_type_supply: nstr,
    circuits: z.array(CCUAnalysisCircuitSchema).optional(),
    questionsForInspector: z.array(z.string()).optional(),
    confidence: z
      .object({
        overall: z.number().optional(),
        image_quality: z.enum(['clear', 'partially_readable', 'poor']).optional(),
        uncertain_fields: z.array(z.string()).optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
    gptVisionCost: z
      .object({
        cost_usd: z.number(),
        input_tokens: z.number(),
        output_tokens: z.number(),
        image_count: z.number(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
