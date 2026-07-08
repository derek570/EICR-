#!/usr/bin/env node
/**
 * D2 — generated field-sweep corpus (pwa-replay-harness Wave 5).
 *
 *   node scripts/pwa-replay/generate-field-sweep.mjs [--check]
 *
 * Reads config/field_schema.json (the single source of truth for UI + AI
 * fields) and emits one scenario YAML per dictatable field into
 * tests/fixtures/pwa-replay/generated-sweep/: a clean dictation, a
 * garbled variant (sweep-safe garble classes from garbles.json — number
 * words + stutter/filler; trigger-killing garbles live in dedicated
 * session fixtures), and a chitchat-interleaved variant (corpus rotates
 * through chitchat.json). Mock extraction frames are scripted per
 * dictation (this is the deterministic client-composition lane — the
 * backend's own extraction quality is the voice-latency bench's job).
 *
 * Generated files are COMMITTED (reviewable, stable); `--check`
 * regenerates in-memory and exits 1 on drift vs the committed set — the
 * CI sync check against field_schema.json changes.
 *
 * Expectations are intentionally thin in the YAML: the sweep test
 * (field-sweep.test.ts) derives gate expectations from the REAL gate and
 * asserts the D1 invariants + "field lands with the spoken value" for
 * gate-passing dictations, and surfaces (without failing) fields whose
 * canonical spoken form cannot pass the gate — a coverage gap report.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const CHECK = process.argv.includes('--check');
const repoRoot = process.cwd();
const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/field_schema.json'), 'utf8'));
const chitchat = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'tests/fixtures/pwa-replay/chitchat.json'), 'utf8')
).utterances;
const outDir = path.join(repoRoot, 'tests/fixtures/pwa-replay/generated-sweep');

/** Spoken-name overrides for the classic electrician forms (everything
 *  else uses the schema label lower-cased). */
const SPOKEN_NAME = {
  measured_zs_ohm: 'Zs',
  r1_r2_ohm: 'R1 plus R2',
  r2_ohm: 'R2',
  ring_r1_ohm: 'ring R1',
  ring_rn_ohm: 'ring RN',
  ring_r2_ohm: 'ring R2',
  ir_live_earth_mohm: 'insulation resistance live to earth',
  ir_live_live_mohm: 'insulation resistance live to live',
  ir_test_voltage_v: 'IR test voltage',
  rcd_time_ms: 'RCD trip time',
  rcd_operating_current_ma: 'RCD rating',
  ocpd_rating_a: 'OCPD rating',
  ocpd_bs_en: 'OCPD BS number',
  ocpd_type: 'OCPD type',
  ocpd_breaking_capacity_ka: 'breaking capacity',
  ocpd_max_zs_ohm: 'max Zs',
  max_disconnect_time_s: 'max disconnection time',
  live_csa_mm2: 'live cable size',
  cpc_csa_mm2: 'CPC size',
  ze: 'Ze',
  pfc: 'PFC',
  zs_at_db: 'Zs at the board',
  ze_at_db: 'Ze at the board',
};

/** Representative dictation values per field (falls back by type). */
const VALUE_OVERRIDES = {
  measured_zs_ohm: '0.35',
  r1_r2_ohm: '0.42',
  r2_ohm: '0.31',
  ring_r1_ohm: '0.22',
  ring_rn_ohm: '0.23',
  ring_r2_ohm: '0.36',
  ir_live_earth_mohm: '999',
  ir_live_live_mohm: '999',
  ir_test_voltage_v: '500',
  rcd_time_ms: '28',
  rcd_operating_current_ma: '30',
  ocpd_rating_a: '32',
  number_of_points: '8',
  live_csa_mm2: '2.5',
  cpc_csa_mm2: '1.5',
  ocpd_breaking_capacity_ka: '6',
  max_disconnect_time_s: '0.4',
  ocpd_max_zs_ohm: '1.37',
  ze: '0.35',
  pfc: '1.2',
  supply_voltage: '230',
  nominal_voltage: '230',
  supply_frequency: '50',
  nominal_frequency: '50',
  main_earth_conductor_csa: '16',
  main_bonding_conductor_csa: '10',
  earth_electrode_resistance: '21',
  next_inspection_years: '5',
  estimated_age_of_installation: '25',
  client_name: 'Michael Hayden',
  address: '19 Ivy Dean Road',
  postcode: 'RG30 4TN',
  occupier_name: 'Sarah Hayden',
  premises_description: 'Two bed semi detached house',
};

/** Fields that are not voice-dictated readings (identity, signatures,
 *  file uploads, computed) — excluded from the sweep. */
const EXCLUDED = new Set([
  'circuit_ref',
  'local_id',
  'board_id',
  'feeds_board_id',
  'is_distribution_circuit',
  // EIC-only divert-to-comments voice path (applyCircuit0Readings has an
  // EIC-guarded newline-append branch; on the sweep's EICR job the reading
  // is dropped by design). Covered by the WS3 EIC divert tests.
  'comments',
]);

