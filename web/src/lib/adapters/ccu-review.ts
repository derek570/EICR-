import { z } from 'zod';
import { CCUAnalysisSchema } from './ccu';
import { CircuitRowSchema } from './job';

export const CcuReviewSampleSchema = z.object({
  sampleId: z.string(),
  extractionId: z.string(),
  sessionId: z.string(),
  createdAt: z.string().nullable(),
  reviewed: z.boolean(),
});

export const CcuReviewListResponseSchema = z.object({
  items: z.array(CcuReviewSampleSchema),
  total: z.number(),
  reviewed: z.number(),
  unreviewed: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export const CcuReviewGroundTruthSchema = z.object({
  board: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])),
  circuits: z.array(CircuitRowSchema),
  notes: z.string(),
});

export const CcuReviewDetailResponseSchema = z.object({
  sample: CcuReviewSampleSchema,
  imageUrl: z.string(),
  extracted: CCUAnalysisSchema,
  extractionMeta: z.object({
    model: z.string().nullable(),
    timestamp: z.string().nullable(),
    totalElapsedMs: z.number().nullable(),
  }),
  groundTruth: CcuReviewGroundTruthSchema.nullable(),
  reviewMeta: z
    .object({
      reviewedAt: z.string().nullable(),
      revision: z.number(),
    })
    .nullable(),
  sessionConfirmedLayout: z.record(z.string(), z.unknown()).nullable(),
});

export const CcuReviewSaveResponseSchema = z.object({
  success: z.literal(true),
  sampleId: z.string(),
  reviewedAt: z.string(),
  revision: z.number(),
});
