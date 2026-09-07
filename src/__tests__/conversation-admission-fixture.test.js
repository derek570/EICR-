import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(dirname, '..', '..', 'config', 'conversation-admission-vectors.json');
const pinnedDigest = 'a1499b09511ba230d56b015169eb0052fe778a4ff018fd99668606efe98b196d';

describe('ConversationAdmissionV1 shared fixture', () => {
  it('pins the exact bytes consumed by both client suites', () => {
    const bytes = readFileSync(fixturePath);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pinnedDigest);
    const fixture = JSON.parse(bytes);
    expect(fixture.contract).toBe('ConversationAdmissionV1');
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(70);
  });
});
