import { describe, expect, it } from 'vitest';

import {
  createExtractionTurnLedger,
  shouldCloseProcessingTurn,
} from '@/lib/recording/extraction-turn-ledger';

describe('PLAN-3 extraction turn completion ledger', () => {
  it('does not let a delayed recode frame close a later turn early', () => {
    const ledger = createExtractionTurnLedger();
    expect(shouldCloseProcessingTurn(ledger, 'session-a', 'turn-a')).toBe(true);

    // Turn B is now dispatched and is the one outstanding ProcessingBadge
    // slot when A's delayed supplemental re-code arrives.
    let processingCount = 1;
    if (shouldCloseProcessingTurn(ledger, 'session-a', 'turn-a')) processingCount -= 1;
    expect(processingCount).toBe(1);

    if (shouldCloseProcessingTurn(ledger, 'session-a', 'turn-b')) processingCount -= 1;
    expect(processingCount).toBe(0);
  });

  it('retains closed turns across reconnect ordering but resets for a new recording', () => {
    const ledger = createExtractionTurnLedger();
    expect(shouldCloseProcessingTurn(ledger, 'session-a', 'turn-a')).toBe(true);
    // Reconnect keeps the same client session id.
    expect(shouldCloseProcessingTurn(ledger, 'session-a', 'turn-a')).toBe(false);
    // A stop/start rotates the client session id; reused turn bytes are safe.
    expect(shouldCloseProcessingTurn(ledger, 'session-b', 'turn-a')).toBe(true);
  });

  it('keeps legacy no-turn-id frames on the historical per-frame path', () => {
    const ledger = createExtractionTurnLedger();
    expect(shouldCloseProcessingTurn(ledger, 'session-a', undefined)).toBe(true);
    expect(shouldCloseProcessingTurn(ledger, 'session-a', undefined)).toBe(true);
  });
});
