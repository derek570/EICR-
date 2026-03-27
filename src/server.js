/**
 * Server entry point for EICR-oMatic 3000 Backend.
 * Creates HTTP server, mounts WebSocket handlers, starts listening.
 */

import http from 'node:http';
import logger from './logger.js';
import * as storage from './storage.js';
import * as auth from './auth.js';
import { startWorker } from './queue.js';
import { initSocketIO } from './realtime.js';
import { initSonnetStream } from './extraction/sonnet-stream.js';
import { closeTransporter } from './services/email.js';
import { closePool } from './db.js';

// Import app (creates Express instance + middleware via app.js)
// Import api.js which registers all routes on the app
// The wss export is the recording stream WebSocket server
import app, { wss as recordingWss } from './api.js';
import { stopSessionCleanup } from './routes/recording.js';

const PORT = process.env.PORT || 3000;

// Create HTTP server
const httpServer = http.createServer(app);
initSocketIO(httpServer);

// ════════════════════════════════════════════════════════════════════════════
// WebSocket Server — Server-Side Sonnet Extraction
// Path: wss://.../api/sonnet-stream
// ════════════════════════════════════════════════════════════════════════════

const sonnetWss = initSonnetStream(
  httpServer,
  async () => {
    const { getAnthropicKey } = await import('./services/secrets.js');
    return getAnthropicKey();
  },
  auth.verifyToken
);

// ════════════════════════════════════════════════════════════════════════════
// WebSocket upgrade handler
// ════════════════════════════════════════════════════════════════════════════

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/api/recording/stream') {
    recordingWss.handleUpgrade(request, socket, head, (ws) => {
      recordingWss.emit('connection', ws, request);
    });
  } else if (url.pathname === '/api/sonnet-stream') {
    // Authenticate via Authorization header OR query param (browser WS cannot set headers)
    const authHeader = request.headers.authorization || '';
    let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      token = url.searchParams.get('token') || '';
    }
    if (!token) {
      logger.warn('SonnetStream WS rejected: no token in header or query param');
      socket.destroy();
      return;
    }
    (async () => {
      try {
        const decoded = await auth.verifyToken(token);
        if (!decoded) {
          socket.destroy();
          return;
        }
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
  logger.warn('Could not start queue worker', { error: err.message });
});

// Start listening
httpServer.listen(PORT, '0.0.0.0', () => {
  logger.info(`EICR Backend API server running`, {
    port: PORT,
    storage: storage.isUsingS3() ? 'S3' : 'local',
    bucket: storage.getBucketName() || 'N/A',
  });
});

// Graceful shutdown
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Received ${signal}, starting graceful shutdown...`);

  // Force exit after 10 seconds if cleanup stalls
  const forceTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out after 10s, forcing exit');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  // 1. Stop accepting new connections
  httpServer.close(() => logger.info('HTTP server closed'));
  // Close idle keep-alive connections for faster drain (Node 18.2+)
  httpServer.closeIdleConnections();

  // 2. Close WebSocket servers with 1001 (Going Away)
  for (const ws of recordingWss.clients) {
    ws.close(1001, 'Server shutting down');
  }
  for (const ws of sonnetWss.clients) {
    ws.close(1001, 'Server shutting down');
  }

  // 3. Stop session cleanup interval
  stopSessionCleanup();

  // 4. Close job queue
  try {
    const { getJobQueue } = await import('./queue.js');
    const queue = getJobQueue();
    if (queue) await queue.close();
  } catch (_queueErr) {
    /* best-effort during shutdown */
  }

  // 5. Close email transporter
  closeTransporter();

  // 6. Close database pool
  try {
    await closePool();
  } catch (_dbErr) {
    /* best-effort during shutdown */
  }

  logger.info('Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Global crash handlers -- log and exit cleanly for process manager restart
process.on('unhandledRejection', (reason, _promise) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  // Exit after logging -- let process manager (PM2/systemd) restart
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
  // Exit after logging -- let process manager restart
  process.exit(1);
});

export { httpServer };
export default app;
