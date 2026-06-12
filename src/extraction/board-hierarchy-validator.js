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
 *                          legacy single-board snapshots stay valid; off_peak
 *                          boards are NOT counted as main — they are siblings
 *                          to the main board, fed independently from the
 *                          supply mains rather than from another board)
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

/**
 * Deterministically repair a board hierarchy instead of rejecting it.
 *
 * 2026-06-12 — job_1778443465217 field incident: the job's `sub-1` board
 * carried `feed_circuit_ref: "2"` pointing at a parent circuit that no
 * longer exists. The PUT gate rejected EVERY save of that job, so the
 * client retried the identical payload every 30 s indefinitely (observed
 * across 2026-06-05 → 2026-06-12) and every subsequent inspector edit was
 * silently lost server-side — a permanently unsyncable job.
 *
 * Architecture decision: hierarchy validity is enforced strictly where the
 * relationship is CREATED interactively (the add_board dispatcher, where
 * the model/user can react to a rejection), but the persistence path must
 * never wedge. The cert data in a PUT is the inspector's ground truth; a
 * dangling relational pointer is repairable metadata. Each violation has a
 * minimal-information-loss repair, applied to a deep copy:
 *
 *   feed_circuit_not_found → clear feed_circuit_ref (parent link kept; the
 *                            feed pointer is re-establishable by voice/UI —
 *                            "circuit 4 feeds the garage CU")
 *   parent_not_found       → clear parent_board_id + feed_circuit_ref (board
 *                            becomes top-level; reattachable later)
 *   circular_reference     → clear parent_board_id + feed_circuit_ref on the
 *                            reported board (breaks the cycle)
 *   multiple_main_boards   → first main (array order) keeps the role; later
 *                            mains demote to 'sub_distribution'. Demotion is
 *                            reversible in the UI; an unsyncable job is not.
 *
 * Every repair strictly REMOVES constraint sources (clears pointers /
 * resolves the main-count), so re-validation converges; the loop is bounded
 * defensively and the caller falls back to rejection if `ok` never becomes
 * true (should be unreachable).
 *
 * @param {Array<Object>} boards
 * @param {Array<Object>} circuits
 * @returns {{ok: boolean, boards: Array<Object>, repairs: Array<Object>}}
 *   `boards` is a repaired deep copy (or the original reference when no
 *   repairs were needed); `repairs` lists {code, board_id, action} entries.
 */
export function repairBoardHierarchy(boards = [], circuits = []) {
  const first = validateBoardHierarchy(boards, circuits);
  if (first.ok) {
    return { ok: true, boards, repairs: [] };
  }

  const repaired = JSON.parse(JSON.stringify(boards));
  const repairs = [];
  const byId = (id) => repaired.find((b) => b?.id === id);

  // Bounded: each pass strictly clears pointers, so two passes cover any
  // cascade (e.g. a cycle reported on several boards); the third is a
  // defensive ceiling.
  for (let pass = 0; pass < 3; pass++) {
    const { ok, errors } = validateBoardHierarchy(repaired, circuits);
    if (ok) {
      return { ok: true, boards: repaired, repairs };
    }
    for (const err of errors) {
      switch (err.code) {
        case 'feed_circuit_not_found': {
          const b = byId(err.board_id);
          if (b && b.feed_circuit_ref != null) {
            b.feed_circuit_ref = null;
            repairs.push({
              code: err.code,
              board_id: err.board_id,
              action: 'cleared_feed_circuit_ref',
              was: err.ref,
            });
          }
          break;
        }
        case 'parent_not_found':
        case 'circular_reference': {
          const b = byId(err.board_id);
          if (b && (b.parent_board_id != null || b.feed_circuit_ref != null)) {
            repairs.push({
              code: err.code,
              board_id: err.board_id,
              action: 'cleared_parent_link',
              was_parent: b.parent_board_id ?? null,
            });
            b.parent_board_id = null;
            b.feed_circuit_ref = null;
          }
          break;
        }
        case 'multiple_main_boards': {
          let keptFirstMain = false;
          for (const b of repaired) {
            const isMainShaped = !b?.board_type || b.board_type === 'main';
            if (!isMainShaped) continue;
            if (!keptFirstMain) {
              keptFirstMain = true;
              continue;
            }
            b.board_type = 'sub_distribution';
            repairs.push({
              code: err.code,
              board_id: b.id ?? null,
              action: 'demoted_to_sub_distribution',
            });
          }
          break;
        }
        default:
          // Unknown future code — no repair known; the caller's fallback
          // rejection path handles it.
          break;
      }
    }
  }

  const final = validateBoardHierarchy(repaired, circuits);
  return { ok: final.ok, boards: repaired, repairs };
}
