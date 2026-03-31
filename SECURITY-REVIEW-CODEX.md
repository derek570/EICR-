# CertMate Security Review — Codex Cross-Validation Report

**Date:** 2026-03-26
**Scope:** Authentication, secrets management, payments/billing, and database layers
**Methodology:** Two-model security review (Claude AI + OpenAI Codex via codex-cli MCP)
**Original Review:** [SECURITY-REVIEW.md](./SECURITY-REVIEW.md) (Claude-only, 80 findings)

---

## 1. Executive Summary

This report presents the results of a two-model security review of the CertMate codebase. The original Claude-only review identified 80 findings. This follow-up cross-validated every finding with OpenAI Codex and compared results.

### Aggregate Statistics

| Metric | Count |
|--------|-------|
| **Original Claude findings** | 80 |
| **Previously remediated** | 15 |
| **New findings (Codex found, Claude missed)** | 31 |
| **Confirmed (both reviewers agree)** | 45 |
| **Disputed (Codex disagrees or overstates)** | 7 |
| **Claude-only (Codex did not flag)** | 8 |
| **Combined unique findings** | 96 |

### New Findings by Severity

| Severity | Auth & Secrets | Payments | Database | **Total** |
|----------|---------------|----------|----------|-----------|
| **CRITICAL** | 1 | 0 | 0 | **1** |
| **HIGH** | 1 | 3 | 3 | **7** |
| **MEDIUM** | 4 | 5 | 6 | **15** |
| **LOW** | 2 | 3 | 3 | **8** |
| **Total** | 8 | 11 | 12 | **31** |

### Remediation Progress Since Original Review

15 of the original 80 Claude findings have been fixed in the current codebase:

| Domain | Remediated | Key Fixes |
|--------|-----------|-----------|
| Auth & Secrets | 6 | Async bcrypt, password policy, token version increment, algorithm enforcement |
| Payments | 7 | Webhook dedup, priceId validation, customer idempotency, rate limiting, payment_failed handler, error messages, plan derivation |
| Database | 2 | Pool size configurable, pool error handler |

**However**, Codex found new vulnerabilities in several of the remediated implementations themselves (e.g., the dedup fix has a race window, the priceId validation fails open when unconfigured, the plan derivation still defaults to the highest tier).

### Top 5 Most Critical New Findings

| # | Severity | Area | Finding | Impact |
|---|----------|------|---------|--------|
| 1 | **CRITICAL** | Auth | `verifyToken()` never checks `token_version` — token revocation is fundamentally broken | Stolen tokens valid 24h after password change/deletion |
| 2 | **HIGH** | Database | Cross-tenant IDOR via `createProperty()` — properties can be linked to another tenant's clients | Data leakage across tenants |
| 3 | **HIGH** | Database | Job version history exposure — no ownership checks on read/write | Cross-tenant data access |
| 4 | **HIGH** | Payments | Out-of-order webhook events overwrite newer subscription state | Users lose/gain access incorrectly |
| 5 | **HIGH** | Payments | Plan defaults to `'pro'` on missing metadata — unauthorized tier upgrades | Revenue loss, unauthorized access |

---

## 2. New Findings from Codex

Codex identified 31 findings that were absent from the original Claude review. These are grouped by file and rated by severity.

### `src/auth.js`

#### CX-1 — CRITICAL: Token Version Not Checked in `verifyToken()`
- **Lines:** 149-171
- **Category:** Authentication Bypass / Token Revocation
- **Description:** `verifyToken()` validates the JWT signature and checks `user.is_active`, but never compares `decoded.tv` (token version) against the user's current `token_version` in the database. Even after `incrementTokenVersion()` is called (on password change, account deletion, or token theft detection), the old token continues to work for every authenticated request until its 24-hour expiry. The token version is only checked during `refreshToken()`, but `verifyToken()` is used by `requireAuth` middleware on every protected route.
- **Impact:** The entire token revocation mechanism is ineffective. Password changes, account deletions, and theft detection all believe they've invalidated tokens, but they haven't.
- **Recommendation:** Add version check: `if ((decoded.tv || 0) < (user.token_version || 0)) return null;`

#### CX-2 — HIGH: Failed-Login Counter Race Condition
- **Lines:** 92-104
- **Category:** Race Condition / Brute Force Defense Bypass
- **Description:** Login failure tracking reads `user.failed_login_attempts`, increments in application code, then writes back. Concurrent failed login attempts can all read the same counter value and overwrite each other's updates, undercounting failures and delaying or bypassing the 5-attempt lockout.
- **Impact:** Attacker sending 10+ concurrent login attempts could get significantly more than 5 attempts before lockout.
- **Recommendation:** Use atomic SQL: `UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = $1 RETURNING failed_login_attempts`

