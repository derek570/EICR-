/**
 * Billing routes — Stripe webhook, subscription status, checkout, portal
 *
 * NOTE: The Stripe webhook (POST /api/billing/webhook) stays in api.js because
 * it must be registered BEFORE express.json() middleware.
 */

import { Router } from 'express';
import * as auth from '../auth.js';
import * as billing from '../billing.js';
import * as db from '../db.js';
import { getSubscription as getDbSubscription, upsertSubscription } from '../db.js';
import logger from '../logger.js';

const router = Router();

// P2: Validate priceId against allowed list to prevent arbitrary subscription creation
const ALLOWED_PRICE_IDS = (process.env.STRIPE_ALLOWED_PRICE_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

/**
 * Get current user's subscription status
 * GET /api/billing/status
 */
router.get('/status', auth.requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const sub = await getDbSubscription(userId);

    if (!sub) {
      return res.json({
        plan: 'free',
        status: 'inactive',
        billing_configured: billing.isConfigured(),
      });
    }

    res.json({
      plan: sub.plan || 'free',
      status: sub.status || 'inactive',
      stripe_subscription_id: sub.stripe_subscription_id || null,
      current_period_end: sub.current_period_end || null,
      cancel_at_period_end: sub.cancel_at_period_end || false,
      billing_configured: billing.isConfigured(),
    });
  } catch (error) {
    logger.error('Failed to get billing status', { userId: req.user?.id, error: error.message });
    res.status(500).json({ error: 'Failed to get billing status' });
  }
});

/**
 * Create a Stripe Checkout session
 * POST /api/billing/create-checkout
 */
router.post('/create-checkout', auth.requireAuth, async (req, res) => {
  if (!billing.isConfigured()) {
    return res.status(503).json({ error: 'Billing not configured' });
  }

  try {
    const userId = req.user.id;
    const { priceId } = req.body;

    if (!priceId) {
      return res.status(400).json({ error: 'priceId is required' });
    }

    if (ALLOWED_PRICE_IDS.length > 0 && !ALLOWED_PRICE_IDS.includes(priceId)) {
      logger.warn('Rejected checkout with invalid priceId', { userId, priceId });
      return res.status(400).json({ error: 'Invalid price selected' });
    }

    let sub = await getDbSubscription(userId);
    let customerId = sub?.stripe_customer_id;

    if (!customerId) {
      const user = await db.getUserById(userId);
      const customer = await billing.createCustomer(userId, user.email, user.name || user.email);
      customerId = customer.id;

      await upsertSubscription(userId, {
        stripe_customer_id: customerId,
      });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://certomatic3000.co.uk';
    const session = await billing.createCheckoutSession(
      customerId,
      priceId,
      `${frontendUrl}/settings/billing?success=true`,
      `${frontendUrl}/settings/billing?canceled=true`
    );

    res.json({ url: session.url });
  } catch (error) {
    logger.error('Failed to create checkout session', {
      userId: req.user?.id,
      error: error.message,
    });
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * Create a Stripe Customer Portal session
 * POST /api/billing/portal
 */
router.post('/portal', auth.requireAuth, async (req, res) => {
  if (!billing.isConfigured()) {
    return res.status(503).json({ error: 'Billing not configured' });
  }

  try {
    const userId = req.user.id;
    const sub = await getDbSubscription(userId);

    if (!sub?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found. Please subscribe first.' });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://certomatic3000.co.uk';
    const session = await billing.createPortalSession(
      sub.stripe_customer_id,
      `${frontendUrl}/settings/billing`
    );

    res.json({ url: session.url });
  } catch (error) {
    logger.error('Failed to create portal session', { userId: req.user?.id, error: error.message });
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

export default router;
