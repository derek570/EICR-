/**
 * Database operations for EICR-oMatic 3000 (Node.js)
 * Connects to PostgreSQL in production or uses mock data for local development.
 */

import pg from "pg";
import logger from "./logger.js";

const { Pool } = pg;

let pool = null;

// Read DATABASE_URL dynamically (secrets are loaded after module import)
function getDatabaseUrl() {
  return process.env.DATABASE_URL;
}

function usePostgres() {
  const url = getDatabaseUrl();
  return url && url.startsWith("postgres");
}

function getPool() {
  if (!pool && usePostgres()) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      // AWS RDS requires SSL
      ssl: {
        rejectUnauthorized: false,
      },
    });
  }
  return pool;
}

/**
 * Get user by email
 */
export async function getUserByEmail(email) {
  if (!usePostgres()) {
    logger.warn("Database not configured, auth will not work");
    return null;
  }

  const pool = getPool();
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email.toLowerCase()]
    );
    return result.rows[0] || null;
  } catch (error) {
    logger.error("getUserByEmail failed", { error: error.message });
    throw error;
  }
}

/**
 * Get user by ID
 */
export async function getUserById(userId) {
  if (!usePostgres()) {
    return null;
  }

  const pool = getPool();
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [userId]
    );
    return result.rows[0] || null;
  } catch (error) {
    logger.error("getUserById failed", { error: error.message });
    throw error;
  }
}

/**
 * Update last login and clear lockout
 */
export async function updateLastLogin(userId) {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(
      `UPDATE users SET last_login = $1, failed_login_attempts = 0, locked_until = NULL WHERE id = $2`,
      [new Date().toISOString(), userId]
    );
  } catch (error) {
    logger.error("updateLastLogin failed", { error: error.message });
  }
}

/**
 * Update failed login attempts
 */
export async function updateLoginAttempts(userId, attempts, lockedUntil) {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(
      `UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3`,
      [attempts, lockedUntil, userId]
    );
  } catch (error) {
    logger.error("updateLoginAttempts failed", { error: error.message });
  }
}

/**
 * Log an action to audit log
 */
export async function logAction(userId, action, details = {}, ipAddress = null) {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    const id = `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await pool.query(
      `INSERT INTO audit_log (id, user_id, action, details, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, action, JSON.stringify(details), ipAddress, new Date().toISOString()]
    );
  } catch (error) {
    logger.error("logAction failed", { error: error.message });
  }
}

/**
 * Get all jobs for a user from S3-based storage
 * Jobs are stored as S3 prefixes, not in the database for now
 */
export async function getJobsByUser(userId) {
  if (!usePostgres()) {
    return [];
  }

  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT * FROM jobs WHERE user_id = $1 ORDER BY COALESCE(updated_at, created_at::TIMESTAMP) DESC`,
      [userId]
    );
    return result.rows;
  } catch (error) {
    logger.error("getJobsByUser failed", { error: error.message });
    return [];
  }
}

/**
 * Create a job record
 */
export async function createJob(job) {
  if (!usePostgres()) return job;

  const pool = getPool();
  try {
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO jobs (id, user_id, folder_name, certificate_type, status, address, client_name, created_at, updated_at, s3_prefix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [job.id, job.user_id, job.folder_name, job.certificate_type || 'EICR',
       job.status || 'pending', job.address, job.client_name, now, now, job.s3_prefix]
    );
    return job;
  } catch (error) {
    logger.error("createJob failed", { error: error.message });
    throw error;
  }
}

/**
 * Get a single job by ID
 */
export async function getJob(jobId) {
  if (!usePostgres()) {
    return null;
  }

  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT * FROM jobs WHERE id = $1`,
      [jobId]
    );
    return result.rows[0] || null;
  } catch (error) {
    logger.error("getJob failed", { error: error.message });
    throw error;
  }
}

/**
 * Get a job by address/folder name for a specific user
 */
