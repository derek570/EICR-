/**
 * Real-time Socket.io server for EICR-oMatic 3000
 * Provides WebSocket-based real-time job progress updates.
 */

import { Server } from "socket.io";
import { verifyToken } from "./auth.js";
import logger from "./logger.js";

let io = null;

/**
 * Initialize Socket.io server attached to the existing HTTP server.
 * Adds JWT authentication middleware and room-based user routing.
 *
 * @param {import("node:http").Server} httpServer - The HTTP server instance
 */
export function initSocketIO(httpServer) {
  const allowedOrigins = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL
    : ["http://localhost:3001", "https://certomatic3000.co.uk", "https://certmate.uk", "https://www.certmate.uk"];

  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
  });

  // JWT authentication middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Authentication required"));
    }

    try {
      const user = await verifyToken(token);
      if (!user) {
        return next(new Error("Invalid or expired token"));
      }
      socket.data.user = user;
      next();
    } catch (err) {
      logger.warn("Socket auth failed", { error: err.message });
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.user.id;
    const room = `user:${userId}`;

    socket.join(room);
    logger.info("Socket connected", { userId, socketId: socket.id });

    // ---- Phone companion mic relay ----
    // Phone joins a recording room, sends audio chunks, desktop receives them.

    socket.on("join-recording", ({ jobId }) => {
      if (!jobId) return;
      const recordingRoom = `recording:${jobId}`;
      socket.join(recordingRoom);
      // Notify other devices in the room that a companion connected
      socket.to(recordingRoom).emit("companion-joined", { socketId: socket.id });
      logger.info("Joined recording room", { userId, jobId, socketId: socket.id });
    });

    socket.on("leave-recording", ({ jobId }) => {
      if (!jobId) return;
      const recordingRoom = `recording:${jobId}`;
      socket.leave(recordingRoom);
      socket.to(recordingRoom).emit("companion-left", { socketId: socket.id });
      logger.info("Left recording room", { userId, jobId, socketId: socket.id });
    });

    socket.on("audio-chunk", ({ jobId, chunk }) => {
      if (!jobId || !chunk) return;
      // Relay audio chunk to all other devices in the recording room
      socket.to(`recording:${jobId}`).emit("audio-chunk", { chunk });
    });

    socket.on("disconnect", (reason) => {
      logger.info("Socket disconnected", { userId, socketId: socket.id, reason });
    });
  });

  logger.info("Socket.io server initialized");
  return io;
}

/**
 * Emit job progress update to a specific user.
 *
 * @param {string} userId
 * @param {string} jobId
 * @param {number|object} progress
 */
export function emitJobProgress(userId, jobId, progress) {
  if (!io) return;
  io.to(`user:${userId}`).emit("job:progress", { jobId, progress });
}

/**
 * Emit job completed event to a specific user.
 *
 * @param {string} userId
 * @param {string} jobId
 * @param {string} address - The resolved property address
 */
export function emitJobCompleted(userId, jobId, address) {
  if (!io) return;
  io.to(`user:${userId}`).emit("job:completed", { jobId, address });
}

/**
 * Emit job failed event to a specific user.
 *
 * @param {string} userId
 * @param {string} jobId
 * @param {string} error - Error message
 */
export function emitJobFailed(userId, jobId, error) {
  if (!io) return;
  io.to(`user:${userId}`).emit("job:failed", { jobId, error });
}

/**
 * Get the Socket.io server instance.
 *
 * @returns {Server|null}
 */
export function getIO() {
  return io;
}
