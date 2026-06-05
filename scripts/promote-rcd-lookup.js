#!/usr/bin/env node
/**
 * promote-rcd-lookup
 *
 * Interactive CLI that:
 *   1. Lists every pending entry in S3 under `rcd-lookup-pending/`
 *   2. Shows its sighting count, vote tallies, and matched verifying signal
 *   3. Lets the operator promote each one into `config/rcd-type-lookup.json`
 *      as either a `manufacturer_default` or a `model` entry
 *   4. Optionally deletes the pending S3 entry after promotion
 *
 * Usage:
 *   AWS_PROFILE=...  S3_BUCKET=eicr-uploads  node scripts/promote-rcd-lookup.js
 *
 * Flags:
 *   --list        List pending entries without prompting (read-only)
 *   --min-count N Skip entries with fewer than N sightings (default 1)
 *   --dry-run     Show what would change but don't write
 *
 * Lifecycle:
 *   - Reads `rcd-lookup-pending/<mfg>/<model>.json` for every key under the
 *     prefix.
 *   - For each entry: prints summary, prompts (skip|model|manufacturer|edit),
 *     applies the chosen action.
 *   - On promotion: rewrites `config/rcd-type-lookup.json` (preserves
 *     `_doc`, `_changelog`, schema_version, all existing entries) and
 *     deletes the pending file unless --dry-run.
 *   - Appends a `_changelog` row summarising the promotion batch.
 *
 * Safety: ALWAYS reads the live config first, never overwrites unrelated
 * entries, and creates a `.bak` next to the config before writing.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'rcd-type-lookup.json');
const PENDING_PREFIX = 'rcd-lookup-pending/';

const args = new Set(process.argv.slice(2));
const FLAGS = {
  listOnly: args.has('--list'),
  dryRun: args.has('--dry-run'),
  minCount: 1,
};
{
  const i = process.argv.indexOf('--min-count');
  if (i !== -1 && process.argv[i + 1]) {
    const n = parseInt(process.argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) FLAGS.minCount = n;
  }
}

const VALID_TYPES = ['AC', 'A', 'B', 'F', 'S'];
const VALID_CONFIDENCES = ['high', 'medium', 'low'];

function fail(msg) {
  console.error(`promote-rcd-lookup: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// S3 helpers
// ---------------------------------------------------------------------------

async function getS3() {
  const { S3Client } = await import('@aws-sdk/client-s3');
  return new S3Client({ region: process.env.AWS_REGION || 'eu-west-2' });
}

async function listPendingKeys(s3, bucket) {
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const keys = [];
  let token;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: PENDING_PREFIX,
        ContinuationToken: token,
      })
    );
    for (const obj of resp.Contents ?? []) {
      if (obj.Key && obj.Key.endsWith('.json')) keys.push(obj.Key);
    }
    token = resp.IsTruncated ? resp.NextContinuationToken : null;
  } while (token);
  return keys;
}

async function fetchPending(s3, bucket, key) {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(body);
}

async function deletePending(s3, bucket, key) {
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// ---------------------------------------------------------------------------
// Vote tally → suggestions
// ---------------------------------------------------------------------------

function pickWinner(votes) {
  let best = null;
  let bestCount = 0;
  for (const [v, c] of Object.entries(votes ?? {})) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return { value: best, count: bestCount, total: Object.values(votes ?? {}).reduce((a, b) => a + b, 0) };
}

function suggestPromotion(pending) {
  const typeWinner = pickWinner(pending.aggregate?.type_votes);
  const waysWinner = pickWinner(pending.aggregate?.ways_votes);
  const typeAgreement =
    typeWinner.total > 0 ? typeWinner.count / typeWinner.total : 0;
  const waysAgreement =
    waysWinner.total > 0 ? waysWinner.count / waysWinner.total : 0;
  return {
    suggestedType: typeAgreement >= 0.6 ? typeWinner.value : null,
    typeAgreement,
    typeWinner,
    suggestedWays: waysAgreement >= 0.6 ? Number(waysWinner.value) : null,
    waysAgreement,
    waysWinner,
  };
}

// ---------------------------------------------------------------------------
// Config read / write
// ---------------------------------------------------------------------------

function readConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function writeConfig(config) {
  if (FLAGS.dryRun) {
    console.log('[dry-run] would write:', CONFIG_PATH);
    return;
  }
  // Backup before write.
  const backup = `${CONFIG_PATH}.bak`;
  fs.copyFileSync(CONFIG_PATH, backup);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function normaliseManufacturerKey(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normaliseModelKey(model) {
  return model.trim().toUpperCase().replace(/\s+/g, '');
}

function applyPromotion(config, decision) {
  const now = new Date().toISOString().slice(0, 10);
  if (decision.kind === 'model') {
    const key = `${normaliseManufacturerKey(decision.manufacturer)}/${normaliseModelKey(decision.model)}`;
    config.models[key] = {
      rcd_type: decision.rcd_type,
      ways: decision.ways ?? null,
      confidence: decision.confidence,
      verified_by: decision.verified_by,
      added: now,
      note: decision.note ?? null,
    };
  } else if (decision.kind === 'manufacturer_default') {
    const key = normaliseManufacturerKey(decision.manufacturer);
    config.manufacturer_defaults[key] = {
      rcd_type: decision.rcd_type,
      confidence: decision.confidence,
      verified_by: decision.verified_by,
      added: now,
      note: decision.note ?? null,
    };
  }
}

function appendChangelog(config, summary) {
  const date = new Date().toISOString().slice(0, 10);
  if (!Array.isArray(config._changelog)) config._changelog = [];
  config._changelog.push({ date, change: summary });
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------

async function promptOnce(rl, message, validator) {
  for (;;) {
    const ans = (await rl.question(message)).trim();
    const v = validator(ans);
    if (v.ok) return v.value;
    console.log(`  ✘ ${v.error}`);
  }
}

async function promptDecision(rl, pending, suggestion) {
  console.log('\n────────────────────────────────────────────────────────────────');
  console.log(`  ${pending.manufacturer ?? '(no manufacturer)'} / ${pending.model ?? '(no model)'}`);
  console.log(`  outcome:        ${pending.outcome}`);
  console.log(`  sighting_count: ${pending.sighting_count}`);
  console.log(
    `  type_votes:     ${JSON.stringify(pending.aggregate?.type_votes ?? {})}` +
      (suggestion.suggestedType
        ? `  → suggest ${suggestion.suggestedType} (${(suggestion.typeAgreement * 100).toFixed(0)}% agreement)`
        : '  → no clear majority')
  );
  console.log(
    `  ways_votes:     ${JSON.stringify(pending.aggregate?.ways_votes ?? {})}` +
      (suggestion.suggestedWays
        ? `  → suggest ${suggestion.suggestedWays} (${(suggestion.waysAgreement * 100).toFixed(0)}% agreement)`
        : '  → no clear majority')
  );
  console.log(`  first_seen:     ${pending.first_seen}`);
  console.log(`  last_seen:      ${pending.last_seen}`);

  const action = await promptOnce(
    rl,
    '  action [s]kip / [m]odel / [d]efault / [t]rash (delete only): ',
    (v) => {
      const lc = v.toLowerCase();
      if (['s', 'skip', ''].includes(lc)) return { ok: true, value: 'skip' };
      if (['m', 'model'].includes(lc)) return { ok: true, value: 'model' };
      if (['d', 'default', 'manufacturer'].includes(lc))
        return { ok: true, value: 'manufacturer_default' };
      if (['t', 'trash', 'delete'].includes(lc)) return { ok: true, value: 'trash' };
      return { ok: false, error: 'choose s, m, d, or t' };
    }
  );
  if (action === 'skip') return { kind: 'skip' };
  if (action === 'trash') return { kind: 'trash' };

  if (!pending.manufacturer) fail('cannot promote — pending entry has no manufacturer');

  const rcdType = await promptOnce(
    rl,
    `  rcd_type [${suggestion.suggestedType ?? 'A/AC/B/F/S'}]: `,
    (v) => {
      const choice = v || suggestion.suggestedType || '';
      const u = choice.toUpperCase();
      if (VALID_TYPES.includes(u)) return { ok: true, value: u };
      return { ok: false, error: `must be one of ${VALID_TYPES.join('/')}` };
    }
  );

  const confidence = await promptOnce(rl, '  confidence [medium]: ', (v) => {
    const choice = (v || 'medium').toLowerCase();
    if (VALID_CONFIDENCES.includes(choice)) return { ok: true, value: choice };
    return { ok: false, error: `must be one of ${VALID_CONFIDENCES.join('/')}` };
  });

  const verifiedBy = await promptOnce(rl, '  verified_by [field]: ', (v) => {
    const s = (v || 'field').trim();
    if (s.length > 0) return { ok: true, value: s };
    return { ok: false, error: 'verified_by must be non-empty' };
  });

  const note = (await rl.question('  note (optional): ')).trim() || null;

  if (action === 'model') {
    if (!pending.model) fail('cannot promote model entry — pending has no model');
    const ways = await promptOnce(
      rl,
      `  ways [${suggestion.suggestedWays ?? 'leave blank'}]: `,
      (v) => {
        const t = (v || (suggestion.suggestedWays ? String(suggestion.suggestedWays) : '')).trim();
        if (t === '') return { ok: true, value: null };
        const n = parseInt(t, 10);
        if (Number.isFinite(n) && n > 0 && n < 200) return { ok: true, value: n };
        return { ok: false, error: 'must be a positive integer or blank' };
      }
    );
    return {
      kind: 'model',
      manufacturer: pending.manufacturer,
      model: pending.model,
      rcd_type: rcdType,
      ways,
      confidence,
      verified_by: verifiedBy,
      note,
    };
  }
  return {
    kind: 'manufacturer_default',
    manufacturer: pending.manufacturer,
    rcd_type: rcdType,
    confidence,
    verified_by: verifiedBy,
    note,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) fail('S3_BUCKET env var required');

  const s3 = await getS3();
  const keys = await listPendingKeys(s3, bucket);
  if (keys.length === 0) {
    console.log('No pending entries. Nothing to do.');
    return;
  }

  const entries = [];
  for (const key of keys) {
    try {
      const body = await fetchPending(s3, bucket, key);
      if ((body.sighting_count ?? 0) >= FLAGS.minCount) {
        entries.push({ key, body });
      }
    } catch (err) {
      console.error(`  warning: could not parse ${key} — ${err.message}`);
    }
  }
  // Sort by sighting count desc so highest-confidence promotions surface first.
  entries.sort((a, b) => (b.body.sighting_count ?? 0) - (a.body.sighting_count ?? 0));

  if (FLAGS.listOnly) {
    for (const { key, body } of entries) {
      const sug = suggestPromotion(body);
      console.log(
        `${(body.sighting_count ?? 0).toString().padStart(3)}  ${body.manufacturer ?? '?'} / ${body.model ?? '?'}  ` +
          `→ ${sug.suggestedType ?? '?'} type (${(sug.typeAgreement * 100).toFixed(0)}%)` +
          (sug.suggestedWays ? `, ${sug.suggestedWays} ways (${(sug.waysAgreement * 100).toFixed(0)}%)` : '') +
          `  [${key}]`
      );
    }
    return;
  }

  const rl = readline.createInterface({ input, output });
  const config = readConfig();
  const promotions = [];
  const trashed = [];

  try {
    for (const { key, body } of entries) {
      const suggestion = suggestPromotion(body);
      const decision = await promptDecision(rl, body, suggestion);
      if (decision.kind === 'skip') continue;
      if (decision.kind === 'trash') {
        trashed.push({ key, body });
        if (!FLAGS.dryRun) await deletePending(s3, bucket, key);
        console.log(`  trashed ${key}`);
        continue;
      }
      applyPromotion(config, decision);
      promotions.push({ key, decision });
      if (!FLAGS.dryRun) await deletePending(s3, bucket, key);
      console.log(`  promoted ${decision.kind}: ${decision.manufacturer}${decision.model ? '/' + decision.model : ''}`);
    }
  } finally {
    rl.close();
  }

  if (promotions.length > 0) {
    appendChangelog(
      config,
      `Promoted ${promotions.length} entries from rcd-lookup-pending: ` +
        promotions
          .map((p) =>
            p.decision.kind === 'model'
              ? `${p.decision.manufacturer}/${p.decision.model} (${p.decision.rcd_type}, ${p.decision.confidence})`
              : `${p.decision.manufacturer} default (${p.decision.rcd_type}, ${p.decision.confidence})`
          )
          .join(', ')
    );
    writeConfig(config);
    console.log(`\n${FLAGS.dryRun ? '[dry-run] ' : ''}wrote ${CONFIG_PATH} (+ .bak)`);
  } else if (trashed.length > 0) {
    console.log(`\n${trashed.length} pending entries trashed; no config changes.`);
  } else {
    console.log('\nNo changes.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
