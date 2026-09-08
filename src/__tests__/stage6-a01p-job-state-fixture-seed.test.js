/**
 * A01P (2026-09-08) — the shared job-state fixture, replayed through the REAL
 * `session_start` seed for BOTH clients' wire builders.
 *
 * `src/__tests__/fixtures/job-state/input-job.json` is the one API-shaped job
 * both platforms start from (byte-identical iOS copy, enforced by
 * scripts/check-job-state-fixture-sync.sh). Each client drives it through its
 * REAL builder and commits the key-sorted result:
 *   - web:  `buildJobStateForWire`            → web-build-job-state-for-wire.json
 *   - iOS:  APIClient.decoder → JobViewModel → `_test_buildJobStateForServer()`
 *                                              → ios-build-job-state-for-server.json
 * This suite sends each output as `session_start.jobState` through the real
 * `initSonnetStream` and asserts the seed the extraction session ends up with:
 * `circuits[0].client_name` (red on the original backend — the installation
 * ingest never read the name) and the canonical long-form supply Ze
 * (`circuits[0].earth_loop_impedance_ze`, whichever alias the client sent).
 * `manifest.json` digests the input and both outputs (no self-reference).
 */

import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: { create: jest.fn(async () => ({ content: [] })), stream: jest.fn() },
  })),
}));
jest.unstable_mockModule('../logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../storage.js', () => ({ uploadJson: jest.fn(async () => {}) }));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'job-state'
);
const INPUT = 'input-job.json';
const OUTPUTS = {
  web: 'web-build-job-state-for-wire.json',
  ios: 'ios-build-job-state-for-server.json',
};

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}
function sha256(name) {
  return createHash('sha256')
    .update(fs.readFileSync(path.join(FIXTURE_DIR, name)))
    .digest('hex');
}

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: jest.fn((payload, cb) => {
      sent.push(JSON.parse(payload));
      cb?.();
    }),
    ping: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    _handlers: new Map(),
  };
  Object.defineProperty(ws.send, 'length', { value: 2 });
  ws.on.mockImplementation((event, handler) => ws._handlers.set(event, handler));
  ws._sent = sent;
  ws._emit = async (event, data) => ws._handlers.get(event)(data);
  return ws;
}

let wss;
beforeEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, async () => 'fake-key', jest.fn());
});
afterEach(() => {
  for (const entry of activeSessions.values()) {
    try {
      entry?.session?.stop?.();
    } catch {
      /* teardown only */
    }
  }
  activeSessions.clear();
  sonnetSessionStore.clear();
});

async function seedThroughSessionStart(jobState, sessionId) {
  const ws = makeFakeWs();
  wss.emit('connection', ws, { headers: {} }, 'user-1');
  await ws._emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'session_start', sessionId, jobState }))
  );
  const entry = activeSessions.get(sessionId);
  expect(entry?.session).toBeDefined();
  return entry.session.stateSnapshot;
}

describe('[invariant] A01P — both client wire outputs seed the session with the client name and canonical supply Ze', () => {
  test('the committed outputs exist for BOTH clients (generated once from the real builders)', () => {
    for (const name of Object.values(OUTPUTS)) {
      expect(fs.existsSync(path.join(FIXTURE_DIR, name))).toBe(true);
    }
  });

  test('input fixture carries what the outputs must preserve', () => {
    const input = readJson(INPUT);
    expect(input.installation_details.client_name).toBe('Mrs Smith');
    expect(input.supply_characteristics.earth_loop_impedance_ze).toBe('0.50');
    expect(input.supply_characteristics.ze).toBe('0.50');
    expect(input.boards.map((b) => b.id)).toEqual(['main', 'garage']);
  });

  test.each(Object.entries(OUTPUTS).filter(([, f]) => fs.existsSync(path.join(FIXTURE_DIR, f))))(
    '%s output → session_start seeds circuits[0].client_name and earth_loop_impedance_ze',
    async (client, file) => {
      const snapshot = await seedThroughSessionStart(readJson(file), `sess-a01p-fixture-${client}`);
      // Name (red on 37dfde39: the installation ingest never read it).
      expect(snapshot.circuits[0].client_name).toBe('Mrs Smith');
      // Canonical long-form supply Ze, whichever alias spelling the client sent.
      expect(snapshot.circuits[0].earth_loop_impedance_ze).toBe('0.50');
      // The board overrides survive on the board records (main 0.35, garage 0.38).
      const byId = Object.fromEntries((snapshot.boards ?? []).map((b) => [b.id, b]));
      expect(String(byId.main?.ze)).toBe('0.35');
      expect(String(byId.garage?.ze)).toBe('0.38');
    }
  );

  test('manifest.json digests the input and both outputs, never itself', () => {
    const manifestPath = path.join(FIXTURE_DIR, 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.files).toBeDefined();
    expect(Object.keys(manifest.files)).not.toContain('manifest.json');
    for (const name of [INPUT, ...Object.values(OUTPUTS)]) {
      expect(manifest.files[name]).toBe(sha256(name));
    }
  });
});
