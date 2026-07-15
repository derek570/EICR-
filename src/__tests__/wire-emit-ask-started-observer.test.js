/**
 * wire-emit-ask-started-observer.test.js — F7 Item 2. `safeSend` is the SINGLE
 * dialogue-engine send choke point; it fires the ask-emission observer
 * (attached to the WS under ASK_STARTED_OBSERVER by runLiveMode) on a
 * SUCCESSFUL ask_user_started send only, structurally capturing every current
 * AND future engine emission path (enterScriptByName / tryResumePausedScript /
 * tryEnterScriptFromWrites and their nested sends) without enumerating them.
 */

import { jest } from '@jest/globals';
import { safeSend, ASK_STARTED_OBSERVER } from '../extraction/dialogue-engine/helpers/wire-emit.js';

function openWs() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(s) {
      this.sent.push(JSON.parse(s));
    },
  };
}

test('fires the observer with source:dialogue_script on a successful ask_user_started send', () => {
  const ws = openWs();
  const fired = [];
  ws[ASK_STARTED_OBSERVER] = (e) => fired.push(e);
  safeSend(ws, { type: 'ask_user_started', tool_call_id: 'toolu_ds', question: 'q' });
  expect(ws.sent).toHaveLength(1);
  expect(fired).toEqual([{ toolCallId: 'toolu_ds', source: 'dialogue_script' }]);
});

test('does NOT fire the observer for non-ask frames', () => {
  const ws = openWs();
  const fired = [];
  ws[ASK_STARTED_OBSERVER] = (e) => fired.push(e);
  safeSend(ws, { type: 'extraction', result: {} });
  expect(ws.sent).toHaveLength(1);
  expect(fired).toEqual([]);
});

test('does NOT fire the observer when the socket is not OPEN (send skipped)', () => {
  const ws = openWs();
  ws.readyState = 3;
  const fired = [];
  ws[ASK_STARTED_OBSERVER] = (e) => fired.push(e);
  safeSend(ws, { type: 'ask_user_started', tool_call_id: 'toolu_closed' });
  expect(ws.sent).toHaveLength(0);
  expect(fired).toEqual([]);
});

test('a throwing observer never tears down the send', () => {
  const ws = openWs();
  ws[ASK_STARTED_OBSERVER] = () => {
    throw new Error('observer blew up');
  };
  expect(() =>
    safeSend(ws, { type: 'ask_user_started', tool_call_id: 'toolu_throw' })
  ).not.toThrow();
  expect(ws.sent).toHaveLength(1);
});

test('no observer attached → safeSend is a no-op change (still sends)', () => {
  const ws = openWs();
  expect(() => safeSend(ws, { type: 'ask_user_started', tool_call_id: 'x' })).not.toThrow();
  expect(ws.sent).toHaveLength(1);
});