function valueFor(field, def) {
  if (VALUE_OVERRIDES[field]) return VALUE_OVERRIDES[field];
  if (def.type === 'select' && Array.isArray(def.options) && def.options.length > 0) {
    // Prefer a digit-bearing option (keeps the utterance reading-shaped).
    const opt = def.options.find((o) => /\d/.test(String(o))) ?? def.options[0];
    if (opt !== undefined && String(opt).trim() !== '') return String(opt);
  }
  if (def.type === 'checkbox' || def.type === 'boolean') return 'Yes';
  return '42';
}

function spokenName(field, def) {
  return SPOKEN_NAME[field] ?? String(def.label ?? field).toLowerCase();
}

/** Number-word garble (the naught-point class) + stutter/filler — the
 *  sweep-safe garble transforms recorded in garbles.json. */
function garble(text) {
  const words = {
    0: 'naught',
    1: 'one',
    2: 'two',
    3: 'three',
    4: 'four',
    5: 'five',
    6: 'six',
    7: 'seven',
    8: 'eight',
    9: 'nine',
  };
  let g = text.replace(/(\d+)\.(\d+)/g, (_m, a, b) => {
    const spell = (s) => s.split('').map((d) => words[d]).join(' ');
    return `${spell(a)} point ${spell(b)}`;
  });
  const firstWord = g.split(' ')[0];
  g = `Um, ${firstWord.toLowerCase()} ${g.charAt(0).toLowerCase()}${g.slice(1)}`; // stutter + filler
  return g;
}

function scenarioFor(sectionKind, field, def, index) {
  const isCircuit = sectionKind === 'circuit';
  const value = String(valueFor(field, def));
  const name = spokenName(field, def);
  const dictation = isCircuit ? `Circuit 1 ${name} is ${value}.` : `${capitalise(name)} is ${value}.`;
  const chitchatLine = chitchat[index % chitchat.length];
  const frame = {
    type: 'extraction',
    // Section readings ride circuit 0 on the wire — applyCircuit0Readings
    // requires reading.circuit === 0 (null never routes to a section).
    readings: [{ circuit: isCircuit ? 1 : 0, field, value }],
    confirmations: [
      {
        field,
        circuit: isCircuit ? 1 : null,
        text: isCircuit ? `Circuit 1, ${name} ${value}` : `${name} ${value}`,
      },
    ],
  };
  const garbled = garble(dictation);
  return {
    name: `sweep-${sectionKind}-${field}`,
    description: `Generated field-sweep scenario for ${sectionKind} field '${field}' (clean + garbled + chitchat-interleaved). Regenerate via scripts/pwa-replay/generate-field-sweep.mjs.`,
    suite: 'pwa-replay-generated-sweep',
    metadata: {
      generated: true,
      section: sectionKind,
      field,
      expect_value: value,
      synthetic_interims: true,
    },
    job_state: {
      boards: [
        {
          id: 'main',
          designation: 'Main DB',
          circuits: [{ number: 1, designation: 'Lighting' }],
        },
      ],
    },
    transcript: [
      { at_ms: 1000, text: dictation, isFinal: true },
      { at_ms: 9000, text: chitchatLine, isFinal: true },
      { at_ms: 17000, text: garbled, isFinal: true },
    ],
    sweep: {
      dictation,
      garbled,
      chitchat: chitchatLine,
      field,
      section: sectionKind,
      value,
    },
    mock_frames: [
      { on_transcript: dictation, frames: [frame] },
      { on_transcript: garbled, frames: [frame] },
    ],
  };
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const sections = [
  ['circuit', schema.circuit_fields ?? {}],
  ['board', schema.board_fields ?? {}],
  ['installation', schema.installation_details_fields ?? {}],
  ['supply', schema.supply_characteristics_fields ?? {}],
];

const generated = new Map();
let index = 0;
for (const [kind, fields] of sections) {
  for (const [field, def] of Object.entries(fields)) {
    if (EXCLUDED.has(field)) continue;
    const scenario = scenarioFor(kind, field, def, index++);
    generated.set(
      `${scenario.name}.yaml`,
      `# GENERATED by scripts/pwa-replay/generate-field-sweep.mjs — do not hand-edit.\n` +
        yaml.dump(scenario, { lineWidth: 100 })
    );
  }
}

if (CHECK) {
  let drift = 0;
  const existing = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.yaml')) : [];
  for (const [file, content] of generated) {
    const p = path.join(outDir, file);
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== content) {
      console.error(`sweep-check: ${file} is stale or missing`);
      drift++;
    }
  }
  for (const f of existing) {
    if (!generated.has(f)) {
      console.error(`sweep-check: ${f} is orphaned (field removed from schema?)`);
      drift++;
    }
  }
  if (drift > 0) {
    console.error(
      `sweep-check: ${drift} drift(s) — run 'node scripts/pwa-replay/generate-field-sweep.mjs' and commit.`
    );
    process.exit(1);
  }
  console.log(`sweep-check: ${generated.size} scenarios in sync with field_schema.json`);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
for (const [file, content] of generated) fs.writeFileSync(path.join(outDir, file), content);
// Remove orphans so schema deletions clean up.
for (const f of fs.readdirSync(outDir).filter((f) => f.endsWith('.yaml'))) {
  if (!generated.has(f)) fs.unlinkSync(path.join(outDir, f));
}
console.log(`generate-field-sweep: wrote ${generated.size} scenarios to ${outDir}`);
