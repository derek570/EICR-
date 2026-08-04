import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundleRoot = resolve(
  repoRoot,
  '.planning/voice-latency-conversational-2026-07-31/plan-00-gpt56-port-parity'
);

describe('tracked Plan 00 bundle provenance', () => {
  test('committed copies reconstruct their canonical hashes and fail closed for EP', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/plan00-bundle-provenance.mjs', '--verify-committed'],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    expect(output).toContain('verified 4 Plan 00 reference copies');
  });

  test.each(['00', '00A', '00B', '00C'])(
    'Plan %s is visibly reference-only with an adjacent disabled policy',
    (planId) => {
      const markdownPath = resolve(bundleRoot, `PLAN-${planId}-final.md`);
      const markdown = readFileSync(markdownPath, 'utf8');
      const policy = JSON.parse(readFileSync(`${markdownPath}.ep-policy.json`, 'utf8'));
      expect(markdown).toMatch(/^> \*\*REFERENCE COPY — NOT EXECUTABLE\.\*\*/);
      expect(markdown).not.toMatch(/\/ep --plan=(?:\/|<)/);
      expect(markdown).not.toContain('/Users/derekbeckley/');
      expect(policy).toEqual({ schema_version: 1, executable: false });
    }
  );
});
