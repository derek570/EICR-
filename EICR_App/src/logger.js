import winston from "winston";

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom format for console output
const consoleFormat = printf(({ level, message, timestamp, jobId, ...meta }) => {
  const job = jobId ? `[${jobId}] ` : "";
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} ${level}: ${job}${message}${metaStr}`;
});

// JSON format for CloudWatch/production
const jsonFormat = printf(({ level, message, timestamp, ...meta }) => {
  return JSON.stringify({ timestamp, level, message, ...meta });
});

// Determine if we're in production
const isProduction = process.env.NODE_ENV === "production";

// Create the logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(
    errors({ stack: true }),
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" })
  ),
  defaultMeta: { service: "eicr-omatic" },
  transports: [
    // Console transport - colorized in dev, JSON in production
    new winston.transports.Console({
      format: isProduction
        ? combine(timestamp(), jsonFormat)
        : combine(colorize(), timestamp({ format: "HH:mm:ss" }), consoleFormat),
    }),
  ],
});

// Add file transport in production
if (isProduction && process.env.LOG_FILE) {
  logger.add(
    new winston.transports.File({
      filename: process.env.LOG_FILE,
      format: combine(timestamp(), jsonFormat),
    })
  );
}

// Helper to create a child logger with job context
export function createJobLogger(jobId) {
  return logger.child({ jobId });
}

export default logger;
