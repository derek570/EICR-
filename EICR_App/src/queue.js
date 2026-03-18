import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { processJob } from './process_job.js';
import * as storage from './storage.js';
import * as db from './db.js';
import logger from './logger.js';
import { emitJobCompleted, emitJobFailed, emitJobProgress } from './realtime.js';
import { sendPushToUser } from './services/push.js';

const QUEUE_NAME = 'certificate-processing';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let connection = null;
let jobQueue = null;
let worker = null;
let redisAvailable = false;

export function getConnection() {
  if (!connection) {
    connection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 500, 3000);
      },
    });
    connection.on('error', (err) => {
      logger.warn('Redis connection error', { error: err.message });
    });
  }
  return connection;
}

export function isRedisAvailable() {
  return redisAvailable;
}

function getQueue() {
  if (!jobQueue) {
    jobQueue = new Queue(QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 7 * 24 * 3600 },
        removeOnFail: { age: 30 * 24 * 3600 },
      },
    });
  }
  return jobQueue;
}

async function uploadOutputDir(dir, prefix) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = path.join(dir, entry.name);
    const s3Key = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      await uploadOutputDir(localPath, `${s3Key}/`);
    } else {
      const content = await fs.readFile(localPath);
      await storage.uploadBytes(content, s3Key);
    }
  }
}

async function processorFn(job) {
  const { userId, jobId, localDir } = job.data;
  const jobLogger = logger.child({ jobId, userId });
  let tempDir = null;

  jobLogger.info('Worker picked up job');

  await db.updateJobStatus(jobId, userId, 'processing');

  try {
    let jobDir;
    let outDir;

    if (storage.isUsingS3()) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `eicr-job-${jobId}-`));
      jobDir = path.join(tempDir, 'input');
      outDir = path.join(tempDir, 'output');
      await fs.mkdir(jobDir, { recursive: true });
      await fs.mkdir(outDir, { recursive: true });

      const s3Prefix = `jobs/${userId}/${jobId}/input/`;
      const inputFiles = await storage.listFiles(s3Prefix);

      for (const s3Key of inputFiles) {
        const filename = path.basename(s3Key);
        const isPhoto = /\.(jpg|jpeg|png|heic)$/i.test(filename);
        const localPath = isPhoto
          ? path.join(jobDir, 'photos', filename)
          : path.join(jobDir, filename);
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await storage.downloadFile(s3Key, localPath);
      }

      jobLogger.info('Downloaded input files from S3', { fileCount: inputFiles.length });
    } else if (localDir) {
      jobDir = localDir;
      outDir = `${localDir}/output`;
      await fs.mkdir(outDir, { recursive: true });
    } else {
      const projectRoot = path.resolve(import.meta.dirname, '..');
      jobDir = path.join(projectRoot, 'data', `INCOMING_${userId}`, jobId);
      outDir = path.join(path.dirname(jobDir).replace('INCOMING', 'OUTPUT'), jobId);
    }

    const result = await processJob({ jobDir, outDir, jobId });

    if (storage.isUsingS3() && tempDir) {
      const folderName = result.address || jobId;
      const outputPrefix = `jobs/${userId}/${folderName}/output/`;
      const actualOutDir = result.finalOutDir || outDir;

      await uploadOutputDir(actualOutDir, outputPrefix);

      await db.updateJobStatus(jobId, userId, 'done', result.address);

      if (result.address && result.address !== jobId) {
        const oldPrefix = `jobs/${userId}/${jobId}/`;
        jobLogger.info('Scheduling old job folder deletion', { oldPrefix });
        storage.deletePrefix(oldPrefix).catch((err) => {
          jobLogger.warn('Failed to delete old S3 prefix', { oldPrefix, error: err.message });
        });
      }

      await fs.rm(tempDir, { recursive: true, force: true });
    } else {
      await db.updateJobStatus(jobId, userId, 'done', result.address);
    }

    jobLogger.info('Job processing complete', { address: result.address });
    return { ok: true, address: result.address };
  } catch (err) {
    jobLogger.error('Job processing failed', { error: err.message });
    await db.updateJobStatus(jobId, userId, 'failed').catch((dbErr) => {
      jobLogger.error('Failed to update job status to failed', { error: dbErr.message });
    });
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    throw err;
  }
}

