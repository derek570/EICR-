// A02D — the published RegexFreshOccurrenceEvidence must attest the checked-out
// bytes. Codex fix-verification cycles 2 and 3 found the committed document
// lagging the sources it claimed to pin, so the generator's `--verify` mode
// is a CI gate: any inventoried source, fixture or test that changes without
// a regeneration fails here with the list of drifted files. Regenerate with
// fresh run inputs (see the generator header), never by hand-editing digests.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const GENERATOR = 'scripts/evidence/build-regex-fresh-occurrence-evidence.mjs';
const DOC = 'docs/reference/evidence/regex-fresh-occurrence.json';

function runVerify(extraArgs = []) {
  return spawnSync(process.execPath, [GENERATOR, '--verify', ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('RegexFreshOccurrenceEvidence pins the checked-out sources', () => {
  test('[invariant] --verify exits 0 against the committed document', () => {
    const r = runVerify();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/digests match the checkout/);
  });

  test('[invariant] --verify exits 1 when an inventoried digest differs', () => {
    const doc = JSON.parse(readFileSync(join(repoRoot, DOC), 'utf8'));
    const [file] = Object.keys(doc.digests.sources);
    doc.digests.sources[file] = '0'.repeat(64);
    const dir = mkdtempSync(join(tmpdir(), 'a02d-evidence-'));
    const altered = join(dir, 'altered.json');
    writeFileSync(altered, JSON.stringify(doc));
    const r = runVerify([`--out=${altered}`]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`sources: ${file}`);
  });

  test('[invariant] every inventoried file exists (a null digest is never a pin)', () => {
    const doc = JSON.parse(readFileSync(join(repoRoot, DOC), 'utf8'));
    for (const group of ['sources', 'fixtures', 'tests']) {
      for (const [file, digest] of Object.entries(doc.digests[group])) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
        expect(() => readFileSync(join(repoRoot, file))).not.toThrow();
      }
    }
  });
});