export async function getJobByAddress(userId, address) {
  if (!usePostgres()) {
    return null;
  }

  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT * FROM jobs WHERE user_id = $1 AND (address = $2 OR folder_name = $2)`,
      [userId, address]
    );
    return result.rows[0] || null;
  } catch (error) {
    logger.error("getJobByAddress failed", { error: error.message });
    throw error;
  }
}

/**
 * Update job fields
 */
export async function updateJob(jobId, data) {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    // Always set updated_at on any update
    if (!data.updated_at) {
      data.updated_at = new Date().toISOString();
    }

    const updates = [];
    const params = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(data)) {
      updates.push(`${key} = $${paramIndex}`);
      params.push(value);
      paramIndex++;
    }

    if (updates.length === 0) return;

    params.push(jobId);
    await pool.query(
      `UPDATE jobs SET ${updates.join(", ")} WHERE id = $${paramIndex}`,
      params
    );
  } catch (error) {
    logger.error("updateJob failed", { error: error.message });
  }
}

/**
 * Update job status
 */
export async function updateJobStatus(jobId, userId, status, address = null) {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    const updates = ["status = $1"];
    const params = [status];
    let paramIndex = 2;

    if (address) {
      updates.push(`address = $${paramIndex}`);
      params.push(address);
      paramIndex++;
    }

    if (status === "done") {
      updates.push(`completed_at = $${paramIndex}`);
      params.push(new Date().toISOString());
      paramIndex++;
    }

    // Always update updated_at on status change
    updates.push(`updated_at = $${paramIndex}`);
    params.push(new Date().toISOString());
    paramIndex++;

    params.push(jobId, userId);
    await pool.query(
      `UPDATE jobs SET ${updates.join(", ")} WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}`,
      params
    );
  } catch (error) {
    logger.error("updateJobStatus failed", { error: error.message });
  }
}

/**
 * Delete a job
 */
export async function deleteJob(jobId, userId) {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(
      `DELETE FROM jobs WHERE id = $1 AND user_id = $2`,
      [jobId, userId]
    );
    logger.info("Job deleted from database", { jobId, userId });
  } catch (error) {
    logger.error("deleteJob failed", { error: error.message });
    throw error;
  }
}

/**
 * Ensure jobs table has updated_at column and backfill from created_at
 */
export async function ensureJobsUpdatedAt() {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    // Check if column exists and what type it is
    const colCheck = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'jobs' AND column_name = 'updated_at'
    `);

    if (colCheck.rows.length === 0) {
      // Column doesn't exist — add as TIMESTAMP to match created_at
      await pool.query(`ALTER TABLE jobs ADD COLUMN updated_at TIMESTAMP`);
      logger.info("ensureJobsUpdatedAt: added updated_at column as TIMESTAMP");
    } else if (colCheck.rows[0].data_type === 'text') {
      // Column exists as TEXT — migrate to TIMESTAMP
      await pool.query(`ALTER TABLE jobs ALTER COLUMN updated_at TYPE TIMESTAMP USING updated_at::TIMESTAMP`);
      logger.info("ensureJobsUpdatedAt: migrated updated_at from TEXT to TIMESTAMP");
    }

    // Backfill NULLs from created_at so existing jobs keep their original timestamp
    await pool.query(`UPDATE jobs SET updated_at = created_at::TIMESTAMP WHERE updated_at IS NULL`);
    logger.info("ensureJobsUpdatedAt: NULLs backfilled");
  } catch (error) {
    logger.error("ensureJobsUpdatedAt failed", { error: error.message });
  }
}

/**
 * Ensure push_subscriptions table exists
 */
export async function ensurePushSubscriptionsTable() {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, endpoint)
      )
    `);
  } catch (error) {
    logger.error("ensurePushSubscriptionsTable failed", { error: error.message });
  }
}

/**
 * Save (upsert) a push subscription for a user
 */
export async function savePushSubscription(userId, subscription) {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, endpoint)
       DO UPDATE SET p256dh = $3, auth = $4, created_at = NOW()`,
      [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
    );
  } catch (error) {
    logger.error("savePushSubscription failed", { error: error.message });
    throw error;
  }
}

/**
 * Get all push subscriptions for a user
 */
export async function getPushSubscriptions(userId) {
  if (!usePostgres()) return [];

  const pool = getPool();
  try {
    const result = await pool.query(
      "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1",
      [userId]
    );
    return result.rows;
  } catch (error) {
    logger.error("getPushSubscriptions failed", { error: error.message });
    throw error;
  }
}

