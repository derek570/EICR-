/**
 * PLAN-B B1 ingress 7 (feedback id 128) — ENDPOINT-LEVEL regressions for the
 * three text-extract egress repairs (Codex pre-merge finding: the shipped
 * coverage pinned the source regexes; these tests drive the real functions
 * against canned provider responses and assert on the RETURNED objects).
 *
 *   - sonnetExtractFromText (src/sonnet_extract.js)  — Anthropic via global fetch
 *   - extractSession        (src/extract_session.js) — Anthropic via global fetch
 *   - extractChunk          (src/extract_chunk.js)   — OpenAI SDK
 *
 * Each provider response carries circuits with dirty designations. Asserted:
 *   1. edge-token designations are repaired in the returned circuits;
 *   2. a banned-token-only designation is preserved UNCHANGED;
 *   3. a circuit WITHOUT a circuit_designation key is passed through with no
 *      key synthesised;
 *   4. the response object's key set is unchanged (repair is value-level —
 *      no wire-shape change).
 *
 * process_job's row repair is covered by designation-hygiene-process-job.test.js.
 */

import { jest } from '@jest/globals';

// Secrets seam — both Anthropic callers resolve their key through this.
jest.unstable_mockModule('../services/secrets.js', () => ({
  getAnthropicKey: jest.fn().mockResolvedValue('test-anthropic-key'),
  getDeepgramKey: jest.fn().mockResolvedValue('test-deepgram-key'),
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  createJobLogger: jest.fn().mockReturnValue({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// OpenAI SDK seam for extractChunk (same pattern as
// stage6-clear-board-reading-session-seam.test.js).
const mockOpenAICreate = jest.fn();
jest.unstable_mockModule('openai', () => ({
  default: class FakeOpenAI {
    constructor() {
      this.chat = { completions: { create: mockOpenAICreate } };
    }
  },
}));

const { sonnetExtractFromText } = await import('../sonnet_extract.js');
const { extractSession } = await import('../extract_session.js');
const { extractChunk } = await import('../extract_chunk.js');

const DIRTY_CIRCUITS = [
  { circuit_ref: '1', circuit_designation: 'Upstairs lighting circuit', measured_zs_ohm: '0.35' },
  { circuit_ref: '2', circuit_designation: 'Circuit' },
  { circuit_ref: '3', measured_zs_ohm: '0.99' }, // no designation key at all
];

function assertRepairedCircuits(circuits) {
  expect(circuits).toHaveLength(3);
  expect(circuits[0].circuit_designation).toBe('Upstairs lighting');
  expect(circuits[0].measured_zs_ohm).toBe('0.35'); // sibling fields untouched
  expect(circuits[1].circuit_designation).toBe('Circuit'); // banned-only UNCHANGED
  expect(circuits[2].measured_zs_ohm).toBe('0.99');
  expect('circuit_designation' in circuits[2]).toBe(false); // no key synthesised
}

/** Build a canned Anthropic /v1/messages response around a JSON payload. */
function anthropicResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    text: async () => '',
  };
}

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

describe('sonnetExtractFromText — egress designation repair (src/sonnet_extract.js)', () => {
  test('repairs dirty designations, preserves banned-only, keeps response keys unchanged', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      anthropicResponse({
        circuits: DIRTY_CIRCUITS,
        supply: { earth_loop_impedance_ze: '0.28' },
        installation: {},
        board: {},
        orphaned_values: [{ value: '0.5', unit: 'ohm' }],
      })
    );

    const result = await sonnetExtractFromText('circuit one upstairs lighting circuit', '');

    assertRepairedCircuits(result.circuits);

    // Response shape unchanged — value-level repair only.
    expect(Object.keys(result).sort()).toEqual([
      'board',
      'circuits',
      'installation',
      'orphaned_values',
      'supply',
      'usage',
    ]);
    expect(result.supply).toEqual({ earth_loop_impedance_ze: '0.28' });
    expect(result.orphaned_values).toEqual([{ value: '0.5', unit: 'ohm' }]);
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
  });
});

describe('extractSession — egress designation repair (src/extract_session.js)', () => {
  test('repairs dirty designations, preserves banned-only, keeps response keys unchanged', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      anthropicResponse({
        circuits: DIRTY_CIRCUITS,
        observations: [{ code: 'C3', observation_text: 'No RCD test button label' }],
        board: { manufacturer: 'Hager' },
        installation: {},
        supply_characteristics: {},
      })
    );

    const result = await extractSession(
      'full transcript of the session mentioning the upstairs lighting circuit'
    );

    assertRepairedCircuits(result.circuits);

    expect(Object.keys(result).sort()).toEqual([
      'board',
      'circuits',
      'installation',
      'observations',
      'supply_characteristics',
      'usage',
    ]);
    expect(result.observations).toEqual([
      { code: 'C3', observation_text: 'No RCD test button label' },
    ]);
    expect(result.board).toEqual({ manufacturer: 'Hager' });
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });
});

describe('extractChunk — egress designation repair (src/extract_chunk.js)', () => {
  test('repairs dirty designations, preserves banned-only, keeps response keys unchanged', async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              circuits: [...DIRTY_CIRCUITS, {}], // trailing empty object is filtered by the endpoint
              observations: [],
              board: {},
              installation: {},
              supply_characteristics: {},
            }),
          },
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });

    const result = await extractChunk('circuit one upstairs lighting circuit zs 0.35', 0, 0);

    assertRepairedCircuits(result.circuits); // empty object filtered → 3 circuits

    expect(Object.keys(result).sort()).toEqual([
      'board',
      'circuits',
      'installation',
      'observations',
      'supply_characteristics',
      'usage',
    ]);
    expect(result.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3 });
  });
});
