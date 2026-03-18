/**
 * Centralized error handling middleware for EICR-oMatic 3000 Backend.
 *
 * Provides consistent error response format across all endpoints.
 * Mount as the LAST middleware in app.js.
 */

import logger from "../logger.js";

/**
 * Application error class for typed, status-aware errors.
 * Throw these in route handlers and the error handler will format them.
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, code = "INTERNAL_ERROR") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

/**
 * 404 handler — mount before the error handler.
 */
export function notFoundHandler(req, res, next) {
  const err = new AppError(`Route not found: ${req.method} ${req.path}`, 404, "NOT_FOUND");
  next(err);
}

/**
 * Centralized error handler middleware.
 * Express requires the 4-argument signature (err, req, res, next) to recognize it as error middleware.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // Default to 500 if no status code is set
  const statusCode = err.statusCode || err.status || 500;
  const code = err.code || "INTERNAL_ERROR";

  // Log server errors, but not client errors (4xx)
  if (statusCode >= 500) {
    logger.error("Unhandled server error", {
      error: err.message,
      stack: err.stack,
      method: req.method,
      path: req.path,
      statusCode,
    });
  } else {
    logger.warn("Client error", {
      error: err.message,
      method: req.method,
      path: req.path,
      statusCode,
    });
  }

  // Never leak stack traces in production
  const response = {
    error: err.message || "Internal server error",
    code,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  };

  res.status(statusCode).json(response);
}