/**
 * Delete a push subscription by user and endpoint
 */
export async function deletePushSubscription(userId, endpoint) {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(
      "DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2",
      [userId, endpoint]
    );
  } catch (error) {
    logger.error("deletePushSubscription failed", { error: error.message });
    throw error;
  }
}

/**
 * Ensure job_versions table exists
 */
export async function ensureJobVersionsTable() {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS job_versions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        changes_summary TEXT,
        data_snapshot JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(job_id, version_number)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_job_versions_job ON job_versions(job_id)`);
  } catch (error) {
    logger.error("ensureJobVersionsTable failed", { error: error.message });
  }
}

/**
 * Save a version snapshot of job data
 */
export async function saveJobVersion(jobId, userId, dataSnapshot, changesSummary) {
  if (!usePostgres()) return null;

  const pool = getPool();
  try {
    const id = `ver_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const result = await pool.query(
      `INSERT INTO job_versions (id, job_id, user_id, version_number, changes_summary, data_snapshot)
       VALUES ($1, $2, $3,
         (SELECT COALESCE(MAX(version_number), 0) + 1 FROM job_versions WHERE job_id = $2),
         $4, $5)
       RETURNING version_number`,
      [id, jobId, userId, changesSummary, JSON.stringify(dataSnapshot)]
    );
    const versionNumber = result.rows[0].version_number;
    return { id, versionNumber };
  } catch (error) {
    logger.error("saveJobVersion failed", { error: error.message });
    return null;
  }
}

/**
 * Get all versions for a job (metadata only, no snapshots)
 */
export async function getJobVersions(jobId) {
  if (!usePostgres()) return [];

  const pool = getPool();
  try {
    const result = await pool.query(
      "SELECT id, version_number, user_id, changes_summary, created_at FROM job_versions WHERE job_id = $1 ORDER BY version_number DESC",
      [jobId]
    );
    return result.rows;
  } catch (error) {
    logger.error("getJobVersions failed", { error: error.message });
    return [];
  }
}

/**
 * Get a specific version with full data snapshot
 */
export async function getJobVersion(versionId, jobId, userId) {
  if (!usePostgres()) return null;

  const pool = getPool();
  try {
    const result = await pool.query(
      "SELECT * FROM job_versions WHERE id = $1 AND job_id = $2 AND user_id = $3",
      [versionId, jobId, userId]
    );
    return result.rows[0] || null;
  } catch (error) {
    logger.error("getJobVersion failed", { error: error.message });
    return null;
  }
}

// ============= CRM: Clients & Properties =============

/**
 * Ensure clients and properties tables exist
 */
