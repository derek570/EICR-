/**
 * Storage abstraction for EICR-oMatic 3000.
 * Supports both local filesystem (development) and AWS S3 (production).
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import logger from "./logger.js";

// Determine storage mode from environment
const S3_BUCKET = process.env.S3_BUCKET;
const USE_S3 = !!S3_BUCKET;

// Lazy-loaded S3 client
let _s3Client = null;

async function getS3() {
  if (!_s3Client) {
    const { S3Client } = await import("@aws-sdk/client-s3");
    _s3Client = new S3Client({
      region: process.env.AWS_REGION || "eu-west-2"
    });
  }
  return _s3Client;
}

// Local storage base path
const LOCAL_DATA_DIR = path.resolve(import.meta.dirname, "..", "data");

/**
 * Ensure a local directory exists.
 */
async function ensureLocalDir(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Get the storage prefix for a job.
 * @param {string} userId
 * @param {string} jobId
 * @returns {string}
 */
export function getJobPrefix(userId, jobId) {
  if (USE_S3) {
    return `jobs/${userId}/${jobId}/`;
  }
  return path.join(LOCAL_DATA_DIR, `OUTPUT_${userId}`, jobId);
}

// ============= File Operations =============

/**
 * Upload a file to storage.
 * @param {string} localPath - Path to local file
 * @param {string} remoteKey - S3 key or relative path in data directory
 * @returns {Promise<boolean>}
 */
export async function uploadFile(localPath, remoteKey) {
  if (USE_S3) {
    try {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = await getS3();
      const fileContent = await fs.readFile(localPath);

      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: remoteKey,
        Body: fileContent
      }));
      return true;
    } catch (e) {
      logger.error("S3 upload error", { error: e.message });
      return false;
    }
  } else {
    // Local: copy file
    const dest = path.join(LOCAL_DATA_DIR, remoteKey);
    await ensureLocalDir(dest);
    await fs.copyFile(localPath, dest);
    return true;
  }
}

/**
 * Upload bytes directly to storage.
 * @param {Buffer|string} data - Data to upload
 * @param {string} remoteKey - S3 key or relative path
 * @param {string} [contentType] - MIME type for S3
 * @returns {Promise<boolean>}
 */
export async function uploadBytes(data, remoteKey, contentType = "application/octet-stream") {
  const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;

  if (USE_S3) {
    try {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = await getS3();

      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: remoteKey,
        Body: buffer,
        ContentType: contentType
      }));
      return true;
    } catch (e) {
      logger.error("S3 upload error", { error: e.message });
      return false;
    }
  } else {
    const dest = path.join(LOCAL_DATA_DIR, remoteKey);
    await ensureLocalDir(dest);
    await fs.writeFile(dest, buffer);
    return true;
  }
}

/**
 * Upload text content to storage.
 */
export async function uploadText(text, remoteKey) {
  return uploadBytes(text, remoteKey, "text/plain; charset=utf-8");
}

/**
 * Upload JSON data to storage.
 */
export async function uploadJson(data, remoteKey) {
  const json = JSON.stringify(data, null, 2);
  return uploadBytes(json, remoteKey, "application/json");
}

/**
 * Download a file from storage.
 * @param {string} remoteKey - S3 key or relative path
 * @param {string} localPath - Where to save locally
 * @returns {Promise<boolean>}
 */
export async function downloadFile(remoteKey, localPath) {
  await ensureLocalDir(localPath);

  if (USE_S3) {
    try {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = await getS3();

      const response = await s3.send(new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: remoteKey
      }));

      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      await fs.writeFile(localPath, Buffer.concat(chunks));
      return true;
    } catch (e) {
      logger.error("S3 download error", { error: e.message });
      return false;
    }
  } else {
    const src = path.join(LOCAL_DATA_DIR, remoteKey);
    if (fssync.existsSync(src)) {
      await fs.copyFile(src, localPath);
      return true;
    }
    return false;
  }
}

/**
 * Download file as Buffer.
 * @param {string} remoteKey
 * @returns {Promise<Buffer|null>}
 */
export async function downloadBytes(remoteKey) {
  if (USE_S3) {
    try {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = await getS3();

      const response = await s3.send(new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: remoteKey
      }));

      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (e) {
      if (e.name === "NoSuchKey") return null;
      logger.error("S3 download error", { error: e.message });
      return null;
    }
  } else {
    const src = path.join(LOCAL_DATA_DIR, remoteKey);
    if (fssync.existsSync(src)) {
      return fs.readFile(src);
    }
    return null;
  }
}

