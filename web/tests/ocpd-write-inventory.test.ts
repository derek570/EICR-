/**
 * PLAN-CC (feedback-2026-09-17 wave) — the OCPD write-path inventory guard.
 *
 * WHY A GREP TEST RATHER THAN TYPES
 * ---------------------------------
 * The standard-aware lookup returns null far more often than the type-only one
 * it replaced, so a write site that was merely stale before this plan can now
 * leave a max Zs for the WRONG DEVICE on the certificate. Every write or clear
 * of `ocpd_max_zs_ohm`, and every write to one of the four tuple members, has
 * to route through the shared helpers — and TypeScript cannot see that, because
 * the dangerous writers are computed-key spreads (`{ ...row, [column]: value }`)
 * whose key is a string at runtime.
 *
 * WHAT THIS IS, PRECISELY
 * -----------------------
 * A CHANGE DETECTOR over two narrow idioms, not a proof of correctness. It
 * tells you a new write site exists; you then decide whether it is routed. The
 * runtime half — `ocpd-max-zs-tuple.test.ts` and the per-path cases in
 * `apply-extraction-max-zs-lim.test.ts` — is what proves the routing works.
 *
 * An earlier, wider version of this file matched schema declarations, label
 * maps and every unrelated `out[key] = value` in the codebase. A detector that
 * fires on everything gets its allow-list padded until it fires on nothing, so
 * it was narrowed to the two shapes that can actually put a value on a circuit
 * row.
 *
 * WHAT IT DOES NOT COVER, stated so it is not mistaken for more than it is:
 * a setter whose receiver this scan cannot see to be a circuit row; a write
 * through a helper defined in another file; anything outside the two
 * directories walked below; and the tuple members when written through a
 * computed key that does not spread a row.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');

const ROOTS = [path.join(REPO, 'web', 'src'), path.join(REPO, 'packages', 'shared-utils', 'src')];

/** Read-only surfaces: PDF templates, dev fixtures, settings pages. A read is
 *  not a write, and including them would bury the signal. */
const EXCLUDED = [
  path.join('web', 'src', 'lib', 'pdf'),
  path.join('web', 'src', 'app', 'dev-reference'),
  path.join('web', 'src', 'app', 'settings'),
  '.generated.ts',
];

/** Detector A — a write whose TARGET is the derived max-Zs column. Rare, and
 *  every one of them must go through `writeMaxZs` / `clearMaxZs`. */
const MAX_ZS_WRITE = [
  /\bocpd_max_zs_ohm\s*:\s*[^;]/,
  /\.ocpd_max_zs_ohm\s*=[^=]/,
  /\['ocpd_max_zs_ohm'\]\s*=[^=]/,
];

/** Detector B — a circuit ROW spread with a computed key. This is the shape a
 *  field-name grep cannot see, and it is how the desktop bulk fill and the
 *  server-frame apply used to leave a stale derived value behind. */
const ROW_COMPUTED_KEY = [
  /\{\s*\.\.\.(row|c|circuit|next|existing)\s*,\s*\[/,
  /(row|circuits\[[^\]]+\]|next)\[(field|column|fieldKey|key|colKey)\]\s*=[^=]/,
];

/** Detector C — a direct property assignment of a tuple member. */
const TUPLE_PROPERTY_WRITE = [
  /\.(ocpd_bs_en|ocpd_type|ocpd_rating_a|max_disconnect_time_s)\s*=[^=]/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

type Hit = { file: string; line: number; text: string };

function scan(patterns: RegExp[]): Hit[] {
  const hits: Hit[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const rel = path.relative(REPO, file);
      if (EXCLUDED.some((ex) => rel.includes(ex))) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((text, i) => {
          const trimmed = text.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
            return;
          }
          if (patterns.some((re) => re.test(text))) {
            hits.push({ file: rel, line: i + 1, text: trimmed });
          }
        });
    }
  }
  return hits;
}

/** Files allowed to carry one of the idioms above. A new entry here is the
 *  whole signal: add it only once its writes route through
 *  `recomputeMaxZsForOcpdTuple` / `writeMaxZs` / `clearMaxZs` /
 *  `applyOcpdAwarePatch`, and say in the commit which helper it uses. */
const INVENTORY = new Set([
  // Shared helpers — these DEFINE the routing.
  path.join('packages', 'shared-utils', 'src', 'max-zs-lookup.ts'),
  path.join('packages', 'shared-utils', 'src', 'apply-defaults.ts'),
  path.join('packages', 'shared-utils', 'src', 'voice-commands.ts'),
  // Apply paths.
  path.join('web', 'src', 'lib', 'recording', 'apply-extraction.ts'),
  path.join('web', 'src', 'lib', 'recording', 'apply-ccu-analysis.ts'),
  path.join('web', 'src', 'lib', 'recording', 'apply-document-extraction.ts'),
  path.join('web', 'src', 'lib', 'recording', 'apply-regex-match.ts'),
  // Editing surfaces.
  path.join('web', 'src', 'app', 'job', '[id]', 'circuits', 'page.tsx'),
  // Two files that carry an idiom above WITHOUT writing an OCPD column, listed
  // rather than filtered out by a rule — a rule that excused them would excuse
  // a real write with the same shape:
  //   `impedance.ts` spreads a circuit row with a computed key, but
  //   `writeField` is always one of the impedance columns (Zs, R1+R2, R2).
  //   `transcript-field-matcher.ts` assigns tuple members on its own `updates`
  //   object, which is a DETECTOR result, not a circuit row. Those values
  //   reach a row through `apply-regex-match.ts`, which is inventoried above
  //   and is where canonicalisation happens.
  path.join('packages', 'shared-utils', 'src', 'impedance.ts'),
  path.join('web', 'src', 'lib', 'recording', 'transcript-field-matcher.ts'),
]);

describe('OCPD write-path inventory — static half', () => {
  const maxZsHits = scan(MAX_ZS_WRITE);
  const rowKeyHits = scan(ROW_COMPUTED_KEY);
  const tupleHits = scan(TUPLE_PROPERTY_WRITE);

  it('the scan finds something (a detector that matches nothing proves nothing)', () => {
    // The instrument's own known-good check. A rename of these columns would
    // otherwise make every assertion below pass by matching zero lines — which
    // is how two earlier instruments in this plan's history returned PASS while
    // the property they checked was false.
    expect(maxZsHits.length).toBeGreaterThanOrEqual(2);
    expect(rowKeyHits.length).toBeGreaterThan(2);
    expect(tupleHits.length).toBeGreaterThan(2);
  });

  it.each([
    ['max-Zs column writes', () => maxZsHits],
    ['circuit-row computed-key setters', () => rowKeyHits],
    ['tuple-member property writes', () => tupleHits],
  ])('%s all live in an inventoried file', (_label, get) => {
    const stray = get().filter((h) => !INVENTORY.has(h.file));
    expect(stray.map((h) => `${h.file}:${h.line} ${h.text}`)).toEqual([]);
  });

  it('the superseded provenance inference has no callers left', () => {
    // iOS removed the bare zero-argument `recalculateMaxZs()` outright rather
    // than wrapping it: a wrapper that still nulls on a lookup miss is unsafe
    // once the lookup is standard-aware. Web's equivalent was
    // `shouldClearAutoDerivedMaxZs`, whose value-equality inference this plan
    // replaced with a stored provenance key. Comment lines are skipped, so the
    // retirement note that names it does not make this pass by accident.
    const callers = scan([/\bshouldClearAutoDerivedMaxZs\b/]);
    expect(callers.map((h) => `${h.file}:${h.line}`)).toEqual([]);
  });
});
