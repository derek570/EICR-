/**
 * API keys and proxy routes — keys, Claude proxy, TTS proxies, remote config
 */

import { Router } from "express";
import * as auth from "../auth.js";
import * as storage from "../storage.js";
import { getDeepgramKey } from "../services/secrets.js";
import logger from "../logger.js";

const router = Router();

/**
 * Get API keys for direct iOS-to-service connections
 * GET /api/keys
 * Returns: { deepgram: string, anthropic: string, elevenlabs: string }
 */
router.get("/keys", auth.requireAuth, async (req, res) => {
  try {
    const { getAnthropicKey, getElevenLabsKey } = await import("../services/secrets.js");
    const [deepgramKey, anthropicKey, elevenLabsKey] = await Promise.all([
      getDeepgramKey(),
      getAnthropicKey(),
      getElevenLabsKey(),
    ]);
    res.json({
      deepgram: deepgramKey || null,
      anthropic: anthropicKey || null,
      elevenlabs: elevenLabsKey || null,
    });
  } catch (error) {
    logger.error("Failed to retrieve API keys", { error: error.message });
    res.status(500).json({ error: "Failed to retrieve API keys" });
  }
});

/**
 * Proxy Claude Anthropic API calls from the web app
 * POST /api/proxy/claude
 */
router.post("/proxy/claude", auth.requireAuth, async (req, res) => {
  try {
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
