/**
 * Shared Multer upload utilities — MIME type constants and file filter factory.
 *
 * Prevents arbitrary file uploads by restricting accepted MIME types
 * at the Multer middleware level before files reach route handlers.
 */

/** Allowed image MIME types */
export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/heic', 'image/gif', 'image/webp'];

/** Allowed audio MIME types */
export const AUDIO_MIMES = [
  'audio/m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/aac',
  'audio/x-m4a',
  'audio/mp3',
  'audio/flac',
  'audio/x-flac',
];

/** Allowed document MIME types */
export const DOCUMENT_MIMES = ['application/pdf'];

/**
 * Create a Multer fileFilter function that only accepts the given MIME types.
 *
 * @param {string[]} allowedMimes - Array of allowed MIME type strings
 * @returns {Function} Multer fileFilter callback
 */
export function createFileFilter(allowedMimes) {
  const allowed = new Set(allowedMimes);
  return (_req, file, cb) => {
    if (allowed.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  };
}

/**
 * Express error-handling middleware for Multer file filter rejections.
 * Mount on a router after upload routes to return 400 instead of 500.
 *
 * @param {Error} err
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function handleUploadError(err, _req, res, next) {
  if (err && err.message && err.message.startsWith('File type not allowed:')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
}
