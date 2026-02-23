/**
 * Proxy routes and remote config — Claude proxy, TTS proxies, remote config
 * The GET /api/keys endpoint has been removed for security (never expose raw API keys to clients).
 * iOS clients should use proxy endpoints or direct WebSocket connections instead.
 */

import { Router } from "express";
import * as auth from "../auth.js";
import * as storage from "../storage.js";
import { getDeepgramKey } from "../services/secrets.js";
import logger from "../logger.js";

const router = Router();

// Allowed Claude models for proxy requests
const ALLOWED_MODELS = new Set([
  "claude-sonnet-4-5-20241022",
  "claude-sonnet-4-5-latest",
  "claude-haiku-4-5-20241022",
  "claude-haiku-4-5-latest",
  "claude-opus-4-6-latest",
  "claude-opus-4-6-20250501",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
]);

const MAX_TOKENS_LIMIT = 8192;

/**
 * Proxy Claude Anthropic API calls
 * POST /api/proxy/claude
 *
 * Validates model whitelist and max_tokens before forwarding.
 * Logs per-user cost data from Anthropic response usage.
 */
router.post("/proxy/claude", auth.requireAuth, async (req, res) => {
  try {
    // Validate request body
    const { model, max_tokens, messages } = req.body;

    if (!model || !ALLOWED_MODELS.has(model)) {
      return res.status(400).json({
        error: `Invalid model. Allowed: ${[...ALLOWED_MODELS].join(", ")}`,
      });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    if (max_tokens && (typeof max_tokens !== "number" || max_tokens > MAX_TOKENS_LIMIT)) {
      return res.status(400).json({
        error: `max_tokens must be a number <= ${MAX_TOKENS_LIMIT}`,
      });
    }

    const { getAnthropicKey } = await import("../services/secrets.js");
    const anthropicKey = await getAnthropicKey();
    if (!anthropicKey) {
      return res.status(500).json({ error: "Anthropic API key not configured" });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();

    // Log per-user cost tracking
    const userId = req.user?.id || req.user?.userId || "unknown";
    if (data.usage) {
      logger.info("Claude proxy usage", {
        userId,
        model,
        input_tokens: data.usage.input_tokens || 0,
        output_tokens: data.usage.output_tokens || 0,
      });
    }

    res.status(response.status).json(data);
  } catch (error) {
    logger.error("Claude proxy error", { error: error.message });
    res.status(500).json({ error: "Claude proxy request failed" });
  }
});

/**
 * Proxy Deepgram TTS calls from the web app
 * POST /api/proxy/deepgram-tts
 */
router.post("/proxy/deepgram-tts", auth.requireAuth, async (req, res) => {
  try {
    const deepgramKey = await getDeepgramKey();
    if (!deepgramKey) {
      return res.status(500).json({ error: "Deepgram API key not configured" });
    }

    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: "text field required" });
    }

    const response = await fetch(
      "https://api.deepgram.com/v1/speak?model=aura-2-draco-en&encoding=mp3",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${deepgramKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    res.set("Content-Type", "audio/mpeg");
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    logger.error("Deepgram TTS proxy error", { error: error.message });
    res.status(500).json({ error: "Deepgram TTS proxy request failed" });
  }
});

/**
 * Proxy ElevenLabs TTS calls from the web app
 * POST /api/proxy/elevenlabs-tts
 */
router.post("/proxy/elevenlabs-tts", auth.requireAuth, async (req, res) => {
  try {
    const { getElevenLabsKey } = await import("../services/secrets.js");
    const elevenLabsKey = await getElevenLabsKey();
    if (!elevenLabsKey) {
      return res.status(500).json({ error: "ElevenLabs API key not configured" });
    }

    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: "text field required" });
    }

    const voiceId = "JBFqnCBsd6RMkjVDRZzb"; // George
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": elevenLabsKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.3,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    res.set("Content-Type", "audio/mpeg");
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    logger.error("ElevenLabs TTS proxy error", { error: error.message });
    res.status(500).json({ error: "ElevenLabs TTS proxy request failed" });
  }
});

/**
 * Get remote config for CertMate iOS app
 * GET /api/config/certmate
 */
router.get("/config/certmate", async (req, res) => {
  try {
    const configContent = await storage.downloadText("config/certmate_config.json");
    if (configContent) {
      res.setHeader("Content-Type", "application/json");
      res.send(configContent);
      return;
    }
    res.json({
      config_version: 1,
      last_updated: new Date().toISOString(),
      message: "No remote config found — using bundled default"
    });
  } catch (error) {
    logger.error("Failed to serve remote config", { error: error.message });
    res.status(500).json({ error: "Failed to load config" });
  }
});

export default router;
