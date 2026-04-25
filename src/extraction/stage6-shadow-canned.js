/**
 * Stage 6 shadow-mode canned SSE events — the deterministic input the
 * shadow-mode harness (stage6-shadow-harness.js) feeds `createAssembler()`
 * on every shadow-mode turn during Phase 1, so the stream-assembler branch
 * is exercised end-to-end from the production seam.
 *
 * WHY this lives under src/extraction/ (not __tests__/fixtures/): the
 * harness loads this at runtime in production whenever SONNET_TOOL_CALLS=
 * shadow. An earlier version of this module read the test fixture via
 * `fs.readFileSync('src/__tests__/fixtures/stage6-sse/shadow-canned-
 * interleaved.json')` — any Docker build layer that excluded __tests__/
 * (a standard image-slim optimisation) would silently disable the shadow-
 * mode divergence payload on every turn while still returning success.
 * Codex's Phase-1 STG review flagged this (MAJOR @ harness:54). Moving
 * the events into a runtime module eliminates the fragility entirely —
 * if the module is missing, Node's import would throw at service start
 * rather than silently soft-failing per turn.
 *
 * WHY a frozen `export const` (not JSON): production loads this via a
 * single top-level `import`, which Node validates at process start. No
 * per-turn fs cost, no load-failure code path, no test/prod drift. The
 * tests also import from here so there is exactly one source of truth
 * for what the harness replays.
 *
 * WHY these specific events: two interleaved tool_use blocks (indexes 0
 * and 1) at content_block_delta level — exactly the pattern the assembler
 * is designed to handle per STT-02. content_block_stop arrives in reverse
 * order (index 1 before index 0) to exercise finalize()'s index-ascending
 * sort. Values (circuit 1 / 0.43 ohm and circuit 2 / 0.51 ohm) are
 * deterministic so divergence logs are stable in observation.
 *
 * Phase 2+ replaces `runAssemblerReplay()` in the harness with a real
 * capture of Anthropic's streamed tool_use events — at that point this
 * module can either be deleted or kept as a regression smoke fixture for
 * the assembler.
 */
export const SHADOW_CANNED_EVENTS = Object.freeze([
  {
    type: 'message_start',
    message: {
      id: 'msg_shadow_canned_01',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-6',
      stop_reason: null,
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'tool_use',
      id: 'toolu_shadow01',
      name: 'record_reading',
      input: {},
    },
  },
  {
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'tool_use',
      id: 'toolu_shadow02',
      name: 'record_reading',
      input: {},
    },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"field":"measured_zs_ohm",',
    },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"field":"measured_zs_ohm",',
    },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json:
        '"circuit":1,"value":"0.43","confidence":0.95,"source_turn_id":"shadow-t1"}',
    },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: {
      type: 'input_json_delta',
      partial_json:
        '"circuit":2,"value":"0.51","confidence":0.92,"source_turn_id":"shadow-t1"}',
    },
  },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  { type: 'message_stop' },
]);
