/**
 * Validate the board hierarchy on a job snapshot.
 *
 * Phase 2.3 of the multi-board / sub-main support sprint
 * (.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/PLAN.md).
 *
 * Used as a gate inside `PUT /api/job/:userId/:jobId` so that an invalid
 * hierarchy (orphan parent, cycle, multiple main boards, dangling feed
 * reference) cannot be persisted. iOS already enforces these rules at
 * the UI layer, but the cloud sync must enforce them too — a malformed
 * payload from a future client (or a stale offline mutation merging in
 * via the outbox) would otherwise corrupt the snapshot.
 *
 * Codes returned:
 *   parent_not_found     — board.parent_board_id refers to an id not in boards[]
 *   circular_reference   — DFS up the parent chain revisits a board
 *   multiple_main_boards — more than one board has board_type === 'main'
 *                          (a missing/empty board_type is treated as 'main' so
 *                          legacy single-board snapshots stay valid)
 *   feed_circuit_not_found — board.feed_circuit_ref points at a circuit that
 *                            doesn't exist on board.parent_board_id
 *
 * Usage:
 *   const { ok, errors } = validateBoardHierarchy(boards, circuits);
 *   if (!ok) return res.status(400).json({ error: 'invalid_board_hierarchy', details: errors });
 */

export function validateBoardHierarchy(boards = [], circuits = []) {
  const errors = [];

  if (!Array.isArray(boards)) {
    return { ok: true, errors };
  }
  const safeCircuits = Array.isArray(circuits) ? circuits : [];

  const ids = new Set(boards.map((b) => b?.id).filter((id) => typeof id === 'string'));

  // 1. Every parent_board_id resolves to a known board id.
  for (const b of boards) {
    if (b?.parent_board_id && !ids.has(b.parent_board_id)) {
      errors.push({
        code: 'parent_not_found',
        board_id: b.id,
        parent: b.parent_board_id,
      });
    }
  }

  // 2. No cycles. Walk parent chain from each board; bail if we revisit.
  for (const b of boards) {
    if (!b?.id) continue;
    const seen = new Set([b.id]);
    let cur = b.parent_board_id;
    while (cur) {
      if (seen.has(cur)) {
        errors.push({ code: 'circular_reference', board_id: b.id });
        break;
      }
      seen.add(cur);
      const parent = boards.find((x) => x?.id === cur);
      cur = parent?.parent_board_id;
    }
  }

  // 3. At most one main board. A missing board_type counts as 'main' so the
  //    common single-board snapshot (board_type undefined) stays valid.
  const mainCount = boards.filter((b) => !b?.board_type || b.board_type === 'main').length;
  if (mainCount > 1) {
    errors.push({ code: 'multiple_main_boards', count: mainCount });
  }

  // 4. feed_circuit_ref resolves to a circuit on the parent board.
  //
  // Legacy-snapshot fallback: if the parent is the main board (board_type
  // 'main' or unset, mirroring rule #3), accept circuits with no `board_id`
  // as belonging to it. Pre-multi-board snapshots stamped no `board_id` on
  // their circuit buckets; without this clause a sub_main cannot be added
  // to any legacy job because every feed circuit lookup would miss.
  for (const b of boards) {
    if (!b?.feed_circuit_ref || !b?.parent_board_id) continue;
    const parent = boards.find((x) => x?.id === b.parent_board_id);
    const parentIsMain = !parent?.board_type || parent.board_type === 'main';
    const ref = String(b.feed_circuit_ref);
    const match = safeCircuits.find(
      (c) =>
        (c?.board_id === b.parent_board_id || (parentIsMain && c?.board_id == null)) &&
        (String(c?.circuit ?? '') === ref || String(c?.circuit_ref ?? '') === ref)
    );
    if (!match) {
      errors.push({
        code: 'feed_circuit_not_found',
        board_id: b.id,
        parent: b.parent_board_id,
        ref: b.feed_circuit_ref,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}
