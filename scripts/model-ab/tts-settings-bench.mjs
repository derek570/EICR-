#!/usr/bin/env node
/**
 * tts-settings-bench.mjs — one-variable-at-a-time ElevenLabs synthesis bench.
 *
 * WHY THIS EXISTS (Plan 03 §3, voice-latency wave 2026-07-31)
 * ----------------------------------------------------------
 * Plan 03 §3 is the config-only half of the ElevenLabs work (Tier A in the
 * 2026-08-10 re-scope; the §1–2 connection pooling is held). It asks whether any
 * of ElevenLabs' latency levers — `auto_mode`, text normalization, `style`,
 * speaker boost, output format — buys us vendor-side time on the read-back path
 * WITHOUT degrading how electrical values are pronounced.
 *
 * The plan's constraint is the important part and this script enforces it
 * structurally: **do not flip multiple settings in one cohort.** Every variant
 * here differs from BASELINE in exactly one field, so any latency delta and any
 * pronunciation regression is attributable to that field alone. A combined
 * "fast preset" is not offered, deliberately.
 *
 * WHAT IT MEASURES, AND WHAT IT CANNOT
 * ------------------------------------
 * Measures, per (corpus line x variant): vendor time-to-first-audio-byte, total
 * synth wall clock, byte count, and audio duration. Time-to-first-byte is the
 * number that matters for perceived latency — the inspector hears audio when the
 * first chunk plays, not when the last one lands.
 *
 * It CANNOT judge naturalness or pronunciation. That is Derek's ear, and the
 * plan says so: "a faster setting that misreads electrical values fails". So the
 * script writes every clip to disk as a WAV, grouped so the same corpus line can
 * be played back-to-back across variants, and emits a blind listening sheet with
 * the variant labels withheld until the answer key is opened. Latency alone must
 * never select a setting here.
 *
 * WHY THE CORPUS IS WHAT IT IS
 * ----------------------------
 * These are read-back shapes the field actually produces: bare decimals, ohms
 * and milliamps, `R1 plus R2`, `live-to-live`, circuit designations that are
 * words rather than numbers, and one long clarification question (the worst case
 * for synthesis latency, since it is the longest text). Text is passed through
 * the production `expandForTTS()` first, because that is what the live path
 * sends — benchmarking raw text would measure a string we never synthesise, and
 * would make the normalization-off arm meaningless.
 *
 * SAFETY
 * ------
 * Non-production. Fixed synthetic corpus — no real inspection data, addresses or
 * customer names. Talks only to ElevenLabs; touches no RDS, S3, ECS or session
 * state. Costs roughly (corpus lines x variants) short syntheses.
 *
 * USAGE
 *   ELEVENLABS_API_KEY=… node scripts/model-ab/tts-settings-bench.mjs --out-dir ./tts-bench
 *   … --variants baseline,auto_mode,style_0     # subset
 *   … --repeats 3                               # median over N runs per cell
 *   … --dry-run                                 # print the matrix and exit
 *
 * Reads are serialised on purpose: concurrent syntheses contend for the same
 * vendor connection budget and would corrupt the latency numbers this exists to
 * produce.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { expandForTTS } from '../../src/extraction/tts-text-expander.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const OUT_DIR = flag('out-dir', './tts-bench');
const REPEATS = Math.max(1, Number(flag('repeats', '3')));
const DRY = has('dry-run');

const VOICE_ID = flag('voice', 'Fahco4VZzobUeiPqni1S'); // Archer Conversational — production default
const MODEL_ID = flag('model', 'eleven_flash_v2_5');

/**
 * Production defaults, mirrored from src/extraction/elevenlabs-stream-client.js
 * (DEFAULT_VOICE_SETTINGS + _buildUrl). BASELINE must stay byte-identical to
 * what production sends, or every delta is measured against a fiction.
 */
const BASELINE = {
  outputFormat: 'pcm_22050',
  applyTextNormalization: 'on',
  autoMode: false,
  voiceSettings: {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.3,
    use_speaker_boost: true,
    speed: 1.0,
  },
};

