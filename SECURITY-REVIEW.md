# CertMate Security & Scalability Review

**Date:** 2026-03-26
**Scope:** Authentication, secrets management, payments/billing, and database layers
**Methodology:** Manual code review by Claude AI. Codex (OpenAI) second opinion was attempted for all three review phases but failed due to OpenAI API authentication error (401 Unauthorized) — all findings are single-reviewer.

**Files Reviewed:**
- `src/auth.js` — Authentication logic, JWT, token rotation
- `src/routes/auth.js` — Auth route handlers (login, logout, refresh, password change, account deletion)
- `src/services/secrets.js` — AWS Secrets Manager integration, secret caching
- `src/billing.js` — Stripe SDK wrapper
- `src/routes/billing.js` — Billing route handlers
- `src/api.js` (lines 57–159) — Stripe webhook handler
- `src/db.js` — Database queries, connection pool, CRUD operations (1,762 lines)
- `migrations/001_baseline.cjs` — Schema baseline migration (192 lines)

---

## Executive Summary

| Severity | Auth & Secrets | Payments | Database | **Total** |
|----------|---------------|----------|----------|-----------|
| **CRITICAL** | 0 | 1 | 2 | **3** |
| **HIGH** | 6 | 4 | 8 | **18** |
| **MEDIUM** | 12 | 5 | 14 | **31** |
| **LOW** | 17 | 3 | 8 | **28** |
| **Total** | 35 | 13 | 32 | **80** |

### Top 5 Most Critical Issues

| # | Severity | Area | Finding | Risk |
|---|----------|------|---------|------|
| 1 | **CRITICAL** | Database | Raw `query()` export accepts arbitrary SQL — potential injection vector if any caller uses string concatenation | Full database compromise |
| 2 | **CRITICAL** | Database | Missing ownership checks on `getJob()`, `updateJob()`, `getClient()`, `updateClient()` — IDOR vulnerability | Users can read/modify other users' data |
| 3 | **CRITICAL** | Payments | No webhook idempotency — Stripe retries can cause duplicate processing and inconsistent subscription state | Billing errors, data corruption |
| 4 | **HIGH** | Auth | Synchronous `bcrypt.compareSync()`/`hashSync()` blocks the Node.js event loop — DoS vector under concurrent load | Service unavailability |
| 5 | **HIGH** | Auth | Password change and account deletion don't invalidate existing JWT tokens — stolen tokens remain valid for up to 24 hours | Account takeover persists after remediation |

### Positive Findings

The codebase demonstrates several strong security practices:
- **Parameterized SQL queries** throughout — no SQL injection in existing query functions
- **Proper bcrypt hashing** for passwords (just needs async variant)
- **Token rotation** with theft detection mechanism
- **Account lockout** after failed login attempts
- **Audit logging** of auth events
- **AWS Secrets Manager** integration (no hardcoded secrets)
- **`allowedFields` whitelist** in `updateUser` prevents mass assignment
- **Webhook signature verification** correctly implemented with raw body
- **Auth middleware** on all user-facing billing routes
- **UPSERT pattern** prevents duplicate subscription rows
- **Graceful degradation** when Stripe is not configured

---

## Detailed Findings

### Auth & Secrets

