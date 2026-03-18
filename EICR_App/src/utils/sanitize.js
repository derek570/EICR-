/**
 * Input sanitization utilities for S3 key construction.
 *
 * Prevents path traversal attacks by stripping dangerous characters
 * from user-provided strings before they are used in S3 key paths.
 */

/**
 * Sanitize a string for safe use in S3 key paths.
 *
 * Strips path traversal sequences, path separators, null bytes,
 * and control characters from user-provided input.
 *
 * @param {string} input - User-provided string (e.g., address)
 * @returns {string} Sanitized string safe for S3 key construction
 */
export function sanitizeS3Path(input) {
  if (!input || typeof input !== 'string') return input;
  return (
    input
      .replace(/\.\./g, '') // Remove parent directory traversal
      .replace(/[/\\]/g, '-') // Replace path separators with dash
      .replace(/\0/g, '') // Remove null bytes
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f]/g, '') // Remove control characters
      .trim()
  );
}
