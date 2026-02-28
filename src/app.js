/**
 * Express application setup for EICR-oMatic 3000 Backend.
 * Configures middleware only. Routes are registered by api.js.
 * Does NOT call listen() — that's in server.js.
 */

import 'dotenv/config';
import * as Sentry from '@sentry/node';

// Initialize Sentry error tracking (no-op if SENTRY_DSN is empty)
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
  });
}

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';
import { getAllSecrets } from './services/secrets.js';
import { validateEnv } from './env.js';
import logger from './logger.js';

// Load secrets from AWS Secrets Manager into process.env at startup
async function loadSecrets() {
  if (process.env.USE_AWS_SECRETS?.toLowerCase() === 'true') {
    logger.info('Loading secrets from AWS Secrets Manager...');
    const secrets = await getAllSecrets();
    for (const [key, value] of Object.entries(secrets)) {
      if (!process.env[key]) {
        process.env[key] = value;
        logger.info(`Loaded secret: ${key}`);
      }
    }
  }
}

// Initialize secrets before starting
await loadSecrets();

// Validate required environment variables (after secrets are loaded)
validateEnv();

// Schema migrations now handled by node-pg-migrate
// Run: npm run migrate:up (or automatically in deployment pipeline)
// See migrations/ directory for migration files

const app = express();

// Trust exactly 1 proxy hop (AWS ALB). Do NOT set to true -- that trusts
// all X-Forwarded-For hops, allowing client IP spoofing.
app.set('trust proxy', 1);

// CORS — explicit origin allowlist (no wildcard with credentials)
const ALLOWED_ORIGINS = [
  'https://certomatic3000.co.uk',
  'https://www.certomatic3000.co.uk',
  // Add dev origins in non-production environments
  ...(process.env.NODE_ENV !== 'production'
    ? ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002']
    : []),
  // Support comma-separated FRONTEND_URL override
  ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map((u) => u.trim()) : []),
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl, mobile apps)
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn('CORS blocked request from disallowed origin', { origin });
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

// Security middleware — restrictive CSP for optimizer reports (inline styles OK, scripts blocked)
app.use((req, res, next) => {
  if (req.path.match(/^\/api\/optimizer-report\/[0-9a-f-]+$/i)) {
    return helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
    })(req, res, next);
  }
  return helmet()(req, res, next);
});
app.use(hpp());

export default app;
