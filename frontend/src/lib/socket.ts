/**
 * Socket.io client for real-time job updates.
 * Lazy singleton pattern — socket is created on first use and reused.
 */

import { io, Socket } from "socket.io-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

// --- Event interfaces ---

export interface JobCompletedEvent {
  jobId: string;
  address: string;
}

export interface JobFailedEvent {
  jobId: string;
  error: string;
}

// --- Singleton ---

let socket: Socket | null = null;

/**
 * Get or create the Socket.io client singleton.
 * Does NOT auto-connect — call connectSocket() explicitly.
 */
export function getSocket(): Socket {
  if (!socket) {
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;

    socket = io(API_URL, {
      auth: { token },
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
    });
  }
  return socket;
}

/**
 * Connect the socket (refreshing the auth token on each attempt).
 */
export function connectSocket(): void {
  const s = getSocket();

  // Refresh token before connecting in case it changed
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  s.auth = { token };

  if (!s.connected) {
    s.connect();
  }
}

/**
 * Disconnect and destroy the singleton so a fresh one is created next time.
 */
export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

// --- Typed event subscriptions (return unsubscribe function) ---

export function onJobCompleted(callback: (event: JobCompletedEvent) => void): () => void {
  const s = getSocket();
  s.on("job:completed", callback);
  return () => {
    s.off("job:completed", callback);
  };
}

export function onJobFailed(callback: (event: JobFailedEvent) => void): () => void {
  const s = getSocket();
  s.on("job:failed", callback);
  return () => {
    s.off("job:failed", callback);
  };
}
