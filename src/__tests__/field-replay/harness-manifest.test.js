/**
 * harness-manifest.test.js — the trusted-harness manifest self-consistency
 * + the verify-harness-manifest pure core (plan Item 4). A manifest listing
 * a file that doesn't exist, or the verifier accepting a dropped/edited
 * entry, would silently uncover the anti-forgery guarantee.
 */

import fs from 'node:fs';
import path from 'node:path';
import { verifyManifest } from '../../../scripts/field-replay/verify-harness-manifest.mjs';

const manifest = JSON.parse(fs.readFileSync(path.resolve('config/field-replay-harness-manifest.json'), 'utf8'));

describe('manifest self-consistency', () => {
  test('every listed core file exists on disk', () => {
    const missing = manifest.core_files.filter((f) => !fs.existsSync(path.resolve(f)));
    expect(missing).toEqual([]);
  });
  test('the manifest lists the load-bearing runner + crypto + governance modules', () => {
    const must = [
      'scripts/voice-latency-bench/transcript-replay-direct.mjs',
      'scripts/voice-latency-bench/transcript-replay-direct-runner.mjs',
      'scripts/field-replay/lib/canonical-crypto.mjs',
      'scripts/field-replay/lib/replay-runner-core.mjs',
      'scripts/field-replay/lib/governance-core.mjs',
      'src/__tests__/helpers/mockStream.js',
      'src/__tests__/helpers/f7-audibility-core.js',
      'config/field-replay-runtime.json',
      'package-lock.json',
    ];
    for (const f of must) expect(manifest.core_files).toContain(f);
  });
});

describe('verifyManifest pure core', () => {
  const anchorManifest = { core_files: ['a.mjs', 'b.mjs'] };
  const anchorBytes = Buffer.from(JSON.stringify(anchorManifest));

  test('identical checkout passes', () => {
    const r = verifyManifest({
      anchorManifestBytes: anchorBytes,
      checkedOutManifestBytes: Buffer.from(JSON.stringify(anchorManifest)),
      coreFileBytes: {
        'a.mjs': { anchor: Buffer.from('AAA'), head: Buffer.from('AAA') },
        'b.mjs': { anchor: Buffer.from('BBB'), head: Buffer.from('BBB') },
      },
    });
    expect(r.errors).toEqual([]);
  });

  test('an EDITED manifest (differs from anchor) fails closed before per-file checks', () => {
    const edited = { core_files: ['a.mjs'] }; // dropped b.mjs
    const r = verifyManifest({
      anchorManifestBytes: anchorBytes,
      checkedOutManifestBytes: Buffer.from(JSON.stringify(edited)),
      coreFileBytes: {},
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/differs from the target-branch copy/);
  });

  test('a MODIFIED helper (present in the manifest but changed) fails', () => {
    const r = verifyManifest({
      anchorManifestBytes: anchorBytes,
      checkedOutManifestBytes: Buffer.from(JSON.stringify(anchorManifest)),
      coreFileBytes: {
        'a.mjs': { anchor: Buffer.from('AAA'), head: Buffer.from('AAA-TAMPERED') },
        'b.mjs': { anchor: Buffer.from('BBB'), head: Buffer.from('BBB') },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/differs from the anchored target-branch blob: a\.mjs/);
  });

  test('a core file missing from the checkout fails', () => {
    const r = verifyManifest({
      anchorManifestBytes: anchorBytes,
      checkedOutManifestBytes: Buffer.from(JSON.stringify(anchorManifest)),
      coreFileBytes: {
        'a.mjs': { anchor: Buffer.from('AAA'), head: null },
        'b.mjs': { anchor: Buffer.from('BBB'), head: Buffer.from('BBB') },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/missing in checkout: a\.mjs/);
  });
});
