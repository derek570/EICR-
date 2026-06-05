/**
 * Wire-shape snapshot — locks the exact `regexResults` payload that
 * lands on the `transcript` WebSocket frame for known input. If iOS or
 * the backend ever evolves the shape, this test fails loudly and points
 * at the parity gap.
 *
 * Three layers verified:
 *   1. `buildRegexSummary` produces the iOS-canonical entry shape
 *      (`{field}` per entry, `{field, value}` for postcode).
 *   2. `SonnetSession.sendTranscript` includes `regexResults` on the
 *      outbound WS frame when non-empty, omits the field when empty.
 *   3. End-to-end: text → normalise → matcher → buildRegexSummary →
 *      sendTranscript → exact `transcript` frame the backend will
 *      receive.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WS from 'jest-websocket-mock';
import { TranscriptFieldMatcher } from '@/lib/recording/transcript-field-matcher';
import { FieldSourceTracker } from '@/lib/recording/field-source-tracker';
import { applyRegexMatchToJob } from '@/lib/recording/apply-regex-match';
import { buildRegexSummary } from '@/lib/recording/regex-match-result';
import { normalise } from '@/lib/recording/number-normaliser';
import { SonnetSession } from '@/lib/recording/sonnet-session';
import type { JobDetail, CircuitRow } from '@/lib/types';

function makeJob(): JobDetail {
  const circuits: CircuitRow[] = [
    { id: 'row-1', circuit_ref: '1', circuit_designation: 'Lights' },
    { id: 'row-3', circuit_ref: '3', circuit_designation: 'Sockets' },
  ];
  return {
    id: 'job_1',
    job_id: 'job_1',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: 'a',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    installation_details: {},
    supply_characteristics: {},
    board_info: {},
    circuits,
  } as unknown as JobDetail;
}

describe('buildRegexSummary wire shape', () => {
  it('emits {field} per entry, NOT {field, circuit}', () => {
    const job = makeJob();
    const tracker = new FieldSourceTracker();
    tracker.seedFromJob(job);
    const matcher = new TranscriptFieldMatcher();

    const result = matcher.match('Circuit 3 Zs is 0.62', job);
    applyRegexMatchToJob(job, result, tracker);
    const writtenKeys = tracker.consumeTurnWrites();
    const summary = buildRegexSummary(writtenKeys, job);

    expect(summary).toEqual([{ field: 'circuit.row-3.measured_zs_ohm' }]);
    // Critical: NO `circuit` key (iOS doesn't emit it; circuit attribution
    // is encoded in the field name itself).
    expect(summary?.[0]).not.toHaveProperty('circuit');
  });

  it('adds value for install.postcode (postcodes.io lookup)', () => {
    const job = makeJob();
    // Apply postcode directly via the tracker so we can drive
    // buildRegexSummary in isolation. The full normalise+match path is
    // also exercised below in the end-to-end test.
    const tracker = new FieldSourceTracker();
    tracker.recordRegexWrite('install.postcode');
    const updatedJob: JobDetail = {
      ...job,
      installation_details: { ...(job.installation_details ?? {}), postcode: 'RG6 6BB' },
    } as JobDetail;
    const summary = buildRegexSummary(tracker.consumeTurnWrites(), updatedJob);
    expect(summary).toEqual([{ field: 'install.postcode', value: 'RG6 6BB' }]);
  });

  it('returns undefined when no keys written', () => {
    const job = makeJob();
    const summary = buildRegexSummary([], job);
    expect(summary).toBeUndefined();
  });
});

// MARK: — SonnetSession integration
//
// URL prefix + token key match the existing sonnet-session.test.ts
// suite. The WS prefix is the bare host+path; the client appends
// ?token=… as a query string, which jest-websocket-mock's prefix
// match accepts.

const WS_BASE = 'ws://localhost:3000/api/sonnet-stream';
const TOKEN_KEY = 'cm_token';

describe('SonnetSession.sendTranscript regexResults', () => {
  let server: WS;

  beforeEach(() => {
    localStorage.setItem(TOKEN_KEY, 'fake-jwt-token');
    server = new WS(WS_BASE);
  });

  afterEach(() => {
    WS.clean();
    localStorage.clear();
  });

  async function openSession(): Promise<SonnetSession> {
    const session = new SonnetSession({});
    session.connect({
      sessionId: 'test-session',
      jobId: 'job_1',
      certificateType: 'EICR',
      jobState: {},
    });
    await server.connected;
    // Drain the session_start frame so subsequent assertions see the
    // transcript frame directly.
    await server.nextMessage;
    return session;
  }

  it('omits regexResults from the wire when undefined', async () => {
    const session = await openSession();
    session.sendTranscript('hello', { utteranceId: 'u1' });
    const raw = (await server.nextMessage) as string;
    const msg = JSON.parse(raw);
    expect(msg.type).toBe('transcript');
    expect(msg.text).toBe('hello');
    expect(msg).not.toHaveProperty('regexResults');
  });

  it('omits regexResults from the wire when empty array', async () => {
    const session = await openSession();
    session.sendTranscript('hello', { utteranceId: 'u1', regexResults: [] });
    const raw = (await server.nextMessage) as string;
    const msg = JSON.parse(raw);
    expect(msg).not.toHaveProperty('regexResults');
  });

  it('emits regexResults on the wire when non-empty', async () => {
    const session = await openSession();
    session.sendTranscript('Circuit 3 Zs is 0.62', {
      utteranceId: 'u1',
      regexResults: [
        { field: 'circuit.row-3.measured_zs_ohm' },
        { field: 'install.postcode', value: 'RG6 6BB' },
      ],
    });
    const raw = (await server.nextMessage) as string;
    const msg = JSON.parse(raw);
    expect(msg.type).toBe('transcript');
    expect(msg.text).toBe('Circuit 3 Zs is 0.62');
    expect(msg.regexResults).toEqual([
      { field: 'circuit.row-3.measured_zs_ohm' },
      { field: 'install.postcode', value: 'RG6 6BB' },
    ]);
  });
});

// MARK: — End-to-end (matcher → tracker → summary → SonnetSession → WS)

describe('end-to-end: text → wire frame with regexResults', () => {
  let server: WS;

  beforeEach(() => {
    localStorage.setItem(TOKEN_KEY, 'fake-jwt-token');
    server = new WS(WS_BASE);
  });

  afterEach(() => {
    WS.clean();
    localStorage.clear();
  });

  it('produces the iOS-canonical wire frame for "Circuit 3 Zs is 0.62"', async () => {
    const job = makeJob();
    const tracker = new FieldSourceTracker();
    tracker.seedFromJob(job);
    const matcher = new TranscriptFieldMatcher();

    const text = 'Circuit 3 Zs is 0.62';
    const normalised = normalise(text);
    const result = matcher.match(normalised, job);
    applyRegexMatchToJob(job, result, tracker);
    const writtenKeys = tracker.consumeTurnWrites();
    const regexResults = buildRegexSummary(writtenKeys, job);

    const session = new SonnetSession({});
    session.connect({
      sessionId: 'test-session',
      jobId: 'job_1',
      certificateType: 'EICR',
      jobState: {},
    });
    await server.connected;
    await server.nextMessage; // drain session_start

    session.sendTranscript(text, { utteranceId: 'u1', regexResults });
    const raw = (await server.nextMessage) as string;
    const msg = JSON.parse(raw);

    expect(msg.type).toBe('transcript');
    expect(msg.text).toBe(text);
    expect(msg.regexResults).toEqual([{ field: 'circuit.row-3.measured_zs_ohm' }]);
  });
});
