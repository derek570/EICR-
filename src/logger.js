import winston from 'winston';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Personal-data field keys that must never be written to logs in plaintext.
// Discovered by the 2026-05-11 compliance audit: logger.info(...) call sites
// in src/routes/jobs.js and src/routes/calendar.js were writing raw `address`,
// `client_name`, `postcode` strings into CloudWatch — combined with the lack
// of CloudWatch log-group retention this would have created a permanent
// record of every homeowner address that ever entered the system. Audit
// finding R3 in the DPIA. Redaction here is at the format-chain level so it
// applies to every log call (and every child logger) regardless of which
// route or service constructed it, without requiring an audit + rewrite of
// every call site. Scope is conservative — only fields whose name clearly
// signals homeowner-personal-data — to avoid silently mangling internal
// "name" / "email" fields (e.g. inspector name, internal service-account
// emails) that are legitimately logged.
export const PII_FIELDS = new Set([
  'address',
  'client_name',
  'clientName',
  'postcode',
  'postCode',
  'client_phone',
  'clientPhone',
  'client_email',
  'clientEmail',
]);

const REDACTED = '[REDACTED]';

export function redactPiiInPlace(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 6) {
    return;
  }
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (PII_FIELDS.has(key) && value != null) {
      obj[key] = REDACTED;
    } else if (value && typeof value === 'object') {
      redactPiiInPlace(value, depth + 1);
    }
  }
}

// Winston format factory — runs in the chain before printf so the console
// and JSON serialisers only see redacted metadata. Operates on the `info`
// object in place; winston gives each format invocation a fresh object so
// mutation is safe.
const redactPiiFormat = winston.format((info) => {
  redactPiiInPlace(info);
  return info;
});

// Custom format for console output
const consoleFormat = printf(({ level, message, timestamp, jobId, ...meta }) => {
  const job = jobId ? `[${jobId}] ` : '';
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level}: ${job}${message}${metaStr}`;
});

// JSON format for CloudWatch/production
const jsonFormat = printf(({ level, message, timestamp, ...meta }) => {
  return JSON.stringify({ timestamp, level, message, ...meta });
});

// Determine if we're in production
const isProduction = process.env.NODE_ENV === 'production';

// Create the logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    redactPiiFormat(),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })
  ),
  defaultMeta: { service: 'eicr-omatic' },
  transports: [
    // Console transport - colorized in dev, JSON in production
    new winston.transports.Console({
      format: isProduction
        ? combine(timestamp(), jsonFormat)
        : combine(colorize(), timestamp({ format: 'HH:mm:ss' }), consoleFormat),
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