export async function ensureCRMTables() {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        company TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS properties (
        id TEXT PRIMARY KEY,
        client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
        user_id TEXT NOT NULL,
        address TEXT NOT NULL,
        postcode TEXT,
        property_type TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_properties_user ON properties(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_properties_client ON properties(client_id)`);

    logger.info("CRM tables ensured");
  } catch (error) {
    logger.error("ensureCRMTables failed", { error: error.message });
  }
}

/**
 * Get all clients for a user
 */
export async function getClients(userId) {
  if (!usePostgres()) return [];

  const pool = getPool();
  try {
    const result = await pool.query(
      "SELECT * FROM clients WHERE user_id = $1 ORDER BY name ASC",
      [userId]
    );
    return result.rows;
  } catch (error) {
    logger.error("getClients failed", { error: error.message });
    return [];
  }
}

/**
 * Create a client
 */
export async function createClient(client) {
  if (!usePostgres()) return client;

  const pool = getPool();
  try {
    const id = client.id || `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await pool.query(
      `INSERT INTO clients (id, user_id, name, email, phone, company, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, client.user_id, client.name, client.email || null, client.phone || null,
       client.company || null, client.notes || null]
    );
    return { ...client, id };
  } catch (error) {
    logger.error("createClient failed", { error: error.message });
    throw error;
  }
}

/**
 * Update a client
 */
export async function updateClient(clientId, data) {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    const updates = [];
    const params = [];
    let paramIndex = 1;

    const allowedFields = ["name", "email", "phone", "company", "notes"];
    for (const [key, value] of Object.entries(data)) {
      if (allowedFields.includes(key)) {
        updates.push(`${key} = $${paramIndex}`);
        params.push(value);
        paramIndex++;
      }
    }

    if (updates.length === 0) return;

    updates.push(`updated_at = $${paramIndex}`);
    params.push(new Date().toISOString());
    paramIndex++;

    params.push(clientId);
    await pool.query(
      `UPDATE clients SET ${updates.join(", ")} WHERE id = $${paramIndex}`,
      params
    );
  } catch (error) {
    logger.error("updateClient failed", { error: error.message });
    throw error;
  }
}

/**
 * Delete a client (with ownership check)
 */
export async function deleteClient(clientId, userId) {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(
      "DELETE FROM clients WHERE id = $1 AND user_id = $2",
      [clientId, userId]
    );
    logger.info("Client deleted", { clientId, userId });
  } catch (error) {
    logger.error("deleteClient failed", { error: error.message });
    throw error;
  }
}

/**
 * Get all properties for a user
 */
export async function getProperties(userId) {
  if (!usePostgres()) return [];

  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT p.*, c.name as client_name
       FROM properties p
       LEFT JOIN clients c ON p.client_id = c.id
       WHERE p.user_id = $1
       ORDER BY p.address ASC`,
      [userId]
    );
    return result.rows;
  } catch (error) {
    logger.error("getProperties failed", { error: error.message });
    return [];
  }
}

/**
 * Create a property
 */
export async function createProperty(property) {
  if (!usePostgres()) return property;

  const pool = getPool();
  try {
    const id = property.id || `prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await pool.query(
      `INSERT INTO properties (id, client_id, user_id, address, postcode, property_type, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, property.client_id || null, property.user_id, property.address,
       property.postcode || null, property.property_type || null, property.notes || null]
    );
    return { ...property, id };
  } catch (error) {
    logger.error("createProperty failed", { error: error.message });
    throw error;
  }
}

/**
 * Get properties linked to a specific client
 */
export async function getPropertiesByClient(clientId) {
  if (!usePostgres()) return [];

  const pool = getPool();
  try {
    const result = await pool.query(
      "SELECT * FROM properties WHERE client_id = $1 ORDER BY address ASC",
      [clientId]
    );
    return result.rows;
  } catch (error) {
    logger.error("getPropertiesByClient failed", { error: error.message });
    return [];
  }
}

/**
 * Get a property by address for a specific user
 */
export async function getPropertyByAddress(userId, address) {
  if (!usePostgres()) return null;

  const pool = getPool();
  try {
    const result = await pool.query(
      "SELECT * FROM properties WHERE user_id = $1 AND address = $2",
      [userId, address]
    );
    return result.rows[0] || null;
  } catch (error) {
    logger.error("getPropertyByAddress failed", { error: error.message });
    return null;
  }
}

/**
 * Get a single client by ID
 */
export async function getClient(clientId) {
  if (!usePostgres()) return null;

  const pool = getPool();
  try {
    const result = await pool.query(
      "SELECT * FROM clients WHERE id = $1",
      [clientId]
    );
    return result.rows[0] || null;
  } catch (error) {
    logger.error("getClient failed", { error: error.message });
    return null;
  }
}

// ============= Billing / Subscriptions =============

/**
 * Ensure subscriptions table exists
 */
