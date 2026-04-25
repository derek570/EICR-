/**
 * Tests for src/extraction/stage6-stream-assembler.js — Stage 6 agentic
 * extraction streaming-event reducer (STD-01, STT-02).
 *
 * The assembler is a pure in-memory reducer that turns Anthropic Messages-API
 * streaming events (parsed event objects, not the raw SSE wire format) into
 * completed tool-call records. Every test drives the assembler with a
 * pre-recorded fixture from src/__tests__/fixtures/stage6-sse/ — no SDK, no
 * network, deterministic.
 *
 * Coverage per Phase 1 Plan 01-03 behaviour block:
 *  - single tool_use block reconstructs correctly (name, id, parsed input)
 *  - two interleaved concurrent tool_use blocks both reconstruct (THE STT-02
 *    assertion — keyed by event.index, NOT tool_use.id)
 *  - text + tool_use in the same response: text is ignored, tool call emitted
 *  - malformed final JSON -> error record with raw_partial; does not throw
 *  - end_turn with no tool_use -> 0 records, stop_reason captured
 *  - 3 sequential tool_use blocks -> 3 records in index-ascending order
 *  - orphan content_block_delta (no preceding content_block_start) -> logged
 *    and recorded as error; does not throw; valid siblings still complete
 *  - empty partial_json deltas (Anthropic's first-delta-empty pattern) do
 *    NOT corrupt string accumulation
 *  - handle() returns null mid-stream, returns the finalized object on
 *    message_stop; content_block_start placeholder input:{} is ignored
 */

import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAssembler } from '../extraction/stage6-stream-assembler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures', 'stage6-sse');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
}

function runFixture(name, opts = {}) {
  const asm = createAssembler(opts);
  let lastReturn = null;
  for (const ev of loadFixture(name)) {
    lastReturn = asm.handle(ev);
  }
  return { asm, lastReturn };
}

