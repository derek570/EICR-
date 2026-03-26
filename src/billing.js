/**
 * Stripe Billing integration for CertMate
 * Handles customer creation, checkout sessions, subscriptions, and webhooks.
 */

import Stripe from 'stripe';
import logger from './logger.js';

let stripe = null;

// CX-14: Allowlist of valid redirect origins for Stripe checkout/portal URLs
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * CX-14: Validate that a URL belongs to an allowed origin.
 * Throws if the URL is invalid or not in the allowlist.
 */
function validateRedirectUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('Redirect URL is required');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid redirect URL');
  }
  if (ALLOWED_ORIGINS.length === 0) {
    throw new Error('No allowed origins configured — cannot validate redirect URL');
  }
  const isAllowed = ALLOWED_ORIGINS.some((origin) => {
    try {
      return parsed.origin === new URL(origin).origin;
    } catch {
      return false;
    }
  });
  if (!isAllowed) {
    throw new Error('Redirect URL origin not allowed');
  }
}

/**
 * CX-16: Wrap Stripe API errors into sanitized application errors.
 * Logs the full Stripe error details server-side, throws a generic message.
 */
function handleStripeError(operation, err) {
  logger.error(`Stripe ${operation} failed`, {
    type: err.type,
    code: err.code,
    statusCode: err.statusCode,
    message: err.message,
  });
  const sanitized = new Error(`Billing operation failed: ${operation}`);
  sanitized.statusCode = err.statusCode || 500;
  throw sanitized;
}

/**
 * Check if Stripe is configured
 */
export function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Eagerly initialize if key is present
if (process.env.STRIPE_SECRET_KEY) {
  try {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-12-18.acacia',
    });
    logger.info('Stripe initialized successfully');
  } catch (err) {
    logger.error('Failed to initialise Stripe', { error: err.message });
  }
} else {
  logger.info('Stripe not configured — billing features disabled');
}

/**
 * Create a Stripe customer for a user
 */
export async function createCustomer(userId, email, name) {
  if (!stripe) throw new Error('Stripe not configured');

  try {
    // P3: Idempotency key prevents duplicate customers from concurrent requests
    const customer = await stripe.customers.create(
      {
        email,
        name,
        metadata: { userId },
      },
      {
        idempotencyKey: `create-customer-${userId}`,
      }
    );

    logger.info('Stripe customer created', { userId, customerId: customer.id });
    return customer;
  } catch (err) {
    handleStripeError('createCustomer', err);
  }
}

/**
 * Create a Checkout Session for subscription purchase
 */
export async function createCheckoutSession(customerId, priceId, successUrl, cancelUrl) {
  if (!stripe) throw new Error('Stripe not configured');

  // CX-14: Validate redirect URLs against allowed origins
  validateRedirectUrl(successUrl);
  validateRedirectUrl(cancelUrl);

  try {
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
    });

    logger.info('Checkout session created', { customerId, sessionId: session.id });
    return session;
  } catch (err) {
    handleStripeError('createCheckoutSession', err);
  }
}

/**
 * Retrieve a subscription by ID
 */
export async function getSubscription(subscriptionId) {
  if (!stripe) throw new Error('Stripe not configured');

  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    handleStripeError('getSubscription', err);
  }
}

/**
 * Record metered usage on a subscription item
 */
// CX-15: Maximum allowed usage quantity per record
const MAX_USAGE_QUANTITY = 10000;

export async function recordUsage(subscriptionItemId, quantity) {
  if (!stripe) throw new Error('Stripe not configured');

  // CX-15: Validate quantity is a positive safe integer within bounds
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_USAGE_QUANTITY) {
    throw new Error(
      `Invalid usage quantity: must be a positive integer <= ${MAX_USAGE_QUANTITY}, got ${quantity}`
    );
  }

  try {
    const record = await stripe.subscriptionItems.createUsageRecord(subscriptionItemId, {
      quantity,
      timestamp: Math.floor(Date.now() / 1000),
      action: 'increment',
    });

    logger.info('Usage recorded', { subscriptionItemId, quantity });
    return record;
  } catch (err) {
    handleStripeError('recordUsage', err);
  }
}

/**
 * Verify and construct a webhook event from the raw body + Stripe signature
 */
export function constructWebhookEvent(body, signature) {
  if (!stripe) throw new Error('Stripe not configured');

  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!endpointSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET not set');
  }

  return stripe.webhooks.constructEvent(body, signature, endpointSecret);
}

/**
 * Create a Customer Portal session so users can manage their subscription
 */
export async function createPortalSession(customerId, returnUrl) {
  if (!stripe) throw new Error('Stripe not configured');

  // CX-14: Validate return URL against allowed origins
  validateRedirectUrl(returnUrl);

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    logger.info('Portal session created', { customerId, sessionId: session.id });
    return session;
  } catch (err) {
    handleStripeError('createPortalSession', err);
  }
}
