/**
 * Recording routes — session start, chunk processing, photo capture, finish, analytics, debug reports
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as auth from '../auth.js';
import * as db from '../db.js';
import * as storage from '../storage.js';
import { extractChunk } from '../extract_chunk.js';
import {
  createAccumulator,
  addChunk,
  addPhoto,
  getFormData,
  finalize,
  injectRingReading,
  injectReading,
} from '../chunk_accumulator.js';
import {
  createEICRBuffer,
  addTranscript,
  getExtractionPayload,
  markExtracted,
  parseRingValues,
  getRingReadings,
  getExtractionWindow,
  parseCommonReadings,
} from '../eicr_buffer.js';
import { transcribeChunk } from '../transcribe.js';
import { circuitsToCSV } from '../export.js';
import { extractSession } from '../extract_session.js';
import { generateAndSaveDebugReports } from '../generate_debug_report.js';
import { createTokenAccumulator, logTokenUsage } from '../token_logger.js';
import { stripMarkdown, isNoSpeechDescription } from '../utils/html.js';
import { routeTimeout } from '../utils/jobs.js';
import {
  activeSessions,
  getActiveSession,
  setActiveSession,
  deleteActiveSession,
} from '../state/recording-sessions.js';
import logger from '../logger.js';
import { createFileFilter, IMAGE_MIMES, AUDIO_MIMES, handleUploadError } from '../utils/upload.js';

const router = Router();

const diskStorage = multer.diskStorage({
  destination: os.tmpdir(),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.m4a';
    cb(null, `${file.fieldname}-${Date.now()}${ext}`);
  },
});

const uploadLimits = { fileSize: 100 * 1024 * 1024 };

// Specialized Multer instances with MIME type filters
const audioUpload = multer({
  storage: diskStorage,
  limits: uploadLimits,
  fileFilter: createFileFilter(AUDIO_MIMES),
});

const photoUpload = multer({
  storage: diskStorage,
  limits: uploadLimits,
  fileFilter: createFileFilter(IMAGE_MIMES),
});

const analyticsUpload = multer({
  storage: diskStorage,
  limits: uploadLimits,
  fileFilter: createFileFilter([
    'application/json',
    'application/x-ndjson',
    'application/octet-stream',
    ...AUDIO_MIMES,
    ...IMAGE_MIMES,
  ]),
});

// Debug audio keyword patterns
const DEBUG_START = /\b(?:d[\s-]?bug|debug|dee\s*bug)\b/i;
const DEBUG_END = /\b(?:end|stop|finish|done)\s+(?:d[\s-]?bug|debug)\b/i;

/**
 * Save a recording session's accumulated data to the database and S3.
 */