export async function ensureSubscriptionsTable() {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        stripe_price_id TEXT,
        plan TEXT DEFAULT 'free',
        status TEXT DEFAULT 'inactive',
        current_period_start TIMESTAMP,
        current_period_end TIMESTAMP,
        cancel_at_period_end BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id)`);
    logger.info("Subscriptions table ensured");
  } catch (error) {
    logger.error("ensureSubscriptionsTable failed", { error: error.message });
  }
}

/**
 * Get subscription for a user
 */
export async function getSubscription(userId) {
  if (!usePostgres()) return null;

  const pool = getPool();
  try {
    const result = await pool.query(
      "SELECT * FROM subscriptions WHERE user_id = $1",
      [userId]
    );
    return result.rows[0] || null;
  } catch (error) {
    logger.error("getSubscription failed", { error: error.message });
    return null;
  }
}

/**
 * Get subscription by Stripe customer ID
 */
export async function getSubscriptionByCustomerId(stripeCustomerId) {
  if (!usePostgres()) return null;

  const pool = getPool();
  try {
    const result = await pool.query(
      "SELECT * FROM subscriptions WHERE stripe_customer_id = $1",
      [stripeCustomerId]
    );
    return result.rows[0] || null;
  } catch (error) {
    logger.error("getSubscriptionByCustomerId failed", { error: error.message });
    return null;
  }
}

/**
 * Upsert subscription data for a user
 */
export async function upsertSubscription(userId, data) {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan, status, current_period_start, current_period_end, cancel_at_period_end, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET
         stripe_customer_id = COALESCE($2, subscriptions.stripe_customer_id),
         stripe_subscription_id = COALESCE($3, subscriptions.stripe_subscription_id),
         stripe_price_id = COALESCE($4, subscriptions.stripe_price_id),
         plan = COALESCE($5, subscriptions.plan),
         status = COALESCE($6, subscriptions.status),
         current_period_start = COALESCE($7, subscriptions.current_period_start),
         current_period_end = COALESCE($8, subscriptions.current_period_end),
         cancel_at_period_end = COALESCE($9, subscriptions.cancel_at_period_end),
         updated_at = NOW()`,
      [
        userId,
        data.stripe_customer_id || null,
        data.stripe_subscription_id || null,
        data.stripe_price_id || null,
        data.plan || null,
        data.status || null,
        data.current_period_start || null,
        data.current_period_end || null,
        data.cancel_at_period_end ?? null,
      ]
    );
    logger.info("Subscription upserted", { userId, plan: data.plan, status: data.status });
  } catch (error) {
    logger.error("upsertSubscription failed", { error: error.message });
    throw error;
  }
}

// ============= Calendar Tokens =============

/**
 * Ensure calendar_tokens table exists for storing Google OAuth refresh tokens
 */
export async function ensureCalendarTokensTable() {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS calendar_tokens (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        access_token TEXT,
        refresh_token TEXT,
        expiry_date BIGINT,
        token_type TEXT,
        scope TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_calendar_tokens_user ON calendar_tokens(user_id)`);
    logger.info("Calendar tokens table ensured");
  } catch (error) {
    logger.error("ensureCalendarTokensTable failed", { error: error.message });
  }
}

/**
 * Save (upsert) Google Calendar OAuth tokens for a user
 */
export async function saveCalendarTokens(userId, tokens) {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO calendar_tokens (user_id, access_token, refresh_token, expiry_date, token_type, scope)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id)
       DO UPDATE SET
         access_token = COALESCE($2, calendar_tokens.access_token),
         refresh_token = COALESCE($3, calendar_tokens.refresh_token),
         expiry_date = COALESCE($4, calendar_tokens.expiry_date),
         token_type = COALESCE($5, calendar_tokens.token_type),
         scope = COALESCE($6, calendar_tokens.scope),
         updated_at = NOW()`,
      [
        userId,
        tokens.access_token || null,
        tokens.refresh_token || null,
        tokens.expiry_date || null,
        tokens.token_type || null,
        tokens.scope || null,
      ]
    );
    logger.info("Calendar tokens saved", { userId });
  } catch (error) {
    logger.error("saveCalendarTokens failed", { error: error.message });
    throw error;
  }
}

/**
 * Get stored Google Calendar tokens for a user
 */
export async function getCalendarTokens(userId) {
  if (!usePostgres()) return null;

  const pool = getPool();
  try {
    const result = await pool.query(
      "SELECT access_token, refresh_token, expiry_date, token_type, scope FROM calendar_tokens WHERE user_id = $1",
      [userId]
    );
    if (!result.rows[0]) return null;

    const row = result.rows[0];
    return {
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      expiry_date: row.expiry_date ? Number(row.expiry_date) : undefined,
      token_type: row.token_type,
      scope: row.scope,
    };
  } catch (error) {
    logger.error("getCalendarTokens failed", { error: error.message });
    return null;
  }
}

/**
 * Delete stored Google Calendar tokens for a user (disconnect)
 */
