/**
 * Photo wire schemas — observation photo upload + delete.
 *
 * The backend generates the final filename server-side
 * (`photo_{timestamp}.{ext}`) and returns the canonical URLs; callers
 * append the returned `filename` to the observation's `photos` array
 * and persist via `saveJob`.
 */

import { z } from 'zod';

export const UploadObservationPhotoResponseSchema = z.object({
  success: z.literal(true),
  photo: z.object({
    filename: z.string(),
    url: z.string(),
    thumbnail_url: z.string(),
    uploaded_at: z.string(),
  }),
});

export const DeleteObservationPhotoResponseSchema = z.object({
  success: z.literal(true),
});
