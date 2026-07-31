/**
 * Session-scoped completion ledger for extraction frames.
 *
 * PLAN-3 adds a supplemental extraction frame after an async observation
 * severity re-code. Both frames carry the originating turn_id. Only the first
 * extraction frame for a turn is allowed to close one ProcessingBadge slot;
 * later frames still flow through the normal apply/TTS path.
 */

const MAX_CLOSED_TURNS = 512;

export interface ExtractionTurnLedger {
  sessionId: string;
  closedTurnIds: Set<string>;
}

export function createExtractionTurnLedger(): ExtractionTurnLedger {
  return { sessionId: '', closedTurnIds: new Set() };
}

export function shouldCloseProcessingTurn(
  ledger: ExtractionTurnLedger,
  sessionId: string,
  turnId: string | null | undefined
): boolean {
  if (ledger.sessionId !== sessionId) {
    ledger.sessionId = sessionId;
    ledger.closedTurnIds.clear();
  }

  // Compatibility with older backend frames: without a stable turn identity,
  // retain the historical one-frame/one-decrement behaviour.
  if (typeof turnId !== 'string' || turnId.length === 0) return true;
  if (ledger.closedTurnIds.has(turnId)) return false;

  ledger.closedTurnIds.add(turnId);
  if (ledger.closedTurnIds.size > MAX_CLOSED_TURNS) {
    const oldest = ledger.closedTurnIds.values().next().value;
    if (typeof oldest === 'string') ledger.closedTurnIds.delete(oldest);
  }
  return true;
}