/**
 * Each variant overrides EXACTLY ONE thing. The `changed` field is asserted at
 * startup so a future edit cannot quietly introduce a two-variable arm.
 */
const VARIANTS = [
  { name: 'baseline', changed: null, patch: {} },
  {
    name: 'auto_mode',
    changed: 'autoMode',
    patch: { autoMode: true },
    why: 'Vendor-documented latency lever; lets ElevenLabs choose chunk scheduling.',
  },
  {
    name: 'normalization_off',
    changed: 'applyTextNormalization',
    patch: { applyTextNormalization: 'off' },
    why: 'expandForTTS already expands units/decimals server-side, so vendor normalization may be redundant work. HIGH pronunciation risk — listen hardest here.',
  },
  {
    name: 'style_0',
    changed: 'voiceSettings.style',
    patch: { voiceSettings: { style: 0 } },
    why: 'Style > 0 costs inference time; 0 is the documented fastest setting.',
  },
  {
    name: 'speaker_boost_off',
    changed: 'voiceSettings.use_speaker_boost',
    patch: { voiceSettings: { use_speaker_boost: false } },
    why: 'Speaker boost is post-processing; disabling may shave time at some clarity cost.',
  },
  {
    name: 'pcm_16000',
    changed: 'outputFormat',
    patch: { outputFormat: 'pcm_16000' },
    why: 'Fewer bytes to transfer. Note iOS/web expect the negotiated rate — this is a MEASUREMENT arm only, not a shippable change on its own.',
  },
];

/**
 * Read-back shapes the field actually produces. Deliberately includes the
 * pronunciation traps: bare decimals, ohms/milliamps, R1+R2, live-to-live, a
 * word-designation circuit, and one long question.
 */
const CORPUS = [
  { id: 'decimal_ohms', text: 'Circuit 4 Zs 0.42 ohms.' },
  { id: 'r1r2', text: 'Circuit 12 R1 plus R2 0.85 ohms.' },
  {
    id: 'insulation',
    text: 'Circuit 7 insulation resistance live to live greater than 299 megohms.',
  },
  { id: 'rcd_ma', text: 'Circuit 3 RCD 30 milliamps, tripped in 24.6 milliseconds.' },
  { id: 'word_designation', text: 'Kitchen Ring Final Zs 0.31 ohms.' },
  { id: 'supply_ze', text: 'Ze 0.19 ohms, prospective fault current 1.6 kiloamps.' },
  {
    id: 'long_question',
    text: 'I have two circuits described as lighting on this board. Which one did you mean, circuit 5 or circuit 9?',
  },
];

function mergeConfig(patch) {
  return {
    ...BASELINE,
    ...patch,
    voiceSettings: { ...BASELINE.voiceSettings, ...(patch.voiceSettings || {}) },
  };
}

function buildUrl(cfg) {
  const params = new URLSearchParams({
    model_id: MODEL_ID,
    output_format: cfg.outputFormat,
    inactivity_timeout: '20',
    apply_text_normalization: cfg.applyTextNormalization,
  });
  if (cfg.autoMode) params.set('auto_mode', 'true');
  return `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?${params}`;
}

/** Minimal 16-bit mono WAV header so the clips open in any player. */
function wavHeader(dataLength, sampleRate) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLength, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataLength, 40);
  return b;
}

