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
 *
 * 2026-05-03: Added `slots[]`, `extraction_source`, `board_technology`,
 * and `technology_override` — all returned by the per-slot
 * crop-and-classify pipeline shipped 2026-04-22 (commit 613d54b on the
 * backend). iOS decodes the same fields in
 * CertMateUnified/Sources/Models/FuseboardAnalysis.swift. Without the
 * decode, the PWA was silently dropping per-slot confidence (so any UI
 * that wants to gate row overwrites on slot confidence couldn't see it),
 * and `apply-ccu-analysis.ts` had no way to branch on rewireable vs
 * modern boards.
 */

import { z } from 'zod';

const nstr = z.string().nullable().optional();

export const CCUAnalysisCircuitSchema = z
  .object({
    /** Optional — the per-slot pipeline emits standalone-RCD schedule
     *  rows with `circuit_number: null` and `is_rcd_device: true` so
     *  consumers must filter them out before mapping to a circuit. */
    circuit_number: z.number().nullable().optional(),
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
    /** Set by the backend merger for standalone-RCD schedule rows
     *  (2-module BS EN 61008-1 devices). Filter these out before
     *  mapping to a numbered circuit; the BS EN number the row carries
     *  is already applied at the board-SPD/main-switch level. */
    is_rcd_device: z.boolean().optional(),
  })
  .passthrough();

/**
 * Per-slot classification from the Stage 3 crop-and-classify pipeline.
 *
 * Shape covers both modern (`mcb | rcbo | rcd | main_switch | spd | blank`)
 * and rewireable (`rewireable | cartridge | blank | main_switch`) classifiers.
 * `unknown` and `empty` also appear. All device-read fields are
 * optional — the backend only populates what the VLM could actually
 * read; blanks and low-confidence slots leave them null.
 *
 * `label`/`labelRaw`/`labelConfidence` are populated by the Stage 4
 * label-pass when it succeeds (see extraction.js:1888-1910).
 */
export const CCUSlotBBoxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  })
  .passthrough();

export const CCUSlotSchema = z
  .object({
    slotIndex: z.number(),
    classification: z.string().nullable().optional(),
    manufacturer: nstr,
    model: nstr,
    ratingAmps: z.number().nullable().optional(),
    poles: z.number().nullable().optional(),
    tripCurve: nstr,
    sensitivity: z.number().nullable().optional(),
    rcdWaveformType: nstr,
    bsEn: nstr,
    /** Rewireable/cartridge only — e.g. "red", "blue", "white" per BS 3036 colour code. */
    bodyColour: nstr,
    confidence: z.number().nullable().optional(),
    /** `{x, y, w, h}` in original-photo pixel coordinates. */
    bbox: CCUSlotBBoxSchema.nullable().optional(),
    /** Cropped JPEG (base64) — drives the iOS tap-to-correct grid. */
    crop: z
      .object({
        bbox: CCUSlotBBoxSchema.nullable().optional(),
        base64: nstr,
      })
      .passthrough()
      .nullable()
      .optional(),
    /** Stage 4 label-pass output. */
    label: nstr,
    labelRaw: nstr,
    labelConfidence: z.number().nullable().optional(),
  })
  .passthrough();

export const CCUAnalysisSchema = z
  .object({
    board_manufacturer: nstr,
    board_model: nstr,
    /** Overcurrent-protection technology — drives downstream defaults
     *  (rewireable boards have no RCD protection / no kA breaking
     *  capacity). Returned by the board-classifier as of 2026-04-22. */
    board_technology: z
      .enum(['modern', 'rewireable_fuse', 'cartridge_fuse', 'mixed'])
      .nullable()
      .optional(),
    /** Set when the board-model classifier overrides a VLM-issued
     *  rewireable_fuse / cartridge_fuse classification because the model
     *  string matches a known modern series (Wylex NHRS, Hager VML).
     *  Useful only for telemetry / debug; the UI should use
     *  `board_technology` directly. */
    technology_override: z
      .object({
        appliedBy: z.string().optional(),
        fromVlm: z.string().optional(),
        toTechnology: z.string().optional(),
        series: z.string().optional(),
        matchedPattern: z.string().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
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
    /** Per-slot classifications from the Stage 3 crop-and-classify
     *  pipeline. Populated when the per-slot primary path succeeds. */
    slots: z.array(CCUSlotSchema).nullable().optional(),
    /** "geometric-merged" when circuits[] was built from Stage 3 slot
     *  classifications; "single-shot" / "classifier-only" when the
     *  geometric pipeline errored or returned empty. */
    extraction_source: nstr,
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
