/**
 * Dialogue engine — public API.
 *
 * Exports both the new unified `processDialogueTurn` and a pair of
 * thin wrappers that match the legacy `processRingContinuityTurn` /
 * `processInsulationResistanceTurn` signatures. The wrappers let
 * sonnet-stream.js's call sites stay unchanged in PR1 — the
 * engine takes over without a wire-protocol or call-site refactor.
 *
 * In a future PR we can collapse the two wrapper calls into a single
 * `processDialogueTurn(...)` call at the dispatch site, but PR1's
 * goal is the engine extraction itself with byte-identical behaviour.
 */

import { processDialogueTurn } from './engine.js';
import { ringContinuitySchema } from './schemas/ring-continuity.js';
import { insulationResistanceSchema } from './schemas/insulation-resistance.js';
import { ocpdSchema } from './schemas/ocpd.js';
import { rcdSchema } from './schemas/rcd.js';
import { rcboSchema } from './schemas/rcbo.js';

export { processDialogueTurn };
export { ringContinuitySchema, insulationResistanceSchema, ocpdSchema, rcdSchema, rcboSchema };

/**
 * Drop-in replacement for the legacy `processRingContinuityTurn`.
 * Runs ONE schema (ring continuity) — keeps the per-domain semantics
 * intact, so the existing topic-switch / mutual-exclusion contract
 * with the IR script (whichever the caller invokes second) holds.
 */
export function processRingContinuityTurn(ctx) {
  return processDialogueTurn({ ...ctx, schemas: [ringContinuitySchema] });
}

/**
 * Drop-in replacement for the legacy `processInsulationResistanceTurn`.
 */
export function processInsulationResistanceTurn(ctx) {
  return processDialogueTurn({ ...ctx, schemas: [insulationResistanceSchema] });
}

/**
 * Protective-device family wrapper. Runs RCBO + OCPD + RCD as a
 * single registry — RCBO is listed first so its specific trigger
 * ("RCBO") wins over OCPD's broader "MCB|breaker|OCPD" trigger
 * when both could match. The schemas pivot among each other via the
 * BS-EN-61009 derivation: enter via OCPD, fill bs_en=61009, pivot
 * to RCBO. The engine reads the schemas list to find the pivot
 * target.
 */
export function processProtectiveDeviceTurn(ctx) {
  return processDialogueTurn({
    ...ctx,
    schemas: [rcboSchema, ocpdSchema, rcdSchema],
  });
}
