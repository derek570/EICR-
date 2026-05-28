#!/usr/bin/env node
/**
 * One-off operator probe — mints a JWT for derek@beckleyelectrical.co.uk
 * using the live JWT_SECRET, calls
 *   GET https://certmate.uk/api/voice-latency/loaded-barrel-readiness
 * and prints the snapshot. Used to decide whether to flip
 * VOICE_LATENCY_LOADED_BARREL=true (plan v10 §G3 gate, ≥80% adoption).
 *
 * Self-contained — does not import the project's auth.js because it
 * needs to be runnable from any cwd. Replicates the JWT payload shape
 * from src/auth.js:132-144.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const REGION = 'eu-west-2';
const EMAIL = 'derek@beckleyelectrical.co.uk';
const URL = 'https://certmate.uk/api/voice-latency/loaded-barrel-readiness';

function getSecret(id) {
  const raw = execSync(
    `aws secretsmanager get-secret-value --secret-id ${id} --region ${REGION} --query SecretString --output text`,
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString('utf8');
  return JSON.parse(raw);
}

const apiKeys = getSecret('eicr/api-keys');
const dbCreds = getSecret('eicr/database');
const JWT_SECRET = apiKeys.JWT_SECRET;

const client = new pg.Client({
  host: dbCreds.host || 'eicr-db-production.cfo684yymx9d.eu-west-2.rds.amazonaws.com',
  port: dbCreds.port || 5432,
  user: dbCreds.username,
  password: dbCreds.password,
  database: dbCreds.dbname || 'eicr',
  ssl: { rejectUnauthorized: false },
});

await client.connect();
const { rows } = await client.query(
  'SELECT id, email, role, company_id, company_role, token_version FROM users WHERE email = $1 LIMIT 1',
  [EMAIL]
);
await client.end();
if (rows.length === 0) {
  console.error(`No user found for ${EMAIL}`);
  process.exit(1);
}
const u = rows[0];
const token = jwt.sign(
  {
    userId: u.id,
    email: u.email,
    role: u.role || 'user',
    company_id: u.company_id || null,
    company_role: u.company_role || 'employee',
    tv: u.token_version || 0,
    jti: randomUUID(),
  },
  JWT_SECRET,
  { expiresIn: '5m' }
);

const res = await fetch(URL, { headers: { Authorization: `Bearer ${token}` } });
const text = await res.text();
console.log(`HTTP ${res.status}`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
