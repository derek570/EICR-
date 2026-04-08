/**
 * Sleep log route — accepts POST requests with sleep state transitions
 * (doze/wake/start/stop events) and logs them as structured JSON for CloudWatch.
 *
 * Ported from transcript-standalone /api/sleep-log endpoint.
 */

import { Router } from 'express';
import logger from '../logger.js';

const router = Router();

/**
 * POST /api/sleep-log
 * Body: { event: string, detail?: string, sessionId?: string }
 *
 * Logs sleep detector state transitions (ENTER_DOZING, ENTER_SLEEPING, WAKE,
 * STARTED, STOPPED, etc.) for production monitoring and debugging.
 * No auth required — these are lightweight telemetry events from recording sessions.
 */
router.post('/sleep-log', (req, res) => {
  try {
    const { event, detail, sessionId } = req.body;

    if (!event || typeof event !== 'string') {
      return res.status(400).json({ error: 'event required' });
    }

    logger.info('sleep_event', {
      component: 'sleep',
      event,
      detail: detail || undefined,
      sessionId: sessionId || 'no-session',
    });

    return res.json({ ok: true });
  } catch (err) {
    logger.error('sleep_log_error', { error: err.message });
    return res.status(400).json({ error: 'invalid request' });
  }
});

export default router;
