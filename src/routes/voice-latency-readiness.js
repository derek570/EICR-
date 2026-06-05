/**
 * Loaded Barrel Phase 1.F readiness probe endpoint (plan v10 §C + §G3).
 *
 * GET /api/voice-latency/loaded-barrel-readiness
 *
 * Returns the per-process adoption snapshot for the iOS Phase 4a
 * `turnId` POST-body field. Used as the gate before flipping the
 * VOICE_LATENCY_LOADED_BARREL flag — the speculator's cache is only
 * useful when iOS POSTs include `turnId` to compute the lookup key.
 *
 * Plan gate G3: ≥80% adoption over the last 1h is the operator's
 * green-light to enable the speculator.
 *
 * Auth: protected by auth.requireAuth so casual public callers can't
 * scrape the per-user activity table. Internal ops + the operator (Derek)
 * authenticate the same way they hit /api/admin endpoints.
 */

import { Router } from 'express';
import * as auth from '../auth.js';
import { getReadinessSnapshot } from '../extraction/loaded-barrel-readiness.js';

const router = Router();

router.get('/voice-latency/loaded-barrel-readiness', auth.requireAuth, (_req, res) => {
  const snapshot = getReadinessSnapshot();
  res.set('Cache-Control', 'no-store');
  res.json(snapshot);
});

export default router;