export async function deleteCalendarTokens(userId) {
  if (!usePostgres()) return;

  const pool = getPool();
  try {
    await pool.query(
      "DELETE FROM calendar_tokens WHERE user_id = $1",
      [userId]
    );
    logger.info("Calendar tokens deleted", { userId });
  } catch (error) {
    logger.error("deleteCalendarTokens failed", { error: error.message });
    throw error;
  }
}

// ============= Analytics =============

/**
 * Get job statistics for a user
 */
export async function getJobStats(userId) {
  if (!usePostgres()) {
    return { total: 0, completed: 0, processing: 0, failed: 0, eicr_count: 0, eic_count: 0 };
  }

  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'done') AS completed,
         COUNT(*) FILTER (WHERE status = 'processing' OR status = 'pending') AS processing,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed,
         COUNT(*) FILTER (WHERE UPPER(certificate_type) = 'EICR' OR certificate_type IS NULL) AS eicr_count,
         COUNT(*) FILTER (WHERE UPPER(certificate_type) = 'EIC') AS eic_count
       FROM jobs WHERE user_id = $1`,
      [userId]
    );
    const row = result.rows[0];
    return {
      total: Number(row.total),
      completed: Number(row.completed),
      processing: Number(row.processing),
      failed: Number(row.failed),
      eicr_count: Number(row.eicr_count),
      eic_count: Number(row.eic_count),
    };
  } catch (error) {
    logger.error("getJobStats failed", { error: error.message });
    return { total: 0, completed: 0, processing: 0, failed: 0, eicr_count: 0, eic_count: 0 };
  }
}

/**
 * Get jobs per week for the last N weeks
 */
export async function getJobsPerWeek(userId, weeks = 12) {
  if (!usePostgres()) {
    return [];
  }

  // Clamp weeks to a safe integer range
  const safeWeeks = Math.max(1, Math.min(Math.floor(Number(weeks)), 52));

  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT
         DATE_TRUNC('week', created_at) AS week_start,
         COUNT(*) AS job_count
       FROM jobs
       WHERE user_id = $1
         AND created_at >= NOW() - ($2 || ' weeks')::interval
       GROUP BY week_start
       ORDER BY week_start ASC`,
      [userId, String(safeWeeks)]
    );
    return result.rows.map(row => ({
      week_start: row.week_start,
      job_count: Number(row.job_count),
    }));
  } catch (error) {
    logger.error("getJobsPerWeek failed", { error: error.message });
    return [];
  }
}

/**
 * Get processing time statistics for completed jobs
 */
export async function getProcessingTimes(userId) {
  if (!usePostgres()) {
    return { avg_minutes: 0, min_minutes: 0, max_minutes: 0 };
  }

  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT
         ROUND(AVG(EXTRACT(EPOCH FROM (completed_at::timestamp - created_at::timestamp)) / 60)::numeric, 1) AS avg_minutes,
         ROUND(MIN(EXTRACT(EPOCH FROM (completed_at::timestamp - created_at::timestamp)) / 60)::numeric, 1) AS min_minutes,
         ROUND(MAX(EXTRACT(EPOCH FROM (completed_at::timestamp - created_at::timestamp)) / 60)::numeric, 1) AS max_minutes
       FROM jobs
       WHERE user_id = $1
         AND status = 'done'
         AND completed_at IS NOT NULL
         AND created_at IS NOT NULL`,
      [userId]
    );
    const row = result.rows[0];
    return {
      avg_minutes: row.avg_minutes ? Number(row.avg_minutes) : 0,
      min_minutes: row.min_minutes ? Number(row.min_minutes) : 0,
      max_minutes: row.max_minutes ? Number(row.max_minutes) : 0,
    };
  } catch (error) {
    logger.error("getProcessingTimes failed", { error: error.message });
    return { avg_minutes: 0, min_minutes: 0, max_minutes: 0 };
  }
}

/**
 * Run a raw SQL query (used by admin endpoints for health checks and stats)
 */
export async function query(text, params) {
  if (!usePostgres()) {
    throw new Error("Database not configured");
  }

  const pool = getPool();
  return pool.query(text, params);
}

export { usePostgres };
