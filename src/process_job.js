import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { transcribeAudio } from "./transcribe.js";
import { extractAll } from "./extract.js";
import { enrichInstallationDetails } from "./postcode_lookup.js";
import { salvageNumbers } from "./salvage_numbers.js";
import { mergeSalvageIntoRows } from "./merge_salvage.js";
import { analyzePhotos } from "./analyze_photos.js";
import { generateTestResultsPDF } from "./generate_pdf.js";
import logger, { createJobLogger } from "./logger.js";
import { createTokenAccumulator, logTokenUsage } from "./token_logger.js";

/* ---------------- helpers ---------------- */

/**
 * Format seconds into MM:SS or HH:MM:SS format for audio timestamps
 */
function formatAudioTimestamp(seconds) {
  if (typeof seconds !== 'number' || isNaN(seconds)) return "00:00";

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

async function loadInspectorProfile(projectRoot) {
  const profilesPath = path.join(projectRoot, "config", "inspector_profiles.json");

  if (!fssync.existsSync(profilesPath)) {
    return { name: "", organisation: "", enrolment_number: "", mft_serial_number: "", signature_file: null };
  }

  try {
    const data = JSON.parse(await fs.readFile(profilesPath, "utf8"));
    const profiles = data.profiles || [];

    if (!profiles.length) {
      return { name: "", organisation: "", enrolment_number: "", mft_serial_number: "", signature_file: null };
    }

    // Try last selected first
    const lastSelected = data.last_selected;
    if (lastSelected) {
      const found = profiles.find(p => p.id === lastSelected);
      if (found) {
        return {
          name: found.name || "",
          organisation: found.organisation || "",
          enrolment_number: found.enrolment_number || "",
          mft_serial_number: found.mft_serial_number || "",
          signature_file: found.signature_file ? path.join(projectRoot, "assets", "signatures", found.signature_file) : null
        };
      }
    }

    // Try default
    const defaultProfile = profiles.find(p => p.is_default);
    if (defaultProfile) {
      return {
        name: defaultProfile.name || "",
        organisation: defaultProfile.organisation || "",
        enrolment_number: defaultProfile.enrolment_number || "",
        mft_serial_number: defaultProfile.mft_serial_number || "",
        signature_file: defaultProfile.signature_file ? path.join(projectRoot, "assets", "signatures", defaultProfile.signature_file) : null
      };
    }

    // Fall back to first
    const first = profiles[0];
    return {
      name: first.name || "",
      organisation: first.organisation || "",
      enrolment_number: first.enrolment_number || "",
      mft_serial_number: first.mft_serial_number || "",
      signature_file: first.signature_file ? path.join(projectRoot, "assets", "signatures", first.signature_file) : null
    };
  } catch {
    return { name: "", organisation: "", enrolment_number: "", mft_serial_number: "", signature_file: null };
  }
}

async function findAllAudioFiles(jobDir) {
  const files = await fs.readdir(jobDir);
  const audio = files
    .filter(f => /\.(m4a|mp3|wav|aac)$/i.test(f))
    .map(f => path.join(jobDir, f));

  // Sort by extension priority (m4a, mp3, wav, aac), then alphabetically
  const extPriority = { ".m4a": 0, ".mp3": 1, ".wav": 2, ".aac": 3 };
  return audio.sort((a, b) => {
    const extA = path.extname(a).toLowerCase();
    const extB = path.extname(b).toLowerCase();
    const priorityDiff = (extPriority[extA] ?? 99) - (extPriority[extB] ?? 99);
    if (priorityDiff !== 0) return priorityDiff;
    return a.localeCompare(b);
  });
}

async function maybeScalePhotos(jobDir, outDir) {
  const photosDir = path.join(jobDir, "photos");
  if (!fssync.existsSync(photosDir)) {
    return { ran: false, reason: "no photos folder" };
  }

  let mod;
  try {
    mod = await import("./scale_photos.js");
  } catch {
    return { ran: false, reason: "scale_photos.js not present" };
  }

  const fn = mod.scalePhotosInJob || mod.scalePhotos || mod.scaleAllPhotosUniform || mod.default;

  if (typeof fn !== "function") {
    return { ran: false, reason: "no callable export in scale_photos.js" };
  }

  const outPhotos = path.join(outDir, "photos_scaled");
  await fs.mkdir(outPhotos, { recursive: true });

  try {
    const photoResults = await fn({ photosDir, outDir: outPhotos });

    // Create photo manifest with timestamps for correlation
    const manifest = {
      photos: (photoResults || []).map(p => ({
        filename: p.filename || path.basename(p.scaled),
        captureTime: p.captureTime || null,
        original: path.basename(p.original)
      })),
      firstPhotoTime: null,
      lastPhotoTime: null,
      spanMinutes: null
    };

    // Calculate time span if we have timestamps
    const validTimes = manifest.photos
      .map(p => p.captureTime)
      .filter(Boolean)
      .map(t => new Date(t).getTime())
      .sort((a, b) => a - b);

    if (validTimes.length >= 1) {
      manifest.firstPhotoTime = new Date(validTimes[0]).toISOString();
      manifest.lastPhotoTime = new Date(validTimes[validTimes.length - 1]).toISOString();
      manifest.spanMinutes = Math.round((validTimes[validTimes.length - 1] - validTimes[0]) / 60000);
    }

    // Save manifest
    await fs.writeFile(
      path.join(outDir, "photos_manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );

    return { ran: true, outDir: outPhotos, manifest };
  } catch (e) {
    return { ran: true, error: String(e?.message || e) };
  }
}

function optionalSchemaPath() {
  const p = path.join("assets", "schema", "tradecert_csv_headers.json");
  return fssync.existsSync(p) ? p : null;
}

function missingToMd(missing) {
  if (!Array.isArray(missing) || !missing.length) {
    return "No missing values flagged.\n";
  }
  return (
    "# Missing values\n\n" +
    missing.map(m =>
      `- **${m.item || "Unknown"}** — ${m.reason || ""}`
    ).join("\n") +
    "\n"
  );
}

/* ---------------- main ---------------- */

export async function processJob({ jobDir, outDir, dryRun = false, jobId: providedJobId = null }) {
  // Use provided jobId if available, otherwise fall back to folder name
  const jobId = providedJobId || path.basename(jobDir);
  const log = createJobLogger(jobId);

  await fs.mkdir(outDir, { recursive: true });

  // Load baseline config for observation settings
  const projectRoot = path.resolve(import.meta.dirname, "..");
  let baselineConfig = {};
  try {
    const configPath = path.join(projectRoot, "config", "baseline_config.json");
    if (fssync.existsSync(configPath)) {
      baselineConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    }
  } catch (e) {
    log.debug("Could not load baseline config", { error: e.message });
  }

  // Create token accumulator to track API usage across the job
  const tokenAccumulator = createTokenAccumulator();

  /* 1️⃣ Find audio files (now optional - photos-only mode supported) */
  const audioPaths = await findAllAudioFiles(jobDir);

  /* 2️⃣ Optional photo scaling */
  const photoInfo = await maybeScalePhotos(jobDir, outDir);

  // Check we have at least photos OR audio
  const hasPhotos = photoInfo.ran || fssync.existsSync(path.join(jobDir, "photos"));
  if (!audioPaths.length && !hasPhotos) {
    throw new Error("No audio files and no photos found in job folder - need at least one");
  }

  if (!audioPaths.length) {
    log.info("Photos-only mode: No audio files found, proceeding with photos only");
  }

  /* 3️⃣ Transcription (Gemini) - process all audio files if present */
  const transcriptionResults = [];
  const transcriptParts = [];
  let transcript = "";

  if (audioPaths.length > 0) {
    for (const audioPath of audioPaths) {
      const fileName = path.basename(audioPath);
      log.info(`Transcribing audio file`, { fileName });

      const t = await transcribeAudio(audioPath);

      const partTranscript =
        typeof t === "string"
          ? t
          : (t && typeof t.transcript === "string" ? t.transcript : "");

      if (partTranscript.trim()) {
        transcriptParts.push({
          file: fileName,
          transcript: partTranscript.trim()
        });

        const modelUsed = typeof t === "object" ? t.modelUsed || null : process.env.GEMINI_MODEL || null;

        transcriptionResults.push({
          audioFile: fileName,
          modelUsed,
          attempts: typeof t === "object" ? t.attempts || null : null
        });

        // Track token usage from transcription
        if (typeof t === "object" && t.usage) {
          tokenAccumulator.add(t.usage, modelUsed);
        }
      } else {
        log.warn(`Empty transcript for audio file`, { fileName });
      }
    }

    // Combine transcripts with file markers if multiple files
    if (transcriptParts.length === 1) {
      transcript = transcriptParts[0].transcript;
    } else if (transcriptParts.length > 1) {
      transcript = transcriptParts
        .map((p, i) => `=== Audio File ${i + 1}: ${p.file} ===\n\n${p.transcript}`)
        .join("\n\n");
    }

    if (transcript) {
      await fs.writeFile(
        path.join(outDir, "transcript.txt"),
        transcript,
        "utf8"
      );
    }
  }

  const transcriptionMeta = {
    provider: audioPaths.length > 0 ? "gemini" : "none",
    mode: audioPaths.length > 0 ? "audio" : "photos-only",
    audioFiles: transcriptionResults,
    totalFiles: audioPaths.length,
    successfulTranscriptions: transcriptParts.length,
    photoScaling: photoInfo
  };

  await fs.writeFile(
    path.join(outDir, "transcription_meta.json"),
    JSON.stringify(transcriptionMeta, null, 2),
    "utf8"
  );

  /* 3b️⃣ Analyze photos for consumer unit info */
  let photoAnalysis = "";
  let questionsForInspector = [];
  const scaledPhotosDir = path.join(outDir, "photos_scaled");

  if (fssync.existsSync(scaledPhotosDir)) {
    log.info("Analyzing photos for consumer unit details");
    const photoResult = await analyzePhotos(scaledPhotosDir);

    // Track token usage from photo analysis
    tokenAccumulator.add(photoResult.usage, photoResult.model);

    if (photoResult.analysis) {
      photoAnalysis = photoResult.analysis;

      await fs.writeFile(
        path.join(outDir, "photo_analysis.txt"),
        photoAnalysis,
        "utf8"
      );

      log.info(`Photo analysis complete`, { photoCount: photoResult.photoCount });
    }

    // Save questions for inspector (extracted from CCU analysis Step 3h)
    if (photoResult.questionsForInspector && photoResult.questionsForInspector.length > 0) {
      questionsForInspector = photoResult.questionsForInspector;

      await fs.writeFile(
        path.join(outDir, "questions_for_inspector.json"),
        JSON.stringify({ questions: questionsForInspector }, null, 2),
        "utf8"
      );

      log.info(`CCU analysis has questions for inspector`, {
        count: questionsForInspector.length,
        questions: questionsForInspector
      });
    }
  }

  // Load photo timing context - prefer synchronized recording manifest over EXIF-based manifest
  let photoTimingContext = "";
  let usingSynchronizedCapture = false;

  // Check for synchronized recording manifest first (from PWA/app synchronized capture)
  const recordingManifestPath = path.join(jobDir, "recording_manifest.json");
  if (fssync.existsSync(recordingManifestPath)) {
    try {
      const recordingManifest = JSON.parse(await fs.readFile(recordingManifestPath, "utf8"));
      if (recordingManifest.photos && recordingManifest.photos.length > 0) {
        usingSynchronizedCapture = true;
        log.info("Using synchronized recording manifest for photo-audio correlation", {
          photoCount: recordingManifest.photos.length,
          audioDuration: recordingManifest.audio?.duration_seconds
        });

        // Format audio timestamps for AI context
        const photoTimings = recordingManifest.photos
          .map((p, i) => {
            const formatted = p.audio_timestamp_formatted || formatAudioTimestamp(p.audio_timestamp_seconds);
            return `Photo ${i + 1} (${p.filename}): taken at ${formatted} in the audio recording`;
          })
          .join("\n");

        photoTimingContext = `\n\n=== SYNCHRONIZED PHOTO CAPTURE TIMES (HIGHLY ACCURATE) ===\n` +
          `These photos were captured during the audio recording at these EXACT timestamps.\n` +
          `When matching observations to photos, use these timestamps:\n` +
          `- If the electrician mentions something at [02:05] in the transcript\n` +
          `- And Photo 3 was taken at 02:10\n` +
          `- Then Photo 3 shows what they were talking about\n\n` +
          `ALWAYS set source_photo to the photo taken closest to when the issue was mentioned.\n\n` +
          photoTimings;

        if (recordingManifest.audio?.duration_seconds) {
          const duration = formatAudioTimestamp(recordingManifest.audio.duration_seconds);
          photoTimingContext += `\n\nTotal recording duration: ${duration}`;
        }
        photoTimingContext += "\n";

        // Copy recording manifest to output for reference
        await fs.writeFile(
          path.join(outDir, "recording_manifest.json"),
          JSON.stringify(recordingManifest, null, 2),
          "utf8"
        );
      }
    } catch (e) {
      log.warn("Could not load recording manifest", { error: e.message });
    }
  }

  // Fall back to EXIF-based photo manifest if no synchronized capture
  if (!usingSynchronizedCapture) {
    const manifestPath = path.join(outDir, "photos_manifest.json");
    if (fssync.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        if (manifest.photos && manifest.photos.length > 0) {
          const photoTimings = manifest.photos
            .filter(p => p.captureTime)
            .map((p, i) => {
              const time = new Date(p.captureTime);
              const timeStr = time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              return `Photo ${i + 1} (${p.filename}): captured at ${timeStr}`;
            })
            .join("\n");

          if (photoTimings) {
            photoTimingContext = `\n\n=== PHOTO CAPTURE TIMES (from EXIF data) ===\n` +
              `Use these timestamps to correlate observations with photos.\n` +
              `If the transcript mentions taking a photo at a certain time, match it to the closest photo capture time.\n\n` +
              photoTimings;

            if (manifest.spanMinutes !== null && manifest.spanMinutes > 0) {
              photoTimingContext += `\n\nTotal photo span: ${manifest.spanMinutes} minutes`;
            }
            photoTimingContext += "\n";
          }
        }
      } catch (e) {
        log.debug("Could not load photo manifest for timing context", { error: e.message });
      }
    }
  }

  // Combine transcript with photo analysis for extraction
  let combinedContent = "";
  const questionsContext = questionsForInspector.length > 0
    ? `\n\n=== UNCERTAIN ITEMS FROM PHOTO ANALYSIS ===\nThe following could not be read clearly from the consumer unit photos. If the inspector clarified any of these during the audio recording, use their answers:\n${questionsForInspector.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n`
    : "";

  if (transcript && photoAnalysis) {
    // Both audio and photos - include timing context and questions
    combinedContent = `${transcript}${photoTimingContext}\n\n=== PHOTO ANALYSIS (Consumer Unit Details, Circuit Layouts, Handwritten Forms) ===\n\n${photoAnalysis}${questionsContext}`;
  } else if (photoAnalysis) {
    // Photos only mode
    combinedContent = `=== PHOTO ANALYSIS (Consumer Unit Details, Circuit Layouts, Handwritten Forms) ===\n\n${photoAnalysis}${questionsContext}`;
    log.info("Using photo analysis as primary data source");
  } else if (transcript) {
    // Audio only (no photos)
    combinedContent = transcript;
  }

  // Final check - must have some content to extract
  if (!combinedContent.trim()) {
    throw new Error("No content to extract - both transcript and photo analysis are empty");
  }

  /* 4️⃣ Structured extraction (GPT-5.2) */
  const schemaPath = optionalSchemaPath();

  const extractResult = await extractAll({
    transcript: combinedContent,
    headersPath: schemaPath,
    schemaPath
  });

  const { csv, rows, observations, missing, board, installation, supply_characteristics } = extractResult;

  // Track token usage from extraction
  tokenAccumulator.add(extractResult.usage, extractResult.model);

  // Enrich installation details with town/county from postcode lookup
  let enrichedInstallation = installation;
  if (installation && installation.postcode) {
    log.info("Enriching installation details with postcode lookup");
    enrichedInstallation = await enrichInstallationDetails(installation);
    if (enrichedInstallation.town || enrichedInstallation.county) {
      log.info("Postcode lookup successful", {
        town: enrichedInstallation.town,
        county: enrichedInstallation.county,
      });
    }
  }

  // Save installation details
  if (enrichedInstallation && Object.keys(enrichedInstallation).length > 0) {
    await fs.writeFile(
      path.join(outDir, "installation_details.json"),
      JSON.stringify(enrichedInstallation, null, 2),
      "utf8"
    );
  }

  // Save board/consumer unit data
  if (board && Object.keys(board).length > 0) {
    await fs.writeFile(
      path.join(outDir, "board_details.json"),
      JSON.stringify(board, null, 2),
      "utf8"
    );
  }

  // Save supply characteristics
  if (supply_characteristics && Object.keys(supply_characteristics).length > 0) {
    await fs.writeFile(
      path.join(outDir, "supply_characteristics.json"),
      JSON.stringify(supply_characteristics, null, 2),
      "utf8"
    );
  }

  /* 4b️⃣ Numeric salvage pass (use combinedContent to include photo data) */
  const salvage = await salvageNumbers(combinedContent);

  // Track token usage from salvage
  tokenAccumulator.add(salvage.usage, salvage.model);

  await fs.writeFile(
    path.join(outDir, "numeric_salvage.json"),
    JSON.stringify(salvage, null, 2),
    "utf8"
  );

  /* 5️⃣ Safe merge of salvage into rows */
  const { merged, unresolved } = mergeSalvageIntoRows(rows, salvage);

  // Get headers from schema
  const csvLines = csv.trim().split("\n");
  const csvHeaders = csvLines[0].split(",");

  const mergedCsv = [
    csvHeaders.join(","),
    ...merged.map(r => csvHeaders.map(h => r[h] || "").join(","))
  ].join("\n") + "\n";

  await fs.writeFile(
    path.join(outDir, "test_results.csv"),
    mergedCsv,
    "utf8"
  );

  /* 5a️⃣ Circuit mention detection */
  // Detect circuits mentioned in transcript but not extracted
  const mentionedCircuits = new Set(
    (transcript.match(/circuit\s*(\d+)/gi) || [])
      .map(m => m.match(/\d+/)?.[0])
      .filter(Boolean)
  );
  const extractedCircuits = new Set(merged.map(r => String(r.circuit_ref)));
  const missingCircuits = [...mentionedCircuits].filter(c => !extractedCircuits.has(c));

  if (missingCircuits.length > 0) {
    log.warn(`[CIRCUIT] Missing circuits detected`, {
      missing: missingCircuits.join(', '),
      mentioned: [...mentionedCircuits].join(', '),
      extracted: [...extractedCircuits].join(', '),
    });
  } else {
    log.info(`[CIRCUIT] All mentioned circuits extracted`, {
      count: extractedCircuits.size,
      circuits: [...extractedCircuits].join(', '),
    });
  }

  /* 5b️⃣ Generate PDF test results */
  log.info("Generating PDF test results");

  // Load inspector profile from project root (projectRoot already declared at line 198)
  const inspector = await loadInspectorProfile(projectRoot);

  if (inspector.name) {
    log.debug(`Using inspector profile`, { inspector: inspector.name });
  }

  await generateTestResultsPDF({
    outDir,
    circuits: merged,
    board,
    testedBy: inspector.name || "Not specified",
    testDate: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
    inspector
  });

  /* 6️⃣ Observations + missing values */
  // Get observation settings from config
  const obsSettings = baselineConfig.observation_settings || {};
  const MIN_CONFIDENCE = obsSettings.min_confidence_threshold ?? 0.6;

  // Filter out low-confidence observations
  let filteredObservations = (observations || []).filter(obs => {
    const confidence = obs.confidence ?? 1.0; // Default to 1.0 if not specified
    if (obsSettings.suppress_low_confidence !== false && confidence < MIN_CONFIDENCE) {
      log.debug(`[OBSERVATION] Suppressed low-confidence`, { title: obs.title, confidence });
      return false;
    }
    return true;
  });

  // Filter out audio quality FI observations if configured
  if (obsSettings.suppress_audio_quality_fi) {
    filteredObservations = filteredObservations.filter(obs => {
      const isAudioQualityFI = obs.code === 'FI' &&
        ((obs.text || obs.observation_text || '').toLowerCase().includes('unintelligible') ||
         (obs.text || obs.observation_text || '').toLowerCase().includes('audio') ||
         (obs.text || obs.observation_text || '').toLowerCase().includes('background noise') ||
         (obs.text || obs.observation_text || '').toLowerCase().includes('not stated'));
      if (isAudioQualityFI) {
        log.debug('[OBSERVATION] Suppressed audio quality FI', { title: obs.title || obs.item_location });
        return false;
      }
      return true;
    });
  }

  // Photo-to-observation matching
  // ONLY use AI-provided source_photo - no keyword fallback (causes too many wrong matches)
  let observationsWithPhotos = filteredObservations;
  if (fssync.existsSync(scaledPhotosDir)) {
    const photoFiles = (await fs.readdir(scaledPhotosDir))
      .filter(f => /\.(jpg|jpeg|png)$/i.test(f));

    if (photoFiles.length > 0 && observationsWithPhotos.length > 0) {
      observationsWithPhotos = observationsWithPhotos.map(obs => {
        // ONLY use AI-provided source_photo - no fallback matching
        if (obs.source_photo && typeof obs.source_photo === 'string') {
          // Check if the photo actually exists in the job
          const matchedPhoto = photoFiles.find(f =>
            f.toLowerCase() === obs.source_photo.toLowerCase() ||
            obs.source_photo.toLowerCase().includes(f.toLowerCase())
          );
          if (matchedPhoto) {
            log.debug(`Using AI-provided source_photo`, { observation: obs.title, photo: matchedPhoto });
            return { ...obs, photo: `photos_scaled/${matchedPhoto}` };
          }
          // AI specified a photo but it doesn't exist - log warning
          log.warn(`AI specified source_photo not found`, { observation: obs.title, source_photo: obs.source_photo });
        }

        // No source_photo provided by AI - leave observation without photo
        // This is better than guessing wrong with keyword matching
        log.debug(`No source_photo from AI, leaving observation without photo`, { observation: obs.title });
        return obs;
      });
    }
  }

  // === OBSERVATION SOURCE LOGGING ===
  for (const obs of observationsWithPhotos) {
    const source = obs.source_photo ? 'photo' : 'audio';
    log.info(`[OBSERVATION] ${obs.code}: ${obs.title || obs.item_location}`, {
      source,
      confidence: obs.confidence?.toFixed(2) || 'N/A',
      text: (obs.text || obs.observation_text)?.substring(0, 80),
    });
  }

  await fs.writeFile(
    path.join(outDir, "observations.json"),
    JSON.stringify(observationsWithPhotos, null, 2),
    "utf8"
  );

  await fs.writeFile(
    path.join(outDir, "missing_values.md"),
    missingToMd(missing),
    "utf8"
  );

  if (unresolved.length) {
    const extra = unresolved.map(u =>
      `- Salvage candidate: circuit ${u.circuit_ref ?? "?"}, ${u.test} = ${u.value} ${u.unit || ""} (${u.reason})`
    ).join("\n");

    await fs.appendFile(
      path.join(outDir, "missing_values.md"),
      `\n## Salvage candidates (not auto-merged)\n${extra}\n`,
      "utf8"
    );
  }

  /* 6b️⃣ Generate full EICR certificate PDF */
  log.info("Generating full EICR certificate");
  try {
    // projectRoot already declared at line 198
    const pythonScript = path.join(projectRoot, "python", "generate_full_pdf.py");
    execSync(`python3 "${pythonScript}" "${outDir}"`, {
      cwd: projectRoot,
      stdio: "inherit"
    });
  } catch (e) {
    log.warn(`Could not generate full certificate`, { error: e.message });
  }

  /* 7️⃣ Rename folder and copy PDF to Completed Certificates */
  let finalOutDir = outDir;
  let finalPdfName = "test_results.pdf";

  // Get address for folder/file naming
  const address = installation?.address || "";
  if (address) {
    // Clean address for use as folder/file name
    const cleanAddress = address
      .replace(/[<>:"/\\|?*]/g, "")  // Remove invalid filename chars
      .replace(/\s+/g, " ")          // Normalize whitespace
      .trim()
      .substring(0, 100);            // Limit length

    if (cleanAddress) {
      // Rename output folder to address
      const newOutDir = path.join(path.dirname(outDir), cleanAddress);

      // Only rename if different and doesn't exist
      if (newOutDir !== outDir && !fssync.existsSync(newOutDir)) {
        try {
          await fs.rename(outDir, newOutDir);
          finalOutDir = newOutDir;
          log.info(`Renamed output folder`, { newName: cleanAddress });
        } catch (e) {
          log.warn(`Could not rename folder`, { error: e.message });
        }
      }

      // Copy full EICR certificate to Completed Certificates folder
      const completedDir = path.join(path.dirname(outDir), "Completed Certificates");
      await fs.mkdir(completedDir, { recursive: true });

      // Prefer full certificate, fall back to test_results.pdf
      let pdfSource = path.join(finalOutDir, "eicr_certificate.pdf");
      if (!fssync.existsSync(pdfSource)) {
        pdfSource = path.join(finalOutDir, "test_results.pdf");
      }
      finalPdfName = `${cleanAddress}.pdf`;
      const pdfDest = path.join(completedDir, finalPdfName);

      if (fssync.existsSync(pdfSource)) {
        try {
          await fs.copyFile(pdfSource, pdfDest);
          log.info(`Certificate copied to Completed Certificates`, { fileName: finalPdfName });
        } catch (e) {
          log.warn(`Could not copy PDF`, { error: e.message });
        }
      }
    }
  }

  /* 8️⃣ Log token usage to CSV */
  const tokenTotals = tokenAccumulator.getTotals();
  if (tokenTotals.totalTokens > 0) {
    const dataDir = path.resolve(import.meta.dirname, "..");
    await logTokenUsage({
      dataDir,
      jobId,
      address: address || jobId,
      geminiTokens: tokenTotals.geminiTokens,
      geminiCost: tokenTotals.geminiCost,
      gptTokens: tokenTotals.gptTokens,
      gptCost: tokenTotals.gptCost,
      totalTokens: tokenTotals.totalTokens,
      totalCost: tokenTotals.totalCost
    });
    log.info(`Token usage logged`, {
      geminiTokens: tokenTotals.geminiTokens,
      geminiCost: `$${tokenTotals.geminiCost.toFixed(4)}`,
      gptTokens: tokenTotals.gptTokens,
      gptCost: `$${tokenTotals.gptCost.toFixed(4)}`,
      totalCost: `$${tokenTotals.totalCost.toFixed(4)}`
    });
  }

  return {
    ok: true,
    dryRun,
    finalOutDir,
    address,
    outputs: {
      transcript: "transcript.txt",
      transcriptionMeta: "transcription_meta.json",
      csv: "test_results.csv",
      pdf: "test_results.pdf",
      completedPdf: finalPdfName,
      installation: "installation_details.json",
      board: "board_details.json",
      observations: "observations.json",
      missing: "missing_values.md",
      salvage: "numeric_salvage.json",
      questionsForInspector: questionsForInspector.length > 0 ? "questions_for_inspector.json" : null
    }
  };
}

