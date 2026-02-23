/**
 * Server entry point for EICR-oMatic 3000 Backend.
 * Creates HTTP server, mounts WebSocket handlers, starts listening.
 */

import http from "node:http";
import logger from "./logger.js";
import * as storage from "./storage.js";
import * as auth from "./auth.js";
import { startWorker } from "./queue.js";
import { initSocketIO } from "./realtime.js";
import { initSonnetStream } from "./extraction/sonnet-stream.js";
import { closeTransporter } from "./services/email.js";

// Import app (creates Express instance + middleware via app.js)
// Import api.js which registers all routes on the app
// The wss export is the recording stream WebSocket server
import app, { wss as recordingWss } from "./api.js";
import { stopSessionCleanup } from "./routes/recording.js";

const PORT = process.env.PORT || 3000;

// Create HTTP server
const httpServer = http.createServer(app);
initSocketIO(httpServer);

// ════════════════════════════════════════════════════════════════════════════
// WebSocket Server — Server-Side Sonnet Extraction
// Path: wss://.../api/sonnet-stream
// ════════════════════════════════════════════════════════════════════════════

const sonnetWss = initSonnetStream(httpServer, async () => {
  const { getAnthropicKey } = await import("./services/secrets.js");
  return getAnthropicKey();
}, auth.verifyToken);

// ════════════════════════════════════════════════════════════════════════════
// WebSocket upgrade handler
// ════════════════════════════════════════════════════════════════════════════

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/api/recording/stream") {
    recordingWss.handleUpgrade(request, socket, head, (ws) => {
      recordingWss.emit("connection", ws, request);
    });
  } else if (url.pathname === "/api/sonnet-stream") {
    // Authenticate via query param or Authorization header
    const token = url.searchParams.get('token') ||
      (request.headers.authorization || '').replace('Bearer ', '');
    if (!token) { socket.destroy(); return; }
    (async () => {
      try {
        const decoded = await auth.verifyToken(token);
        if (!decoded) { socket.destroy(); return; }
        const userId = decoded.id || decoded.userId || decoded.sub;
        sonnetWss.handleUpgrade(request, socket, head, (ws) => {
          sonnetWss.emit('connection', ws, request, userId);
        });
      } catch (e) {
        logger.error('SonnetStream auth failed', { error: e.message });
        socket.destroy();
      }
    })();
  } else {
    // Let other upgrade handlers (socket.io) handle it
    socket.destroy();
  }
});

// Start queue worker
startWorker().catch((err) => {
  logger.warn("Could not start queue worker", { error: err.message });
});

// Start listening
httpServer.listen(PORT, "0.0.0.0", () => {
  logger.info(`EICR Backend API server running`, {
    port: PORT,
    storage: storage.isUsingS3() ? "S3" : "local",
    bucket: storage.getBucketName() || "N/A"
  });
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  httpServer.close(() => logger.info("HTTP server closed"));
  try {
    const { getJobQueue } = await import("./queue.js");
    const queue = getJobQueue();
    if (queue) await queue.close();
  } catch (_) {}
  stopSessionCleanup();
  closeTransporter();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export { httpServer };
export default app;