| # | Severity | Category | File | Line(s) | Description | Recommendation |
|---|----------|----------|------|---------|-------------|----------------|
| A1 | **HIGH** | DoS | `src/auth.js` | 31 | `bcrypt.compareSync()` blocks event loop (~100ms+), serializing login requests. Attacker can DoS with concurrent logins. | Use async `bcrypt.compare()` |
| A2 | **HIGH** | DoS | `src/routes/auth.js` | 149 | `bcrypt.hashSync()` blocks event loop during password change (~100-200ms). | Use async `bcrypt.hash()` |
| A3 | **HIGH** | Auth Bypass | `src/routes/auth.js` | 133 | Minimum password length is only 6 characters. No complexity rules, no bcrypt 72-byte max guard, no breach check. | Enforce 8+ chars, complexity, max 72 bytes |
| A4 | **HIGH** | Token Mgmt | `src/routes/auth.js` | 125-160 | Password change doesn't invalidate existing tokens. Stolen tokens usable for up to 24h after password reset. | Increment `token_version` after password change |
| A5 | **HIGH** | Token Mgmt | `src/routes/auth.js` | 95-118 | Account deletion (`is_active = false`) doesn't invalidate tokens. Mitigated by `verifyToken` check but not defense-in-depth. | Increment `token_version` on account deactivation |
| A6 | **HIGH** | Data Exposure | `src/services/secrets.js` | 113-141 | `getAllSecrets()` returns every secret (JWT_SECRET, DB creds, API keys) in one call. Accidental exposure leaks everything. | Audit callers; remove or restrict function |
| A7 | MEDIUM | Race Condition | `src/auth.js` | 204-222 | Token rotation version check + increment is not atomic. Concurrent refresh requests can bypass theft detection. | Use atomic compare-and-swap (`UPDATE ... WHERE token_version = $1`) |
| A8 | MEDIUM | Token Mgmt | `src/auth.js` | 257-282 | No token blacklisting on logout. Tokens valid until expiry (24h). | Increment `token_version` on logout, or use Redis blacklist |
| A9 | MEDIUM | Authz | `src/auth.js` | 325-341 | `canAccessUser` IDOR check is opt-in per route. Forgotten calls = IDOR vulnerability. | Create middleware wrapper `requireAccessToUser(param)` |
| A10 | MEDIUM | Perf/Scale | `src/auth.js` | 150-166 | `verifyToken()` does DB query on every authenticated request to check `is_active`. | Cache in Redis (30-60s TTL) or include in JWT |
| A11 | MEDIUM | Crypto | `src/auth.js` | 121-130,151 | No explicit `algorithms: ['HS256']` in `jwt.verify()`. Algorithm confusion risk if library changes. | Add `{ algorithms: ['HS256'] }` to all verify calls |
| A12 | MEDIUM | Token Mgmt | `src/routes/auth.js` | 64-66 | Refresh endpoint accepts token from request body (legacy fallback). Body tokens risk logging/caching. | Remove body fallback; use Authorization header only |
| A13 | MEDIUM | CSRF | `src/routes/auth.js` | 46,95,125 | No explicit CSRF protection on state-changing POST/PUT/DELETE. Safe with Bearer tokens but fragile. | Document as security invariant; add CSRF if cookies are ever used |
| A14 | MEDIUM | Authz | `src/routes/auth.js` | 95 | Account deletion requires only valid JWT — no re-authentication/password confirmation. | Require password confirmation for account deletion |
| A15 | MEDIUM | Secret Mgmt | `src/services/secrets.js` | 26,87 | Secrets cached in memory indefinitely. Rotated secrets never take effect; memory dump exposes all. | Add TTL-based cache (refresh every 1h) |
| A16 | MEDIUM | Secret Mgmt | `src/services/secrets.js` | 82-85 | `JWT_SECRET` written to `process.env` — readable by child processes, `/proc`, crash reporters. | Use getter function instead of env vars |
| A17 | MEDIUM | Resilience | `src/services/secrets.js` | 42,48,65 | No retry/backoff for AWS Secrets Manager. New client created per call. | Singleton client + exponential backoff |
| A18 | MEDIUM | Secret Mgmt | `src/services/secrets.js` | 99-105 | If AWS fails, silently falls back to env vars. Production could run on dev secrets undetected. | Fail startup in production if AWS secrets unavailable |
| A19 | LOW | PII | `src/auth.js` | 122-129 | JWT contains `email` — base64-decoded by anyone with the token. | Remove email from JWT payload; use `userId` for lookups |
| A20 | LOW | Enum | `src/auth.js` | 79-88 | Separate error messages for "disabled" vs "locked" enable account state enumeration. | Return generic error for all failure cases |
| A21 | LOW | Perf | `src/auth.js` | 68-143 | Multiple sequential DB calls on login (getUserByEmail + updateLoginAttempts + logAction). | Batch into single transaction |
| A22 | LOW | Code Quality | `src/auth.js` | 257-282 | `requireAuth` uses `.then()/.catch()` while rest of codebase uses `async/await`. | Convert to async middleware |
| A23 | LOW | Code Quality | `src/auth.js` | 117 | Login attempt reset buried in DB function instead of explicit in auth logic. | Minor readability concern |
| A24 | LOW | Validation | `src/routes/auth.js` | 22 | No email format validation — `toLowerCase().trim()` only. Won't cause injection but pollutes audit logs. | Add email format validation |
| A25 | LOW | Logging | `src/routes/auth.js` | 28 | `X-Forwarded-For` is spoofable. Spoofed IPs in audit logs reduce forensic value. | Configure Express `trust proxy` and use `req.ip` |
| A26 | LOW | DoS | `src/routes/auth.js` | — | No request body size limit on auth endpoints. Large payloads consume memory. | Apply `express.json({ limit: '10kb' })` |
| A27 | LOW | Perf | `src/routes/auth.js` | 47 | Logout endpoint makes unnecessary DB query through `requireAuth`. | Minor; acceptable |
| A28 | LOW | Error Handling | `src/routes/auth.js` | 46-49 | Missing try/catch around logout `logAction()`. Logging failure returns 500 for logout. | Wrap in try/catch; return success even if log fails |
| A29 | LOW | Validation | `src/services/secrets.js` | 47-51 | No validation that secret values are well-formed (JWT_SECRET length, API key format). | Add basic validation for critical secrets |
| A30 | LOW | Logging | `src/services/secrets.js` | 51,55-59,71 | Logs include AWS secret names/paths. Could help attacker target secrets via log access. | Reduce log verbosity for secret ops in production |
| A31 | LOW | Resilience | `src/services/secrets.js` | 146-148 | `clearCache()` wipes entire cache with no per-key refresh. | Add per-key refresh and background refresh mechanism |
| A32 | LOW | Resilience | `src/services/secrets.js` | — | No circuit breaker for AWS calls. If AWS is down, every request retries and times out. | Implement circuit breaker with cooldown |
| A33 | LOW | Access Control | `src/services/secrets.js` | 146 | `clearCache()` exported without access control. Accidental call causes latency spike. | Add guard for production environments |
| A34 | LOW | Encoding | `src/services/secrets.js` | 70 | Database URL built with string interpolation + `encodeURIComponent`. Edge cases possible. | Use URL builder or pg config object |
| A35 | LOW | Code Quality | `src/auth.js` | 117 | `failed_login_attempts` reset buried in DB function. | Minor readability concern |

