/**
 * PLAN-A (feedback-2026-09-17) — the import-safety assertions for the
 * descriptor leaf (A-111 / A-216 / A-221 / A-227).
 *
 * THIS FILE IS THE NORMATIVE ARTEFACT, and the prose in
 * `circuit-value-descriptors.js` is descriptive of it. If the two ever
 * disagree, this is right.
 *
 * Why an assertion rather than a prose list of forbidden modules: the property
 * was restated in three consecutive review rounds and was incomplete each time,
 * because the set of modules a cycle can route through grows whenever the
 * engine grows. `engine.js` imports the leaf, so a later `predicate → engine.js`
 * import closes `engine → leaf → predicate → engine` without touching any
 * named module; and the leaf imports every registered predicate by
 * construction, so `leaf → predicate → leaf` closes a cycle the same way. The
 * durable statement is a CLOSURE property, so it is computed, not enumerated.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const LEAF = 'src/extraction/circuit-value-descriptors.js';

/** Static `import ... from '<spec>'` / `export ... from '<spec>'` specifiers. */
function staticImportSpecifiers(absPath) {
  const src = readFileSync(absPath, 'utf8');
  const out = [];
  // `[^;]*?` deliberately spans NEWLINES: the multi-line `import {\n … \n}
  // from '…'` form is the common one here, and a newline-excluding class
  // silently misses every one of them.
  const re = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  // Bare side-effect imports: `import 'x';`
  const re2 = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]\s*;/g;
  while ((m = re2.exec(src)) !== null) out.push(m[1]);
  return out;
}

function resolveRelative(fromAbs, spec) {
  if (!spec.startsWith('.')) return null; // bare specifier: node builtin or package
  const abs = resolve(dirname(fromAbs), spec);
  return existsSync(abs) ? abs : null;
}

/**
 * Transitive static-import closure of one repo-relative module, as
 * repo-relative paths. Bare specifiers (node builtins, packages) are not
 * followed — nothing under `src/extraction/` is reachable through them.
 */
function importClosure(repoRelStart) {
  const startAbs = resolve(REPO_ROOT, repoRelStart);
  const seen = new Set();
  const queue = [startAbs];
  while (queue.length > 0) {
    const cur = queue.pop();
    const rel = relative(REPO_ROOT, cur);
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const spec of staticImportSpecifiers(cur)) {
      const next = resolveRelative(cur, spec);
      if (next) queue.push(next);
    }
  }
  seen.delete(relative(REPO_ROOT, startAbs));
  return seen;
}

/**
 * The forbidden-destination predicate, stated as a closure property rather
 * than a list: a registered predicate's module may not reach the descriptor
 * leaf itself, the validation layer, the tool schemas, or ANY module under
 * `dialogue-engine/` other than `parsers/`.
 */
function forbiddenDestinations(closure) {
  return [...closure].filter(
    (p) =>
      p === LEAF ||
      p === 'src/extraction/stage6-dispatch-validation.js' ||
      p === 'src/extraction/stage6-tool-schemas.js' ||
      (p.startsWith('src/extraction/dialogue-engine/') &&
        !p.startsWith('src/extraction/dialogue-engine/parsers/'))
  );
}

