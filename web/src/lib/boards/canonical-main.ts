/**
 * A2-multiboard (2026-07-28) scope item 5 — the CANONICAL-MAIN ATTRIBUTION
 * rule. Web's half of the one rule backend, web and iOS all state identically.
 *
 * Backend twin: `findCanonicalMainBoard` / `resolveCanonicalMainBoardId` /
 * `DEFAULT_MAIN_BOARD_ID` in `src/extraction/stage6-multi-board-shape.js`.
 * Hand-mirrored, not imported — web cannot import from `src/`. Keep the two in
 * step; the symptom of drift is the client attributing a board-scoped write to
 * a different record than the server addressed it to.
 *
 * The question this answers is "which board record IS the main board?", and
 * the answer is NEVER "whichever one happens to be first in the array". Web
 * lets the inspector REORDER boards (`moveActive` on the Board tab), so array
 * index 0 is a UI-ordering artefact, not an identity. Deriving the single-board
 * `board_info` summary from index 0 meant a reordered `[sub, main]` job wrote
 * the SUB-board's fields into the field every `board_info` consumer reads as
 * "the board" — the Overview hero strip, the backend's own single-board
 * ingest, and the PDF.
 *
 * Rule, in order:
 *   1. Keep only USABLE entries — objects carrying a truthy `id`. An id-less
 *      record cannot be an attribution target: nothing can address a write to
 *      it.
 *   2. The FIRST usable entry whose `board_type` is absent or `'main'`
 *      (absent = legacy rows written before the field existed).
 *   3. Otherwise `null` — never the first sub-board, never a parent-pointer
 *      walk.
 */

/**
 * The id the BACKEND synthesises for a snapshot that arrived with no
 * `boards[]` at all (`DEFAULT_MAIN_BOARD_ID` in
 * `src/extraction/stage6-multi-board-shape.js`). Web has no board named this —
 * it is the server's name for "the only board" on a legacy flat job.
 */
export const BACKEND_DEFAULT_MAIN_BOARD_ID = 'main';

/** The minimum shape attribution needs. Every board-ish row on web satisfies it. */
export type MainBoardCandidate = {
  id?: unknown;
  board_type?: unknown;
};

/**
 * The main-board RECORD, or `null` when no entry qualifies.
 *
 * Returns the caller's own object (not a copy) so callers can spread it into a
 * summary without a second lookup.
 */
export function findCanonicalMainBoard<T extends MainBoardCandidate>(
  boards: readonly T[] | null | undefined
): T | null {
  if (!Array.isArray(boards)) return null;
  for (const b of boards) {
    if (!b || typeof b !== 'object') continue;
    if (!b.id) continue;
    if (!b.board_type || b.board_type === 'main') return b;
  }
  return null;
}

/**
 * The id half of {@link findCanonicalMainBoard}. Falls back to the backend's
 * synthesised default identity rather than to any other board, so an
 * unattributable board list resolves to the SAME id on client and server.
 */
export function resolveCanonicalMainBoardId(
  boards: readonly MainBoardCandidate[] | null | undefined
): string {
  const main = findCanonicalMainBoard(boards);
  return typeof main?.id === 'string' && main.id ? main.id : BACKEND_DEFAULT_MAIN_BOARD_ID;
}