### Payments

| # | Severity | Category | File | Line(s) | Description | Recommendation |
|---|----------|----------|------|---------|-------------|----------------|
| P1 | **CRITICAL** | Idempotency | `src/api.js` | 57-159 | No webhook event deduplication. Stripe retries process events multiple times, causing inconsistent state. | Track processed event IDs in DB/Redis |
| P2 | **HIGH** | Input Validation | `src/routes/billing.js` | 59 | No `priceId` validation — any Stripe price accepted. Attacker could subscribe at test/legacy prices. | Validate against allowlist of known price IDs |
| P3 | **HIGH** | Race Condition | `src/routes/billing.js` | 64-76 | TOCTOU race in customer creation. Concurrent clicks create duplicate Stripe customers. | Use advisory lock, unique constraint, or idempotency key |
| P4 | **HIGH** | Rate Limiting | `src/api.js` | 246 | No rate limiter on billing routes. Spam `create-checkout` to exhaust Stripe rate limits (DoS). | Add `billingLimiter` (5 req/min per user) |
| P5 | **HIGH** | Missing Handler | `src/api.js` | 78-152 | No `invoice.payment_failed` webhook handler. Users retain access after payment failure until Stripe updates status. | Add handler to set status `past_due` and notify user |
| P6 | MEDIUM | Info Leak | `src/api.js` | 72 | Webhook signature error message returned verbatim, leaking internal details. | Return generic "Invalid webhook signature" |
| P7 | MEDIUM | Authz | `src/routes/billing.js` | 104-106 | Portal session trusts stored `stripe_customer_id` without cross-validating against authenticated user. | Cross-validate customer email/metadata |
| P8 | MEDIUM | CSRF | `src/routes/billing.js` | 52,97 | State-changing billing endpoints lack explicit CSRF protection. Safe with Bearer tokens but fragile. | Document invariant; add CSRF if cookies are ever used |
| P9 | MEDIUM | Rate Limiting | `src/api.js` | 57 | No rate limiting on webhook endpoint. Stolen secret enables flood attack on DB. | Add IP-based rate limiting or use event queue |
| P10 | MEDIUM | Scalability | `src/api.js` | 77-158 | Synchronous webhook processing. Slow DB = Stripe timeouts = retries = duplicates (compounds P1). | Acknowledge 200 immediately; process via job queue |
| P11 | LOW | Info Exposure | `src/routes/billing.js` | 38 | `stripe_subscription_id` exposed in status response. Frontend doesn't need it. | Remove from response |
| P12 | LOW | Data Integrity | `src/db.js` | 1489-1500 | `COALESCE` in upsert prevents intentionally setting fields to NULL. Footgun for future changes. | Use dedicated `clearSubscription` for cancellation |
| P13 | LOW | Hardcoding | `src/api.js` | 89 | `plan: 'pro'` hardcoded in checkout completion. Breaks when multiple tiers are added. | Derive plan from Stripe price/product metadata |

