/**
 * AWS Secrets Manager integration for CertMate.
 *
 * All API keys live in a single combined AWS secret (eicr/api-keys) as a JSON object.
 * Database credentials live in a separate secret (eicr/database).
 * For local development, keys fall back to environment variables.
 *
 * Usage:
 *   import { getAnthropicKey, getDeepgramKey } from './secrets.js';
 *   const key = await getAnthropicKey();
 *
 * HISTORY (4699c5c, 2026-02-24): This file was completely rewritten to unify all secrets
 * into a single AWS secret. The original implementation had separate per-service secret
 * lookups (e.g. eicr/anthropic, eicr/deepgram) which caused Sonnet connection failures
 * in production — the per-service secrets didn't exist in AWS, only the combined one did.
 * The old code would fail to find ANTHROPIC_API_KEY because it was looking in the wrong
 * AWS secret path. Now everything loads from eicr/api-keys (one JSON object with all keys)
 * and eicr/database (DB credentials). The convenience accessors at the bottom (getAnthropicKey,
 * getDeepgramKey, etc.) all delegate to getSecret() which checks the combined secret first,
 * then falls back to environment variables for local development.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import logger from '../logger.js';

// Cached secrets — loaded once per process from AWS, then reused.
let secretsCache = null;

/**
 * Load all secrets from AWS Secrets Manager into cache.
 *
 * Loads from two AWS secrets:
 *   - eicr/api-keys  — combined JSON with all API keys
 *   - eicr/database   — DB connection fields → constructs DATABASE_URL
 *
 * @returns {Promise<Object>} Cached dictionary of all secrets.
 */
async function loadSecretsFromAWS() {
  if (secretsCache !== null) return secretsCache;

  const region = process.env.AWS_REGION || 'eu-west-2';
  const client = new SecretsManagerClient({ region });
  const secrets = {};

  // Load combined API keys
  const apiKeysSecretName = process.env.AWS_SECRET_NAME || 'eicr/api-keys';
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: apiKeysSecretName }));
    if (response.SecretString) {
      Object.assign(secrets, JSON.parse(response.SecretString));
      logger.info(`[secrets] Loaded API keys from ${apiKeysSecretName}`);
    }
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      logger.warn(`[secrets] Secret not found: ${apiKeysSecretName}`);
    } else if (error.name === 'AccessDeniedException') {
      logger.warn('[secrets] Access denied to Secrets Manager — check IAM permissions');
    } else {
      logger.error(`[secrets] Failed to load API keys: ${error.message}`);
    }
  }

  // Load database credentials and construct DATABASE_URL
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: 'eicr/database' }));
    if (response.SecretString) {
      const db = JSON.parse(response.SecretString);
      if (db.host && db.username && db.password && db.database) {
        const port = db.port || 5432;
        secrets.DATABASE_URL = `postgresql://${db.username}:${encodeURIComponent(db.password)}@${db.host}:${port}/${db.database}`;
        logger.info('[secrets] Constructed DATABASE_URL from eicr/database');
      }
    }
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      logger.warn('[secrets] Database secret not found: eicr/database');
    } else {
      logger.error(`[secrets] Failed to load database secret: ${error.message}`);
    }
  }

  // Propagate JWT_SECRET to process.env so auth.js can read it at startup
  if (secrets.JWT_SECRET && !process.env.JWT_SECRET) {
    process.env.JWT_SECRET = secrets.JWT_SECRET;
  }

  secretsCache = secrets;
  return secretsCache;
}

/**
 * Get a secret by key name.
 * Checks AWS Secrets Manager (combined secret) first, then environment variables.
 *
 * @param {string} key - The secret key (e.g. 'ANTHROPIC_API_KEY')
 * @param {string|null} defaultValue - Fallback if not found anywhere
 * @returns {Promise<string|null>}
 */
export async function getSecret(key, defaultValue = null) {
  if (process.env.USE_AWS_SECRETS?.toLowerCase() === 'true') {
    const secrets = await loadSecretsFromAWS();
    if (key in secrets) return secrets[key];
  }
  return process.env[key] || defaultValue;
}

/**
 * Get all secrets as a merged dictionary (AWS + environment variables).
 * AWS values take precedence over environment variables.
 *
 * @returns {Promise<Object>}
 */
export async function getAllSecrets() {
  const secrets = {};

  // Seed from environment variables
  const knownKeys = [
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'TRADECERT_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPGRAM_API_KEY',
    'ELEVENLABS_API_KEY',
    'DATABASE_URL',
    'DATABASE_PASSWORD',
    'JWT_SECRET',
  ];

  for (const key of knownKeys) {
    if (process.env[key]) {
      secrets[key] = process.env[key];
    }
  }

  // Override with AWS secrets (includes any keys not in knownKeys)
  if (process.env.USE_AWS_SECRETS?.toLowerCase() === 'true') {
    Object.assign(secrets, await loadSecretsFromAWS());
  }

  return secrets;
}

/**
 * Clear the secrets cache. Call between tests to reset state.
 */
export function clearCache() {
  secretsCache = null;
}

// ─── Convenience accessors ───────────────────────────────────────────────────
// Every key lives in the combined eicr/api-keys secret (or env var fallback).

export const getOpenAIKey = () => getSecret('OPENAI_API_KEY');
export const getGeminiKey = () => getSecret('GEMINI_API_KEY');
export const getTradecertKey = () => getSecret('TRADECERT_API_KEY');
export const getAnthropicKey = () => getSecret('ANTHROPIC_API_KEY');
export const getDeepgramKey = () => getSecret('DEEPGRAM_API_KEY');
export const getElevenLabsKey = () => getSecret('ELEVENLABS_API_KEY');

export default {
  getSecret,
  getAllSecrets,
  clearCache,
  getOpenAIKey,
  getGeminiKey,
  getTradecertKey,
  getAnthropicKey,
  getDeepgramKey,
  getElevenLabsKey,
};
