/**
 * mockStream / mockClient — Jest test helper for Stage 6 streaming-loop tests.
 *
 * Why this helper exists:
 *   - `client.messages.stream({...})` (Anthropic SDK) returns a special object
 *     that is both async-iterable over SSE-parsed events AND exposes a
 *     `.finalMessage()` promise resolving to the accumulated assistant Message.
 *   - Unit tests for `stage6-tool-loop.js` must be fully deterministic and free
 *     of network calls. We replay canned event arrays per loop-round instead.
 *   - Hoisted to src/__tests__/helpers/ because later phases (shadow harness,
 *     dispatcher wiring, iOS protocol) will reuse the same fixture-driven
 *     pattern.
 *
 * Contract:
 *   mockStream(events)  — returns a single stream-shaped object
 *     events: Array<AnthropicStreamEvent>
 *     returns: { [Symbol.asyncIterator](): AsyncIterator, finalMessage(): Promise<Message> }
 *
 *   mockClient(streamResponses) — returns an Anthropic-client-shaped object
 *     streamResponses: Array<Array<AnthropicStreamEvent>>  // one event array per invocation
 *     returns: { messages: { stream(args): MockStream } }
 *     Each call to `client.messages.stream()` consumes the next element of
 *     streamResponses. Running out (more calls than provided arrays) yields an
 *     empty event stream — that is deliberately an error signal in tests, not
 *     a silent success.
 *
 * What `finalMessage()` reconstructs:
 *   An Anthropic Message-like object { role: 'assistant', content, stop_reason }.
 *   The `content` array is rebuilt from the events by replaying
 *   content_block_start / content_block_delta / content_block_stop pairs
 *   per index — tool_use blocks get their `input` parsed from the
 *   concatenated input_json_delta fragments; text blocks get their
 *   concatenated text_delta string. stop_reason comes from message_delta.
 *   This matches what the real SDK synthesises from the same events, which is
 *   what `runToolLoop` pushes onto `messages` to satisfy Anthropic's
 *   tool_use-before-tool_result ordering invariant.
 */

export function mockStream(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
    async finalMessage() {
      const stateByIndex = new Map();
      let stopReason = null;

      for (const ev of events) {
        if (ev.type === 'content_block_start') {
          // Clone to avoid mutating the fixture. Strip the `input: {}` placeholder
          // on tool_use — the real input comes from input_json_delta fragments.
          const cb = { ...ev.content_block };
          stateByIndex.set(ev.index, {
            index: ev.index,
            block: cb,
            partialJson: '',
            text: '',
          });
        } else if (ev.type === 'content_block_delta') {
          const s = stateByIndex.get(ev.index);
          if (!s) continue; // orphan delta — ignored in mock, assembler handles for real
          if (ev.delta?.type === 'input_json_delta') {
            s.partialJson += ev.delta.partial_json ?? '';
          } else if (ev.delta?.type === 'text_delta') {
            s.text += ev.delta.text ?? '';
          }
        } else if (ev.type === 'content_block_stop') {
          const s = stateByIndex.get(ev.index);
          if (!s) continue;
          if (s.block.type === 'tool_use') {
            try {
              s.block.input = JSON.parse(s.partialJson || '{}');
            } catch {
              s.block.input = {};
            }
          } else if (s.block.type === 'text') {
            s.block.text = s.text;
          }
        } else if (ev.type === 'message_delta') {
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        }
      }

      // Emit content in index-ascending order — mirrors the real SDK.
      const content = [...stateByIndex.keys()]
        .sort((a, b) => a - b)
        .map((i) => stateByIndex.get(i).block);

      return { role: 'assistant', content, stop_reason: stopReason };
    },
  };
}

export function mockClient(streamResponses) {
  let callCount = 0;
  return {
    messages: {
      stream(/* args ignored in mock */) {
        const events = streamResponses[callCount] ?? [];
        callCount += 1;
        return mockStream(events);
      },
    },
    // Expose for test assertions: how many times was .stream() called?
    get _callCount() {
      return callCount;
    },
  };
}
