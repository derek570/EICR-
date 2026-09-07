import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const EXPECTED_SHA256 = '05936a20f2f4443f8b366abe0105020f5b7520461756c0e0e4cb31132b5ecdb9';

describe('DictatedReadbackPolicyV1', () => {
  it('pins the shared executable policy bytes', () => {
    const bytes = readFileSync(
      resolve(process.cwd(), '..', 'config', 'dictated-readback-policy-v1.json')
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(EXPECTED_SHA256);
  });
});
