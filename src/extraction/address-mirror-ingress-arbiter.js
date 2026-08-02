/**
 * Short transcript-first hold for a durable address-mirror answer pair.
 *
 * The client sends both a transcript and ask_user_answered. After a process
 * restart the in-memory ask registry is gone, so an unannotated "yes" can
 * otherwise reach extraction before the exact server-owned answer frame. The
 * arbiter stores only the opaque utterance id (never address/question text),
 * bounds memory, and releases unchanged when the paired frame does not arrive.
 */

export const ADDRESS_MIRROR_ANSWER_GRACE_MS = 400;
export const ADDRESS_MIRROR_ANSWER_HOLD_CAP = 16;
const RELEASE_RESERVATION_MS = 15_000;

export function createAddressMirrorIngressArbiter({
  graceMs = ADDRESS_MIRROR_ANSWER_GRACE_MS,
  cap = ADDRESS_MIRROR_ANSWER_HOLD_CAP,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const holds = new Map();
  const released = new Map();

  function pruneReleased(now = Date.now()) {
    for (const [utteranceId, expiry] of released) {
      if (expiry > now) break;
      released.delete(utteranceId);
    }
  }

  function settle(utteranceId, disposition) {
    const hold = holds.get(utteranceId);
    if (!hold) return false;
    holds.delete(utteranceId);
    clearTimer(hold.timer);
    if (disposition === 'released') {
      pruneReleased();
      released.set(utteranceId, Date.now() + RELEASE_RESERVATION_MS);
      while (released.size > cap) released.delete(released.keys().next().value);
    }
    hold.resolve(disposition);
    return true;
  }

  function hold(utteranceId) {
    if (typeof utteranceId !== 'string' || !utteranceId) {
      return Promise.resolve('released');
    }
    // The first arrival owns release to extraction. A duplicate with the
    // same server/client utterance identity is consumed immediately.
    if (holds.has(utteranceId)) return Promise.resolve('consumed');

    while (holds.size >= cap) {
      const oldest = holds.keys().next().value;
      settle(oldest, 'released');
    }

    return new Promise((resolve) => {
      const timer = setTimer(() => settle(utteranceId, 'released'), graceMs);
      holds.set(utteranceId, { resolve, timer });
    });
  }

  function consume(utteranceId) {
    return settle(utteranceId, 'consumed');
  }

  function clear() {
    for (const utteranceId of [...holds.keys()]) settle(utteranceId, 'consumed');
    released.clear();
  }

  function wasReleased(utteranceId) {
    pruneReleased();
    return typeof utteranceId === 'string' && released.has(utteranceId);
  }

  return {
    hold,
    consume,
    clear,
    wasReleased,
    get size() {
      return holds.size;
    },
  };
}
