/**
 * Legal-text-versions endpoint.
 *
 * Single endpoint that exposes the current version + wording for every
 * piece of in-app legal copy (BTA consent screen + the two per-PDF
 * attestation paragraphs). Clients fetch this on app start and render
 * whatever the server returns; this means wording can be updated
 * without an iOS / web rebuild as long as the version doesn't bump.
 *
 * The endpoint is intentionally unauthenticated so the iOS app can
 * preload the wording on the login screen and the web app's marketing
 * surfaces can reuse the copy if needed. The content is non-secret —
 * it's the same text we publish at certmate.uk/legal/ as long-form.
 */

import { Router } from 'express';
import { currentVersionsBundle } from '../lib/legal-text-versions.js';

const router = Router();

router.get('/text-versions', (req, res) => {
  // Cache hints — the bundle changes only when we ship a new version,
  // which we do via deploy, so a short browser cache is safe. The iOS
  // client manages its own cache lifecycle.
  res.set('Cache-Control', 'public, max-age=300');
  res.json(currentVersionsBundle());
});

export default router;
