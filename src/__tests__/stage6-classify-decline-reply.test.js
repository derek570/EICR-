/**
 * P4 (ask-decline-ack-net) — classifyDeclineReply conservatism (Codex r1).
 *
 * The classifier ONLY selects which ack FAMILY the answered-ask net speaks
 * (decline "No problem, moving on." vs generic "Okay."); it must NEVER classify
 * a substantive reply (one carrying a value, a circuit ref, or other content)
 * as a decline. The original substring/leading-"no" matcher mis-classified
 * "No, it was 0.63" / "No CPC on that circuit" / "Don't worry, it is circuit
 * three" — this pins the whole-reply-anchored, digit-guarded rewrite.
 */

import { classifyDeclineReply } from '../extraction/stage6-dispatcher-ask.js';

describe('classifyDeclineReply — genuine declines classify', () => {
  const declines = [
    "No. Don't worry.", // the feedback-85 repro (internal full stop)
    'No',
    'no.',
    'Nope',
    'nah',
    'No thanks',
    "Don't worry",
    'dont worry about it',
    'Leave it',
    'leave that',
    'skip it',
    'Skip that.',
    'never mind',
    'nevermind',
    'forget it',
    'No problem',
    "Don't bother",
    'No, leave it', // bare-negation + allowlisted phrase
    'No — never mind.',
    // Codex mini-review NIT — bounded politeness + curly apostrophe + "about that"
    'Please leave it.',
    'Just leave it.',
    'No, leave it thanks.',
    "Don't worry about that.",
    'Don’t worry.', // curly apostrophe
    'Leave it, thanks',
  ];
  for (const reply of declines) {
    test(`"${reply}" → decline`, () => {
      expect(classifyDeclineReply(reply)).toBe('decline');
    });
  }
});

describe('classifyDeclineReply — substantive replies do NOT classify as decline (generic ack)', () => {
  const nonDeclines = [
    'No, it was 0.63', // a value correction — must NOT be decline
    'No CPC on that circuit', // a substantive observation-shaped answer
    "Don't worry, it is circuit three", // decline phrase + substantive content
    '0.55', // a bare value
    'circuit three', // a scope answer
    'measured zed s', // a field answer
    'It is a TN-C-S system', // substantive
    'no its 5', // digit present
    'leave it at 0.4', // decline phrase but carries a value
  ];
  for (const reply of nonDeclines) {
    test(`"${reply}" → null (generic)`, () => {
      expect(classifyDeclineReply(reply)).toBeNull();
    });
  }

  test('non-string / empty inputs → null', () => {
    expect(classifyDeclineReply(null)).toBeNull();
    expect(classifyDeclineReply(undefined)).toBeNull();
    expect(classifyDeclineReply('')).toBeNull();
    expect(classifyDeclineReply('   ')).toBeNull();
  });
});
