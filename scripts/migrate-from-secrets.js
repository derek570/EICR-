#!/usr/bin/env node
/**
 * Apply pending node-pg-migrate migrations to the production RDS.
 *
 * Designed to run as a one-off Fargate task during the CI/CD deploy step:
 * the task uses the SAME backend image we are about to ship, so the
 * migrations[] applied here are exactly the ones the new code expects.
 *
 * Why this exists: prior to 2026-05-29 the deploy pipeline had no
 * migration step. Migration 010_account_consents (compliance/consent
 * tables) and 011_cert_attestations (per-PDF audit trail) sat un-applied
 * in production for weeks — they were authored alongside the route code
 * in commit 02e13380 but `npm run migrate:up` was never run against
 * eicr-db-production. The iOS "Issue certificate" sheet surfaced this as
 * `failed to record attestations` (500 from /api/cert-attestations/accept,
 * because the underlying table did not exist). The matching consent
 * endpoint was also failing silently (caught + warned, no user-visible
 * surface). Wiring this step into deploy.yml closes that gap.
 *
 * Reads DB creds from AWS Secrets Manager (eicr/database) the same way
 * the backend does at runtime — see src/services/secrets.js — so the
 * IAM perms and credential location are identical to normal backend
 * operation. SSL is required by the RDS pg_hba.conf; node-pg-migrate
 * goes through the `pg` driver, so we pass sslmode=no-verify on the
 * connection string (RDS uses a CA bundle Amazon controls; we trust it
 * by virtue of running inside the VPC).
 *
 * Exit code 0 = all pending migrations applied (or none pending).
 * Exit code != 0 = migration failure; CI will block the service update.
 */
import { execSync } from 'node:child_process';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const region = process.env.AWS_REGION || 'eu-west-2';
const secretId = process.env.DB_SECRET_ID || 'eicr/database';

const client = new SecretsManagerClient({ region });
const resp = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
if (!resp.SecretString) {
  console.error(`[migrate] secret ${secretId} returned no SecretString`);
  process.exit(1);
}
const db = JSON.parse(resp.SecretString);
for (const k of ['host', 'username', 'password', 'database']) {
  if (!db[k]) {
    console.error(`[migrate] secret ${secretId} missing field: ${k}`);
    process.exit(1);
  }
}

const port = db.port || 5432;
const databaseUrl = `postgresql://${db.username}:${encodeURIComponent(db.password)}@${db.host}:${port}/${db.database}?sslmode=no-verify`;

console.log(`[migrate] applying pending migrations against ${db.host}:${port}/${db.database}`);

try {
  execSync('npx --no-install node-pg-migrate up --migrations-dir ./migrations', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'no-verify' },
  });
} catch (err) {
  console.error(`[migrate] node-pg-migrate exited with status ${err.status ?? 'unknown'}`);
  process.exit(err.status || 1);
}

console.log('[migrate] done');