### Database

| # | Severity | Category | File | Line(s) | Description | Recommendation |
|---|----------|----------|------|---------|-------------|----------------|
| D1 | **CRITICAL** | SQL Injection | `src/db.js` | 1741-1748 | Raw `query(text, params)` export. If any caller concatenates user input into `text`, it's direct SQL injection. | Remove export; replace with purpose-built functions |
| D2 | **HIGH** | IDOR | `src/db.js` | 436,495,1162,991 | `getJob()`, `updateJob()`, `getClient()`, `updateClient()` have no `user_id` filter. Any authenticated user can access any record by ID. | Add `user_id` as required parameter in WHERE clause |
| D3 | **HIGH** | Data Leak | `src/db.js` | 90,108 | `SELECT *` on users table returns `password_hash`, `failed_login_attempts`, `locked_until`. Accidental serialization leaks hashes. | Use explicit column list; create `SAFE_USER_COLUMNS` constant |
| D4 | **HIGH** | Token Security | `src/db.js` | 1556-1586 | Google OAuth tokens (access + refresh) stored in plaintext. DB compromise = Google Calendar access for all users. | Encrypt at rest with AES-256-GCM (key from AWS KMS) |
| D5 | **HIGH** | Scalability | `src/db.js` | 174 | `listUsers()` — unbounded `SELECT` with `LEFT JOIN`, no LIMIT. Exhausts memory as users grow. | Remove; use `listUsersPaginated()` only |
| D6 | **HIGH** | Scalability | `src/db.js` | 1299 | `getJobsByCompany()` — unbounded, plus `COALESCE` in ORDER BY prevents index use. | Remove; use paginated version |
| D7 | **HIGH** | Scalability | `src/db.js` | 1218-1234 | `listCompanies()` — correlated subqueries (2 per row). 100 companies = 200 extra scans. | Rewrite with `LEFT JOIN ... GROUP BY` |
| D8 | **HIGH** | Missing Indexes | `src/db.js` / migration | — | Critical indexes missing: `jobs(user_id)`, `jobs(company_id)`, `jobs(status)`, `users(email)`, `users(company_id)`. | Add migration with all missing indexes |
| D9 | **HIGH** | Data Integrity | `migrations/001_baseline.cjs` | 140,172,66,90,112 | Missing FK constraints on `subscriptions.user_id`, `calendar_tokens.user_id`, `job_versions`, `clients`, `properties`. Orphaned records possible. | Add FK constraints with appropriate ON DELETE |
| D10 | **HIGH** | Data Integrity | `src/db.js` | 1388-1408 | `assignUserToCompany()` runs two UPDATEs without a transaction. Partial failure = inconsistent state. | Wrap in BEGIN/COMMIT/ROLLBACK transaction |
| D11 | MEDIUM | ID Security | `src/db.js` | 158,240,777,967,1100,1185 | `Math.random()` for ID generation — not cryptographically secure. Partially predictable with known creation time. | Use `crypto.randomUUID()` |
| D12 | MEDIUM | Missing Index | migration | — | `stripe_subscription_id` stored without index or unique constraint. Full table scan + possible duplicates. | Add unique index |
| D13 | MEDIUM | Scalability | `src/db.js` | 918,1042 | `getClients()` and `getProperties()` unbounded — no LIMIT. | Deprecate or add hard cap |
| D14 | MEDIUM | Performance | `src/db.js` | 352,1309,1334 | `COALESCE(updated_at, created_at::TIMESTAMP)` in ORDER BY prevents index usage, forces full sort. | Backfill NULLs; add NOT NULL with DEFAULT; sort on `updated_at` directly |
| D15 | MEDIUM | Pool Config | `src/db.js` | 70 | Connection pool `max: 10` hardcoded. May be insufficient for multi-tenant use. | Make configurable via `DB_POOL_MAX` env var; default 20 |
| D16 | MEDIUM | Resilience | `src/db.js` | 66-77 | No `pool.on('error', ...)` handler. Unexpected disconnection = unhandled error = crash. | Add pool error handler |
| D17 | MEDIUM | Error Handling | `src/db.js` | various | Inconsistent error handling: some throw, some swallow and return empty, some return nothing. | Standardize: throw on writes, return null/empty on reads |
| D18 | MEDIUM | Schema Drift | `migrations/001_baseline.cjs` | — | Core tables (`users`, `jobs`, `audit_log`, `companies`) not in migration. Schema unversioned. | Create migration 002 to capture existing schemas |
| D19 | MEDIUM | Dead Code | `src/db.js` | 586,629,663,745,873,1415,1526 | Seven `ensure*` functions duplicate migration logic. Marked deprecated but still exported. | Remove entirely |
| D20 | MEDIUM | Scalability | migration | 89,110,64 | TEXT primary keys on `clients`, `properties`, `job_versions`. Slower B-tree comparisons, more disk space. | Use UUID for new tables |
| D21 | MEDIUM | Data Integrity | migration | — | No `updated_at` auto-update trigger. App code sets it inconsistently. | Add PostgreSQL trigger function |
| D22 | MEDIUM | Data Integrity | migration | — | No CHECK constraints on status/plan/role columns. Any value accepted. | Add CHECK constraints for enum columns |
| D23 | MEDIUM | Missing Index | migration | — | Composite indexes missing: `properties(user_id, address)`, `jobs(user_id, status)`, `job_versions(job_id, user_id)`. | Add in index migration |
| D24 | MEDIUM | Scalability | `src/api.js` | 246 | Webhook handler doesn't scale horizontally without idempotency (compounds P1). | Implement event deduplication |
| D25 | LOW | Timestamps | `src/db.js` | various | Mixed `new Date().toISOString()` vs SQL `NOW()`. Timezone mismatch if DB not set to UTC. | Standardize on `NOW()` or ensure `SET timezone = 'UTC'` |
| D26 | LOW | Ergonomics | `src/db.js` | various | No `RETURNING` on UPDATE operations. Callers need separate SELECT for updated state. | Add `RETURNING` to UPDATE queries where useful |
| D27 | LOW | Code Quality | `src/db.js` | 512 vs 286 | Inconsistent column quoting in dynamic queries (quoted in `updateJob`, unquoted in `updateUser`). | Always quote column names |
| D28 | LOW | Migration | `migrations/001_baseline.cjs` | 191 | No rollback (`down = false`). Acceptable for baseline. | Ensure future migrations include `down` |
| D29 | LOW | Type Consistency | `migrations/001_baseline.cjs` | 44 vs 66,90,112 | `push_subscriptions.user_id` is `varchar(255)` while all others are `text`. | Standardize to one type |
| D30 | LOW | Data Integrity | migration | — | `subscriptions.stripe_customer_id` nullable but meaningless for paid plans. | Consider NOT NULL for non-free subscriptions |
| D31 | LOW | Data Integrity | `src/db.js` | various | Deprecated `ensure*` functions could create tables with different schemas than migration. | Remove deprecated functions |
| D32 | LOW | Scalability | `src/db.js` | — | No pool stats monitoring. Hard to diagnose connection exhaustion. | Add pool event listeners for monitoring |

