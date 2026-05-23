#!/usr/bin/env node
/**
 * Stage 0.D — Voice fidelity A/B sample generator.
 *
 * Per PLAN_v3 §3.D: 10 representative confirmation strings × 2 models ×
 * 2 output formats = 40 samples. Saved as audio files Derek listens to
 * back-to-back and picks the model+format combo.
 *
 * Pass criterion: Derek confirms PCM is acceptably close to MP3 (so we
 * keep locked decision 1.14) OR explicitly chooses MP3 and accepts the
 * 2-3 day MP3-parser implementation cost.
 *
 * Output:
 *   stage0-results/voice-ab-samples/
 *     flash_pcm_01.wav
 *     flash_mp3_01.mp3
 *     turbo_pcm_01.wav
 *     turbo_mp3_01.mp3
 *     ...
 *
 * PCM is wrapped in a WAV header (Apple QuickTime / Safari plays it).
 * MP3 is raw bytes (any player handles it).
 *
 * Usage:
 *   ELEVENLABS_API_KEY=... node scripts/voice-latency-bench/voice-ab-samples.mjs
 *
 * Cost: ~$0.60 for the full 40-sample suite (Flash $0.00018 per char).
 */

import fs from 'node:fs';
import path from 'node:path';

const VOICE_ID = 'Fahco4VZzobUeiPqni1S';
const MODELS = ['eleven_flash_v2_5', 'eleven_turbo_v2_5'];
const FORMATS = ['pcm_22050', 'mp3_22050_32'];

const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.3,
  use_speaker_boost: true,
  speed: 1.0,
};

const SAMPLES = [
  'Circuit one. Number of points five.',
  'Circuit two. Zs nought point thirty eight ohms.',
  'Circuit three. R1 plus R2 nought point five two ohms.',
  'Circuit four. Polarity confirmed.',
  'Circuit five. Insulation resistance two hundred megohms each.',
  'Earth loop impedance at the DB nought point one nine ohms.',
  'Prospective fault current one point six kilo amps.',
  'Should I log that as an observation on the certificate?',
  'What is the BS number for the OCPD?',
  'Recorded. Polarity confirmed on circuit twelve.',
];

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error('Set ELEVENLABS_API_KEY in the environment.');
  process.exit(2);
}

// Output dir lives in the planning handoff so it's grouped with the
// other Stage 0 artefacts. NOT committed (binary audio) — see
// .gitignore append at the end of the script.
const OUT_DIR = path.resolve(
  '.planning-stage6-agentic/handoffs/voice-latency-2026-05-23/stage0-results/voice-ab-samples',
);
fs.mkdirSync(OUT_DIR, { recursive: true });

function wavHeader(dataLen, sampleRate = 22050) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit mono)
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

async function synth(text, modelId, format) {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}` +
    `?output_format=${format}` +
    `&apply_text_normalization=on`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: format.startsWith('pcm') ? 'audio/L16' : 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: VOICE_SETTINGS,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (format.startsWith('pcm')) {
    return Buffer.concat([wavHeader(buf.length), buf]);
  }
  return buf;
}

async function main() {
  const indexLines = [];
  let total = 0;
  for (let i = 0; i < SAMPLES.length; i++) {
    const text = SAMPLES[i];
    for (const model of MODELS) {
      for (const format of FORMATS) {
        const ext = format.startsWith('pcm') ? 'wav' : 'mp3';
        const modelShort = model.includes('flash') ? 'flash' : 'turbo';
        const idx = String(i + 1).padStart(2, '0');
        const name = `${modelShort}_${ext}_${idx}.${ext}`;
        process.stdout.write(`  ${name} ... `);
        try {
          const data = await synth(text, model, format);
          fs.writeFileSync(path.join(OUT_DIR, name), data);
          process.stdout.write(`${data.length} bytes\n`);
          indexLines.push(`${name}\t${model}\t${format}\t"${text}"`);
          total += text.length;
        } catch (err) {
          process.stdout.write(`FAILED — ${err.message}\n`);
        }
        // Tiny gap; ElevenLabs rate-limits at the burst level but
        // batch calls are fine.
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }
  fs.writeFileSync(
    path.join(OUT_DIR, 'index.tsv'),
    'file\tmodel\tformat\ttext\n' + indexLines.join('\n') + '\n',
  );
  console.log(`\nWrote ${SAMPLES.length * MODELS.length * FORMATS.length} files to ${OUT_DIR}`);
  console.log(`Approx ElevenLabs cost: $${((total * MODELS.length * FORMATS.length) * 0.00018).toFixed(2)}`);
}

main().catch((err) => {
  console.error('Generator failed:', err);
  process.exit(1);
});
