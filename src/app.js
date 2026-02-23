/**
 * Express application setup for EICR-oMatic 3000 Backend.
 * Configures middleware only. Routes are registered by api.js.
 * Does NOT call listen() — that's in server.js.
 */

import "dotenv/config";
import * as Sentry from "@sentry/node";

// Initialize Sentry error tracking (no-op if SENTRY_DSN is empty)
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
  });
}

import express from "express";
import cors from "cors";
import helmet from "helmet";
import hpp from "hpp";
import { getAllSecrets } from "./services/secrets.js";
import logger from "./logger.js";
import {
  ensurePushSubscriptionsTable, ensureJobsUpdatedAt,
  ensureSubscriptionsTable, ensureCalendarTokensTable,
} from "./db.js";
import { ensureJobVersionsTable, ensureCRMTables } from "./db.js";

// Load secrets from AWS Secrets Manager into process.env at startup
async function loadSecrets() {
  if (process.env.USE_AWS_SECRETS?.toLowerCase() === 'true') {
    logger.info("Loading secrets from AWS Secrets Manager...");
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

// Ensure DB tables exist and backfill
await ensureJobsUpdatedAt();
await ensurePushSubscriptionsTable();
await ensureJobVersionsTable();
await ensureCRMTables();
await ensureSubscriptionsTable();
await ensureCalendarTokensTable();

const app = express();

// Trust the ALB proxy so express-rate-limit sees real client IPs
app.set('trust proxy', 1);

// CORS for React frontend
app.use(cors({
  origin: process.env.FRONTEND_URL || ["http://localhost:3001", "https://certomatic3000.co.uk"],
  credentials: true,
}));

// Security middleware — skip Helmet CSP for optimizer report pages (they use inline styles/scripts)
app.use((req, res, next) => {
  if (req.path.match(/^\/api\/optimizer-report\/[0-9a-f-]+$/i)) {
    return helmet({ contentSecurityPolicy: false })(req, res, next);
  }
  return helmet()(req, res, next);
});
app.use(hpp());

export default app;
