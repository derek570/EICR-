import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(dirname, '..', '..', 'config', 'conversation-admission-vectors.json');
const pinnedDigest = '19cfa6878db40320a4704f5f1b1b2e4f09f363f9ae5bf72d6d57628067b6e15f';

describe('ConversationAdmissionV1 shared fixture', () => {
  it('pins the exact bytes consumed by both client suites', () => {
    const bytes = readFileSync(fixturePath);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pinnedDigest);
    const fixture = JSON.parse(bytes);
    expect(fixture.contract).toBe('ConversationAdmissionV1');
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(70);
  });
});