---

## Recommendations Priority Matrix

### Quick Fixes (< 1 hour each, high impact)

| Finding | Description | Impact |
|---------|-------------|--------|
| A1, A2 | Switch `bcrypt.compareSync`/`hashSync` to async `compare`/`hash` | Eliminates event loop blocking DoS |
| A4, A5 | Increment `token_version` on password change and account deletion | Immediate token invalidation |
| A3 | Strengthen password policy (8+ chars, complexity, 72-byte guard) | Prevents weak credentials |
| A11 | Add `{ algorithms: ['HS256'] }` to `jwt.verify()` calls | Prevents algorithm confusion |
| P2 | Add priceId allowlist validation | Prevents arbitrary subscription creation |
| P6 | Return generic webhook error message | Stops information leakage |
| P13 | Derive plan from Stripe metadata instead of hardcoding `'pro'` | Future-proofs multi-tier billing |
| D3 | Replace `SELECT *` with explicit columns in user queries | Prevents password hash leakage |
| D16 | Add `pool.on('error', ...)` handler | Prevents crash on DB disconnect |
| D15 | Make pool size configurable via env var | Easy scalability win |

### Medium Effort (1-4 hours each)

| Finding | Description | Impact |
|---------|-------------|--------|
| P1 | Implement webhook event deduplication (event ID tracking in DB/Redis) | Prevents duplicate processing on Stripe retries |
| P3 | Add Stripe idempotency key to customer creation | Eliminates duplicate customer race condition |
| P4 | Add `billingLimiter` to billing routes | Prevents Stripe rate limit exhaustion |
| P5 | Add `invoice.payment_failed` webhook handler | Correct subscription status on payment failure |
| D2 | Add `user_id` parameter to `getJob`, `updateJob`, `getClient`, `updateClient` | Closes IDOR vulnerabilities |
| D8, D23 | Create migration adding all missing indexes | Major query performance improvement |
| D9 | Add FK constraints to all `user_id` columns | Prevents orphaned records |
| D10 | Wrap `assignUserToCompany()` in transaction | Ensures data consistency |
| A7 | Atomic compare-and-swap for token version in refresh | Prevents token rotation bypass |
| A8 | Implement token invalidation on logout (version increment or Redis blacklist) | Complete session management |
| A9 | Create `requireAccessToUser` middleware | Defense-in-depth against IDOR |
| D11 | Replace `Math.random()` with `crypto.randomUUID()` for ID generation | Eliminates ID predictability |