export async function startWorker() {
  try {
    if (worker) {
      await worker.close();
      worker = null;
    }

    const conn = getConnection();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Redis connection timeout')), 5000);
      const onReady = () => {
        clearTimeout(timeout);
        conn.off('error', onError);
        resolve();
      };
      const onError = (err) => {
        clearTimeout(timeout);
        conn.off('ready', onReady);
        reject(err);
      };
      conn.once('ready', onReady);
      conn.once('error', onError);
      if (conn.status === 'ready') onReady();
    });

    redisAvailable = true;

    worker = new Worker(QUEUE_NAME, processorFn, {
      connection: getConnection(),
      concurrency: 2,
      limiter: { max: 5, duration: 60000 },
    });

    worker.on('completed', (job, result) => {
      logger.info('Queue job completed', { jobId: job.data.jobId, address: result?.address });
      emitJobCompleted(job.data.userId, job.data.jobId, result?.address);
      sendPushToUser(job.data.userId, {
        title: 'Certificate Ready',
        body: `EICR for ${result?.address || 'your property'} is ready for review`,
        url: `/job/${job.data.jobId}`,
        tag: `job-${job.data.jobId}`,
      }).catch((err) =>
        logger.error('Push notification failed (completed)', { error: err.message })
      );
    });

    worker.on('failed', async (job, err) => {
      logger.error('Queue job failed', { jobId: job?.data?.jobId, error: err.message });
      if (job?.data) {
        try {
          await db.updateJobStatus(job.data.jobId, job.data.userId, 'failed');
          emitJobFailed(job.data.userId, job.data.jobId, err.message);
          sendPushToUser(job.data.userId, {
            title: 'Processing Failed',
            body: `Job failed: ${err.message}`,
            url: '/dashboard',
            tag: `job-${job.data.jobId}`,
          }).catch((pushErr) =>
            logger.error('Push notification failed (failed)', { error: pushErr.message })
          );
        } catch (dbErr) {
          logger.error('Failed to update job status to failed', {
            jobId: job.data.jobId,
            error: dbErr.message,
          });
        }
      }
    });

    worker.on('progress', (job, progress) => {
      logger.info('Queue job progress', { jobId: job.data.jobId, progress });
      emitJobProgress(job.data.userId, job.data.jobId, progress);
    });

    logger.info('BullMQ worker started', { queue: QUEUE_NAME, concurrency: 2 });
  } catch (err) {
    redisAvailable = false;
    logger.warn('Redis unavailable, queue disabled. Jobs will run in-process.', {
      error: err.message,
    });
  }
}

export async function enqueueJob(userId, jobId, localDir = null) {
  if (!redisAvailable) {
    return null;
  }

  try {
    const queue = getQueue();
    const job = await queue.add(
      `process-${jobId}`,
      { userId, jobId, localDir },
      {
        jobId,
      }
    );
    logger.info('Job enqueued', { jobId, queueJobId: job.id });
    return job;
  } catch (err) {
    logger.warn('Failed to enqueue job, falling back to in-process', { jobId, error: err.message });
    redisAvailable = false;
    return null;
  }
}

export async function getQueueStatus(jobId) {
  if (!redisAvailable) {
    return { queued: false, reason: 'redis_unavailable' };
  }

  try {
    const queue = getQueue();
    const job = await queue.getJob(jobId);
    if (!job) {
      return { queued: false };
    }
    const state = await job.getState();
    return {
      queued: true,
      id: job.id,
      state,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
    };
  } catch (err) {
    logger.warn('Failed to get queue status', { jobId, error: err.message });
    return { queued: false, error: err.message };
  }
}

export async function getQueueHealth() {
  if (!redisAvailable) {
    return { available: false, reason: 'redis_unavailable' };
  }

  try {
    const queue = getQueue();
    const [waiting, active, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);
    return { available: true, waiting, active, failed, delayed };
  } catch (err) {
    logger.warn('Failed to get queue health', { error: err.message });
    return { available: false, error: err.message };
  }
}

export function getJobQueue() {
  return getQueue();
}
