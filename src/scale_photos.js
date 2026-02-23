import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "./logger.js";
import convert from "heic-convert";
import exifr from "exifr";

const execFileAsync = promisify(execFile);

/**
 * Extract capture timestamp from photo EXIF data
 * Uses exifr library which supports HEIC, JPEG, PNG, etc.
 * Returns ISO string or null if not available
 */
async function extractCaptureTime(imagePath) {
  try {
    // Use exifr to extract EXIF DateTimeOriginal (when photo was actually taken)
    const exif = await exifr.parse(imagePath, {
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'DateTime']
    });

    if (exif) {
      // Priority: DateTimeOriginal > CreateDate > ModifyDate > DateTime
      const captureDate = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || exif.DateTime;

      if (captureDate) {
        // exifr returns Date objects
        const isoString = captureDate instanceof Date
          ? captureDate.toISOString()
          : new Date(captureDate).toISOString();

        logger.debug(`Extracted EXIF capture time`, { file: path.basename(imagePath), captureTime: isoString });
        return isoString;
      }
    }

    // Fallback to file stats if no EXIF data
    logger.debug(`No EXIF timestamp found, using file stats`, { file: path.basename(imagePath) });
    const stats = await fs.stat(imagePath);
    const captureTime = stats.birthtime && stats.birthtime.getTime() > 0
      ? stats.birthtime
      : stats.mtime;

    return captureTime.toISOString();
  } catch (err) {
    logger.debug(`Could not extract capture time`, { file: path.basename(imagePath), error: err.message });

    // Last resort fallback to file stats
    try {
      const stats = await fs.stat(imagePath);
      return stats.mtime.toISOString();
    } catch {
      return null;
    }
  }
}

const IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif"
]);

const HEIC_EXTS = new Set([".heic", ".heif"]);

/**
 * Convert HEIC/HEIF to JPG using heic-convert (pure JS), Sharp, ImageMagick, or macOS sips
 */
async function convertHeicToJpg(inPath, outPath, longEdge, quality = 85) {
  const filename = path.basename(inPath);
  logger.info(`Converting HEIC file`, { file: filename });

  // Try heic-convert first (pure JS, works everywhere)
  try {
    logger.info(`Trying heic-convert for HEIC conversion`, { file: filename });
    const inputBuffer = await fs.readFile(inPath);
    const outputBuffer = await convert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: quality / 100  // heic-convert uses 0-1 scale
    });

    // Use Sharp to resize the converted JPEG
    await sharp(outputBuffer)
      .rotate()
      .resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toFile(outPath);

    logger.info(`Converted HEIC with heic-convert`, { file: filename });
    return;
  } catch (heicErr) {
    logger.info(`heic-convert failed`, { file: filename, error: heicErr.message });
  }

  // Try Sharp directly (works if libvips has HEIF support)
  try {
    logger.info(`Trying Sharp for HEIC conversion`, { file: filename });
    const image = sharp(inPath, { failOnError: false });
    const meta = await image.metadata();

    if (meta.width && meta.height) {
      const resize =
        meta.width >= meta.height
          ? { width: longEdge }
          : { height: longEdge };

      await image
        .rotate()
        .resize(resize)
        .jpeg({ quality, mozjpeg: true })
        .toFile(outPath);

      logger.info(`Converted HEIC with Sharp`, { file: filename });
      return;
    }
  } catch (sharpErr) {
    logger.info(`Sharp HEIC conversion failed`, { file: filename, error: sharpErr.message });
  }

  // Try ImageMagick convert (Linux fallback)
  try {
    logger.info(`Trying ImageMagick for HEIC conversion`, { file: filename });
    await execFileAsync("convert", [
      inPath,
      "-resize", `${longEdge}x${longEdge}>`,
      "-quality", String(quality),
      "-auto-orient",
      outPath
    ]);
    logger.info(`Converted HEIC with ImageMagick`, { file: filename });
    return;
  } catch (magickErr) {
    logger.info(`ImageMagick HEIC conversion failed`, { file: filename, error: magickErr.message });
  }

  // Fallback to macOS sips command
  logger.info(`Trying sips for HEIC conversion`, { file: filename });
  const tempJpg = outPath + ".tmp.jpg";

  await execFileAsync("sips", [
    "-s", "format", "jpeg",
    "-s", "formatOptions", "85",
    "--resampleHeightWidthMax", String(longEdge),
    inPath,
    "--out", tempJpg
  ]);

  await fs.rename(tempJpg, outPath);
  logger.info(`Converted HEIC with sips`, { file: filename });
}

/**
 * Scales all photos in a folder to a uniform size.
 * - Keeps aspect ratio
 * - Respects EXIF orientation
 * - Converts everything to JPG
 * - Uses macOS sips for HEIC/HEIF files
 * - Leaves originals untouched
 */
export async function scaleAllPhotosUniform({
  photosDir,
  outDir,
  longEdge = 2048,
  quality = 85
}) {
  await fs.mkdir(outDir, { recursive: true });

  let files = [];
  try {
    files = await fs.readdir(photosDir);
  } catch {
    // No photos folder present – that's OK
    return [];
  }

  const results = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;

    const inPath = path.join(photosDir, file);
    const baseName = file.slice(0, -ext.length); // Remove extension properly
    const outPath = path.join(outDir, baseName + ".jpg");

    try {
      // Extract capture time before processing
      const captureTime = await extractCaptureTime(inPath);

      // Check if already optimized (from iOS CertMate app)
      // Skip files under 2MB that are already 2048px or smaller
      if (!HEIC_EXTS.has(ext)) {
        const fileStats = await fs.stat(inPath);
        const fileSizeMB = fileStats.size / (1024 * 1024);

        if (fileSizeMB < 2) {
          const meta = await sharp(inPath, { failOnError: false }).metadata();

          if (meta.width && meta.height && meta.width <= 2048 && meta.height <= 2048) {
            logger.info(`Photo already optimized (${fileSizeMB.toFixed(1)}MB, ${meta.width}x${meta.height}), copying as-is`, { file });
            await fs.copyFile(inPath, outPath);
            results.push({ original: inPath, scaled: outPath, captureTime, filename: baseName + ".jpg" });
            continue;
          }
        }
      }

      if (HEIC_EXTS.has(ext)) {
        // Use Sharp for HEIC/HEIF (cross-platform), with sips fallback on macOS
        await convertHeicToJpg(inPath, outPath, longEdge, quality);
      } else {
        // Use sharp for other formats
        const image = sharp(inPath, { failOnError: false });
        const meta = await image.metadata();

        const width = meta.width || longEdge;
        const height = meta.height || longEdge;

        const resize =
          width >= height
            ? { width: longEdge }
            : { height: longEdge };

        await image
          .rotate()
          .resize(resize)
          .jpeg({
            quality,
            mozjpeg: true
          })
          .toFile(outPath);

        logger.debug(`Scaled photo`, { file });
      }

      results.push({
        original: inPath,
        scaled: outPath,
        captureTime,
        filename: baseName + ".jpg"
      });
    } catch (err) {
      logger.error(`Failed to process photo`, { file, error: err.message });
    }
  }

  // Sort results by capture time (earliest first)
  results.sort((a, b) => {
    if (!a.captureTime) return 1;
    if (!b.captureTime) return -1;
    return new Date(a.captureTime) - new Date(b.captureTime);
  });

  return results;
}
