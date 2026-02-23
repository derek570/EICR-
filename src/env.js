/**
 * Startup environment validation for EICR-oMatic 3000 Backend.
 * Call validateEnv() after secrets are loaded but before the HTTP server starts.
 */

import logger from "./logger.js";

const REQUIRED = ["DATABASE_URL"];

const RECOMMENDED = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPGRAM_API_KEY",
];

/**
 * Validate that required environment variables are set and warn about missing recommended ones.
 * Throws if any REQUIRED variable is missing.
 */
export function validateEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  const missingRecommended = RECOMMENDED.filter((key) => !process.env[key]);

  if (missingRecommended.length > 0) {
    logger.warn("Missing recommended environment variables (some features will be unavailable)", {
      missing: missingRecommended,
    });
  }

  if (missing.length > 0) {
    const msg = `Missing required environment variables: ${missing.join(", ")}`;
    logger.error(msg);
    throw new Error(msg);
  }

  logger.info("Environment validation passed");
}