/**
 * Download file as text.
 */
export async function downloadText(remoteKey) {
  const data = await downloadBytes(remoteKey);
  return data ? data.toString("utf8") : null;
}

/**
 * Download and parse JSON file.
 */
export async function downloadJson(remoteKey) {
  const text = await downloadText(remoteKey);
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Check if a file exists in storage.
 */
export async function fileExists(remoteKey) {
  if (USE_S3) {
    try {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = await getS3();
      await s3.send(new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: remoteKey
      }));
      return true;
    } catch {
      return false;
    }
  } else {
    return fssync.existsSync(path.join(LOCAL_DATA_DIR, remoteKey));
  }
}

/**
 * Delete a file from storage.
 */
export async function deleteFile(remoteKey) {
  if (USE_S3) {
    try {
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = await getS3();
      await s3.send(new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: remoteKey
      }));
      return true;
    } catch (e) {
      logger.error("S3 delete error", { error: e.message });
      return false;
    }
  } else {
    const filePath = path.join(LOCAL_DATA_DIR, remoteKey);
    if (fssync.existsSync(filePath)) {
      await fs.unlink(filePath);
      return true;
    }
    return false;
  }
}

/**
 * Delete all files under a prefix (folder deletion).
 * Used to clean up old job folders after rename.
 * @param {string} prefix - S3 prefix or local directory path
 * @returns {Promise<{deleted: number, errors: number}>}
 */
export async function deletePrefix(prefix) {
  let deleted = 0;
  let errors = 0;

  if (USE_S3) {
    try {
      const { ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
      const s3 = await getS3();

      // List all objects under the prefix
      let continuationToken = undefined;
      do {
        const listResponse = await s3.send(new ListObjectsV2Command({
          Bucket: S3_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken
        }));

        if (listResponse.Contents && listResponse.Contents.length > 0) {
          // Delete in batches of up to 1000 (S3 limit)
          const objectsToDelete = listResponse.Contents.map(obj => ({ Key: obj.Key }));

          await s3.send(new DeleteObjectsCommand({
            Bucket: S3_BUCKET,
            Delete: { Objects: objectsToDelete }
          }));

          deleted += objectsToDelete.length;
        }

        continuationToken = listResponse.NextContinuationToken;
      } while (continuationToken);

      logger.info("Deleted S3 prefix", { prefix, deleted });
    } catch (e) {
      logger.error("S3 prefix delete error", { error: e.message, prefix });
      errors++;
    }
  } else {
    // Local: recursively delete directory
    const dirPath = path.join(LOCAL_DATA_DIR, prefix);
    if (fssync.existsSync(dirPath)) {
      try {
        await fs.rm(dirPath, { recursive: true, force: true });
        deleted = 1; // Count as 1 directory deletion
        logger.info("Deleted local directory", { dirPath });
      } catch (e) {
        logger.error("Local directory delete error", { error: e.message, dirPath });
        errors++;
      }
    }
  }

  return { deleted, errors };
}

/**
 * List files with a given prefix.
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
export async function listFiles(prefix) {
  if (USE_S3) {
    try {
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const s3 = await getS3();

      const response = await s3.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix
      }));

      if (!response.Contents) return [];
      return response.Contents.map(obj => obj.Key);
    } catch (e) {
      logger.error("S3 list error", { error: e.message });
      return [];
    }
  } else {
    const dirPath = path.join(LOCAL_DATA_DIR, prefix);
    if (!fssync.existsSync(dirPath)) return [];

    const stat = await fs.stat(dirPath);
    if (stat.isFile()) {
      return [prefix];
    }

    const results = [];
    async function walkDir(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else {
          results.push(path.relative(LOCAL_DATA_DIR, fullPath));
        }
      }
    }
    await walkDir(dirPath);
    return results;
  }
}

/**
 * List subdirectories under a prefix.
 */
export async function listDirectories(prefix) {
  if (USE_S3) {
    try {
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const s3 = await getS3();

      const response = await s3.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        Delimiter: "/"
      }));

      const prefixes = response.CommonPrefixes || [];
      return prefixes.map(p => p.Prefix.replace(/\/$/, "").split("/").pop());
    } catch (e) {
      logger.error("S3 list error", { error: e.message });
      return [];
    }
  } else {
    const dirPath = path.join(LOCAL_DATA_DIR, prefix);
    if (!fssync.existsSync(dirPath)) return [];

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  }
}