### Large Refactor (4+ hours / multi-session)

| Finding | Description | Impact |
|---------|-------------|--------|
| D1 | Audit all callers of raw `query()`, replace with purpose-built functions, remove export | Eliminates SQL injection risk |
| D4 | Implement encryption at rest for OAuth tokens (AES-256-GCM + KMS) | Protects Google Calendar access |
| D5, D6, D7, D13 | Remove all unbounded query functions, rewrite `listCompanies` with JOINs | Prevents memory exhaustion at scale |
| A10 | Add Redis caching for user auth state (replace per-request DB lookup) | Reduces auth DB load by ~90% |
| P10 | Move webhook processing to async job queue (BullMQ) | Eliminates Stripe timeout retries |
| A15, A16 | Refactor secrets to TTL cache + getter pattern (remove process.env storage) | Supports secret rotation; reduces exposure |
| D18 | Capture core tables (users, jobs, audit_log, companies) in versioned migrations | Schema integrity and reproducibility |
| D19 | Remove all deprecated `ensure*` functions | Eliminates schema drift risk |
| D21, D22 | Add `updated_at` triggers and CHECK constraints across all tables | Database-level data integrity |

---

## Scalability Roadmap

### At 100 Users (Current Scale) — Mostly Fine

**What works:** The current architecture handles 100 users adequately. Parameterized queries, bcrypt hashing, and basic auth are functional.

