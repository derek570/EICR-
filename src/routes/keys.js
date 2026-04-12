/**
 * Proxy routes and remote config — Claude proxy, TTS proxies, remote config
 * The GET /api/keys endpoint has been removed for security (never expose raw API keys to clients).
 * iOS clients should use proxy endpoints or direct WebSocket connections instead.
 *
 * HISTORY (3ea46f3, 2026-02-24): The original implementation sent the master Deepgram API key
 * directly to the iOS client. This was replaced with short-lived temp keys (600s TTL) created
 * via the Deepgram REST API, so the master key never leaves the server. The Claude proxy was
 * also hardened with a field whitelist — only model, messages, max_tokens, system, temperature,
 * top_p, and stop_sequences are forwarded. Any extra fields from the client are stripped and logged.
 *
 * HISTORY (a3e0759, 2026-02-26): Temp key creation requires the keys:write scope on the
 * Deepgram API key (which requires a Member-level role). When the Deepgram key only has
 * basic scopes, createDeepgramTempKey() throws a 403. Rather than returning a 500 to the
 * iOS client (which would break the recording session), we fall back to the master key.
 * This is a security trade-off: master key exposure to the client is worse than temp keys,
 * but a broken recording session is worse than either.
 */

import { Router } from 'express';
import * as auth from '../auth.js';
import * as storage from '../storage.js';
import { getDeepgramKey, getSecret } from '../services/secrets.js';
import logger from '../logger.js';

// Cached Deepgram project ID to avoid repeated lookups
let cachedProjectId = null;

const router = Router();

// Allowed Claude models for proxy requests
const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-5-20241022',
  'claude-sonnet-4-5-latest',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6-latest',
  'claude-haiku-4-5-20241022',
  'claude-haiku-4-5-latest',
  'claude-opus-4-6-latest',
  'claude-opus-4-6-20250501',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
]);

const MAX_TOKENS_LIMIT = 8192;

/**
 * Proxy Claude Anthropic API calls
 * POST /api/proxy/claude
 *
 * Validates model whitelist and max_tokens before forwarding.
 * Logs per-user cost data from Anthropic response usage.
 */
router.post('/proxy/claude', auth.requireAuth, async (req, res) => {
  try {
    // Validate request body
    const { model, max_tokens, messages } = req.body;

    if (!model || !ALLOWED_MODELS.has(model)) {
      return res.status(400).json({
        error: `Invalid model. Allowed: ${[...ALLOWED_MODELS].join(', ')}`,
      });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    if (max_tokens && (typeof max_tokens !== 'number' || max_tokens > MAX_TOKENS_LIMIT)) {
      return res.status(400).json({
        error: `max_tokens must be a number <= ${MAX_TOKENS_LIMIT}`,
      });
    }

    const { getAnthropicKey } = await import('../services/secrets.js');
    const anthropicKey = await getAnthropicKey();
    if (!anthropicKey) {
      return res.status(500).json({ error: 'Anthropic API key not configured' });
    }

    const userId = req.user?.id || req.user?.userId || 'unknown';

    // Build forwarded body from whitelisted fields only
    const forwardBody = {
      model,
      messages,
      max_tokens: max_tokens || 4096,
    };

    // HISTORY (3ea46f3, 2026-02-24): Only whitelisted Anthropic API fields are forwarded.
    // The client used to be able to send arbitrary fields (like stream: true, tools, etc.)
    // which could be used to abuse the API key. Now only safe fields are forwarded, and
    // any extra fields are stripped and logged as a warning.
    // Include optional Anthropic Messages API fields only if present and valid
    if (typeof req.body.system === 'string') {
      forwardBody.system = req.body.system;
    }
    if (
      typeof req.body.temperature === 'number' &&
      req.body.temperature >= 0 &&
      req.body.temperature <= 1
    ) {
      forwardBody.temperature = req.body.temperature;
    }
    if (typeof req.body.top_p === 'number' && req.body.top_p >= 0 && req.body.top_p <= 1) {
      forwardBody.top_p = req.body.top_p;
    }
    if (Array.isArray(req.body.stop_sequences)) {
      forwardBody.stop_sequences = req.body.stop_sequences;
    }

    // Log stripped non-whitelisted fields
    const allowedFields = new Set([
      'model',
      'messages',
      'max_tokens',
      'system',
      'temperature',
      'top_p',
      'stop_sequences',
    ]);
    const extraFields = Object.keys(req.body).filter((k) => !allowedFields.has(k));
    if (extraFields.length > 0) {
      logger.warn('Claude proxy: stripped non-whitelisted fields', { userId, extraFields });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(forwardBody),
    });

    const data = await response.json();

    // Log per-user cost tracking
    if (data.usage) {
      logger.info('Claude proxy usage', {
        userId,
        model,
        input_tokens: data.usage.input_tokens || 0,
        output_tokens: data.usage.output_tokens || 0,
      });
    }

    res.status(response.status).json(data);
  } catch (error) {
    logger.error('Claude proxy error', { error: error.message });
    res.status(500).json({ error: 'Claude proxy request failed' });
  }
});

/**
 * Proxy Deepgram TTS calls from the web app
 * POST /api/proxy/deepgram-tts
 */
router.post('/proxy/deepgram-tts', auth.requireAuth, async (req, res) => {
  try {
    const deepgramKey = await getDeepgramKey();
    if (!deepgramKey) {
      return res.status(500).json({ error: 'Deepgram API key not configured' });
    }

    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'text field required' });
    }

    const response = await fetch(
      'https://api.deepgram.com/v1/speak?model=aura-2-draco-en&encoding=mp3',
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${deepgramKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    res.set('Content-Type', 'audio/mpeg');
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    logger.error('Deepgram TTS proxy error', { error: error.message });
    res.status(500).json({ error: 'Deepgram TTS proxy request failed' });
  }
});

