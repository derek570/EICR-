/**
 * AWS Secrets Manager integration for EICR-oMatic 3000
 *
 * Retrieves API keys and credentials from AWS Secrets Manager.
 * Falls back to environment variables when running locally.
 *
 * Usage:
 *   import { getSecret, getOpenAIKey } from './secrets.js';
 *
 *   const apiKey = await getSecret('OPENAI_API_KEY');
 *   // or
 *   const openaiKey = await getOpenAIKey();
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import logger from '../logger.js';

// Cache for secrets (loaded once per process)
let secretsCache = null;

/**
 * Load all secrets from AWS Secrets Manager
 * @returns {Promise<Object>} Dictionary of secrets
 */
async function loadSecretsFromAWS() {
    if (secretsCache !== null) {
        return secretsCache;
    }

    const region = process.env.AWS_REGION || 'eu-west-2';
    const client = new SecretsManagerClient({ region });
    const secrets = {};

    // Load API keys secret
    const apiKeysSecretName = process.env.AWS_SECRET_NAME || 'eicr/api-keys';
    try {
        const command = new GetSecretValueCommand({
            SecretId: apiKeysSecretName,
        });
        const response = await client.send(command);
        if (response.SecretString) {
            Object.assign(secrets, JSON.parse(response.SecretString));
            logger.info(`[secrets] Loaded secrets from AWS Secrets Manager: ${apiKeysSecretName}`);
        }
    } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
            logger.warn(`[secrets] Secret not found: ${apiKeysSecretName}`);
        } else if (error.name === 'AccessDeniedException') {
            logger.warn('[secrets] Access denied to Secrets Manager. Check IAM permissions.');
        } else {
            logger.error(`[secrets] Error retrieving API keys secret: ${error.message}`);
        }
    }

    // Load database secret and construct DATABASE_URL
    const dbSecretName = 'eicr/database';
    try {
        const command = new GetSecretValueCommand({
            SecretId: dbSecretName,
        });
        const response = await client.send(command);
        if (response.SecretString) {
            const dbConfig = JSON.parse(response.SecretString);
            // Construct DATABASE_URL from individual fields
            if (dbConfig.host && dbConfig.username && dbConfig.password && dbConfig.database) {
                const port = dbConfig.port || 5432;
                // URL-encode the password in case it has special characters
                const encodedPassword = encodeURIComponent(dbConfig.password);
                secrets.DATABASE_URL = `postgresql://${dbConfig.username}:${encodedPassword}@${dbConfig.host}:${port}/${dbConfig.database}`;
                logger.info(`[secrets] Constructed DATABASE_URL from ${dbSecretName}`);
            }
        }
    } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
            logger.warn(`[secrets] Database secret not found: ${dbSecretName}`);
        } else {
            logger.error(`[secrets] Error retrieving database secret: ${error.message}`);
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
 * Get a secret value by key
 *
 * First checks AWS Secrets Manager (if USE_AWS_SECRETS=true),
 * then falls back to environment variables.
 *
 * @param {string} key - The secret key name (e.g., 'OPENAI_API_KEY')
 * @param {string} defaultValue - Default value if secret is not found
 * @returns {Promise<string|null>} The secret value, or default if not found
 */
export async function getSecret(key, defaultValue = null) {
    const useAWS = process.env.USE_AWS_SECRETS?.toLowerCase() === 'true';

    if (useAWS) {
        const secrets = await loadSecretsFromAWS();
        if (key in secrets) {
            return secrets[key];
        }
    }

    // Fall back to environment variable
    const value = process.env[key] || defaultValue;

    if (value === null) {
        logger.warn(`[secrets] Secret '${key}' not found in AWS or environment`);
    }

    return value;
}

/**
 * Get all secrets as a dictionary
 *
 * Merges AWS secrets with environment variables,
 * with AWS taking precedence.
 *
 * @returns {Promise<Object>} Dictionary of all available secrets
 */
export async function getAllSecrets() {
    const secrets = {};

    // Start with environment variables for known keys
    const knownKeys = [
        'OPENAI_API_KEY',
        'GEMINI_API_KEY',
        'TRADECERT_API_KEY',
        'DATABASE_PASSWORD',
        'DATABASE_URL',
        'JWT_SECRET',
    ];

    for (const key of knownKeys) {
        if (process.env[key]) {
            secrets[key] = process.env[key];
        }
    }

    // Override with AWS secrets if enabled
    const useAWS = process.env.USE_AWS_SECRETS?.toLowerCase() === 'true';
    if (useAWS) {
        const awsSecrets = await loadSecretsFromAWS();
        Object.assign(secrets, awsSecrets);
    }

    return secrets;
}

/**
 * Clear the secrets cache (useful for testing)
 */
export function clearCache() {
    secretsCache = null;
}

// Convenience functions for common secrets

/**
 * Get OpenAI API key
 * @returns {Promise<string>}
 */
export async function getOpenAIKey() {
    return getSecret('OPENAI_API_KEY');
}

/**
 * Get Gemini API key
 * @returns {Promise<string>}
 */
export async function getGeminiKey() {
    return getSecret('GEMINI_API_KEY');
}

/**
 * Get Tradecert API key
 * @returns {Promise<string>}
 */
export async function getTradecertKey() {
    return getSecret('TRADECERT_API_KEY');
}

/**
 * Get Deepgram API key
 * @returns {Promise<string>}
 */
export async function getDeepgramKey() {
    // Deepgram key is stored as a separate secret (plain string, not JSON)
    const useAWS = process.env.USE_AWS_SECRETS?.toLowerCase() === 'true';
    if (useAWS) {
        const region = process.env.AWS_REGION || 'eu-west-2';
        const client = new SecretsManagerClient({ region });
        try {
            const command = new GetSecretValueCommand({ SecretId: 'eicr/deepgram-api-key' });
            const response = await client.send(command);
            if (response.SecretString) {
                // May be plain string or JSON with a key field
                try {
                    const parsed = JSON.parse(response.SecretString);
                    return parsed.DEEPGRAM_API_KEY || parsed.api_key || parsed.key || response.SecretString;
                } catch {
                    return response.SecretString.trim();
                }
            }
        } catch (error) {
            if (error.name !== 'ResourceNotFoundException') {
                logger.error(`[secrets] Error retrieving Deepgram key: ${error.message}`);
            }
        }
    }
    return process.env.DEEPGRAM_API_KEY || null;
}

/**
 * Get Anthropic (Claude) API key
 * @returns {Promise<string>}
 */
export async function getAnthropicKey() {
    // Anthropic key is stored as a separate secret (plain string, not JSON)
    const useAWS = process.env.USE_AWS_SECRETS?.toLowerCase() === 'true';
    if (useAWS) {
        const region = process.env.AWS_REGION || 'eu-west-2';
        const client = new SecretsManagerClient({ region });
        try {
            const command = new GetSecretValueCommand({ SecretId: 'eicr/anthropic-api-key' });
            const response = await client.send(command);
            if (response.SecretString) {
                // May be plain string or JSON with a key field
                try {
                    const parsed = JSON.parse(response.SecretString);
                    return parsed.ANTHROPIC_API_KEY || parsed.api_key || parsed.key || response.SecretString;
                } catch {
                    return response.SecretString.trim();
                }
            }
        } catch (error) {
            if (error.name !== 'ResourceNotFoundException') {
                logger.error(`[secrets] Error retrieving Anthropic key: ${error.message}`);
            }
        }
    }
    return process.env.ANTHROPIC_API_KEY || null;
}

/**
 * Get ElevenLabs API key
 * @returns {Promise<string>}
 */
export async function getElevenLabsKey() {
    return getSecret('ELEVENLABS_API_KEY', null);
}

export default {
    getSecret,
    getAllSecrets,
    clearCache,
    getOpenAIKey,
    getGeminiKey,
    getTradecertKey,
    getDeepgramKey,
    getAnthropicKey,
    getElevenLabsKey,
};