describe('the descriptor leaf is a leaf', () => {
  test('its static imports are exactly the five allowed modules', () => {
    // PLAN-CS added `bs-code.js`, the module of its registered
    // `ocpd_standard_shape` predicate — a `parsers/` module, the carve-out.
    // PLAN-C2 added `mcb-type.js`, the OCPD type advisory's derivation —
    // another `parsers/` module, whose only static import is `bs-code.js`.
    const specs = staticImportSpecifiers(resolve(REPO_ROOT, LEAF));
    expect(new Set(specs)).toEqual(
      new Set([
        'node:module',
        './value-enum-validator.js',
        './value-normalise.js',
        './dialogue-engine/parsers/bs-code.js',
        './dialogue-engine/parsers/mcb-type.js',
      ])
    );
  });

  test('its own transitive closure reaches no forbidden destination', () => {
    expect(forbiddenDestinations(importClosure(LEAF))).toEqual([]);
  });

  test('import order: the production entry loads first and the descriptor still resolves', () => {
    // Production enters through dialogue-engine/index.js. Loading it BEFORE
    // stage6-tool-schemas.js is the order that would expose an uninitialised
    // ALL_DIALOGUE_SCHEMA_NAMES binding if the leaf ever imported the
    // validation layer.
    return import('../extraction/dialogue-engine/index.js').then(async (engineIndex) => {
      // The binding lives on dialogue-engine/index.js; stage6-tool-schemas.js
      // imports it and uses it at module top level, which is the evaluation
      // that would throw if the leaf ever pulled the validation layer in.
      expect(Array.isArray(engineIndex.ALL_DIALOGUE_SCHEMA_NAMES)).toBe(true);
      expect(engineIndex.ALL_DIALOGUE_SCHEMA_NAMES.length).toBeGreaterThan(0);
      const schemas = await import('../extraction/stage6-tool-schemas.js');
      expect(Array.isArray(schemas.TOOL_SCHEMAS)).toBe(true);
      const leaf = await import('../extraction/circuit-value-descriptors.js');
      expect(leaf.describeSlotValidation('ocpd_rating_a').kind).toBe('ranged_numeric');
    });
  });
});

describe('registered parser_backed predicates', () => {
  test('every registered row names a module, and that module reaches nothing forbidden', async () => {
    const { PARSER_BACKED_FIELD_GATES } =
      await import('../extraction/circuit-value-descriptors.js');
    for (const [field, gate] of PARSER_BACKED_FIELD_GATES) {
      expect(typeof gate.module).toBe('string');
      expect(existsSync(resolve(REPO_ROOT, gate.module))).toBe(true);
      expect({ field, forbidden: forbiddenDestinations(importClosure(gate.module)) }).toEqual({
        field,
        forbidden: [],
      });
    }
  });

  test('the instrument FAILS on a known-bad module, through the same code path', () => {
    // An assertion that has never been seen to fail is not evidence. This runs
    // the SAME `importClosure` → `forbiddenDestinations` pair the test above
    // runs, on a real module that genuinely reaches the validation layer — so
    // it exercises the same branch rather than a degenerate one.
    const knownBad = 'src/extraction/stage6-dispatchers-circuit.js';
    const closure = importClosure(knownBad);
    const hits = forbiddenDestinations(closure);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).toContain('src/extraction/stage6-dispatch-validation.js');

    // Each ARM of the predicate is exercised separately, because the arm that
    // matters most is the one an enumerated list kept missing: a predicate
    // module that imports the LEAF back, closing `leaf → predicate → leaf`
    // while touching none of the named modules. The known-bad above happens to
    // trip the `dialogue-engine/` arm, which would leave the leaf arm unproven.
    expect(forbiddenDestinations(new Set([LEAF]))).toEqual([LEAF]);
    expect(forbiddenDestinations(new Set(['src/extraction/stage6-tool-schemas.js']))).toHaveLength(
      1
    );
    expect(
      forbiddenDestinations(new Set(['src/extraction/dialogue-engine/helpers/extraction.js']))
    ).toHaveLength(1);
    // …and the `parsers/` carve-out really is a carve-out.
    expect(
      forbiddenDestinations(new Set(['src/extraction/dialogue-engine/parsers/bs-code.js']))
    ).toEqual([]);
  });

  test('what this assertion does NOT cover', () => {
    // Stated so an empty result is not over-read: the closure is STATIC only.
    // A dynamic `import()` or a `createRequire` of a source module inside a
    // registered predicate is invisible to it. Nothing in the repo does that
    // today, and this line is the record that it would not be caught.
    const src = readFileSync(resolve(REPO_ROOT, LEAF), 'utf8');
    expect(src).not.toMatch(/\bimport\s*\(/);
  });
});
