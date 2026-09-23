/**
 * PLAN-C3 (feedback-2026-09-17, Decision 5) — acceptance 8's dispatcher half:
 * the POST-ASK rejection.
 *
 * THIS IS THE REJECTION THE PLAN EXISTS FOR. The model asks once with the
 * tool-returned options, the inspector answers, and the answer is off-enum
 * too. On 17 September what happened next was a second rejection and then
 * `""` — the certificate value wiped, in silence. The prompt's new rule is
 * "emit nothing further for that slot", and this notice is what makes that
 * rule safe: the SERVER owns the audible outcome instead.
 *
 * "Post-ask" is a property of the CALL SITE, not of a counter. It can only
 * happen inside the ask dispatcher's resolution of the inspector's own reply,
 * which is why this plan needs no cross-turn rejection history at all.
 *
 * Separate file because the harness suite mocks `createAskDispatcher` at the
 * seam, so this branch is unreachable there. Same pattern, and for the same
 * reason, as `stage6-partial-failure-notices-ask.test.js`.
 */

import { jest } from '@jest/globals';
import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import {
  recordAskRegistration,
  stagePostAskRejection,
  recordRejection,
  mintRejectionRef,
} from '../extraction/stage6-blank-write-notices.js';

// F7 Item 2 step 3b — a null/closed ws fast-fails the initial ask, so a
// resolution-path test needs an OPEN ws to keep it pending.
const OPEN_WS = { readyState: 1, OPEN: 1, send() {} };

const noopLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

const buildSession = () => ({
  sessionId: 'sess-c3-post-ask',
  stateSnapshot: {
    circuits: {
      1: { circuit_designation: 'Cooker', rcd_bs_en: 'BS EN 61008' },
      2: { circuit_designation: 'Sockets' },
      3: { circuit_designation: 'Lights' },
    },
    boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
    currentBoardId: 'main',
  },
});

const enumAsk = (overrides = {}) => ({
  question: "What's the BS number of the RCD?",
  reason: 'missing_context',
  context_field: 'rcd_bs_en',
  context_circuit: 1,
  expected_answer_shape: 'free_text',
  ...overrides,
});

/** Drive a full ask cycle with the two PLAN-C3 hooks wired to a live accumulator. */
async function runAsk({ userText, input = enumAsk(), session = buildSession(), perTurnWrites }) {
  const writes = perTurnWrites ?? createPerTurnWrites();
  const logger = noopLogger();
  const pendingAsks = createPendingAsksRegistry();
  const dispatcher = createAskDispatcher(session, logger, 'turn-1', pendingAsks, OPEN_WS, {
    autoResolveWrite: jest.fn(async () => ({ ok: true, body: { ok: true } })),
    recordAskRegistration: (spec) => recordAskRegistration(session, writes, spec),
    stageEnumRejectionAfterAsk: (spec) => stagePostAskRejection(session, writes, 'turn-1', spec),
  });

  const callPromise = dispatcher({ tool_call_id: 'toolu_ask', name: 'ask_user', input }, {});
  await new Promise((r) => setImmediate(r));
  pendingAsks.resolve('toolu_ask', { answered: true, user_text: userText });
  const env = await callPromise;
  return { env, body: JSON.parse(env.content), writes, logger };
}

const c3Notices = (writes) =>
  writes.mandatoryNotices.filter((n) => n.family === 'enum_rejected_after_ask');

