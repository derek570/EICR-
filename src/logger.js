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

// Copy-on-write redaction. The top-level `obj` is mutated (winston owns the
// `info` object passed to format chains, so that's safe), but any nested
// sub-object referenced by `obj` is shallow-cloned before recursion — we
// never mutate a value the caller still holds a reference to. This matters
// because logger metadata routinely contains live references to request /
// session data: prior to this guard, a `logger.info('...', { foo: jobData })`
// call would walk into `jobData.installation_details` and overwrite the
// real `address` / `postcode` strings with `[REDACTED]`. The route handler
// would then return (and persist) the redacted value to S3 and the `jobs.address`
// DB column on the next PUT — observed in `src/routes/jobs.js:507-513` where
// the GET handler logged `installationData: extractedData.installation_details`,
// causing every job-open to flip the saved address to `[REDACTED]` on the
// client's next auto-save.
export function redactPiiInPlace(obj, depth = 0, seen) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 6) {
    return;
  }
  if (!seen) seen = new WeakSet();
  if (seen.has(obj)) return;
  seen.add(obj);

  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (PII_FIELDS.has(key) && value != null) {
      obj[key] = REDACTED;
    } else if (value && typeof value === 'object' && !Array.isArray(value) && !seen.has(value)) {
      const clone = { ...value };
      obj[key] = clone;
      redactPiiInPlace(clone, depth + 1, seen);
    }
  }
}

// Winston format factory — runs in the chain before printf so the console
// and JSON serialisers only see redacted metadata. Mutates the top-level
// `info` object in place; nested sub-objects are cloned by `redactPiiInPlace`
// so caller-owned data is never touched.
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