async function saveSession(
  sessionId,
  session,
  { address, certificateType = 'EICR', isStale = false, whisperDebugLog = null } = {}
) {
  const userId = session.userId;

  try {
    // 1. Flush any held short audio chunk
    if (session.audioHoldBuffer) {
      const held = session.audioHoldBuffer;
      session.audioHoldBuffer = null;
      logger.info('── FLUSHING HELD CHUNK ON SAVE ──', {
        sessionId,
        isStale,
        heldChunkIndex: held.chunkIndex,
      });
      try {
        const transcribeResult = await transcribeChunk(held.path);
        const rawTranscript =
          transcribeResult?.transcript ||
          (typeof transcribeResult === 'string' ? transcribeResult : '');
        const transcript = stripMarkdown(rawTranscript);
        if (transcribeResult?.usage) {
          session.tokenAccumulator.add(
            transcribeResult.usage,
            transcribeResult?.modelUsed || 'unknown'
          );
        }
        if (transcript && transcript.trim() && !isNoSpeechDescription(transcript)) {
          addTranscript(session.eicrBuffer, transcript);
        } else if (isNoSpeechDescription(transcript)) {
          logger.info('NOISE DESCRIPTION FILTERED (held chunk flush)', { sessionId, transcript });
        }
        await fs.unlink(held.path).catch(() => {});
      } catch (err) {
        logger.warn('Held chunk transcription failed on save', { sessionId, error: err.message });
        await fs.unlink(held.path).catch(() => {});
      }
    }

    // 2. Extract any remaining unextracted text
    if (session.eicrBuffer.pendingText.length > 0) {
      const payload = getExtractionPayload(session.eicrBuffer);
      const extractionWindow = getExtractionWindow(session.eicrBuffer, 3000);
      logger.info('── FINAL EXTRACTION (remaining buffer) ──', {
        sessionId,
        isStale,
        remainingChars: payload.pendingText.length,
        windowLength: extractionWindow.length,
        activeCircuit: payload.activeCircuit,
        activeTestType: payload.activeTestType,
      });
      try {
        const finalChunkData = await extractChunk(
          extractionWindow,
          session.chunksReceived,
          0,
          {
            activeCircuit: payload.activeCircuit,
            activeTestType: payload.activeTestType,
          },
          getFormData(session.accumulator)
        );
        if (finalChunkData.usage) {
          session.tokenAccumulator.add(
            finalChunkData.usage,
            process.env.EXTRACTION_MODEL || 'gpt-5.2'
          );
        }
        addChunk(session.accumulator, finalChunkData);
        markExtracted(session.eicrBuffer);
      } catch (err) {
        logger.error('Final extraction failed', { sessionId, error: err.message });
      }
    }

    // 3. Finalize the accumulator
    finalize(session.accumulator);

    // 4. Get form data
    const formData = getFormData(session.accumulator);

    // 5. Determine address and jobId
    const jobAddress =
      address ||
      session.address ||
      formData.installation_details?.address ||
      `Job ${new Date().toISOString().split('T')[0]}`;

    const jobId = session.jobId || `job_${Date.now()}`;
    const isExistingJob = !!session.jobId;

    logger.info(isStale ? 'Auto-saving stale session' : 'Finishing recording session', {
      sessionId,
      jobId,
      isExistingJob,
      isStale,
      address: jobAddress,
      circuits: formData.circuits.length,
      observations: formData.observations.length,
      photos: session.pendingPhotos?.length || 0,
    });

    // 6. Update or create job in database
    if (isExistingJob) {
      const existingJob = await db.getJob(jobId);
      const oldFolderName = existingJob?.folder_name || existingJob?.address || jobId;

      await db.updateJob(jobId, {
        folder_name: jobAddress,
        address: jobAddress,
        status: 'done',
        completed_at: new Date().toISOString(),
      });
      logger.info('Updated existing job', { jobId, address: jobAddress, oldFolder: oldFolderName });

      if (oldFolderName !== jobAddress && storage.isUsingS3()) {
        const oldPrefix = `jobs/${userId}/${oldFolderName}/`;
        try {
          await storage.deletePrefix(oldPrefix);
          logger.info('Cleaned up old S3 folder after address change', {
            jobId,
            oldPrefix,
            newFolder: jobAddress,
          });
        } catch (cleanupErr) {
          logger.warn('Failed to clean up old S3 folder', {
            jobId,
            oldPrefix,
            error: cleanupErr.message,
          });
        }
      }
    } else {
      await db.createJob({
        id: jobId,
        user_id: userId,
        folder_name: jobAddress,
        address: jobAddress,
        certificate_type: certificateType,
        status: 'done',
      });
      logger.info('Created new job', { jobId, address: jobAddress });
    }

    // 7. Upload to S3
    const s3Prefix = `jobs/${userId}/${jobAddress}/output/`;

    if (formData.circuits.length > 0) {
      const csvContent = circuitsToCSV(formData.circuits);
      await storage.uploadText(csvContent, `${s3Prefix}test_results.csv`);
    }

    const extractedData = {
      installation_details: formData.installation_details,
      supply_characteristics: formData.supply_characteristics,
      board_info: formData.board_info,
      observations: formData.observations,
      address: jobAddress,
    };
    await storage.uploadText(
      JSON.stringify(extractedData, null, 2),
      `${s3Prefix}extracted_data.json`
    );

    await storage.uploadText(
      JSON.stringify(formData.installation_details, null, 2),
      `${s3Prefix}installation_details.json`
    );
    await storage.uploadText(
      JSON.stringify(formData.board_info, null, 2),
      `${s3Prefix}board_details.json`
    );
    await storage.uploadText(
      JSON.stringify(formData.supply_characteristics, null, 2),
      `${s3Prefix}supply_characteristics.json`
    );
    await storage.uploadText(
      JSON.stringify(formData.observations, null, 2),
      `${s3Prefix}observations.json`
    );

    if (session.pendingPhotos && session.pendingPhotos.length > 0) {
      for (const photo of session.pendingPhotos) {
        await storage.uploadBytes(
          photo.buffer,
          `jobs/${userId}/${jobAddress}/photos/${photo.filename}`
        );
      }
      logger.info('Photos uploaded', { jobId, count: session.pendingPhotos.length });
    }

    // Save debug log
    const debugData = {
      sessionId,
      jobId,
      address: jobAddress,
      startedAt: new Date(session.startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - session.startedAt,
      chunksReceived: session.chunksReceived,
      chunks: session.debugLog,
      fullTranscript: session.eicrBuffer?.fullText || session.fullTranscript || '',
      extractedCircuits: formData.circuits.length,
      extractedObservations: formData.observations.length,
      savedBy: isStale ? 'stale-cleanup' : 'finish-endpoint',
    };
    await storage.uploadText(
      JSON.stringify(debugData, null, 2),
      `jobs/${userId}/${jobAddress}/output/debug_transcription.json`
    );
    logger.info('Debug transcription log saved', {
      sessionId,
      jobId,
      chunks: session.debugLog.length,
    });

    // Save whisper debug log
    if (whisperDebugLog) {
      try {
        const whisperLog =
          typeof whisperDebugLog === 'string' ? JSON.parse(whisperDebugLog) : whisperDebugLog;
        await storage.uploadText(
          JSON.stringify(whisperLog, null, 2),
          `jobs/${userId}/${jobAddress}/output/whisper_debug.json`
        );
        logger.info('Whisper debug log saved to S3', {
          sessionId,
          jobId,
          events: whisperLog.events?.length || 0,
          snapshots: whisperLog.transcriptSnapshots?.length || 0,
        });
      } catch (err) {
        logger.warn('Failed to save whisper debug log', { sessionId, error: err.message });
      }
    }

    // 8. Session-level GPT extraction
    if (!isStale && session.eicrBuffer.fullText && session.eicrBuffer.fullText.trim().length > 50) {
      try {
        logger.info('── SESSION-LEVEL GPT EXTRACTION ──', {
          sessionId,
          transcriptLength: session.eicrBuffer.fullText.length,
          existingCircuits: formData.circuits?.length || 0,
        });

        const existingData = {
          circuits: formData.circuits || [],
          supply_characteristics: formData.supply_characteristics || {},
          installation_details: formData.installation_details || {},
        };

        const sessionResult = await extractSession(session.eicrBuffer.fullText, existingData);

        if (sessionResult.usage) {
          session.tokenAccumulator.add(
            sessionResult.usage,
            process.env.EXTRACTION_MODEL || 'gpt-5.2'
          );
        }

        let gptFills = 0;

        // Merge circuit test fields
        for (const gptCircuit of sessionResult.circuits) {
          const ref = gptCircuit.circuit_ref;
          if (!ref) continue;

          const existing = formData.circuits.find(
            (c) => c.circuit_ref === ref || c.circuit_ref === String(ref)
          );

          if (existing) {
            const fillableFields = [
              'measured_zs_ohm',
              'r1_r2_ohm',
              'ring_r1_ohm',
              'ring_rn_ohm',
              'ring_r2_ohm',
              'ir_live_live_mohm',
              'ir_live_earth_mohm',
              'rcd_time_ms',
              'polarity_confirmed',
              'rcd_button_confirmed',
              'afdd_button_confirmed',
              'circuit_designation',
              'live_csa_mm2',
              'cpc_csa_mm2',
              'r2_ohm',
            ];
            for (const field of fillableFields) {
              if (gptCircuit[field] && !existing[field]) {
                existing[field] = gptCircuit[field];
                gptFills++;
                logger.info('GPT FILL', {
                  sessionId,
                  circuit: ref,
                  field,
                  value: gptCircuit[field],
                });
              }
            }
          }
        }

        // Merge supply characteristics
        const gptSupply = sessionResult.supply_characteristics || {};
        const existingSupply = formData.supply_characteristics || {};
        const supplyFillFields = [
          'earthing_arrangement',
          'earth_loop_impedance_ze',
          'prospective_fault_current',
          'earthing_conductor_csa',
          'earthing_conductor_material',
          'main_bonding_csa',
          'main_bonding_material',
          'bonding_water',
          'bonding_gas',
          'bonding_oil',
          'bonding_structural_steel',
          'supply_polarity_confirmed',
        ];
        for (const field of supplyFillFields) {
          if (gptSupply[field] && !existingSupply[field]) {
            existingSupply[field] = gptSupply[field];
            formData.supply_characteristics = existingSupply;
            gptFills++;
            logger.info('GPT FILL supply', { sessionId, field, value: gptSupply[field] });
          }
        }

        // Merge installation details
        const gptInstall = sessionResult.installation || {};
        const existingInstall = formData.installation_details || {};
        const installFillFields = [
          'client_name',
          'address',
          'postcode',
          'premises_description',
          'next_inspection_years',
          'extent',
          'agreed_limitations',
        ];
        for (const field of installFillFields) {
          if (gptInstall[field] && !existingInstall[field]) {
            existingInstall[field] = gptInstall[field];
            formData.installation_details = existingInstall;
            gptFills++;
            logger.info('GPT FILL install', { sessionId, field, value: gptInstall[field] });
          }
        }

        // Merge observations
        const gptObs = sessionResult.observations || [];
        const existingObs = formData.observations || [];
        for (const obs of gptObs) {
          if (!obs.observation_text) continue;
          const isDuplicate = existingObs.some(
            (e) =>
              e.observation_text &&
              e.observation_text
                .toLowerCase()
                .includes(obs.observation_text.toLowerCase().substring(0, 30))
          );
          if (!isDuplicate) {
            existingObs.push(obs);
            formData.observations = existingObs;
            gptFills++;
            logger.info('GPT FILL observation', { sessionId, text: obs.observation_text });
          }
        }

        logger.info('── GPT SESSION EXTRACTION COMPLETE ──', {
          sessionId,
          gptCircuits: sessionResult.circuits?.length || 0,
          gptFills,
          finalCircuits: formData.circuits?.length || 0,
          finalObservations: formData.observations?.length || 0,
        });

        // Re-upload GPT-enriched data
        if (gptFills > 0) {
          try {
            const s3Prefix2 = `jobs/${userId}/${jobAddress}/output/`;
            if (formData.circuits.length > 0) {
              const csvContent = circuitsToCSV(formData.circuits);
              await storage.uploadText(csvContent, `${s3Prefix2}test_results.csv`);
            }
            const enrichedData = {
              installation_details: formData.installation_details,
              supply_characteristics: formData.supply_characteristics,
              board_info: formData.board_info,
              observations: formData.observations,
              address: jobAddress,
            };
            await storage.uploadText(
              JSON.stringify(enrichedData, null, 2),
              `${s3Prefix2}extracted_data.json`
            );
            await storage.uploadText(
              JSON.stringify(formData.supply_characteristics, null, 2),
              `${s3Prefix2}supply_characteristics.json`
            );
            await storage.uploadText(
              JSON.stringify(formData.installation_details, null, 2),
              `${s3Prefix2}installation_details.json`
            );
            await storage.uploadText(
              JSON.stringify(formData.observations, null, 2),
              `${s3Prefix2}observations.json`
            );
            logger.info('GPT-enriched data re-uploaded to S3', { sessionId, gptFills });
          } catch (uploadErr) {
            logger.error('Failed to re-upload GPT-enriched data', {
              sessionId,
              error: uploadErr.message,
            });
          }
        }
      } catch (err) {
        logger.error('Session-level GPT extraction failed (non-fatal)', {
          sessionId,
          error: err.message,
        });
      }
    }

    // 9. Auto-close debug segments and generate reports
    if (session.debugMode && session.debugBuffer.trim()) {
      session.debugSegments.push({
        transcript: session.debugBuffer.trim(),
        startedAt: session.debugStartTime,
        endedAt: new Date().toISOString(),
        autoClosedOnSessionEnd: true,
      });
      session.debugMode = false;
      session.debugBuffer = '';
      logger.info('Debug segment auto-closed on session end', {
        sessionId,
        segmentCount: session.debugSegments.length,
      });
    }

    if (session.debugSegments.length > 0) {
      session.sessionId = sessionId;
      generateAndSaveDebugReports(session).catch((err) =>
        logger.error('Failed to generate debug reports', { sessionId, error: err.message })
      );
      logger.info('Debug reports queued for generation', {
        sessionId,
        segments: session.debugSegments.length,
      });
    }

    // 10. Log accumulated token usage
    const tokenTotals = session.tokenAccumulator.getTotals();
    if (tokenTotals.totalTokens > 0) {
      logger.info('Session token usage', {
        sessionId,
        isStale,
        geminiTokens: tokenTotals.geminiTokens,
        geminiCost: `$${tokenTotals.geminiCost.toFixed(4)}`,
        gptTokens: tokenTotals.gptTokens,
        gptCost: `$${tokenTotals.gptCost.toFixed(4)}`,
        totalTokens: tokenTotals.totalTokens,
        totalCost: `$${tokenTotals.totalCost.toFixed(4)}`,
      });
      try {
        await logTokenUsage({
          dataDir: '.',
          jobId,
          address: jobAddress,
          geminiTokens: tokenTotals.geminiTokens,
          geminiCost: tokenTotals.geminiCost,
          gptTokens: tokenTotals.gptTokens,
          gptCost: tokenTotals.gptCost,
          totalTokens: tokenTotals.totalTokens,
          totalCost: tokenTotals.totalCost,
        });
      } catch (err) {
        logger.warn('Failed to log session token usage', { err: err.message });
      }
    }

    // Clean up session
    activeSessions.delete(sessionId);

    logger.info(isStale ? 'Stale session auto-saved' : 'Recording session finished and saved', {
      sessionId,
      jobId,
      address: jobAddress,
    });

    return { jobId, address: jobAddress, formData };
  } catch (error) {
    logger.error(
      isStale ? 'Failed to auto-save stale session' : 'Failed to save recording session',
      {
        sessionId,
        error: error.message,
      }
    );
    if (isStale) {
      activeSessions.delete(sessionId);
    }
    throw error;
  }
}

// Clean up stale sessions every 5 minutes
let cleanupInterval = null;

export function startSessionCleanup() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      const staleThreshold = 30 * 60 * 1000;
      for (const [sessionId, session] of activeSessions) {
        if (now - session.lastActivity > staleThreshold) {
          const hasData =
            session.eicrBuffer?.fullText?.length > 0 ||
            session.accumulator?.circuits?.length > 0 ||
            session.accumulator?.observations?.length > 0;

          if (hasData) {
            logger.info('Stale session has data — auto-saving before cleanup', {
              sessionId,
              transcriptLength: session.eicrBuffer?.fullText?.length || 0,
              circuits: session.accumulator?.circuits?.length || 0,
              observations: session.accumulator?.observations?.length || 0,
            });
            saveSession(sessionId, session, { isStale: true }).catch((err) => {
              logger.error('Failed to auto-save stale session', { sessionId, error: err.message });
              activeSessions.delete(sessionId);
            });
          } else {
            logger.info('Cleaning up stale recording session (no data)', { sessionId });
            activeSessions.delete(sessionId);
          }
        }
      }
    },
    5 * 60 * 1000
  );
}