/**
 * List job folders for a user with metadata.
 * Returns array of { name, lastModified }
 */
export async function listJobFolders(prefix) {
  if (USE_S3) {
    try {
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const s3 = await getS3();

      const response = await s3.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        Delimiter: "/"
      }));

      const prefixes = response.CommonPrefixes || [];
      const folders = prefixes.map(p => ({
        name: p.Prefix.replace(/\/$/, "").split("/").pop(),
        lastModified: null
      }));

      // CommonPrefixes don't include LastModified — list actual objects
      // to get the most recent timestamp per folder.
      if (folders.length > 0) {
        try {
          const objResponse = await s3.send(new ListObjectsV2Command({
            Bucket: S3_BUCKET,
            Prefix: prefix,
            MaxKeys: 1000,
          }));
          const objects = objResponse.Contents || [];
          const folderDates = {};
          for (const obj of objects) {
            const folderName = obj.Key.replace(prefix, "").split("/")[0];
            const ts = obj.LastModified ? new Date(obj.LastModified).toISOString() : null;
            if (ts && (!folderDates[folderName] || ts > folderDates[folderName])) {
              folderDates[folderName] = ts;
            }
          }
          for (const f of folders) {
            f.lastModified = folderDates[f.name] || null;
          }
        } catch (e2) {
          logger.warn("S3 listJobFolders timestamp lookup failed", { error: e2.message });
        }
      }

      return folders;
    } catch (e) {
      logger.error("S3 listJobFolders error", { error: e.message });
      return [];
    }
  } else {
    const dirPath = path.join(LOCAL_DATA_DIR, prefix);
    if (!fssync.existsSync(dirPath)) return [];

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const folders = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const stat = await fs.stat(path.join(dirPath, entry.name));
        folders.push({
          name: entry.name,
          lastModified: stat.mtime.toISOString()
        });
      }
    }
    return folders;
  }
}

/**
 * Get a presigned URL for a file (S3 only).
 * For local, returns a file:// URL.
 */
export async function getFileUrl(remoteKey, expiresIn = 3600) {
  if (!(await fileExists(remoteKey))) return null;

  if (USE_S3) {
    try {
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = await getS3();

      const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: remoteKey
      }), { expiresIn });

      return url;
    } catch (e) {
      logger.error("S3 presign error", { error: e.message });
      return null;
    }
  } else {
    return `file://${path.join(LOCAL_DATA_DIR, remoteKey)}`;
  }
}

// ============= Job-Specific Operations =============

/**
 * Get all files for a job.
 */
export async function getJobFiles(userId, jobId) {
  const prefix = getJobPrefix(userId, jobId);
  const files = await listFiles(USE_S3 ? prefix : path.relative(LOCAL_DATA_DIR, prefix));

  if (USE_S3) {
    return files.map(f => f.slice(prefix.length));
  } else {
    return files.map(f => path.relative(path.relative(LOCAL_DATA_DIR, prefix), f));
  }
}

/**
 * Upload a file to a job's storage location.
 */
export async function uploadJobFile(userId, jobId, filename, data, contentType = null) {
  const prefix = getJobPrefix(userId, jobId);

  if (USE_S3) {
    const key = `${prefix}${filename}`;
    return uploadBytes(data, key, contentType || "application/octet-stream");
  } else {
    const key = path.join(path.relative(LOCAL_DATA_DIR, prefix), filename);
    return uploadBytes(data, key, contentType || "application/octet-stream");
  }
}

/**
 * Download a file from a job's storage location.
 */
export async function downloadJobFile(userId, jobId, filename) {
  const prefix = getJobPrefix(userId, jobId);

  if (USE_S3) {
    const key = `${prefix}${filename}`;
    return downloadBytes(key);
  } else {
    const key = path.join(path.relative(LOCAL_DATA_DIR, prefix), filename);
    return downloadBytes(key);
  }
}

/**
 * Check if storage is using S3.
 */
export function isUsingS3() {
  return USE_S3;
}

/**
 * Get the configured S3 bucket name.
 */
export function getBucketName() {
  return S3_BUCKET;
}
