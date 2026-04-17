/**
 * API Routes for EICR-oMatic 3000 Backend
 * Route registry — imports, middleware, and app.use() mounts.
 * All route handlers live in src/routes/*.js modules.
 * WebSocket recording server lives in src/ws-recording.js.
 */

import express from 'express';
import fssync from 'node:fs';
import path from 'node:path';
import logger from './logger.js';
import * as storage from './storage.js';
import * as auth from './auth.js';
import * as billing from './billing.js';
import { getSubscriptionByCustomerId, upsertSubscription, query } from './db.js';
import { getDeepgramKey, getAnthropicKey } from './services/secrets.js';
import swaggerUi from 'swagger-ui-express';
import yaml from 'js-yaml';

// Rate limiting middleware
import { aiLimiter, uploadLimiter, emailLimiter, authLimiter } from './middleware/rate-limit.js';

// Error handling middleware
import { notFoundHandler, errorHandler } from './middleware/error-handler.js';

// Route modules (pre-existing)
import authRouter from './routes/auth.js';
import keysRouter from './routes/keys.js';
import settingsRouter from './routes/settings.js';
import pushRouter from './routes/push.js';
import feedbackRouter from './routes/feedback.js';
import billingRouter from './routes/billing.js';
import calendarRouter from './routes/calendar.js';
import clientsRouter from './routes/clients.js';
import analyticsRouter from './routes/analytics.js';
import adminRouter from './admin_api.js';
import adminUsersRouter from './routes/admin-users.js';
import companiesRouter from './routes/companies.js';

// Route modules (decomposed from this file)
import jobsRouter from './routes/jobs.js';
import recordingRouter from './routes/recording.js';
import photosRouter from './routes/photos.js';
import extractionRouter from './routes/extraction.js';
import pdfRouter from './routes/pdf.js';
import emailRouter from './routes/email.js';
import exportRouter from './routes/export.js';
import ocrRouter from './routes/ocr.js';
import sleepLogRouter from './routes/sleep-log.js';
import postcodeRouter from './routes/postcode.js';

// WebSocket recording server (re-exported for server.js)
import { wss } from './ws-recording.js';

// Import app from the Express setup module
import app from './app.js';

// ============= Stripe Webhook (raw body — MUST be before express.json()) =============
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!billing.isConfigured()) {
    return res.status(503).json({ error: 'Billing not configured' });
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing Stripe signature' });
  }

  let event;
  try {
    event = billing.constructWebhookEvent(req.body, signature);
  } catch (err) {
    logger.error('Stripe webhook signature verification failed', { error: err.message });
    return res.status(400).json({ error: `Webhook signature failed: ${err.message}` });
  }

  logger.info('Stripe webhook received', { type: event.type, id: event.id });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        const sub = await getSubscriptionByCustomerId(customerId);
        if (sub) {
          await upsertSubscription(sub.user_id, {
            stripe_subscription_id: subscriptionId,
            status: 'active',
            plan: 'pro',
          });
          logger.info('Checkout completed — subscription activated', {
            userId: sub.user_id,
            subscriptionId,
          });
        }
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const sub = await getSubscriptionByCustomerId(customerId);
        if (sub) {
          const periodEnd = invoice.lines?.data?.[0]?.period?.end;
          await upsertSubscription(sub.user_id, {
            status: 'active',
            current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
          });
          logger.info('Invoice paid — subscription renewed', { userId: sub.user_id });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const sub = await getSubscriptionByCustomerId(customerId);
        if (sub) {
          await upsertSubscription(sub.user_id, {
            status: subscription.status,
            stripe_price_id: subscription.items?.data?.[0]?.price?.id || null,
            current_period_start: subscription.current_period_start
              ? new Date(subscription.current_period_start * 1000).toISOString()
              : null,
            current_period_end: subscription.current_period_end
              ? new Date(subscription.current_period_end * 1000).toISOString()
              : null,
            cancel_at_period_end: subscription.cancel_at_period_end,
          });
          logger.info('Subscription updated', { userId: sub.user_id, status: subscription.status });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const sub = await getSubscriptionByCustomerId(customerId);
        if (sub) {
          await upsertSubscription(sub.user_id, {
            status: 'canceled',
            plan: 'free',
            cancel_at_period_end: false,
          });
          logger.info('Subscription cancelled', { userId: sub.user_id });
        }
        break;
      }

      default:
        logger.info('Unhandled Stripe event type', { type: event.type });
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Stripe webhook handler error', { type: event.type, error: err.message });
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// express.json() MUST come after the Stripe webhook route above (which needs raw body)
app.use(express.json({ limit: '10mb' }));

// ============= Health Checks =============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'eicr-backend',
    version: '1.0.0',
    storage: storage.isUsingS3() ? 's3' : 'local',
    timestamp: new Date().toISOString(),
  });
});

