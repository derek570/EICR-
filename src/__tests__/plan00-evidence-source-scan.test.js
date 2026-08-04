/**
 * Plan 00B-3 C3 — evidence-producer source-coverage scan.
 *
 * The closed producer registry only makes bypass fail loudly if NOTHING in
 * production source can mint family/transport-bearing evidence outside the
 * typed registry adapters. This scan enforces, over all of src/ (excluding
 * tests):
 *
 *  1. NO raw `family:`/`transport:` argument in any call to the family-
 *     bearing recording APIs (recordAskProduced / recordDelivery /
 *     recordPlayback) outside the adapters file — registry IDs only.
 *  2. NO direct lifecycle append (`appendLedgerRow`) outside the adapters
 *     file (plan00-lifecycle-hooks.js owns the one append seam).
 *  3. Every `recordLifecycleEvent`/notify* append site names a kind in the
 *     SEPARATE closed non-producer allowlist (round_usage, invalid rows,
 *     freeze rows, non-mutating audit rows do not map to a semantic
 *     producer) — an append that is neither a registered producer event
 *     nor an allowlisted non-producer row fails this table.
 *  4. Every producer ID string used at a production call site is a
 *     registered PRODUCER_REGISTRY member.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCER_REGISTRY,
  NON_PRODUCER_ROW_KINDS,
} from '../extraction/plan00-evidence-registry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = path.join(repoRoot, 'src');
const ADAPTERS_FILE = path.join('src', 'extraction', 'plan00-lifecycle-hooks.js');

function listSources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...listSources(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const sources = listSources(SRC_DIR).map((full) => ({
  rel: path.relative(repoRoot, full),
  text: fs.readFileSync(full, 'utf8'),
}));

/** Collect the argument text of every `fnName(...)`-shaped call (balanced parens). */
function callArgTexts(text, fnName) {
  const out = [];
  let idx = 0;
  for (;;) {
    const at = text.indexOf(`${fnName}(`, idx);
    if (at === -1) break;
    let depth = 0;
    let end = at + fnName.length;
    for (let i = at + fnName.length; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out.push(text.slice(at + fnName.length + 1, end));
    idx = end;
  }
  return out;
}

describe('evidence-producer source-coverage scan (C3)', () => {
  test('no raw family/transport argument reaches the family-bearing recording APIs outside the adapters', () => {
    const offenders = [];
    for (const { rel, text } of sources) {
      if (rel === ADAPTERS_FILE) continue;
      for (const fn of ['recordAskProduced', 'recordDelivery', 'recordPlayback']) {
        for (const args of callArgTexts(text, fn)) {
          if (/(^|[,{\s])family\s*:/.test(args) || /(^|[,{\s])transport\s*:/.test(args)) {
            offenders.push({ rel, fn, args: args.slice(0, 120) });
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no direct appendLedgerRow outside the adapters file', () => {
    const offenders = sources
      .filter(({ rel, text }) => rel !== ADAPTERS_FILE && /appendLedgerRow\s*\(/.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  test('no low-level ledger append (recordDeliveryAttempt/recordPlaybackAck/semanticFamily) outside the evidence adapters', () => {
    // Codex r1 (B-4) — the registry only closes if the RAW ledger APIs are
    // unreachable from production source outside the two evidence modules.
    const LEDGERS_FILE = path.join('src', 'extraction', 'plan00-audibility-ledgers.js');
    const offenders = [];
    for (const { rel, text } of sources) {
      if (rel === ADAPTERS_FILE || rel === LEDGERS_FILE) continue;
      for (const fn of ['recordDeliveryAttempt', 'recordPlaybackAck']) {
        if (new RegExp(`\\.${fn}\\s*\\(`).test(text)) offenders.push({ rel, fn });
      }
      if (/semanticFamily\s*:/.test(text)) offenders.push({ rel, fn: 'semanticFamily arg' });
    }
    expect(offenders).toEqual([]);
  });

  test('every recordLifecycleEvent/notify* append site is an allowlisted non-producer row kind', () => {
    const allow = new Set(NON_PRODUCER_ROW_KINDS);
    const offenders = [];
    for (const { rel, text } of sources) {
      // the adapters file OWNS the append seam (its own delegating function
      // signature is the one legitimate non-literal-kind call shape)
      if (rel === ADAPTERS_FILE) continue;
      for (const args of callArgTexts(text, 'recordLifecycleEvent')) {
        const m = args.match(/^[^,]+,\s*'([^']+)'/);
        if (!m) {
          offenders.push({ rel, args: args.slice(0, 80), reason: 'non-literal kind' });
          continue;
        }
        if (!allow.has(m[1])) offenders.push({ rel, kind: m[1] });
      }
    }
    // notifySuccessfulFrame / notifyConfirmationDelivery are fixed-kind
    // wrappers over allowlisted kinds — assert the wrappers' kinds too.
    const hooksText = sources.find(({ rel }) => rel === ADAPTERS_FILE).text;
    expect(hooksText).toContain("recordLifecycleEvent(entry, 'successful_frame', detail)");
    expect(hooksText).toContain("recordLifecycleEvent(entry, 'confirmation_delivery', detail)");
    expect(offenders).toEqual([]);
  });

  test('every producerId literal at a production call site is a registered member', () => {
    const ids = new Set(Object.keys(PRODUCER_REGISTRY));
    const offenders = [];
    for (const { rel, text } of sources) {
      for (const m of text.matchAll(/producerId:\s*'([^']+)'/g)) {
        if (!ids.has(m[1])) offenders.push({ rel, id: m[1] });
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the appendSub seam inside the adapters only mints schema row kinds', () => {
    const hooksText = sources.find(({ rel }) => rel === ADAPTERS_FILE).text;
    const kinds = new Set();
    for (const m of hooksText.matchAll(/appendSub\(\s*'([^']+)'/g)) kinds.add(m[1]);
    for (const m of hooksText.matchAll(/appendLedgerRow\(ledger,\s*[^,]+,\s*'([^']+)'/g)) {
      kinds.add(m[1]);
    }
    const known = new Set([
      'ask_lifecycle',
      'ask_transition_rejected',
      'delivery_evidence',
      'delivery_rejected',
      'playback_evidence',
      'playback_idempotent',
      'playback_rejected',
      'non_mutating_audible',
      'producer_unknown',
      'round_usage',
      'freeze_invalid',
    ]);
    for (const kind of kinds) expect(known.has(kind)).toBe(true);
    // and the freeze/round seams genuinely exist
    expect(kinds.has('freeze_invalid') || hooksText.includes("'freeze_invalid'")).toBe(true);
  });
});