function synth({ apiKey, cfg, text }) {
  return new Promise((resolve, reject) => {
    // Stamped BEFORE construction: `connect_ms` must cover DNS + TCP + TLS +
    // the WS upgrade, i.e. everything a pooled connection would let us skip.
    // Measuring from the `open` event instead would report ~0 and make Plan 03
    // §1-2 connection pooling look pointless for the wrong reason.
    const startedAt = Date.now();
    const ws = new WebSocket(buildUrl(cfg), { headers: { 'xi-api-key': apiKey } });
    const chunks = [];
    let openedAt = 0;
    let bosAt = 0;
    let firstAudioAt = 0;
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      reject(new Error('synth timeout (25s)'));
    }, 25_000);

    ws.on('open', () => {
      openedAt = Date.now();
      // Frame sequence copied verbatim from the production single-context path
      // (elevenlabs-stream-client.js synth()): BOS with voice settings, text
      // with `try_trigger_generation`, then empty-text EOS. Using `flush: true`
      // here instead — the multi-context idiom — would change generation
      // scheduling and make BASELINE something production never sends.
      ws.send(JSON.stringify({ text: ' ', voice_settings: cfg.voiceSettings }));
      bosAt = Date.now();
      ws.send(JSON.stringify({ text, try_trigger_generation: true }));
      ws.send(JSON.stringify({ text: '' })); // EOS
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.audio) {
        if (!firstAudioAt) firstAudioAt = Date.now();
        chunks.push(Buffer.from(msg.audio, 'base64'));
      }
      if (msg.error) {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        reject(new Error(String(msg.error)));
      }
      if (msg.isFinal) {
        clearTimeout(timer);
        const finishedAt = Date.now();
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        const pcm = Buffer.concat(chunks);
        const sampleRate = Number(cfg.outputFormat.replace('pcm_', '')) || 22050;
        resolve({
          // Measured from BOS, not from socket open: connection setup is
          // Plan 03 §1-2's problem (pooling), not a synthesis-setting effect.
          // Mixing them in would let a slow TCP handshake masquerade as a
          // setting regression.
          first_audio_ms: firstAudioAt ? firstAudioAt - bosAt : null,
          total_ms: finishedAt - bosAt,
          connect_ms: openedAt - startedAt,
          // What the inspector's ear actually waits for on a cold socket:
          // handshake + synthesis. This is the number Plan 03 §1-2 would
          // attack, and it is reported separately so a setting win cannot be
          // confused with a connection win.
          cold_first_audio_ms: firstAudioAt ? firstAudioAt - startedAt : null,
          bytes: pcm.length,
          audio_ms: Math.round((pcm.length / 2 / sampleRate) * 1000),
          sample_rate: sampleRate,
          pcm,
        });
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

async function main() {
  const selected = flag('variants', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const variants = selected.length ? VARIANTS.filter((v) => selected.includes(v.name)) : VARIANTS;

  if (!variants.some((v) => v.name === 'baseline')) {
    console.error(
      'tts-settings-bench: baseline must be included — every delta is measured against it'
    );
    process.exit(2);
  }
  // Structural guard against a future two-variable arm sneaking in.
  for (const v of variants) {
    if (v.name === 'baseline') continue;
    const leaves = Object.entries(v.patch).flatMap(([k, val]) =>
      k === 'voiceSettings' ? Object.keys(val).map((s) => `voiceSettings.${s}`) : [k]
    );
    if (leaves.length !== 1 || leaves[0] !== v.changed) {
      console.error(
        `tts-settings-bench: variant "${v.name}" changes ${leaves.join('+')} but declares "${v.changed}". ` +
          'One variable per arm — see Plan 03 §3.'
      );
      process.exit(2);
    }
  }

  const cells = variants.length * CORPUS.length * REPEATS;
  if (DRY) {
    console.log(
      JSON.stringify(
        {
          variants: variants.map((v) => ({ name: v.name, changes: v.changed, why: v.why ?? null })),
          corpus: CORPUS.map((c) => ({ id: c.id, expanded: expandForTTS(c.text) })),
          repeats: REPEATS,
          total_syntheses: cells,
        },
        null,
        2
      )
    );
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('tts-settings-bench: ELEVENLABS_API_KEY required');
    process.exit(2);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const results = [];

  for (const line of CORPUS) {
    // expandForTTS is what production actually sends. Benchmarking raw text
    // would measure a string we never synthesise, and would make the
    // normalization-off arm meaningless.
    const expanded = expandForTTS(line.text);
    for (const v of variants) {
      const cfg = mergeConfig(v.patch);
      const runs = [];
      for (let i = 0; i < REPEATS; i++) {
        try {
          const r = await synth({ apiKey, cfg, text: expanded });
          runs.push(r);
          // Keep the first repeat's audio only — later repeats are for timing
          // stability, and identical clips would just bloat the listening set.
          if (i === 0) {
            const wav = Buffer.concat([wavHeader(r.pcm.length, r.sample_rate), r.pcm]);
            writeFileSync(join(OUT_DIR, `${line.id}__${v.name}.wav`), wav);
          }
        } catch (err) {
          runs.push({ error: String(err?.message || err) });
        }
      }
      const ok = runs.filter((r) => !r.error);
      const row = {
        corpus_id: line.id,
        variant: v.name,
        changed: v.changed,
        repeats: REPEATS,
        errors: runs.length - ok.length,
        first_audio_ms_median: median(ok.map((r) => r.first_audio_ms)),
        total_ms_median: median(ok.map((r) => r.total_ms)),
        connect_ms_median: median(ok.map((r) => r.connect_ms)),
        cold_first_audio_ms_median: median(ok.map((r) => r.cold_first_audio_ms)),
        bytes: ok[0]?.bytes ?? null,
        audio_ms: ok[0]?.audio_ms ?? null,
      };
      results.push(row);
      console.error(
        `${line.id.padEnd(18)} ${v.name.padEnd(18)} first=${String(row.first_audio_ms_median).padStart(5)}ms total=${String(row.total_ms_median).padStart(5)}ms`
      );
    }
  }

  // Per-variant summary, as a delta against baseline on the SAME corpus lines.
  const summary = variants.map((v) => {
    const rows = results.filter((r) => r.variant === v.name);
    const baseRows = results.filter((r) => r.variant === 'baseline');
    const deltas = rows
      .map((r) => {
        const b = baseRows.find((x) => x.corpus_id === r.corpus_id);
        return b && r.first_audio_ms_median != null && b.first_audio_ms_median != null
          ? r.first_audio_ms_median - b.first_audio_ms_median
          : null;
      })
      .filter((x) => x != null);
    return {
      variant: v.name,
      changed: v.changed,
      why: v.why ?? null,
      first_audio_ms_median: median(rows.map((r) => r.first_audio_ms_median)),
      first_audio_delta_vs_baseline_median_ms: median(deltas),
      errors: rows.reduce((a, r) => a + r.errors, 0),
      // Filled in by ear. A negative latency delta is NOT sufficient to adopt.
      ear_verdict: 'PENDING — listen before adopting',
    };
  });

  const report = { voice_id: VOICE_ID, model_id: MODEL_ID, repeats: REPEATS, summary, results };
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  // Blind listening sheet: filenames are opaque so the label cannot bias the
  // ear. The answer key is a separate file, opened only after scoring.
  const key = [];
  const sheet = ['# Blind listening sheet — Plan 03 §3', ''];
  let n = 0;
  for (const line of CORPUS) {
    sheet.push(`## ${line.id} — "${line.text}"`, '');
    for (const v of variants) {
      n += 1;
      const tag = `clip-${String(n).padStart(3, '0')}`;
      key.push(`${tag} = ${line.id} / ${v.name}`);
      sheet.push(
        `- [ ] **${tag}** (\`${line.id}__${v.name}.wav\`) — numbers/units correct? natural? _____`
      );
    }
    sheet.push('');
  }
  sheet.push(
    '',
    'Score each clip for (a) every number and unit pronounced correctly and',
    '(b) naturalness. A clip that misreads a value FAILS regardless of latency.',
    'Open `answer-key.txt` only after scoring.'
  );
  writeFileSync(join(OUT_DIR, 'listening-sheet.md'), sheet.join('\n'));
  writeFileSync(join(OUT_DIR, 'answer-key.txt'), key.join('\n'));

  console.log(JSON.stringify(summary, null, 2));
  console.error(
    `\nWrote ${OUT_DIR}/report.json, listening-sheet.md, answer-key.txt and ${n} clips.`
  );
}

main().catch((err) => {
  console.error(`tts-settings-bench: ${err?.message || err}`);
  process.exit(1);
});
