/**
 * discovery.mjs — corpus fixture discovery (plan Item 2 "Discovery").
 *
 * Recursive, deterministically-sorted discovery under the corpus root,
 * restricted to the EXACT basename `fixture.yaml` (canonical layout
 * `tests/fixtures/field-replay-corpus/<corpus-id>/fixture.yaml`).
 * Attestations and evidence are explicitly-named `.json` files and are
 * NEVER discovered as scenarios; drafts, ignored files, and unrelated YAML
 * under the root are ignored (tests prove it).
 *
 * An EMPTY or ABSENT corpus directory is a PASS for the field-corpus lane
 * (exit 0 with an explicit `0 fixtures discovered` summary) — the
 * Foundation PR wires the blocking step while shipping ZERO fixtures; the
 * legacy scenario runner's exit-2-on-empty precedent does NOT apply here.
 */

import fs from 'node:fs';
import path from 'node:path';

export const FIXTURE_BASENAME = 'fixture.yaml';

/** Recursively find every fixture.yaml under `root`, sorted by path. */
export function discoverFixtures(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === FIXTURE_BASENAME) {
        out.push({ fixturePath: p, dir });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (a.fixturePath < b.fixturePath ? -1 : 1));
}

/** Duplicate corpus-ID validation over parsed fixture docs. */
export function assertUniqueCorpusIds(fixtures) {
  const seen = new Map();
  for (const f of fixtures) {
    const id = f.doc?.corpus_id;
    if (id == null) continue;
    if (seen.has(id)) {
      throw new Error(`duplicate corpus_id ${id} in ${f.fixturePath} and ${seen.get(id)}`);
    }
    seen.set(id, f.fixturePath);
  }
}