// HISTORY (370e169, 2026-02-23): Added after iOS clients experienced silent connection
// failures when the backend was running but Deepgram/Anthropic keys were unavailable
// (e.g. after a secrets rotation or AWS Secrets Manager access issue). The basic
// /api/health endpoint only checks if Express is responding — it doesn't verify that
// the backend can actually process recordings. This readiness endpoint checks all three
// critical dependencies (database, Deepgram key, Anthropic key) so the iOS app can
// show a meaningful "server not ready" error before starting a recording session,
// and the ALB can route traffic away from degraded instances.
app.get('/api/health/ready', async (req, res) => {
  const checks = { database: false, deepgram_key: false, anthropic_key: false };

  try {
    await query('SELECT 1');
    checks.database = true;
  } catch (err) {
    logger.warn('Health readiness: DB check failed', { error: err.message });
  }

  try {
    const dgKey = await getDeepgramKey();
    checks.deepgram_key = !!dgKey;
  } catch (err) {
    logger.warn('Health readiness: Deepgram key check failed', { error: err.message });
  }

  try {
    const akKey = await getAnthropicKey();
    checks.anthropic_key = !!akKey;
  } catch (err) {
    logger.warn('Health readiness: Anthropic key check failed', { error: err.message });
  }

  const allOk = Object.values(checks).every(Boolean);
  const status = allOk ? 'ready' : 'degraded';
  res.status(allOk ? 200 : 503).json({ status, checks, timestamp: new Date().toISOString() });
});

// ============= Swagger UI =============
const openapiPath = path.resolve(import.meta.dirname, '..', 'docs', 'api', 'openapi.yaml');
try {
  const openapiContent = fssync.readFileSync(openapiPath, 'utf-8');
  const openapiSpec = yaml.load(openapiContent);
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openapiSpec, {
      customSiteTitle: 'CertMate API Docs',
    })
  );
  logger.info('Swagger UI mounted at /api/docs');
} catch (err) {
  logger.warn('Could not load OpenAPI spec — Swagger UI disabled', { error: err.message });
}

// ============= Mount Route Modules =============

// Admin
app.use('/api/admin', auth.requireAuth, adminRouter);
app.use('/api/admin/users', auth.requireAuth, auth.requireAdmin, adminUsersRouter);
app.use('/api/companies', auth.requireAuth, companiesRouter);

// Pre-existing route modules
app.use('/api/auth', authLimiter, authRouter);
app.use('/api', keysRouter); // /api/proxy/*, /api/config/*
app.use('/api', settingsRouter); // /api/settings/*, /api/inspector-profiles/*, /api/schema/*, /api/regulations
app.use('/api/push', pushRouter); // /api/push/*
app.use('/api', feedbackRouter); // /api/feedback/*, /api/optimizer-report/*
app.use('/api/billing', billingRouter); // /api/billing/* (except webhook which stays here)
app.use('/api/calendar', calendarRouter); // /api/calendar/*
app.use('/api', clientsRouter); // /api/clients/*, /api/properties/*
app.use('/api/analytics', analyticsRouter); // /api/analytics/*

// Decomposed route modules
app.use('/api', jobsRouter); // /api/jobs/*, /api/job/*, /api/upload, /api/process-job, /api/queue/*
app.use('/api', recordingRouter); // /api/recording/*, /api/session/*, /api/debug-report
app.use('/api', uploadLimiter, photosRouter); // /api/job/:userId/:jobId/photos/*
app.use('/api', aiLimiter, extractionRouter); // /api/recording/sonnet-extract, /api/analyze-ccu, /api/enhance-observation
app.use('/api', pdfRouter); // /api/job/:userId/:jobId/generate-pdf
app.use('/api', emailLimiter, emailRouter); // /api/job/:userId/:jobId/email, /api/email/status, /api/whatsapp/*
app.use('/api', exportRouter); // /api/job/:userId/:jobId/export/*
app.use('/api', ocrRouter); // /api/ocr/*
app.use('/api', sleepLogRouter); // /api/sleep-log
app.use('/api', postcodeRouter); // /api/postcode/:postcode

// ============= Error Handling (must be last) =============
app.use(notFoundHandler);
app.use(errorHandler);

export { wss };
export default app;