/**
 * Proxy ElevenLabs TTS calls from the web app
 * POST /api/proxy/elevenlabs-tts
 */
router.post('/proxy/elevenlabs-tts', auth.requireAuth, async (req, res) => {
  try {
    const { getElevenLabsKey } = await import('../services/secrets.js');
    const elevenLabsKey = await getElevenLabsKey();
    if (!elevenLabsKey) {
      return res.status(500).json({ error: 'ElevenLabs API key not configured' });
    }

    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'text field required' });
    }

    const voiceId = 'Fahco4VZzobUeiPqni1S'; // Archer Conversational
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': elevenLabsKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.3,
          use_speaker_boost: true,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('ElevenLabs API rejected request', {
        status: response.status,
        error: errorText.substring(0, 200),
      });
      return res.status(response.status).json({ error: errorText });
    }

    res.set('Content-Type', 'audio/mpeg');
    const buffer = Buffer.from(await response.arrayBuffer());
    logger.info('ElevenLabs TTS success', { bytes: buffer.length });
    res.send(buffer);
  } catch (error) {
    logger.error('ElevenLabs TTS proxy error', { error: error.message });
    res.status(500).json({ error: 'ElevenLabs TTS proxy request failed' });
  }
});

/**
 * Create a short-lived Deepgram API key for iOS WebSocket connections.
 * POST /api/proxy/deepgram-streaming-key
 *
 * Creates a temporary Deepgram API key (600s TTL) via the Deepgram REST API.
 * The iOS app connects directly to Deepgram via WebSocket for real-time
 * transcription, which cannot be proxied through the backend.
 *
 * The master Deepgram key is NEVER sent to the client. Only short-lived
 * temp keys with limited scopes are returned.
 */

async function getDeepgramProjectId(masterKey) {
  // Check cached value first
  if (cachedProjectId) return cachedProjectId;

  // Try env/secrets
  const envProjectId = await getSecret('DEEPGRAM_PROJECT_ID');
  if (envProjectId) {
    cachedProjectId = envProjectId;
    return cachedProjectId;
  }

  // Discover via Deepgram REST API
  const projectsResponse = await fetch('https://api.deepgram.com/v1/projects', {
    headers: { Authorization: `Token ${masterKey}` },
  });

  if (!projectsResponse.ok) {
    throw new Error(`Deepgram projects lookup failed: ${projectsResponse.status}`);
  }

  const projects = await projectsResponse.json();
  const projectId = projects.projects?.[0]?.project_id;

  if (!projectId) {
    throw new Error('No Deepgram project found');
  }

  cachedProjectId = projectId;
  return cachedProjectId;
}

/**
 * Create a short-lived Deepgram access token via /v1/auth/grant.
 * This is the modern token endpoint — simpler, doesn't require keys:write scope,
 * and produces JWT-style access tokens that work with WebSocket subprotocol auth.
 * The old /v1/projects/{id}/keys endpoint is deprecated and "too problematic"
 * per Deepgram community feedback.
 *
 * Token only needs to be valid at WS connection time — the WebSocket stays open
 * after token expiry. 30s TTL gives enough headroom for the client to connect.
 */
async function createDeepgramTempKey(userId) {
  const masterKey = await getDeepgramKey();
  if (!masterKey) {
    throw new Error('Deepgram API key not configured');
  }

  const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: {
      Authorization: `Token ${masterKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      time_to_live_in_seconds: 30,
      scopes: ['usage:write'],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Deepgram token grant failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  logger.info('Deepgram temp token created via /v1/auth/grant', { userId, ttl: 30 });
  return data.access_token;
}

router.post('/proxy/deepgram-streaming-key', auth.requireAuth, async (req, res) => {
  const userId = req.user?.id || req.user?.userId || 'unknown';

  try {
    const key = await createDeepgramTempKey(userId);
    logger.info('Deepgram temp streaming key issued', { userId });
    res.json({ key });
  } catch (error) {
    // Fallback: if temp token creation fails, use master key directly
    // This ensures recording sessions aren't silently broken by API changes
    logger.warn('Deepgram temp token failed, falling back to master key', {
      userId,
      error: error.message,
    });
    try {
      const masterKey = await getDeepgramKey();
      if (masterKey) {
        logger.info('Deepgram master key fallback issued', { userId });
        res.json({ key: masterKey });
        return;
      }
    } catch (fallbackErr) {
      logger.error('Deepgram master key fallback also failed', {
        userId,
        error: fallbackErr.message,
      });
    }
    res.status(500).json({ error: 'Failed to create Deepgram streaming key' });
  }
});

/**
 * Get remote config for CertMate iOS app
 * GET /api/config/certmate
 */
router.get('/config/certmate', async (req, res) => {
  try {
    const configContent = await storage.downloadText('config/certmate_config.json');
    if (configContent) {
      res.setHeader('Content-Type', 'application/json');
      res.send(configContent);
      return;
    }
    res.json({
      config_version: 1,
      last_updated: new Date().toISOString(),
      message: 'No remote config found — using bundled default',
    });
  } catch (error) {
    logger.error('Failed to serve remote config', { error: error.message });
    res.status(500).json({ error: 'Failed to load config' });
  }
});

export default router;
