/**
 * Stripe Billing integration for CertMate
 * Handles customer creation, checkout sessions, subscriptions, and webhooks.
 */

import Stripe from "stripe";
import logger from "./logger.js";

let stripe = null;

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
      apiVersion: "2024-12-18.acacia",
    });
    logger.info("Stripe initialized successfully");
  } catch (err) {
    logger.error("Failed to initialise Stripe", { error: err.message });
  }
} else {
  logger.info("Stripe not configured — billing features disabled");
}

/**
 * Create a Stripe customer for a user
 */
export async function createCustomer(userId, email, name) {
  if (!stripe) throw new Error("Stripe not configured");

  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { userId },
  });

  logger.info("Stripe customer created", { userId, customerId: customer.id });
  return customer;
}

/**
 * Create a Checkout Session for subscription purchase
 */
export async function createCheckoutSession(customerId, priceId, successUrl, cancelUrl) {
  if (!stripe) throw new Error("Stripe not configured");

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
  });

  logger.info("Checkout session created", { customerId, sessionId: session.id });
  return session;
}

/**
 * Retrieve a subscription by ID
 */
export async function getSubscription(subscriptionId) {
  if (!stripe) throw new Error("Stripe not configured");

  return stripe.subscriptions.retrieve(subscriptionId);
}

/**
 * Record metered usage on a subscription item
 */
export async function recordUsage(subscriptionItemId, quantity) {
  if (!stripe) throw new Error("Stripe not configured");

  const record = await stripe.subscriptionItems.createUsageRecord(
    subscriptionItemId,
    {
      quantity,
      timestamp: Math.floor(Date.now() / 1000),
      action: "increment",
    }
  );

  logger.info("Usage recorded", { subscriptionItemId, quantity });
  return record;
}

/**
 * Verify and construct a webhook event from the raw body + Stripe signature
 */
export function constructWebhookEvent(body, signature) {
  if (!stripe) throw new Error("Stripe not configured");

  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!endpointSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET not set");
  }

  return stripe.webhooks.constructEvent(body, signature, endpointSecret);
}

/**
 * Create a Customer Portal session so users can manage their subscription
 */
export async function createPortalSession(customerId, returnUrl) {
  if (!stripe) throw new Error("Stripe not configured");

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  logger.info("Portal session created", { customerId, sessionId: session.id });
  return session;
}