// ───────────────────────────────────────────────────────────────────────────
describe('a rejected ANSWER stages the post-ask refusal', () => {
  test('a did_you_mean verdict stages the notice, covered by the ASK tool_call_id', async () => {
    // Coverage matters: without the ask's own call id the turn would speak the
    // specific refusal AND the generic "I couldn't action that", which
    // contradict each other.
    const { body, writes } = await runAsk({ userText: '61018' });
    expect(body.match_status).toBe('did_you_mean');
    const staged = c3Notices(writes);
    expect(staged).toHaveLength(1);
    expect(staged[0].coveredToolCallIds).toEqual(['toolu_ask']);
    expect(staged[0].route).toBe('enum_rejected_after_ask');
  });

  test('an invalid_value verdict stages it too', async () => {
    const { body, writes } = await runAsk({ userText: '68001' });
    expect(body.match_status).toBe('invalid_value');
    expect(c3Notices(writes)).toHaveLength(1);
  });

  test('the line names the circuit and what the slot STILL holds', async () => {
    const { writes } = await runAsk({ userText: '68001' });
    const [notice] = c3Notices(writes);
    expect(notice.friendly).toContain('on circuit 1');
    expect(notice.friendly).toContain('still BS EN 61008');
  });

  test('the tool result tells the model to stop — no second ask, no blank write', async () => {
    // The prompt carries the same rule, but the model reads this result in the
    // same breath as the rejection, and September 17 is what happens when the
    // instruction is only in the prompt.
    const { body } = await runAsk({ userText: '68001' });
    expect(body.post_ask_rejection_policy).toContain('Do not ask again');
    expect(body.post_ask_rejection_policy).toContain('Never write an empty string');
  });

  test('an ACCEPTED answer stages nothing', async () => {
    const { body, writes } = await runAsk({ userText: 'BS EN 61009' });
    expect(body.match_status).toBe('enum_resolved');
    expect(c3Notices(writes)).toHaveLength(0);
  });

  test('a PLURAL ask names every circuit it covered, not just the first', async () => {
    const { writes } = await runAsk({
      userText: '68001',
      input: enumAsk({ context_circuit: undefined, context_circuits: [2, 3] }),
    });
    const [notice] = c3Notices(writes);
    expect(notice.friendly).toContain('on circuits 2 and 3');
  });

  test('the ask is JOURNALED even when the answer is accepted — the drain needs every ask', async () => {
    const { writes } = await runAsk({ userText: 'BS EN 61009' });
    expect(writes.askRegistrations).toHaveLength(1);
    expect(writes.askRegistrations[0]).toMatchObject({
      toolCallId: 'toolu_ask',
      field: 'rcd_bs_en',
      circuits: [1],
      boardId: 'main',
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('ask LINEAGE — which rejection is this ask about?', () => {
  test('an ECHOED rejection_ref resolves the lineage deterministically', async () => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const ref = mintRejectionRef('turn-1', 'tu_bulk');
    recordRejection(writes, {
      ref,
      field: 'ref_method',
      scopeSet: [1, 2, 3],
      boardId: 'main',
      toolCallId: 'tu_bulk',
      bulkInput: { scope: 'all', spare_policy: null, exclude_circuits: null, board_id: null },
      scope: { selector: 'all', sparePolicy: 'include', excludes: [], resolvedRefs: [1, 2, 3] },
    });
    const stamp = recordAskRegistration(session, writes, {
      toolCallId: 'tu_ask',
      rejectionRef: ref,
      // Deliberately a DIFFERENT circuit set from the rejection's: the echo is
      // the statement of lineage, and it must win over any shape heuristic.
      field: 'ref_method',
      circuits: [9],
      boardId: 'main',
    });
    expect(stamp?.ref).toBe(ref);
    expect(stamp?.scope?.selector).toBe('all');
  });

  test('WITHOUT an echo, only an EXACT scope match stamps — a subset is an ordinary plural ask', async () => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    recordRejection(writes, {
      ref: 'turn-1:tu_bulk',
      field: 'ref_method',
      scopeSet: [1, 2, 3],
      boardId: 'main',
      toolCallId: 'tu_bulk',
      scope: { selector: 'all', sparePolicy: 'include', excludes: [], resolvedRefs: [1, 2, 3] },
    });
    const exact = recordAskRegistration(session, writes, {
      toolCallId: 'tu_a1',
      rejectionRef: null,
      field: 'ref_method',
      circuits: [3, 1, 2],
      boardId: 'main',
    });
    expect(exact?.ref).toBe('turn-1:tu_bulk');

    const subset = recordAskRegistration(session, writes, {
      toolCallId: 'tu_a2',
      rejectionRef: null,
      field: 'ref_method',
      circuits: [1, 2],
      boardId: 'main',
    });
    expect(subset).toBeNull();
  });

  test('a match on the same field but ANOTHER board does not stamp', () => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    recordRejection(writes, {
      ref: 'turn-1:tu_bulk',
      field: 'ref_method',
      scopeSet: [1],
      boardId: 'garage',
      toolCallId: 'tu_bulk',
      scope: { selector: 'all', sparePolicy: 'include', excludes: [], resolvedRefs: [1] },
    });
    expect(
      recordAskRegistration(session, writes, {
        toolCallId: 'tu_a',
        rejectionRef: null,
        field: 'ref_method',
        circuits: [1],
        boardId: 'main',
      })
    ).toBeNull();
  });

  test('a BULK stamp turns the post-ask refusal into ONE scope-keyed line', () => {
    const session = buildSession();
    const writes = createPerTurnWrites();
    const entry = recordRejection(writes, {
      ref: 'turn-1:tu_bulk',
      field: 'ref_method',
      scopeSet: [1, 2, 3],
      boardId: 'main',
      toolCallId: 'tu_bulk',
      scope: { selector: 'all', sparePolicy: 'include', excludes: [], resolvedRefs: [1, 2, 3] },
    });
    stagePostAskRejection(session, writes, 'turn-1', {
      toolCallId: 'tu_ask',
      field: 'ref_method',
      circuits: [1, 2, 3],
      boardId: 'main',
      stamp: entry,
    });
    const [notice] = c3Notices(writes);
    expect(notice.route).toBe('enum_rejected_after_ask_bulk');
    expect(notice.friendly).toContain('all circuits');
    expect(notice.friendly).toContain('unchanged');
    // No held-value claim for a scope: each circuit holds its own value, so
    // "still <x>" would be false for most of it.
    expect(notice.friendly).not.toContain('still');
  });

  test('the bulk refusal and its post-ask twin describe the SAME resolved scope', () => {
    // The stamp carries the stored descriptor components rather than
    // re-resolving them, so the second line about a scope cannot name a
    // different set of circuits from the first.
    const session = buildSession();
    const writes = createPerTurnWrites();
    const scope = {
      selector: 'rcd_protected_only',
      sparePolicy: 'exclude',
      excludes: [4],
      resolvedRefs: [1, 2, 3],
    };
    const entry = recordRejection(writes, {
      ref: 'turn-1:tu_bulk',
      field: 'ref_method',
      scopeSet: [1, 2, 3],
      boardId: 'main',
      toolCallId: 'tu_bulk',
      scope,
    });
    stagePostAskRejection(session, writes, 'turn-1', {
      toolCallId: 'tu_ask',
      field: 'ref_method',
      circuits: [1, 2, 3],
      boardId: 'main',
      stamp: entry,
    });
    const [notice] = c3Notices(writes);
    expect(notice.friendly).toContain('the RCD-protected circuits excluding spares except 4');
    expect(notice.friendly).toContain('1, 2 and 3');
  });

  test('bulkInput is stored VERBATIM so an answer resolver can rebuild a byte-equal write', () => {
    const writes = createPerTurnWrites();
    const bulkInput = {
      scope: 'rcd_protected_only',
      spare_policy: 'exclude',
      exclude_circuits: [4],
      board_id: null,
    };
    const entry = recordRejection(writes, {
      ref: 'turn-1:tu_bulk',
      field: 'ref_method',
      scopeSet: [1],
      boardId: 'main',
      toolCallId: 'tu_bulk',
      bulkInput,
    });
    expect(entry.bulkInput).toEqual(bulkInput);
  });
});