export function stopSessionCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Start cleanup on module load
startSessionCleanup();

// ============= Recording Endpoints =============

/**
 * Start a new real-time recording session
 * POST /api/recording/start
 */
router.post('/recording/start', auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { address, jobId } = req.body;

  const sessionId = `rec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const session = {
    accumulator: createAccumulator(),
    userId,
    jobId: jobId || null,
    address: address || '',
    addressUpdated: false,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    chunksReceived: 0,
    pendingChunks: 0,
    finishRequested: false,
    finishResolve: null,
    eicrBuffer: createEICRBuffer(),
    tokenAccumulator: createTokenAccumulator(),
    audioHoldBuffer: null,
    debugLog: [],
    recentTranscripts: [],
    processedChunks: new Map(),
    debugMode: false,
    debugBuffer: '',
    debugSegments: [],
    preDebugContext: '',
    debugStartTime: null,
    fullTranscript: '',
  };

  activeSessions.set(sessionId, session);

  logger.info('Recording session started', { sessionId, userId, jobId: jobId || '(new)' });

  res.json({
    sessionId,
    jobId: jobId || null,
    message: 'Recording session started. Send audio chunks to /api/recording/:sessionId/chunk',
  });
});

/**
 * Process an audio chunk
 * POST /api/recording/:sessionId/chunk
 */
router.post(
  '/recording/:sessionId/chunk',
  auth.requireAuth,
  routeTimeout(60000),
  audioUpload.single('audio'),
  async (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Recording session not found or expired' });
    }

    if (session.userId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const audioFile = req.file;
    const chunkIndex = parseInt(req.body.chunkIndex, 10) || session.chunksReceived;
    const chunkStartSeconds = parseInt(req.body.chunkStartSeconds, 10) || chunkIndex * 60;

    if (!audioFile) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    // Chunk deduplication
    if (session.processedChunks.has(chunkIndex)) {
      const cached = session.processedChunks.get(chunkIndex);
      logger.info('── DUPLICATE CHUNK DETECTED — returning cached response ──', {
        sessionId,
        chunkIndex,
        originalTranscript: (cached.transcript || '').substring(0, 100),
      });
      await fs.unlink(audioFile.path).catch(() => {});
      return res.json({
        success: true,
        chunkIndex,
        formData: getFormData(session.accumulator),
        message: 'Duplicate chunk — cached response returned',
        deduplicated: true,
      });
    }

    session.lastActivity = Date.now();
    session.chunksReceived++;
    session.pendingChunks++;

    try {
      const audioBuffer = await fs.readFile(audioFile.path);

      logger.info('── AUDIO CHUNK RECEIVED ──', {
        sessionId,
        chunkIndex,
        audioSize: `${audioBuffer.length} bytes (${Math.round(audioBuffer.length / 1024)}KB)`,
        audioFile: audioFile.originalname,
        mimeType: audioFile.mimetype,
      });

      let tempAudioPath = audioFile.path;

      // Short chunk concatenation
      const MIN_CHUNK_BYTES = 50_000;

      if (audioBuffer.length < MIN_CHUNK_BYTES && !session.audioHoldBuffer) {
        session.audioHoldBuffer = { path: tempAudioPath, chunkIndex, chunkStartSeconds };
        logger.info('── SHORT CHUNK HELD ──', {
          sessionId,
          chunkIndex,
          audioSize: audioBuffer.length,
          threshold: MIN_CHUNK_BYTES,
        });

        session.pendingChunks--;
        if (session.pendingChunks === 0 && session.finishRequested && session.finishResolve) {
          session.finishResolve();
        }

        return res.json({
          success: true,
          chunkIndex,
          formData: getFormData(session.accumulator),
          message: 'Short chunk held — will be combined with next chunk',
        });
      }

      // Concatenate held chunk if present
      let wasConcatenated = false;
      let heldChunkIndex = null;
      if (session.audioHoldBuffer) {
        const held = session.audioHoldBuffer;
        session.audioHoldBuffer = null;
        heldChunkIndex = held.chunkIndex;

        try {
          const heldAudioContent = await fs.readFile(held.path);
          const heldExt = path.extname(held.path) || '.m4a';
          const heldDebugKey = `debug/${session.userId}/${sessionId}/chunk_${String(held.chunkIndex).padStart(3, '0')}${heldExt}`;
          await storage.uploadBytes(
            heldAudioContent,
            heldDebugKey,
            audioFile.mimetype || 'audio/mp4'
          );
          logger.info('── HELD CHUNK AUDIO SAVED ──', {
            sessionId,
            heldChunkIndex: held.chunkIndex,
            debugKey: heldDebugKey,
          });
        } catch (heldSaveErr) {
          logger.warn('Failed to save held chunk audio', {
            sessionId,
            heldChunkIndex: held.chunkIndex,
            error: heldSaveErr.message,
          });
        }

        const concatPath = tempAudioPath.replace(/(\.[^.]+)$/, '_concat$1');
        try {
          const listPath = tempAudioPath.replace(/(\.[^.]+)$/, '_list.txt');
          await fs.writeFile(listPath, `file '${held.path}'\nfile '${tempAudioPath}'\n`);

          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execFileAsync = promisify(execFile);

          await execFileAsync(
            'ffmpeg',
            ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concatPath],
            { timeout: 10_000 }
          );

          await fs.unlink(held.path).catch(() => {});
          await fs.unlink(tempAudioPath).catch(() => {});
          await fs.unlink(listPath).catch(() => {});

          tempAudioPath = concatPath;
          wasConcatenated = true;
          logger.info('── CHUNKS CONCATENATED ──', {
            sessionId,
            heldChunkIndex: held.chunkIndex,
            currentChunkIndex: chunkIndex,
            concatPath,
          });
        } catch (concatErr) {
          logger.warn('── CONCAT FAILED, using current chunk only ──', {
            sessionId,
            error: concatErr.message,
          });
          await fs.unlink(held.path).catch(() => {});
        }
      }

      // Transcribe
      let transcribeResult;
      let rawTranscript = '';
      let transcript = '';
      let modelUsed = 'unknown';
      let transcribeFailed = false;
      let isEmptyTranscriptError = false;

      try {
        transcribeResult = await transcribeChunk(tempAudioPath);
        rawTranscript =
          transcribeResult?.transcript ||
          (typeof transcribeResult === 'string' ? transcribeResult : '');
        transcript = stripMarkdown(rawTranscript);
        modelUsed = transcribeResult?.modelUsed || 'unknown';

        if (transcribeResult?.usage) {
          session.tokenAccumulator.add(transcribeResult.usage, modelUsed);
        }
      } catch (transcribeErr) {
        transcribeFailed = true;
        isEmptyTranscriptError = /empty transcript/i.test(transcribeErr.message);
        if (isEmptyTranscriptError) {
          logger.warn('── TRANSCRIPTION EMPTY (all models) — returning 422 ──', {
            sessionId,
            chunkIndex,
            error: transcribeErr.message,
          });
        } else {
          logger.warn('── TRANSCRIPTION FAILED (all models) — returning current data ──', {
            sessionId,
            chunkIndex,
            error: transcribeErr.message,
          });
        }
      }

      // Save audio chunk to S3 for debug
      const audioStats = await fs.stat(tempAudioPath).catch(() => null);
      const audioBytes = audioStats?.size || 0;
      const debugExt = path.extname(tempAudioPath) || '.m4a';
      const debugAudioKey = `debug/${session.userId}/${sessionId}/chunk_${String(chunkIndex).padStart(3, '0')}${debugExt}`;
      try {
        const audioContent = await fs.readFile(tempAudioPath);
        await storage.uploadBytes(audioContent, debugAudioKey, audioFile.mimetype || 'audio/mp4');
      } catch (debugErr) {
        logger.warn('Failed to save debug audio chunk', {
          sessionId,
          chunkIndex,
          error: debugErr.message,
        });
      }

      // Add to debug log
      session.debugLog.push({
        chunkIndex,
        chunkStartSeconds,
        timestamp: new Date().toISOString(),
        audioKey: debugAudioKey,
        audioBytes,
        wasConcatenated,
        heldChunkIndex: heldChunkIndex || null,
        transcriptRaw: rawTranscript,
        transcript: transcript || '(empty)',
        modelUsed,
        attempts: transcribeResult?.attempts || 0,
        isEmpty: !transcript || transcript.trim() === '',
        transcribeFailed,
      });

      await fs.unlink(tempAudioPath).catch(() => {});

      if (transcribeFailed) {
        if (isEmptyTranscriptError) {
          return res.status(422).json({
            success: false,
            chunkIndex,
            formData: getFormData(session.accumulator),
            message: 'Empty transcript — Gemini returned no speech after all retries',
          });
        }
        return res.json({
          success: true,
          chunkIndex,
          formData: getFormData(session.accumulator),
          message: 'Transcription failed — audio saved for debug, returning current data',
        });
      }

      logger.info('── TRANSCRIPTION RESULT ──', {
        sessionId,
        chunkIndex,
        modelUsed,
        attempts: transcribeResult?.attempts || 0,
        transcriptLength: transcript.length,
        isEmpty: !transcript || transcript.trim() === '',
        fullTranscript: transcript || '(empty)',
      });

      if (isNoSpeechDescription(transcript)) {
        logger.info('NOISE DESCRIPTION FILTERED', { sessionId, chunkIndex, transcript });
        return res.json({
          success: true,
          chunkIndex,
          formData: getFormData(session.accumulator),
          message: 'Chunk received but noise description filtered',
        });
      }

      if (!transcript || transcript.trim() === '') {
        logger.warn('Empty transcript for chunk', { sessionId, chunkIndex });
        return res.json({
          success: true,
          chunkIndex,
          formData: getFormData(session.accumulator),
          message: 'Chunk received but no speech detected',
          debug_mode: session.debugMode,
        });
      }

      // Debug audio capture — keyword detection
      if (session.debugMode && DEBUG_END.test(transcript)) {
        const debugText = transcript.replace(DEBUG_END, '').trim();
        if (debugText) session.debugBuffer += ' ' + debugText;

        session.debugSegments.push({
          transcript: session.debugBuffer.trim(),
          startedAt: session.debugStartTime,
          endedAt: new Date().toISOString(),
        });

        session.eicrBuffer.fullText = session.preDebugContext;
        session.debugMode = false;
        session.debugBuffer = '';

        logger.info('── DEBUG MODE ENDED ──', {
          sessionId,
          chunkIndex,
          segmentCount: session.debugSegments.length,
          segmentLength: session.debugSegments[session.debugSegments.length - 1].transcript.length,
        });

        session.processedChunks.set(chunkIndex, { transcript: '' });
        return res.json({
          success: true,
          chunkIndex,
          formData: getFormData(session.accumulator),
          message: 'Debug segment complete',
          debug_mode: false,
          debug_segment_complete: true,
        });
      }

      if (session.debugMode) {
        session.debugBuffer += ' ' + transcript;
        logger.info('── DEBUG MODE — buffering ──', {
          sessionId,
          chunkIndex,
          debugBufferLength: session.debugBuffer.length,
          preview: transcript.substring(0, 100),
        });

        session.processedChunks.set(chunkIndex, { transcript: '' });
        return res.json({
          success: true,
          chunkIndex,
          formData: getFormData(session.accumulator),
          message: 'Debug audio captured',
          debug_mode: true,
        });
      }

      if (DEBUG_START.test(transcript)) {
        session.preDebugContext = session.eicrBuffer.fullText;
        session.debugMode = true;
        session.debugStartTime = new Date().toISOString();
        session.debugBuffer = '';

        const parts = transcript.split(DEBUG_START);
        const beforeDebug = parts[0]?.trim() || '';
        const afterDebug = parts.slice(1).join(' ').trim() || '';
        if (afterDebug) session.debugBuffer = afterDebug;

        logger.info('── DEBUG MODE STARTED ──', {
          sessionId,
          chunkIndex,
          beforeDebug: beforeDebug.substring(0, 100),
          afterDebug: afterDebug.substring(0, 100),
        });

        if (!beforeDebug) {
          session.processedChunks.set(chunkIndex, { transcript: '' });
          return res.json({
            success: true,
            chunkIndex,
            formData: getFormData(session.accumulator),
            message: 'Debug mode activated',
            debug_mode: true,
          });
        }

        transcript = beforeDebug;
      }

      // Store transcript in sliding window
      session.recentTranscripts.push(transcript);
      if (session.recentTranscripts.length > 4) {
        session.recentTranscripts.shift();
      }

      // Add transcript to EICR-aware semantic buffer
      const { shouldExtract: shouldExtractNow } = addTranscript(session.eicrBuffer, transcript);

      // Local ring continuity parser
      const ringParsed = parseRingValues(session.eicrBuffer, transcript);
      const ringCircuitName =
        ringParsed.length > 0
          ? session.eicrBuffer.ringCircuit || session.eicrBuffer.activeCircuit
          : null;

      if (ringParsed.length > 0) {
        logger.info('── RING CONTINUITY LOCAL PARSE ──', {
          sessionId,
          chunkIndex,
          circuit: ringCircuitName,
          parsed: ringParsed,
          ringState: getRingReadings(session.eicrBuffer),
        });
      }

      // Local common readings parser
      const commonParsed = parseCommonReadings(session.eicrBuffer, transcript);
      if (commonParsed.length > 0) {
        logger.info('── COMMON READINGS LOCAL PARSE ──', {
          sessionId,
          chunkIndex,
          readings: commonParsed,
        });
      }

      logger.info('── TRANSCRIPT BUFFER ──', {
        sessionId,
        chunkIndex,
        pendingLength: session.eicrBuffer.pendingText.length,
        totalLength: session.eicrBuffer.fullText.length,
        activeCircuit: session.eicrBuffer.activeCircuit,
        activeTestType: session.eicrBuffer.activeTestType,
        recentTranscripts: session.recentTranscripts.length,
        shouldExtract: shouldExtractNow,
        bufferPreview: session.eicrBuffer.pendingText.substring(0, 200),
      });

      if (shouldExtractNow) {
        const payload = getExtractionPayload(session.eicrBuffer);
        const extractionWindow = getExtractionWindow(session.eicrBuffer, 3000);

        const chunkData = await extractChunk(
          extractionWindow,
          chunkIndex,
          chunkStartSeconds,
          {
            activeCircuit: payload.activeCircuit,
            activeTestType: payload.activeTestType,
          },
          getFormData(session.accumulator)
        );

        markExtracted(session.eicrBuffer);

        logger.info('── EXTRACTION RESULT (wider window) ──', {
          sessionId,
          chunkIndex,
          windowLength: extractionWindow.length,
          pendingTextLength: payload.pendingText.length,
          existingCircuits: getFormData(session.accumulator).circuits?.length || 0,
          activeCircuit: payload.activeCircuit,
          activeTestType: payload.activeTestType,
          circuits: Array.isArray(chunkData.circuits) ? chunkData.circuits.length : 0,
          circuitDetails: (Array.isArray(chunkData.circuits) ? chunkData.circuits : []).map(
            (c) => ({
              ref: c.circuit_ref,
              name: c.circuit_designation,
              zs: c.measured_zs_ohm,
              ir: c.ir_live_earth_mohm,
              ocpd: c.ocpd_rating_a,
              ring_r1: c.ring_r1_ohm,
              ring_rn: c.ring_rn_ohm,
              ring_r2: c.ring_r2_ohm,
              r1r2: c.r1_r2_ohm,
            })
          ),
          observations: Array.isArray(chunkData.observations) ? chunkData.observations.length : 0,
          observationDetails: (Array.isArray(chunkData.observations)
            ? chunkData.observations
            : []
          ).map((o) => ({
            code: o.code,
            location: o.item_location,
            text: (o.observation_text || '').substring(0, 80),
          })),
          board: chunkData.board || {},
          installation: chunkData.installation || {},
          supply: chunkData.supply_characteristics || {},
          usage: chunkData.usage,
        });

        if (chunkData.usage) {
          session.tokenAccumulator.add(chunkData.usage, process.env.EXTRACTION_MODEL || 'gpt-5.2');
        }

        addChunk(session.accumulator, chunkData);

        // Inject local ring values AFTER addChunk
        if (ringParsed.length > 0 && ringCircuitName) {
          for (const { field, value } of ringParsed) {
            injectRingReading(session.accumulator, ringCircuitName, field, value);
          }
          logger.info('── RING VALUES INJECTED POST-EXTRACTION ──', {
            sessionId,
            chunkIndex,
            circuit: ringCircuitName,
            injected: ringParsed,
          });
        }

        if (commonParsed.length > 0) {
          for (const reading of commonParsed) {
            const injected = injectReading(session.accumulator, reading);
            if (injected) {
              logger.info('── COMMON READING INJECTED ──', {
                sessionId,
                chunkIndex,
                reading: reading.name,
                field: reading.field,
                value: reading.value,
                target: reading.target,
                circuit: reading.circuitName,
              });
            }
          }
        }

        logger.info('── ACCUMULATED CIRCUITS ──', {
          sessionId,
          chunkIndex,
          circuits: session.accumulator.circuits.map((c) => ({
            ref: c.circuit_ref,
            name: c.circuit_designation,
            ring_r1: c.ring_r1_ohm || '-',
            ring_rn: c.ring_rn_ohm || '-',
            ring_r2: c.ring_r2_ohm || '-',
            r1_r2: c.r1_r2_ohm || '-',
            zs: c.measured_zs_ohm || '-',
            ir: c.ir_live_earth_mohm || '-',
          })),
        });
      } else {
        // Inject local regex values even when extraction doesn't fire
        if (ringParsed.length > 0 && ringCircuitName) {
          for (const { field, value } of ringParsed) {
            injectRingReading(session.accumulator, ringCircuitName, field, value);
          }
          logger.info('── RING VALUES INJECTED (no-extract path) ──', {
            sessionId,
            chunkIndex,
            circuit: ringCircuitName,
            injected: ringParsed,
          });
        }

        if (commonParsed.length > 0) {
          for (const reading of commonParsed) {
            const injected = injectReading(session.accumulator, reading);
            if (injected) {
              logger.info('── COMMON READING INJECTED (no-extract path) ──', {
                sessionId,
                chunkIndex,
                reading: reading.name,
                field: reading.field,
                value: reading.value,
                target: reading.target,
                circuit: reading.circuitName,
              });
            }
          }
        }

        logger.info('── SKIPPING EXTRACTION (semantic buffer incomplete) ──', {
          sessionId,
          chunkIndex,
          pendingLength: session.eicrBuffer.pendingText.length,
          activeCircuit: session.eicrBuffer.activeCircuit,
          activeTestType: session.eicrBuffer.activeTestType,
          ringInjected: ringParsed.length,
          commonInjected: commonParsed.length,
        });
      }

      const formData = getFormData(session.accumulator);

      logger.info('── ACCUMULATED FORM DATA ──', {
        sessionId,
        chunkIndex,
        circuitsTotal: formData.circuits.length,
        observationsTotal: formData.observations.length,
        chunksProcessed: formData.metadata?.chunksProcessed || 0,
        installationAddress: formData.installation_details?.address || '-',
        installationClient: formData.installation_details?.client_name || '-',
      });

      // Update job address if just extracted
      const extractedAddress = formData.installation_details?.address;
      if (session.jobId && extractedAddress && !session.addressUpdated) {
        try {
          await db.updateJob(session.jobId, { address: extractedAddress });
          session.addressUpdated = true;
          session.address = extractedAddress;
          logger.info('── JOB ADDRESS UPDATED ──', {
            sessionId,
            jobId: session.jobId,
            address: extractedAddress,
          });
        } catch (updateErr) {
          logger.warn('Failed to update job address', {
            sessionId,
            jobId: session.jobId,
            error: updateErr.message,
          });
        }
      }

      session.processedChunks.set(chunkIndex, { transcript: transcript || '' });

      res.json({
        success: true,
        chunkIndex,
        formData,
        debug_mode: session.debugMode,
      });
    } catch (error) {
      logger.error('Chunk processing failed', { sessionId, chunkIndex, error: error.message });
      const isEmptyTranscript = /empty transcript/i.test(error.message);
      const statusCode = isEmptyTranscript ? 422 : 500;
      res.status(statusCode).json({ error: 'Chunk processing failed: ' + error.message });
    } finally {
      session.pendingChunks = Math.max(0, (session.pendingChunks || 0) - 1);
      if (session.pendingChunks === 0 && session.finishRequested && session.finishResolve) {
        session.finishResolve();
      }
    }
  }
);

/**
 * Add a photo to the recording session
 * POST /api/recording/:sessionId/photo
 */
router.post(
  '/recording/:sessionId/photo',
  auth.requireAuth,
  photoUpload.single('photo'),
  async (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Recording session not found or expired' });
    }

    if (session.userId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const photoFile = req.file;
    const audioSeconds = parseInt(req.body.audioSeconds, 10);

    if (!photoFile) {
      return res.status(400).json({ error: 'No photo file provided' });
    }

    if (isNaN(audioSeconds)) {
      return res.status(400).json({ error: 'audioSeconds is required' });
    }

    session.lastActivity = Date.now();

    try {
      const ext = path.extname(photoFile.originalname).toLowerCase() || '.jpg';
      const filename = `IMG_${String(session.accumulator.photos.length + 1).padStart(3, '0')}${ext}`;

      const photoBuffer = await fs.readFile(photoFile.path);
      session.pendingPhotos = session.pendingPhotos || [];
      session.pendingPhotos.push({
        filename,
        buffer: photoBuffer,
        audioSeconds,
      });

      await fs.unlink(photoFile.path).catch(() => {});

      addPhoto(session.accumulator, filename, audioSeconds);

      logger.info('Photo added to session', {
        sessionId,
        filename,
        audioSeconds,
        linkedObservation: session.accumulator.photos.find((p) => p.filename === filename)
          ?.linkedToObservation,
      });

      const formData = getFormData(session.accumulator);

      res.json({
        success: true,
        filename,
        audioSeconds,
        formData,
        linkedPhotos: formData.metadata.linked_photos,
      });
    } catch (error) {
      logger.error('Photo upload failed', { sessionId, error: error.message });
      res.status(500).json({ error: 'Photo upload failed: ' + error.message });
    }
  }
);

/**
 * Upload session analytics
 * POST /api/session/:sessionId/analytics
 */
router.post(
  '/session/:sessionId/analytics',
  auth.requireAuth,
  analyticsUpload.fields([
    { name: 'debug_log', maxCount: 1 },
    { name: 'field_sources', maxCount: 1 },
    { name: 'manifest', maxCount: 1 },
    { name: 'job_snapshot', maxCount: 1 },
  ]),
  async (req, res) => {
    const { sessionId } = req.params;
    const userId = req.user.id;

    const tempFiles = [
      req.files?.debug_log?.[0]?.path,
      req.files?.field_sources?.[0]?.path,
      req.files?.manifest?.[0]?.path,
      req.files?.job_snapshot?.[0]?.path,
    ].filter(Boolean);

    try {
      const s3Prefix = `session-analytics/${userId}/${sessionId}/`;
      const uploads = [];

      const debugLogFile = req.files?.debug_log?.[0];
      if (debugLogFile) {
        const debugLogContent = await fs.readFile(debugLogFile.path);
        uploads.push(
          storage
            .uploadBytes(debugLogContent, `${s3Prefix}debug_log.jsonl`, 'application/x-ndjson')
            .then(() => ({ file: 'debug_log', status: 'ok' }))
            .catch((err) => ({ file: 'debug_log', status: 'failed', error: err.message }))
        );
      }

      const fieldSourcesFile = req.files?.field_sources?.[0];
      if (fieldSourcesFile) {
        const fieldSources = await fs.readFile(fieldSourcesFile.path, 'utf8');
        uploads.push(
          storage
            .uploadBytes(fieldSources, `${s3Prefix}field_sources.json`, 'application/json')
            .then(() => ({ file: 'field_sources', status: 'ok' }))
            .catch((err) => ({ file: 'field_sources', status: 'failed', error: err.message }))
        );
      }

      const manifestFile = req.files?.manifest?.[0];
      if (manifestFile) {
        const manifest = await fs.readFile(manifestFile.path, 'utf8');
        uploads.push(
          storage
            .uploadBytes(manifest, `${s3Prefix}manifest.json`, 'application/json')
            .then(() => ({ file: 'manifest', status: 'ok' }))
            .catch((err) => ({ file: 'manifest', status: 'failed', error: err.message }))
        );
      }

      const jobSnapshotFile = req.files?.job_snapshot?.[0];
      if (jobSnapshotFile) {
        const jobSnapshot = await fs.readFile(jobSnapshotFile.path, 'utf8');
        uploads.push(
          storage
            .uploadBytes(jobSnapshot, `${s3Prefix}job_snapshot.json`, 'application/json')
            .then(() => ({ file: 'job_snapshot', status: 'ok' }))
            .catch((err) => ({ file: 'job_snapshot', status: 'failed', error: err.message }))
        );
      }

      const results = await Promise.all(uploads);
      const failures = results.filter((r) => r.status === 'failed');

      if (failures.length > 0) {
        logger.warn('Partial analytics upload', { sessionId, userId, failures });
        return res.status(207).json({
          success: false,
          message: 'Some files failed to upload',
          results,
        });
      }

      logger.info('Session analytics uploaded', { sessionId, userId, s3Prefix });

      res.json({ success: true });
    } catch (error) {
      logger.error('Session analytics upload failed', { sessionId, userId, error: error.message });
      res.status(500).json({ error: 'Analytics upload failed: ' + error.message });
    } finally {
      for (const tmpPath of tempFiles) {
        fs.unlink(tmpPath).catch(() => {});
      }
    }
  }
);

/**
 * Upload inspector-confirmed CCU layout as Phase A ground-truth training label.
 *
 * After the inspector reviews and edits the circuits tab, iOS fires this
 * endpoint so we capture the canonical "final" answer for the session. Paired
 * with the earlier per-extraction original.jpg/result.json samples written by
 * /api/analyze-ccu, this gives us auto-labelled training data for the
 * geometric pipeline (plan 2026-04-16 §7).
 *
 * POST /api/session/:sessionId/confirmed-layout
 * Body: arbitrary JSON — typically { circuits: [...], boardManufacturer, ... }
 */
router.post('/session/:sessionId/confirmed-layout', auth.requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const userId = req.user.id;
  const layout = req.body;

  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    return res.status(400).json({ error: 'Layout body must be a JSON object' });
  }

  try {
    // Sanitize sessionId to a safe S3 path segment (path-traversal guard)
    const sessionSegment = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'no-session';
    const key = `ccu-extractions/${userId}/${sessionSegment}/final.json`;
    const ok = await storage.uploadJson(
      {
        userId,
        sessionId: sessionSegment,
        confirmedAt: new Date().toISOString(),
        layout,
      },
      key
    );
    if (!ok) {
      // storage.uploadJson swallows S3 errors and returns false — treat as upload failure
      throw new Error('storage.uploadJson returned false (S3 upload failed)');
    }
    logger.info('Confirmed CCU layout stored', { sessionId: sessionSegment, userId, key });
    res.json({ success: true, key });
  } catch (error) {
    logger.error('Confirmed layout upload failed', {
      sessionId,
      userId,
      error: error.message,
    });
    res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
});

/**
 * Upload a debug report from iOS
 * POST /api/debug-report
 */
router.post('/debug-report', auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { sessionId, issueText, address, jobId } = req.body;

  if (!issueText || !sessionId) {
    return res.status(400).json({ error: 'sessionId and issueText are required' });
  }
  if (issueText.length > 5000) {
    return res.status(400).json({ error: 'issueText exceeds maximum length of 5000 characters' });
  }

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = `debug-reports/${userId}/${timestamp}`;

    const debugReport = {
      severity: 'user_reported',
      tier: 'user',
      title: issueText.substring(0, 100),
      description: issueText,
      source: 'ios_v2_voice',
      timestamp: new Date().toISOString(),
    };

    const context = {
      userId,
      sessionId,
      jobId: jobId || '',
      address: address || '',
    };

    await Promise.all([
      storage.uploadJson(debugReport, `${prefix}/debug_report.json`),
      storage.uploadJson(context, `${prefix}/context.json`),
    ]);

    logger.info('Debug report uploaded from iOS', { prefix, sessionId, userId });
    res.json({ success: true, reportId: prefix });
  } catch (error) {
    logger.error('Debug report upload failed', { userId, sessionId, error: error.message });
    res.status(500).json({ error: 'Debug report upload failed: ' + error.message });
  }
});

/**
 * Finish the recording session
 * POST /api/recording/:sessionId/finish
 */
router.post('/recording/:sessionId/finish', auth.requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Recording session not found or expired' });
  }

  if (session.userId !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { address, certificateType = 'EICR', jobData, whisperDebugLog } = req.body;

  try {
    if (session.pendingChunks > 0) {
      logger.info('Finish waiting for pending chunks', {
        sessionId,
        pendingChunks: session.pendingChunks,
      });
      await Promise.race([
        new Promise((resolve) => {
          session.finishRequested = true;
          session.finishResolve = resolve;
          if (session.pendingChunks === 0) resolve();
        }),
        new Promise((resolve) => setTimeout(resolve, 90_000)),
      ]);
      logger.info('Finish done waiting', { sessionId, remainingChunks: session.pendingChunks });
    }

    // Whisper mode: populate accumulator from iOS jobData
    if (jobData && session.chunksReceived === 0) {
      logger.info('Whisper mode: populating accumulator from iOS jobData', {
        sessionId,
        circuits: jobData.circuits?.length || 0,
        observations: jobData.observations?.length || 0,
        hasInstallation: !!jobData.installation_details,
        hasSupply: !!jobData.supply_characteristics,
        boards: jobData.boards?.length || 0,
      });

      if (jobData.circuits && jobData.circuits.length > 0) {
        for (const circuit of jobData.circuits) {
          if (circuit.circuit_ref || circuit.circuit_designation) {
            session.accumulator.circuits.push({ ...circuit });
          }
        }
      }

      if (jobData.observations && jobData.observations.length > 0) {
        for (const obs of jobData.observations) {
          if (obs.observation_text || obs.item_location) {
            session.accumulator.observations.push({
              code: obs.code || 'C3',
              item_location: obs.item_location || '',
              observation_text: obs.observation_text || '',
              schedule_item: obs.schedule_item || '',
              schedule_description: obs.schedule_description || '',
              photos: obs.photos || [],
            });
          }
        }
      }

      if (jobData.installation_details && typeof jobData.installation_details === 'object') {
        session.accumulator.installation = { ...jobData.installation_details };
      }

      if (jobData.supply_characteristics && typeof jobData.supply_characteristics === 'object') {
        session.accumulator.supply = { ...jobData.supply_characteristics };
      }

      if (jobData.boards && jobData.boards.length > 0) {
        session.accumulator.board = { ...jobData.boards[0] };
      }

      if (!session.address && jobData.installation_details?.address) {
        session.address = jobData.installation_details.address;
      }

      logger.info('Whisper mode: accumulator populated', {
        sessionId,
        circuits: session.accumulator.circuits.length,
        observations: session.accumulator.observations.length,
        installationKeys: Object.keys(session.accumulator.installation).length,
        supplyKeys: Object.keys(session.accumulator.supply).length,
        boardKeys: Object.keys(session.accumulator.board).length,
      });

      if (whisperDebugLog) {
        try {
          const wdl =
            typeof whisperDebugLog === 'string' ? JSON.parse(whisperDebugLog) : whisperDebugLog;
          const rawTranscript = wdl.finalRawTranscript || wdl.finalTranscript || '';
          if (rawTranscript.trim().length > 20) {
            session.eicrBuffer.fullText = rawTranscript;
            logger.info('Whisper mode: extracted transcript for GPT session extraction', {
              sessionId,
              transcriptLength: rawTranscript.length,
            });
          }
        } catch (err) {
          logger.warn('Could not extract transcript from whisperDebugLog', {
            sessionId,
            error: err.message,
          });
        }
      }
    }

    const result = await saveSession(sessionId, session, {
      address,
      certificateType,
      whisperDebugLog,
    });

    res.json({
      success: true,
      jobId: result.jobId,
      address: result.address,
      formData: result.formData,
      message: 'Recording saved successfully',
    });
  } catch (error) {
    logger.error('Failed to finish recording session', { sessionId, error: error.message });
    res.status(500).json({ error: 'Failed to save recording: ' + error.message });
  }
});

/**
 * Extract structured EICR data from pre-transcribed text (WhisperKit mode)
 * POST /api/recording/extract-transcript
 */
router.post('/recording/extract-transcript', auth.requireAuth, async (req, res) => {
  const { transcript, sessionId, existingData } = req.body;

  if (!transcript || transcript.trim().length < 10) {
    return res.status(400).json({ error: 'Transcript too short for extraction' });
  }

  try {
    const result = await extractSession(transcript, existingData || null);

    const formData = {
      circuits: result.circuits || [],
      observations: result.observations || [],
      installation_details: result.installation || {},
      supply_characteristics: result.supply_characteristics || {},
      board_info: result.board || {},
    };

    if (result.usage) {
      logger.info('Whisper extract-transcript tokens', {
        sessionId: sessionId || 'none',
        inputTokens: result.usage.prompt_tokens,
        outputTokens: result.usage.completion_tokens,
        transcriptLength: transcript.length,
        circuitsExtracted: formData.circuits.length,
        observationsExtracted: formData.observations.length,
      });
    }

    res.json({ success: true, formData });
  } catch (error) {
    logger.error('Failed to extract transcript', {
      sessionId: sessionId || 'none',
      error: error.message,
      transcriptLength: transcript.length,
    });
    res.status(500).json({ error: 'Extraction failed: ' + error.message });
  }
});

/**
 * Get current form data for a recording session
 * GET /api/recording/:sessionId
 */
router.get('/recording/:sessionId', auth.requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Recording session not found or expired' });
  }

  if (session.userId !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  session.lastActivity = Date.now();

  res.json({
    sessionId,
    formData: getFormData(session.accumulator),
    chunksReceived: session.chunksReceived,
    photosCount: session.accumulator.photos.length,
    startedAt: session.startedAt,
  });
});

/**
 * Log sleep detector events (doze/wake transitions).
 * POST /api/recording/:sessionId/sleep-log
 *
 * Fire-and-forget from the frontend — logs to Winston for observability.
 */
router.post('/recording/:sessionId/sleep-log', auth.requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const { event, detail } = req.body;

  if (!event) {
    return res.status(400).json({ error: 'event required' });
  }

  logger.info('sleep-log', {
    sessionId,
    event,
    detail: detail || undefined,
    userId: req.user?.id || req.user?.userId || 'unknown',
  });

  res.json({ ok: true });
});

// Handle Multer file filter rejections with 400 status
router.use(handleUploadError);

export default router;
