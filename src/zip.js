/**
 * ZIP generation utility for bulk PDF export.
 * Streams multiple job PDFs into a ZIP archive.
 */

import archiver from 'archiver';
import * as storage from './storage.js';
import * as db from './db.js';
import logger from './logger.js';

/**
 * Create a ZIP archive containing PDFs for the given job IDs.
 * @param {string} userId - The user ID (for ownership verification)
 * @param {string[]} jobIds - Array of job IDs to include
 * @param {import("stream").Writable} outputStream - Writable stream to pipe the ZIP into
 * @returns {Promise<number>} Number of PDFs successfully added to the ZIP
 */
export async function createJobsZip(userId, jobIds, outputStream) {
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(outputStream);

  // Forward archive warnings/errors to the logger
  archive.on('warning', (err) => {
    if (err.code === 'ENOENT') {
      logger.warn('Archiver warning: file not found', { error: err.message });
    } else {
      logger.error('Archiver warning', { error: err.message });
    }
  });

  archive.on('error', (err) => {
    logger.error('Archiver error', { error: err.message });
    throw err;
  });

  let count = 0;
  const usedFilenames = new Set();

  for (const jobId of jobIds) {
    try {
      // Look up the job from the database (D2: user_id filter prevents IDOR)
      let job = await db.getJob(jobId, userId);
      if (!job) {
        // Try looking up by address (for legacy S3-only jobs)
        job = await db.getJobByAddress(userId, jobId);
      }

      if (!job) {
        logger.warn('Bulk download: skipping job (not found or wrong owner)', { jobId, userId });
        continue;
      }

      // Determine the S3 folder name (address takes precedence)
      const folderName = job.address || jobId;
      const pdfKey = `jobs/${userId}/${folderName}/output/eicr_certificate.pdf`;

      const pdfBuffer = await storage.downloadBytes(pdfKey);
      if (!pdfBuffer) {
        logger.warn('Bulk download: no PDF found for job', { jobId, pdfKey });
        continue;
      }

      // Build a safe filename from the address, deduplicating if needed
      let baseFilename = (job.address || jobId).replace(/[/\\:*?"<>|]/g, '_');
      let filename = `${baseFilename}.pdf`;

      // Handle duplicate filenames
      if (usedFilenames.has(filename.toLowerCase())) {
        let suffix = 2;
        while (usedFilenames.has(`${baseFilename}_${suffix}.pdf`.toLowerCase())) {
          suffix++;
        }
        filename = `${baseFilename}_${suffix}.pdf`;
      }
      usedFilenames.add(filename.toLowerCase());

      archive.append(pdfBuffer, { name: filename });
      count++;

      logger.info('Bulk download: added PDF to ZIP', { jobId, filename, size: pdfBuffer.length });
    } catch (error) {
      logger.error('Bulk download: error processing job', { jobId, error: error.message });
      // Continue with remaining jobs
    }
  }

  await archive.finalize();
  logger.info('Bulk download: ZIP finalized', {
    userId,
    totalPdfs: count,
    requestedJobs: jobIds.length,
  });
  return count;
}
