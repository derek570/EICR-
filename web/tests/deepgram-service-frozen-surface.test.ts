/**
 * A02D — the plan freezes three `DeepgramService` methods byte-for-byte:
 * `onmessage` (the per-socket delivery closure), `handleMessage` (the nova-3
 * decoder + Flux dispatch) and `advanceProcessedWatermark` (PLAN-E2's
 * watermark retirement). A02D gates its OWN admission downstream and never
 * edits them (Codex diff-review cycle 2, BLOCKER 1: an earlier cycle had
 * derived the nova provider-final identity INSIDE `handleMessage`).
 *
 * Exact-source guard: each method's text is extracted from the checked-out
 * source and its SHA-256 compared to the digest of the same text at the
 * pre-A02D base (`2d7b9874`). A byte changes → this test names the method.
 * Update a digest ONLY with a plan amendment that lifts the freeze.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const SOURCE = readFileSync(require.resolve('../src/lib/recording/deepgram-service.ts'), 'utf8');

/** Digests of the frozen text at base 2d7b9874 (pre-A02D `main`). */
const FROZEN: Record<string, string> = {
  onmessage: '22d58b91a1bde915aedbdcf059524f6b501a31eeeb50e3fd622b2d0cb32c58ab',
  handleMessage: 'b3da49fede8b508db058bbb671275a6b3c32641b9cd9b338a4b8733e28d373c1',
  advanceProcessedWatermark: '935ba8f1857716761714833e5845efb1fdec5a216ab3260b0adb545c0eaad815',
};

function privateMethod(name: string): string {
  const start = SOURCE.indexOf(`  private ${name}(`);
  expect(start, `method ${name} present`).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\n  }\n', start) + 4;
  return SOURCE.slice(start, end);
}
function onmessageClosure(): string {
  const start = SOURCE.indexOf('    ws.onmessage = (event) => {');
  expect(start, 'onmessage assignment present').toBeGreaterThan(-1);
  const end = SOURCE.indexOf('    };\n', start) + 7;
  return SOURCE.slice(start, end);
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('[invariant] A02D — frozen DeepgramService surface', () => {
  it('`onmessage` is byte-for-byte the pre-A02D closure', () => {
    expect(sha256(onmessageClosure())).toBe(FROZEN.onmessage);
  });
  it('`handleMessage` is byte-for-byte the pre-A02D method', () => {
    expect(sha256(privateMethod('handleMessage'))).toBe(FROZEN.handleMessage);
  });
  it('`advanceProcessedWatermark` is byte-for-byte the pre-A02D method', () => {
    expect(sha256(privateMethod('advanceProcessedWatermark'))).toBe(
      FROZEN.advanceProcessedWatermark
    );
  });
  it('exactly one `onmessage` assignment exists (no second delivery path was added)', () => {
    expect(SOURCE.match(/^\s*ws\.onmessage = /gm)).toHaveLength(1);
  });
});