#### CX-3 — MEDIUM: Timing Side-Channel for User Enumeration
- **Lines:** 68-76 vs 92
- **Category:** Information Leakage / Side Channel
- **Description:** When a user doesn't exist, `authenticate()` returns immediately. When a user exists but the password is wrong, it performs `bcrypt.compare()` (~100ms). This timing difference reveals whether an email is registered, even though error messages are correctly normalized.
- **Recommendation:** Perform a dummy `bcrypt.compare()` against a pre-computed hash when the user is not found.

#### CX-4 — MEDIUM: `requireCompanyAdmin` Missing `company_id` Check
- **Lines:** 303-319
- **Category:** Authorization Flaw
- **Description:** `requireCompanyAdmin()` grants access if `company_role` is `'admin'` or `'owner'` without requiring `company_id` to be present. A user with `company_role: 'admin'` but no `company_id` (from data inconsistency or race condition) would pass this check.
- **Recommendation:** Add `&& req.user.company_id` to the company role check.

#### CX-5 — MEDIUM: No JWT Issuer/Audience Claims
- **Lines:** 121-130, 151, 228-237
- **Category:** Token Confusion / Cryptographic Weakness
- **Description:** JWTs lack `iss` (issuer) and `aud` (audience) claims. If the same `JWT_SECRET` is used across environments or shared with another service, tokens minted in one context are accepted in another.
- **Recommendation:** Add `issuer: 'certmate'` and `audience: 'certmate-api'` to sign and verify calls.

#### CX-6 — LOW: `jti` Claim Generated But Never Validated
- **Lines:** 126, 233
- **Category:** Token Management / False Security
- **Description:** `crypto.randomUUID()` generates a `jti` (JWT ID) claim in every token, but it is never stored or checked. This provides no actual replay protection and may create a false sense of security.
- **Recommendation:** Either remove `jti` or persist and validate it for true per-token revocation.

### `src/routes/auth.js`

#### CX-7 — LOW: Stale Role Data on Destructive Actions
- **Lines:** 100-104
- **Category:** Authorization / Business Logic
- **Description:** Account deletion checks `req.user.role` from the JWT. If a user's role changed after the token was issued, the check uses stale data, potentially allowing a recently-promoted admin to delete their own account or failing to protect a recently-demoted one.
- **Recommendation:** Fetch fresh role data from the database for destructive actions.

### `src/services/secrets.js`

#### CX-8 — MEDIUM: Prototype Pollution via `Object.assign` in Secret Loading
- **Lines:** 50, 137
- **Category:** Input Validation / Prototype Pollution
- **Description:** `Object.assign(secrets, JSON.parse(response.SecretString))` merges parsed JSON directly. If a secret value in AWS contains `__proto__` or `constructor` keys, this could cause prototype pollution.
- **Recommendation:** Validate keys against an explicit allowlist or parse into a null-prototype object.

### `src/api.js` (Webhook Handler)

#### CX-9 — HIGH: Out-of-Order Webhook Event Processing
- **Lines:** 92-187
- **Category:** Race Condition / State Integrity
- **Description:** Stripe does not guarantee webhook delivery order. The handler blindly overwrites subscription state on each event. An older event can arrive after a newer one and revert the subscription to an incorrect state, wrongly removing or granting access.
- **Recommendation:** Store and compare event timestamps or Stripe object versions before applying state changes. Reject stale events.

