/**
 * Shared in-memory store for active recording sessions.
 * Breaks the circular dependency between recording.js and extraction.js.
 */

const activeSessions = new Map();

export function getActiveSession(sessionId) {
  return activeSessions.get(sessionId);
}

export function setActiveSession(sessionId, session) {
  activeSessions.set(sessionId, session);
}

export function deleteActiveSession(sessionId) {
  activeSessions.delete(sessionId);
}

export { activeSessions };