**What's already painful:**
- Synchronous bcrypt (A1/A2): With 10+ concurrent logins, the event loop blocks. A burst of password resets could hang the entire app for seconds.
- `listUsers()` without LIMIT (D5): Admin pages loading all 100 users is fine, but it's already an anti-pattern.

**Fix now:** Async bcrypt, add billing rate limiter.

### At 1,000 Users — Significant Pain Points

**What breaks:**
- **Database connections exhaust** (D15): 10-connection pool with per-request auth DB lookups (A10) = ~10 concurrent requests max. With 1K users, peak traffic will queue and timeout.
- **Missing indexes hurt** (D8): `jobs(user_id)` queries go from 10ms to 100ms+. Login via `getUserByEmail` scans the full `users` table without an index on `email`.
- **Unbounded queries crash** (D5/D6/D7): `listUsers()` returns 1,000 rows with JOIN. `listCompanies()` fires 2 correlated subqueries per company row. `getJobsByCompany()` for an active company could return 10,000+ jobs.
- **Webhook race conditions materialize** (P1/P3): With 1K subscribers, payment events are frequent enough that duplicate processing and duplicate customer creation become real issues.
- **Memory grows** (A15): All secrets cached forever; more user sessions mean more JWT verifications, more DB queries.

**Fix by 1K:** Add indexes, remove unbounded queries, implement webhook idempotency, increase pool size, add Redis for auth caching.

### At 10,000 Users — Architecture Changes Required

**What breaks:**
- **Single-server is insufficient**: Need horizontal scaling, but webhook handler (P1/D24) and customer creation (P3) have no idempotency — duplicates multiply with multiple instances.
- **Database becomes the bottleneck**: Without FK constraints (D9), orphaned data accumulates. Without `updated_at` triggers (D21), data integrity degrades. `listCompanies()` with correlated subqueries becomes unusable. TEXT primary keys (D20) bloat indexes.
- **Connection pool needs PgBouncer**: Even `max: 50` may not suffice. Need connection pooler in front of PostgreSQL.
- **Auth per-request DB lookup is untenable** (A10): 10K users × multiple requests/minute = thousands of auth DB queries per minute just for `is_active` checks.
- **Webhook processing must be async** (P10): Synchronous processing under load causes Stripe timeouts, which cause retries, which cause more load — a cascading failure.
- **Secret management needs rotation** (A15): With 10K users, a compromised JWT_SECRET means 10K tokens to invalidate. Need rotation support.
- **Audit log grows unbounded**: No index, no partitioning, no retention policy. Query performance degrades.

**Required for 10K:**
1. Redis for auth caching and token blacklisting
2. PgBouncer or similar connection pooler
3. Async webhook processing via job queue (BullMQ already in project)
4. All missing indexes + FK constraints
5. Horizontal scaling with idempotent operations
6. Audit log partitioning and retention
7. Monitoring/alerting on pool exhaustion, slow queries, webhook failures

---

## Appendix: Methodology Notes

- **Review type:** Static code analysis (manual read-through of source files)
- **Tools:** Claude AI code review with structured finding format
- **Codex second opinion:** All three phases attempted OpenAI Codex review via MCP tool but received 401 Unauthorized errors. The Codex auth token appears expired. All 80 findings are from a single reviewer.
- **Scope limitations:** Only server-side code was reviewed. Frontend, infrastructure (AWS config, nginx), CI/CD pipelines, and dependency vulnerabilities (npm audit) were not in scope.
- **Recommended follow-up:** Run `npm audit` for dependency vulnerabilities, review frontend for XSS/CSP issues, and re-attempt Codex second opinion after fixing API auth.