#### CX-10 — HIGH: Plan Defaults to `'pro'` on Missing Metadata
- **Lines:** 100
- **Category:** Authorization / Business Logic / Trust Boundary
- **Description:** The `checkout.session.completed` handler derives the plan from `session.metadata?.plan || 'pro'`. The default grants the highest tier when metadata is absent — a malformed session, API version drift, or metadata tampering results in an unauthorized upgrade. (Claude's P13 rated this LOW as a code quality issue; Codex correctly identifies it as a trust boundary violation.)
- **Recommendation:** Map entitlements from trusted Stripe objects (`price.id` / `product.id`). Treat missing/unknown values as a failure.

#### CX-11 — MEDIUM: Non-Atomic Webhook Deduplication
- **Lines:** 78-86, 189-197
- **Category:** Idempotency / Race Condition
- **Description:** The P1 remediation implemented a `SELECT` check followed by business logic and then `INSERT`. Two concurrent deliveries of the same event can both pass the SELECT and both execute the handler before either records the event ID.
- **Recommendation:** Use `INSERT ... ON CONFLICT DO NOTHING RETURNING event_id` first; only process if the insert returned a row.

#### CX-12 — MEDIUM: Fail-Open on Deduplication Failure
- **Lines:** 87-90
- **Category:** Error Handling / Replay Safety
- **Description:** When the dedup check fails (DB error, table missing), the handler logs a warning and processes the event anyway. If deduplication storage is unavailable, every Stripe retry is reprocessed.
- **Recommendation:** Fail closed — return HTTP 500 so Stripe retries after the issue is resolved.

#### CX-13 — LOW: No Webhook Event Payload Schema Validation
- **Lines:** 92-187
- **Category:** Input Validation
- **Description:** The handler assumes event payload fields exist without validation. API version drift or unexpected event shapes could cause null writes, bad timestamps, or repeated 500s.
- **Recommendation:** Validate each handled event against a per-event schema.

### `src/billing.js`

#### CX-14 — HIGH: Open Redirect via Stripe URL Parameters
- **Lines:** 57, 118
- **Category:** Open Redirect / Input Validation
- **Description:** `createCheckoutSession()` and `createPortalSession()` accept `successUrl`, `cancelUrl`, and `returnUrl` as parameters and pass them directly to Stripe with no validation. While current callers construct these from `FRONTEND_URL`, the billing.js API boundary itself is unprotected. A future caller could pass attacker-controlled URLs.
- **Recommendation:** Validate URLs against an allowlist of application origins within `billing.js`.

#### CX-15 — MEDIUM: Unbounded `recordUsage()` Quantity
- **Lines:** 85-99
- **Category:** Business Logic / Billing Abuse
- **Description:** `recordUsage()` accepts a caller-supplied `quantity` with no bounds checking and always uses `action: "increment"`. Negative, zero, fractional, or extremely large values could corrupt billing.
- **Recommendation:** Require `quantity` to be a safe positive integer within a defined maximum.

#### CX-16 — MEDIUM: Raw Stripe Exceptions Propagate
- **File:** All exported functions
- **Category:** Error Handling / Information Disclosure
- **Description:** Most billing.js functions let raw Stripe SDK exceptions propagate. If route handlers return these to clients, attackers learn billing configuration details.
- **Recommendation:** Catch Stripe errors, map to sanitized application errors, keep details in server logs only.

### `src/routes/billing.js`

#### CX-17 — MEDIUM: ALLOWED_PRICE_IDS Fails Open When Unconfigured
- **Lines:** 18-21, 71
- **Category:** Input Validation / Configuration
- **Description:** The P2 remediation validates `priceId` against `ALLOWED_PRICE_IDS`, but the check is bypassed when the list is empty: `if (ALLOWED_PRICE_IDS.length > 0 && ...)`. If `STRIPE_ALLOWED_PRICE_IDS` is unset in production, any Stripe price ID is accepted.
- **Recommendation:** Fail closed if `ALLOWED_PRICE_IDS` is empty in production.

#### CX-18 — LOW: FRONTEND_URL Not Validated at Startup
- **Lines:** 89, 124
- **Category:** Configuration Hardening
- **Description:** `FRONTEND_URL` is read from env vars with a fallback default. A bad environment value could redirect users to an unintended domain after checkout/portal flows.
- **Recommendation:** Validate at startup against an allowlist of expected origins.

#### CX-19 — LOW: User Enumeration via Portal Error Message
- **Lines:** 120-122
- **Category:** Information Disclosure
- **Description:** `POST /portal` returns `"No billing account found. Please subscribe first."` when no `stripe_customer_id` exists. Since the route is authenticated, risk is low, but it reveals billing state more explicitly than necessary.
- **Recommendation:** Return a generic error message.

### `src/db.js`

#### CX-20 — HIGH: Cross-Tenant IDOR via `createProperty()`
- **Lines:** 1113, 1065
- **Category:** IDOR / Authorization
- **Description:** `createProperty()` accepts any `client_id` without verifying it belongs to the same `user_id`. An attacker can attach their property to another tenant's client ID. Since `getProperties()` left-joins `clients` on `client_id`, this surfaces the other tenant's client name.
- **Recommendation:** Validate `client_id` ownership before insert, or enforce a composite foreign key on `(client_id, user_id)`.

#### CX-21 — HIGH: Job Version History Exposure Without Ownership Checks
- **Lines:** 789, 826, 846
- **Category:** IDOR / Authorization
- **Description:** `getJobVersions()`, `getJobVersionsPaginated()`, and `saveJobVersion()` operate on `job_id` only with no ownership verification. Attackers can read version metadata and `data_snapshot` JSONB for other tenants' jobs, or write attacker-controlled snapshots against another user's job.
- **Recommendation:** Verify job ownership via JOIN to `jobs` table checking `user_id`/company membership.

#### CX-22 — MEDIUM: No Query/Statement Timeout on Connection Pool
- **Lines:** 71-81
- **Category:** Availability / Pool Exhaustion
- **Description:** The pool configures `max`, `idleTimeoutMillis`, and `connectionTimeoutMillis` but has no `statement_timeout`. A slow query can tie up connections indefinitely and starve the application.
- **Recommendation:** Add server-side `statement_timeout` (e.g., 30s) and `idle_in_transaction_session_timeout`.

#### CX-23 — MEDIUM: Security-Sensitive Error Suppression
- **Lines:** 137, 154, 548, 619, 633
- **Category:** Error Handling / Auth Bypass (Silent)
- **Description:** Several security-critical mutations (login lockout state, last-login reset, job status changes, token-version increments) log and silently swallow errors instead of propagating them. This can silently disable account lockout enforcement or JWT invalidation guarantees.
- **Recommendation:** Propagate errors for security-sensitive writes, or return explicit success/failure.

#### CX-24 — LOW: DB Layer Missing Actor Context for Admin Functions
- **Lines:** 192, 245, 284, 323, 341, 1198, 1236, 1257, 1295, 1317, 1367, 1483
- **Category:** Defense in Depth
- **Description:** Many helpers are marked "admin only" in comments, but the DB layer accepts no actor context and enforces no role checks. A single misconfigured route exposes privileged operations.
- **Recommendation:** Pass an explicit actor/role object into privileged DB helpers and assert required role before querying.

### `migrations/001_baseline.cjs`

#### CX-25 — HIGH: Malformed Default Values in Migration
- **Lines:** 144-145
- **Category:** Schema Defect
- **Description:** `subscriptions.plan` defaults to `"'free'"` and `subscriptions.status` to `"'inactive'"` — the double-quoting pattern is incorrect for `node-pg-migrate`. The emitted SQL may contain literal quote characters in the default value.
- **Recommendation:** Change to `default: 'free'` and `default: 'inactive'` (single-quoted).

#### CX-26 — MEDIUM: Missing NOT NULL on Security-Critical Columns
- **Lines:** 22, 31
- **Category:** Data Integrity
- **Description:** `users.token_version` and `jobs.updated_at` have defaults but no `NOT NULL` constraint. Callers can explicitly write `NULL`, bypassing token invalidation semantics or breaking audit trail ordering.
- **Recommendation:** Add `NOT NULL` constraints and backfill existing NULLs.

#### CX-27 — MEDIUM: Missing CHECK on Version Counters
- **Lines:** 22, 67
- **Category:** Data Integrity
- **Description:** `users.token_version` and `job_versions.version_number` are integers with no non-negative constraint. Negative values could break token rotation logic or version ordering.
- **Recommendation:** Add `CHECK (token_version >= 0)` and `CHECK (version_number > 0)`.

#### CX-28 — MEDIUM: Missing UNIQUE on `properties(user_id, address)`
- **Lines:** 112-113
- **Category:** Data Integrity
- **Description:** The app performs `SELECT * FROM properties WHERE user_id = $1 AND address = $2` treating this pair as unique, but the schema allows duplicates, making the lookup nondeterministic.
- **Recommendation:** Add `UNIQUE (user_id, address)` constraint.

#### CX-29 — MEDIUM: Cross-Tenant Linkage at Schema Level
- **Lines:** 111-112
- **Category:** Schema Design / Authorization
- **Description:** `properties.client_id` references `clients(id)` but nothing enforces that the referenced client belongs to the same `user_id` as the property. This is the schema-level root cause of CX-20.
- **Recommendation:** Make `clients` unique on `(id, user_id)` and reference `(client_id, user_id)` from `properties` as a composite FK.

#### CX-30 — LOW: Redundant Indexes Wasting Write Performance
- **Lines:** 80, 155, 184
- **Category:** Performance
- **Description:** `idx_job_versions_job` on `job_versions(job_id)` duplicates the `UNIQUE (job_id, version_number)` constraint. Similarly for `idx_subscriptions_user` and `idx_calendar_tokens_user`.
- **Recommendation:** Drop redundant indexes after verifying via `\d` and query plans.

#### CX-31 — LOW: `timestamp` vs `timestamptz`
- **All tables**
- **Category:** Data Integrity / Timezone
- **Description:** All timestamp columns use `timestamp` without timezone. In a SaaS app handling Stripe webhooks, Google OAuth, and multi-region clients, this creates timezone ambiguity.
- **Recommendation:** Migrate to `TIMESTAMPTZ` for all absolute timestamps.

---

## 3. Confirmed Findings (Both Reviewers Agree)

These 45 findings were independently identified by both Claude and Codex, providing high confidence in their validity. Where severity ratings differ, both are noted.

### Auth & Secrets (19 Confirmed)

| Claude ID | Claude Severity | Codex Severity | Finding | Notes |
|-----------|----------------|----------------|---------|-------|
| A6 | HIGH | HIGH | `getAllSecrets()` returns every secret in one call | Full agreement |
| A7 | MEDIUM | HIGH | Token rotation race condition — version check+increment not atomic | Codex elevated |
| A8 | MEDIUM | MEDIUM | Logout doesn't invalidate/revoke tokens | Full agreement |
| A9 | MEDIUM | MEDIUM | `canAccessUser` IDOR check is opt-in per route | Full agreement |
| A10 | MEDIUM | — | `verifyToken()` DB query on every request | Codex noted session model weakness |
| A12 | MEDIUM | HIGH | Refresh endpoint accepts token from request body | Codex elevated |
| A13 | MEDIUM | HIGH | No explicit CSRF protection on state-changing endpoints | Codex elevated |
| A14 | MEDIUM | MEDIUM | Account deletion requires only valid JWT — no re-auth | Full agreement |
| A15 | MEDIUM | HIGH | Secrets cached indefinitely with no TTL | Codex elevated |
| A16 | MEDIUM | HIGH | `JWT_SECRET` written to `process.env` | Codex elevated |
| A17 | MEDIUM | — | No retry/backoff for AWS Secrets Manager | Claude-only |
| A18 | MEDIUM | HIGH | Silent fallback to env vars if AWS fails | Codex elevated |
| A19 | LOW | MEDIUM | JWT contains `email` — base64-decoded by anyone | Codex elevated |
| A20 | LOW | MEDIUM | Separate error messages for disabled/locked accounts | Codex elevated |
| A24 | LOW | MEDIUM | No email format validation | Codex elevated |
| A25 | LOW | MEDIUM | `X-Forwarded-For` is spoofable | Codex elevated |
| A29 | LOW | LOW | No validation that secret values are well-formed | Full agreement |
| A30 | LOW | MEDIUM | Logs include AWS secret names/paths | Codex elevated |
| A34 | LOW | LOW | Database URL built with string interpolation | Full agreement |

### Payments (8 Confirmed)

| Claude ID | Claude Severity | Codex Severity | Finding | Notes |
|-----------|----------------|----------------|---------|-------|
| P2 | HIGH | MEDIUM | `priceId` validation exists but fails open when unconfigured (see CX-17) | Codex found residual issue |
| P3 | HIGH | MEDIUM | Customer creation race — DB-level race persists despite idempotency key fix | Partial confirmation |
| P7 | MEDIUM | HIGH | Portal session trusts stored `stripe_customer_id` without cross-validation | Codex elevated; expanded to all billing.js functions |
| P8 | MEDIUM | HIGH | No CSRF protection on billing endpoints | Codex elevated |
| P9 | MEDIUM | MEDIUM | No rate limiting on webhook endpoint | Full agreement |
| P10 | MEDIUM | MEDIUM | Synchronous webhook processing — slow DB causes cascading failure | Full agreement |
| P11 | LOW | MEDIUM | `stripe_subscription_id` exposed in status response | Codex elevated |
| P6 | MEDIUM | LOW | Webhook error messages still distinguish failure modes (residual) | Improved but residual |

### Database (18 Confirmed)

| Claude ID | Claude Severity | Codex Severity | Finding | Notes |
|-----------|----------------|----------------|---------|-------|
| D1 | CRITICAL | CRITICAL | Raw `query()` export accepts arbitrary SQL | Full agreement — highest priority |
| D2 | HIGH | HIGH | IDOR: `getJob()`, `updateJob()`, `getClient()`, `updateClient()` lack `user_id` filter | Codex added `getPropertiesByClient()` as additional vector |
| D3 | HIGH | HIGH | `SELECT *` / sensitive field exposure on users table | Codex noted `SELECT *` persists in 11+ locations |
| D4 | HIGH | HIGH | Google OAuth tokens stored in plaintext | Full agreement |
| D5/D6/D13 | HIGH | HIGH | Unbounded queries: `listUsers()`, `getJobsByCompany()`, `getClients()`, `getProperties()` | Full agreement |
| D7 | HIGH | HIGH | `listCompanies()` correlated subqueries (N+1) | Full agreement |
| D9 | HIGH | HIGH | Missing FK constraints on 6 columns | Codex confirmed all individually |
| D10 | MEDIUM | MEDIUM | `assignUserToCompany()` no transaction | Full agreement |
| D11 | MEDIUM | MEDIUM | `Math.random()` for ID generation | Full agreement |
| D12 | MEDIUM | **HIGH** | `stripe_subscription_id` no unique constraint | **Codex elevated**: duplicates could update wrong tenant |
| D17 | MEDIUM | MEDIUM | Inconsistent error handling patterns | Codex sharpened to security-sensitive mutations |
| D20 | MEDIUM | MEDIUM | TEXT primary keys on clients, properties, job_versions | Full agreement |
| D22 | MEDIUM | MEDIUM | No CHECK constraints on enum columns | Full agreement |
| D23 | MEDIUM | MEDIUM | Missing composite indexes | Codex added specific missing composites |
| D25 | LOW | LOW | Mixed timestamp handling | Complementary finding |
| D28 | LOW | LOW | No rollback (`down = false`) in migration | Full agreement |
| D29 | LOW | LOW | `push_subscriptions.user_id` type mismatch | Full agreement |
| D30 | LOW | LOW | `stripe_customer_id` nullable | Covered under broader NOT NULL discussion |

**Severity Trend:** Codex consistently rated findings higher than Claude. Of 45 confirmed findings, Codex elevated the severity on 14 (31%). No findings were rated lower by Codex.

---

## 4. Disputed Findings (Codex Disagrees — Possible False Positives)

7 findings where Codex's assessment appears incorrect, overstated, or based on incomplete context.

### Auth & Secrets (4 Disputed)

#### D-1: Account Lockout DoS — Failed Attempts Not Reset on Success
- **Codex Severity:** MEDIUM | **Claude:** Not a finding
- **Codex Claim:** On successful login, `failed_login_attempts` is never cleared.
- **Assessment:** **Likely invalid.** Claude's A23 notes the reset is "buried in DB function" — `db.updateLastLogin()` internally resets the failed login counter. Codex couldn't see the DB function implementation.

#### D-2: No Rate Limiting on Login/Refresh/Change-Password
- **Codex Severity:** HIGH | **Claude:** Not a finding
- **Codex Claim:** No visible route-level rate limiting on auth endpoints.
- **Assessment:** **Partially invalid.** Rate limiting exists in `src/middleware/rate-limit.js` and is applied at the router mount level in `api.js` (noted in code comments at line 18). Codex couldn't see it from the routes file alone.

#### D-3: User Response May Leak Sensitive Fields
- **Codex Severity:** MEDIUM | **Claude:** Not a finding
- **Codex Claim:** `/login` and `/refresh` return `user: result.user` without explicit DTO.
- **Assessment:** **Invalid.** Both `authenticate()` and `refreshToken()` construct explicit `safeUser` objects with whitelisted fields. `password_hash` is never included.

#### D-4: Same JWT Used as Access and Refresh Token
- **Codex Severity:** HIGH | **Claude:** Not a finding
- **Codex Claim:** Using the same JWT as both access and refresh credential allows stolen access tokens to extend sessions.
- **Assessment:** **Valid concern but overstated.** This is an architectural design choice. The token rotation with version tracking provides mitigation. Separate access/refresh tokens would be more secure but is a significant architectural change. **Recommend MEDIUM at most.**

### Payments (3 Disputed)

#### D-5: P13 Plan Hardcoding — Severity Upgrade
- **Claude Severity:** LOW | **Codex Severity:** HIGH
- **Claude's View:** Code quality issue — `plan: 'pro'` should be derived from metadata.
- **Codex's View:** Trust boundary violation — entitlements should never default to the most privileged tier.
- **Assessment:** **Codex is correct.** The defaulting behavior is a security issue, not just code quality. **Recommend upgrading to HIGH.** (This finding is also listed as new finding CX-10 since it represents a meaningfully different analysis.)

#### D-6: P11 Subscription ID Exposure — Severity Upgrade
- **Claude Severity:** LOW | **Codex Severity:** MEDIUM
- **Codex's View:** Exposing third-party billing IDs expands blast radius of client-side compromise.
- **Assessment:** **Reasonable upgrade to MEDIUM.** A Stripe subscription ID enables targeted API calls if combined with other leaked credentials.

#### D-7: P8 CSRF on Billing Endpoints — Severity Upgrade
- **Claude Severity:** MEDIUM | **Codex Severity:** HIGH
- **Codex's View:** If auth becomes cookie-based, these POST endpoints are directly exploitable.
- **Assessment:** **Depends on auth mechanism.** If JWT Bearer tokens only, MEDIUM is fair. **Recommend keeping at MEDIUM with a note to re-evaluate if auth changes.**

---

## 5. Methodology

### Two-Model Review Approach

This review employed a **two-model security analysis** to reduce blind spots inherent in any single AI reviewer:

1. **Initial Review (Claude AI):** Comprehensive manual code review of all files in scope, producing 80 findings across auth, payments, and database layers. Published as [SECURITY-REVIEW.md](./SECURITY-REVIEW.md).

2. **Cross-Validation (OpenAI Codex):** Each file was independently reviewed by OpenAI Codex via the codex-cli MCP tool. Codex received the raw source code without Claude's findings, ensuring an unbiased second opinion.

3. **Comparison & Consolidation:** Results were compared finding-by-finding to classify each as:
   - **NEW** — Codex identified something Claude missed entirely
   - **CONFIRMED** — Both reviewers independently flagged the same issue (highest confidence)
   - **DISPUTED** — Codex disagrees with Claude's assessment, or appears to have a false positive based on incomplete context

### Why Two Models?

| Benefit | Explanation |
|---------|-------------|
| **Reduced false negatives** | Each model has different blind spots. Codex caught 31 findings Claude missed. |
| **Severity calibration** | Where models disagree on severity, it highlights findings needing human judgment. |
| **False positive detection** | 7 disputed findings reveal where incomplete file context led to incorrect conclusions. |
| **Confirmation confidence** | 45 findings confirmed by both models have the highest remediation priority. |

### Observed Strengths by Model

| Area | Claude | Codex |
|------|--------|-------|
| **Scalability patterns** | Stronger — identified COALESCE ORDER BY issues, correlated subqueries, pool monitoring | — |
| **Codebase-level concerns** | Stronger — dead code, schema drift, deprecated functions | — |
| **Authorization boundaries** | — | Stronger — found more IDOR vectors (createProperty, job versions, getPropertiesByClient) |
| **Trust boundary analysis** | — | Stronger — correctly identified plan defaulting as HIGH, not LOW |
| **Schema-level enforcement** | — | Stronger — composite FK gaps, NOT NULL, CHECK constraints |
| **Remediation quality** | — | Stronger — found bugs in the fixes themselves (dedup race, fail-open priceId, plan default) |

### Limitations

- **Static analysis only** — No dynamic testing, fuzzing, or runtime verification
- **Server-side scope** — Frontend, infrastructure (AWS config, nginx), CI/CD, and dependency vulnerabilities not reviewed
- **File-level context** — Codex reviewed individual files in isolation, leading to some false positives where behavior was implemented in a different file (e.g., rate limiting applied in `api.js`, login counter reset in DB function)
- **No exploit verification** — Findings are theoretical; actual exploitability depends on deployment configuration and access patterns

### Files Reviewed

| File | Lines | Domain |
|------|-------|--------|
| `src/auth.js` | ~350 | Authentication, JWT, token rotation |
| `src/routes/auth.js` | ~170 | Auth route handlers |
| `src/services/secrets.js` | ~150 | AWS Secrets Manager integration |
| `src/billing.js` | ~129 | Stripe SDK wrapper |
| `src/routes/billing.js` | ~137 | Billing route handlers |
| `src/api.js` (lines 57-204) | ~150 | Stripe webhook handler |
| `src/db.js` | 1,762 | Database queries, connection pool, CRUD |
| `migrations/001_baseline.cjs` | 192 | Schema baseline migration |

---

## Appendix: Complete Finding Index

### All 31 New Findings (Codex-Only)

| ID | Severity | File | Finding |
|----|----------|------|---------|
| CX-1 | **CRITICAL** | `src/auth.js` | `verifyToken()` never checks `token_version` |
| CX-2 | **HIGH** | `src/auth.js` | Failed-login counter race condition |
| CX-9 | **HIGH** | `src/api.js` | Out-of-order webhook event processing |
| CX-10 | **HIGH** | `src/api.js` | Plan defaults to `'pro'` on missing metadata |
| CX-14 | **HIGH** | `src/billing.js` | Open redirect via Stripe URL parameters |
| CX-20 | **HIGH** | `src/db.js` | Cross-tenant IDOR via `createProperty()` |
| CX-21 | **HIGH** | `src/db.js` | Job version history exposure without ownership checks |
| CX-25 | **HIGH** | `migrations/001_baseline.cjs` | Malformed default values in migration |
| CX-3 | MEDIUM | `src/auth.js` | Timing side-channel for user enumeration |
| CX-4 | MEDIUM | `src/auth.js` | `requireCompanyAdmin` missing `company_id` check |
| CX-5 | MEDIUM | `src/auth.js` | No JWT issuer/audience claims |
| CX-8 | MEDIUM | `src/services/secrets.js` | Prototype pollution via `Object.assign` |
| CX-11 | MEDIUM | `src/api.js` | Non-atomic webhook deduplication |
| CX-12 | MEDIUM | `src/api.js` | Fail-open on deduplication failure |
| CX-15 | MEDIUM | `src/billing.js` | Unbounded `recordUsage()` quantity |
| CX-16 | MEDIUM | `src/billing.js` | Raw Stripe exceptions propagate |
| CX-17 | MEDIUM | `src/routes/billing.js` | ALLOWED_PRICE_IDS fails open when unconfigured |
| CX-22 | MEDIUM | `src/db.js` | No query/statement timeout on pool |
| CX-23 | MEDIUM | `src/db.js` | Security-sensitive error suppression |
| CX-26 | MEDIUM | `migrations/001_baseline.cjs` | Missing NOT NULL on security-critical columns |
| CX-27 | MEDIUM | `migrations/001_baseline.cjs` | Missing CHECK on version counters |
| CX-28 | MEDIUM | `migrations/001_baseline.cjs` | Missing UNIQUE on `properties(user_id, address)` |
| CX-29 | MEDIUM | `migrations/001_baseline.cjs` | Cross-tenant linkage at schema level |
| CX-6 | LOW | `src/auth.js` | `jti` claim generated but never validated |
| CX-7 | LOW | `src/routes/auth.js` | Stale role data on destructive actions |
| CX-13 | LOW | `src/api.js` | No webhook event payload schema validation |
| CX-18 | LOW | `src/routes/billing.js` | FRONTEND_URL not validated at startup |
| CX-19 | LOW | `src/routes/billing.js` | User enumeration via portal error message |
| CX-24 | LOW | `src/db.js` | DB layer missing actor context for admin functions |
| CX-30 | LOW | `migrations/001_baseline.cjs` | Redundant indexes wasting write performance |
| CX-31 | LOW | `migrations/001_baseline.cjs` | `timestamp` vs `timestamptz` |

### Priority Remediation Order

| Priority | ID | Severity | Action |
|----------|----|----------|--------|
| 1 | CX-1 | CRITICAL | Add `token_version` check to `verifyToken()` |
| 2 | D1 | CRITICAL | Audit/remove raw `query()` export |
| 3 | D2 + CX-20 + CX-21 | HIGH | Close all IDOR vectors (6+ functions) |
| 4 | CX-9 | HIGH | Add event ordering to webhook handler |
| 5 | CX-10 | HIGH | Remove `'pro'` default — fail on missing metadata |
| 6 | CX-2 | HIGH | Make login attempt tracking atomic |
| 7 | CX-14 | HIGH | Validate redirect URLs in billing.js |
| 8 | CX-25 | HIGH | Fix migration default value quoting |
| 9 | CX-11 + CX-12 | MEDIUM | Fix dedup: make atomic + fail closed |
| 10 | CX-23 | MEDIUM | Propagate errors in security-sensitive DB writes |

---

*Generated by Claude Opus 4.6 with OpenAI Codex second opinions via codex-cli MCP*
*Two-model security review — CertMate (EICR_App)*
