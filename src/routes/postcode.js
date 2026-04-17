/**
 * Postcode routes — expose postcodes.io lookup to authenticated clients.
 *
 * Why: previously the lookupPostcode() helper was only called server-side during
 * Sonnet extraction, so when a user typed an address manually in the iOS UI
 * (InstallationTab) the town/county fields stayed empty. This endpoint lets the
 * client resolve a UK postcode to town/county so the UI can auto-fill the rest
 * of the address after the user types the postcode.
 */

import { Router } from 'express';
import * as auth from '../auth.js';
import logger from '../logger.js';
import { lookupPostcode } from '../postcode_lookup.js';

const router = Router();

/**
 * Look up a UK postcode.
 * GET /api/postcode/:postcode
 *
 * 200: { success: true, postcode, town, county }
 * 404: { error: 'Postcode not found' }
 * 400: { error: '...' } on invalid input
 */
router.get('/postcode/:postcode', auth.requireAuth, async (req, res) => {
  const raw = req.params.postcode;

  if (!raw || typeof raw !== 'string') {
    return res.status(400).json({ error: 'Missing postcode' });
  }

  // Defensive length cap — UK postcodes are at most 8 chars including space.
  // We also accept the no-space form, so allow up to ~10 chars of slack.
  if (raw.length > 12) {
    return res.status(400).json({ error: 'Postcode too long' });
  }

  try {
    const result = await lookupPostcode(raw);
    if (!result) {
      return res.status(404).json({ error: 'Postcode not found' });
    }
    return res.json({
      success: true,
      postcode: result.postcode,
      town: result.town,
      county: result.county,
    });
  } catch (err) {
    logger.error('Postcode lookup failed', { postcode: raw, error: err.message });
    return res.status(500).json({ error: 'Postcode lookup failed' });
  }
});

export default router;
