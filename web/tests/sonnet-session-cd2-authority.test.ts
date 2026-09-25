/**
 * PLAN-CD (CD2, Decision 18) — the unresolved-backend-ask authority as the
 * production decoder maintains it. Frames arrive over a mock socket, so the
 * latch under test is `SonnetSession.handleMessage`'s own. Ids are the
 * fixture's vectors; no prefix or lifetime is written here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WS from 'jest-websocket-mock';
import { createRequire } from 'node:module';
import { SonnetSession } from '@/lib/recording/sonnet-session';

const require = createRequire(import.meta.url);
const fixture = require('../../config/ask-class-lifetimes-v1.json') as {
  vectors: Array<{ id: string; tool_call_id: string }>;
};
const vectorId = (id: string) => fixture.vectors.find((v) => v.id === id)!.tool_call_id;

const SONNET_URL = 'ws://localhost:3000/api/sonnet-stream';

describe('SonnetSession — CD2 unresolved-ask authority', () => {
  let server: WS;

  beforeEach(() => {
    localStorage.setItem('cm_token', 'fake-jwt-token');
    server = new WS(SONNET_URL);
  });

  afterEach(() => {
    WS.clean();
    localStorage.clear();
  });

  async function connected(): Promise<SonnetSession> {
    const session = new SonnetSession({});
    session.connect({ sessionId: 'cd2', jobId: 'job-cd2', certificateType: 'EICR' });
    await server.connected;
    return session;
  }
  const ask = async (frame: Record<string, unknown>) => {
    server.send(JSON.stringify({ type: 'ask_user_started', question: 'Which one?', ...frame }));
    await Promise.resolve();
  };

  it('latches an interactive ask and never an expected_answer_shape "none" acknowledgement', async () => {
    const session = await connected();
    await ask({ tool_call_id: vectorId('script_srv_rcs_slot'), expected_answer_shape: 'none' });
    expect(session.hasUnresolvedBackendAsk()).toBe(false);
    await ask({ tool_call_id: vectorId('live_openai_call'), expected_answer_shape: 'free_text' });
    expect(session.hasUnresolvedBackendAsk()).toBe(true);
  });

  it('latches even when the question is empty — the backend registered the ask either way', async () => {
    const session = await connected();
    await ask({ tool_call_id: vectorId('broker_mdr'), question: '' });
    expect(session.hasUnresolvedBackendAsk()).toBe(true);
    // The attribution latch keeps its own rule (it never arms on an empty question).
    expect(session.peekInFlightToolCallId()).toBeNull();
  });

  it('reading the authority consumes nothing, and a second ask never drops the first', async () => {
    const session = await connected();
    const first = vectorId('live_openai_call');
    const second = vectorId('broker_pvr');
    await ask({ tool_call_id: first });
    await ask({ tool_call_id: second });
    expect(session.hasUnresolvedBackendAsk()).toBe(true);
    expect(session.hasUnresolvedBackendAsk()).toBe(true);
    expect(session.peekInFlightToolCallId()).toBe(second);
    // Answering the newer ask leaves the older one live.
    session.consumeInFlightToolCallId(second);
    expect(session.hasUnresolvedBackendAsk()).toBe(true);
    session.sendAskUserAnswered(first, 'the kitchen');
    expect(session.hasUnresolvedBackendAsk()).toBe(false);
  });

  it('an id the client already answered never re-arms on a re-emitted ask_user_started', async () => {
    const session = await connected();
    const id = vectorId('live_openai_call');
    await ask({ tool_call_id: id });
    expect(session.consumeInFlightToolCallId(id)).toBe(id);
    await ask({ tool_call_id: id });
    expect(session.hasUnresolvedBackendAsk()).toBe(false);
  });

  it('clears by cancellation prefix and on session reset', async () => {
    const session = await connected();
    const script = vectorId('script_srv_ocpd_which');
    await ask({ tool_call_id: script });
    session.clearInFlightToolCallIdByPrefix(script.slice(0, script.indexOf('-', 4) + 1));
    expect(session.hasUnresolvedBackendAsk()).toBe(false);
    await ask({ tool_call_id: vectorId('live_openai_call') });
    expect(session.hasUnresolvedBackendAsk()).toBe(true);
    session.disconnect();
    expect(session.hasUnresolvedBackendAsk()).toBe(false);
  });
});
