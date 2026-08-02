import { jest } from '@jest/globals';

import {
  ADDRESS_MIRROR_ANSWER_GRACE_MS,
  createAddressMirrorIngressArbiter,
} from '../extraction/address-mirror-ingress-arbiter.js';

describe('address mirror paired-answer ingress arbiter', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('answer frame consumes a transcript-first hold', async () => {
    const arbiter = createAddressMirrorIngressArbiter();
    const held = arbiter.hold('utt-1');
    expect(arbiter.consume('utt-1')).toBe(true);
    await expect(held).resolves.toBe('consumed');
    expect(arbiter.size).toBe(0);
  });

  test('grace expiry releases the original transcript unchanged', async () => {
    const arbiter = createAddressMirrorIngressArbiter();
    const held = arbiter.hold('utt-2');
    jest.advanceTimersByTime(ADDRESS_MIRROR_ANSWER_GRACE_MS);
    await expect(held).resolves.toBe('released');
    expect(arbiter.consume('utt-2')).toBe(false);
    expect(arbiter.wasReleased('utt-2')).toBe(true);
  });

  test('duplicate id is consumed and clear cannot leak a waiter', async () => {
    const arbiter = createAddressMirrorIngressArbiter({ cap: 1 });
    const first = arbiter.hold('utt-3');
    await expect(arbiter.hold('utt-3')).resolves.toBe('consumed');
    arbiter.clear();
    await expect(first).resolves.toBe('consumed');
    expect(arbiter.size).toBe(0);
  });
});