describe('stage6-stream-assembler', () => {
  describe('single block', () => {
    it('reconstructs a single tool_use block with parsed input', () => {
      const { asm } = runFixture('single-block.json');
      const { records, stop_reason } = asm.finalize();
      expect(records).toHaveLength(1);
      expect(records[0].name).toBe('record_reading');
      expect(records[0].tool_call_id).toBe('toolu_01single');
      expect(records[0].index).toBe(0);
      expect(records[0].error).toBeUndefined();
      expect(records[0].input).toEqual({
        field: 'measured_zs_ohm',
        circuit: 1,
        value: '0.43',
        confidence: 0.95,
        source_turn_id: 't-1',
      });
      expect(stop_reason).toBe('tool_use');
    });
  });

  describe('interleaved concurrent blocks (STT-02 core)', () => {
    it('reconstructs two interleaved tool_use blocks keyed by index', () => {
      const { asm } = runFixture('interleaved-blocks.json');
      const { records, stop_reason } = asm.finalize();
      expect(records).toHaveLength(2);
      // Returned in index-ascending order regardless of content_block_stop order
      expect(records[0].index).toBe(0);
      expect(records[1].index).toBe(1);

      expect(records[0].name).toBe('record_reading');
      expect(records[0].tool_call_id).toBe('toolu_01reading');
      expect(records[0].input).toEqual({
        field: 'measured_zs_ohm',
        circuit: 2,
        value: '0.87',
        confidence: 0.9,
        source_turn_id: 't-inter',
      });

      expect(records[1].name).toBe('record_observation');
      expect(records[1].tool_call_id).toBe('toolu_01observation');
      // Schema-valid record_observation shape per
      // src/extraction/stage6-tool-schemas.js §recordObservation:
      // required [code, location, text]; optional [circuit, suggested_regulation].
      // NO description or source_turn_id on this tool (those are record_reading
      // fields). strict:true on the API would reject either at the model call.
      expect(records[1].input).toEqual({
        code: 'C2',
        location: 'Main distribution board',
        text: 'Missing RCD protection on socket-outlet circuit',
        circuit: 3,
        suggested_regulation: '411.3.3',
      });

      expect(stop_reason).toBe('tool_use');
    });
  });

  describe('text + tool_use in one response', () => {
    it('ignores text block, emits only tool-call records', () => {
      const { asm } = runFixture('text-plus-tool.json');
      const { records } = asm.finalize();
      expect(records).toHaveLength(1);
      expect(records[0].name).toBe('record_reading');
      expect(records[0].input.circuit).toBe(3);
      // Text content must not leak into tool input
      expect(JSON.stringify(records[0].input)).not.toContain("I'll record");
    });
  });

  describe('malformed JSON at content_block_stop', () => {
    it('emits an error record with raw_partial and does not throw', () => {
      const run = () => runFixture('malformed-json.json');
      expect(run).not.toThrow();
      const { asm } = run();
      const { records } = asm.finalize();
      expect(records).toHaveLength(1);
      expect(records[0].error).toBe('invalid_json');
      expect(records[0].raw_partial).toBe('{"field":"measured_zs_ohm","circuit":');
      expect(records[0].name).toBe('record_reading');
      expect(records[0].tool_call_id).toBe('toolu_01malformed');
    });
  });

  describe('end_turn with no tool_use', () => {
    it('returns empty tool-call array with stop_reason end_turn', () => {
      const { asm } = runFixture('end-turn.json');
      const { records, stop_reason } = asm.finalize();
      expect(records).toHaveLength(0);
      expect(stop_reason).toBe('end_turn');
    });
  });

  describe('multiple (3) tool_use blocks', () => {
    it('returns 3 records in index-ascending order', () => {
      const { asm } = runFixture('multiple-tools.json');
      const { records } = asm.finalize();
      expect(records).toHaveLength(3);
      expect(records.map((r) => r.index)).toEqual([1, 2, 3]);
      expect(records.map((r) => r.input.circuit)).toEqual([1, 2, 3]);
    });
  });

  describe('out-of-order / orphan delta', () => {
    it('records orphan as error, logs warn, and processes valid siblings', () => {
      const warn = jest.fn();
      const logger = { warn, info: jest.fn(), error: jest.fn() };
      const asm = createAssembler({ logger });
      for (const ev of loadFixture('out-of-order-delta.json')) {
        expect(() => asm.handle(ev)).not.toThrow();
      }
      const { records } = asm.finalize();

      // Valid block at index 0 must still complete cleanly
      const valid = records.find((r) => r.index === 0);
      expect(valid).toBeDefined();
      expect(valid.error).toBeUndefined();
      expect(valid.name).toBe('record_reading');
      expect(valid.input.circuit).toBe(4);

      // Orphan at index 5 is captured as an error record for observability
      const orphan = records.find((r) => r.index === 5);
      expect(orphan).toBeDefined();
      expect(orphan.error).toBe('orphan_delta');
      expect(orphan.raw_partial).toBe('{"stray":"orphan"}');

      // Logger.warn was called exactly once with the orphan index
      expect(warn).toHaveBeenCalledTimes(1);
      const [msg, meta] = warn.mock.calls[0];
      expect(msg).toBe('stage6.assembler.orphan_delta');
      expect(meta.index).toBe(5);
    });
  });

  describe('empty partial_json deltas (Anthropic first-delta pattern)', () => {
    it('does not corrupt accumulation when partial_json is empty string', () => {
      const { asm } = runFixture('empty-delta.json');
      const { records } = asm.finalize();
      expect(records).toHaveLength(1);
      expect(records[0].error).toBeUndefined();
      expect(records[0].name).toBe('record_reading');
      expect(records[0].tool_call_id).toBe('toolu_empty');
      expect(records[0].input).toEqual({
        field: 'measured_zs_ohm',
        circuit: 1,
        value: '0.43',
        confidence: 0.95,
        source_turn_id: 't-empty',
      });
    });
  });

  describe('streaming invariants', () => {
    it('handle() returns null mid-stream and the finalized object on message_stop', () => {
      const asm = createAssembler();
      const events = loadFixture('single-block.json');
      const returns = events.map((ev) => asm.handle(ev));

      // Every return BEFORE message_stop must be null.
      const messageStopIdx = events.findIndex((e) => e.type === 'message_stop');
      for (let i = 0; i < messageStopIdx; i++) {
        expect(returns[i]).toBeNull();
      }

      // message_stop returns the finalize() object.
      const finalReturn = returns[messageStopIdx];
      expect(finalReturn).not.toBeNull();
      expect(Array.isArray(finalReturn.records)).toBe(true);
      expect(finalReturn.records).toHaveLength(1);
      expect(finalReturn.stop_reason).toBe('tool_use');
    });

    it('finalize() flushes still-open blocks as incomplete_stream error records (Codex STG BLOCK — no orphan tool_use_ids)', () => {
      // Simulate a truncated stream: two tool_use blocks open, one completes
      // via content_block_stop, the other never does (network drop, provider
      // abort, etc.). Without the finalize()-flush, the second block's
      // tool_call_id would vanish from records, and the tool-loop's next
      // round would push assistant(tool_use=id_B) -> user([]) because there
      // is no tool_result pairing id_B. Anthropic rejects that with a 400.
      const log = { warn: jest.fn() };
      const asm = createAssembler({ logger: log });
      asm.handle({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null } });
      asm.handle({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_A', name: 'record_reading', input: {} } });
      asm.handle({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_B', name: 'record_reading', input: {} } });
      asm.handle({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"field":"measured_zs_ohm","circuit":1,"value":"0.43","confidence":0.95,"source_turn_id":"t"}' } });
      asm.handle({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"field":"measured_zs_ohm","circuit":2,' } }); // truncated mid-JSON
      asm.handle({ type: 'content_block_stop', index: 0 });
      // NO content_block_stop for index 1 — simulates mid-stream truncation.
      const { records, stop_reason } = asm.finalize();

      expect(records).toHaveLength(2);
      // Index 0 finished cleanly.
      expect(records[0].index).toBe(0);
      expect(records[0].tool_call_id).toBe('toolu_A');
      expect(records[0].input).toEqual({ field: 'measured_zs_ohm', circuit: 1, value: '0.43', confidence: 0.95, source_turn_id: 't' });
      expect(records[0].error).toBeUndefined();
      // Index 1 was flushed as an incomplete_stream error record with its
      // real tool_call_id preserved so the loop can emit a synthetic
      // tool_result keyed to toolu_B.
      expect(records[1].index).toBe(1);
      expect(records[1].tool_call_id).toBe('toolu_B');
      expect(records[1].name).toBe('record_reading');
      expect(records[1].error).toBe('incomplete_stream');
      expect(records[1].raw_partial).toBe('{"field":"measured_zs_ohm","circuit":2,');
      // stop_reason remains null — no message_delta ever arrived.
      expect(stop_reason).toBeNull();
    });

    it('finalize() is idempotent when called twice (no double-flush of still-open blocks)', () => {
      // Defensive: the shadow harness pattern is `for (ev of events) asm.handle(ev); asm.finalize()`.
      // If the event stream includes message_stop, handle() internally calls
      // finalize() which flushes open blocks and clears the map. The caller's
      // subsequent finalize() must not re-flush (would produce dupes) and
      // must still return the same records.
      const asm = createAssembler();
      asm.handle({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_X', name: 'record_reading', input: {} } });
      asm.handle({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"partial":' } });
      const first = asm.finalize();
      const second = asm.finalize();
      expect(first.records).toHaveLength(1);
      expect(first.records[0].error).toBe('incomplete_stream');
      expect(second.records).toHaveLength(1);
      expect(second.records[0].tool_call_id).toBe('toolu_X');
    });

    it('ignores content_block_start.input placeholder {}', () => {
      // content_block_start carries input:{} as a typed placeholder. The
      // assembler must NOT read it as the tool's actual input; the real
      // payload arrives via input_json_delta events. Verified by the fact
      // that single-block's final input is populated from deltas — if the
      // placeholder won, input would be {} not the deltas payload.
      const { asm } = runFixture('single-block.json');
      const { records } = asm.finalize();
      expect(records[0].input).not.toEqual({});
      expect(records[0].input.field).toBe('measured_zs_ohm');
    });
  });
});
