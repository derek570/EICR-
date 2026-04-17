# EICR-oMatic 3000

> **MANDATORY — Every code change must update docs and be committed.**
> - Changed a pipeline step, field, or architecture? Update the matching [reference file](docs/reference/).
> - Hub CLAUDE.md is an **index only** — add detail to reference files, not here.
> - Add a row to the [Changelog](#changelog) for any user-facing or architectural change.
> - Delete stale content rather than commenting it out. Keep every file under its target line count.
> - **Commit automatically after each logical unit of work — do NOT wait to be asked.** Small, focused commits with detailed messages explaining both what changed and WHY the code exists.

Automated EICR/EIC certificate creation for electrical inspectors using an iOS-first workflow.

## Project Overview

1. **Photo Capture** - Inspector photographs consumer unit (CCU) via iOS app
2. **CCU Analysis** - GPT Vision extracts circuit data from consumer unit photos
3. **Document Extraction** - GPT Vision extracts certificate data from previous certificates, handwritten notes, or photos
4. **Voice Recording** - Inspector dictates test readings and observations into iOS app
4. **Live Transcription** - Deepgram Nova-3 transcribes speech in real time (direct from iOS)
5. **Live Extraction** - Server-side Sonnet 4.5 extracts structured certificate data via multi-turn conversation
6. **Review & Edit** - Inspector reviews populated certificate in iOS app tabs
7. **PDF Generation** - Generate complete EICR/EIC PDF certificates

## Tech Stack

| Component | Technology |
|-----------|------------|
| iOS App | SwiftUI (CertMateUnified) |
| Transcription | Deepgram Nova-3 (direct WebSocket from iOS) |
| Live Extraction | Claude Sonnet 4.5 (server-side multi-turn via WebSocket) |
| CCU Photo AI | GPT Vision (consumer unit analysis) |
| Document Extraction AI | GPT Vision (certificate/notes data extraction) |
| Backend | Node.js (ES modules) — API, WebSocket, S3 |
| PDF (iOS) | WKWebView HTML->PDF (EICRHTMLTemplate.swift) — **iOS app uses this, NOT the server generators** |
| PDF (server) | Python ReportLab + Playwright — **only used by web frontend (web/)** |
| Web Frontend | Next.js (App Router, PWA) |
| Cloud | AWS ECS Fargate, S3, RDS PostgreSQL, Secrets Manager |

## Monorepo Structure

npm workspaces with 3 packages:

| Workspace | Path | Purpose |
|-----------|------|---------|
| Backend | `src/` | Express API + WebSocket server |
| Web | `web/` | Next.js frontend (PWA, dashboard, recording, editing) |
| shared-types | `packages/shared-types/` | TypeScript types (`@certmate/shared-types`) |
| shared-utils | `packages/shared-utils/` | Shared utilities (`@certmate/shared-utils`) |

## Quick Commands

### Development

```bash
npm start                          # Backend (port 3000)
npm run dev --workspace=web        # Web (port 3001)
```

### Testing

```bash
npm test                           # Backend tests
npm test --workspace=web           # Web tests
```

### Linting

```bash
npm run lint                       # ESLint
npm run format                     # Prettier
```

### Deploy (CI/CD via GitHub Actions)

**Primary method:** Push to `main` triggers automatic deployment via `.github/workflows/deploy.yml`.

```
git push origin main
→ GitHub Actions: test → build Docker images (ARM64) → push to ECR → deploy to ECS
→ ~30 minutes end-to-end
→ certmate.uk goes live automatically
```

**Pipeline steps:**
1. **test-backend** — Jest tests (Node.js)
2. **test-frontend** — ESLint, TypeScript check, Next.js build, Jest (runs against `web/`)
3. **security-audit** — npm audit (high/critical)
4. **build-images** — Docker build (ARM64) + Trivy security scan
5. **deploy** — Push to ECR, register ECS task definitions, update services, wait for stable

**Manual trigger (selective deploy):**
```bash
gh workflow run deploy.yml -f deploy_target=backend -f environment=production
gh workflow run deploy.yml -f deploy_target=frontend -f environment=production
gh workflow run deploy.yml -f deploy_target=both -f environment=production
```

**Local quick-deploy (bypasses CI):**
```bash
./deploy.sh              # Web frontend only
./deploy.sh --backend    # Web frontend + backend
```

**Monitor:** `https://github.com/derek570/EICR-/actions`

**Common failure:** Missing npm dependencies in `web/package.json`. Locally-hoisted deps work on dev but fail in Docker (`npm ci` only installs declared deps). Before pushing, verify all imports have matching `package.json` entries.

### Check Status

```bash
aws ecs describe-services --cluster eicr-cluster-production --services eicr-frontend eicr-backend --region eu-west-2 --query "services[*].{Service:serviceName,Running:runningCount,Status:deployments[0].rolloutState}" --output table
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m
gh run list --limit 5     # Recent CI/CD runs
```

## iOS Recording Pipeline (v3)

```
iOS (16kHz PCM) -> DeepgramService (direct Nova-3 WS)
    -> transcript -> NumberNormaliser -> TranscriptFieldMatcher (instant regex)
    -> ServerWebSocketService (wss://backend/api/sonnet-stream) + regex hints
    -> Backend: multi-turn Sonnet 4.5 extraction (with regex context)
    -> results + questions + cost updates back to iOS
```

**Field priority (3-tier):** Pre-existing (CCU/manual) > Sonnet > Regex
**Dual extraction:** Regex provides instant ~40ms field fill; Sonnet overwrites with higher accuracy 1-2s later. Regex hints (field names only) sent to backend as Sonnet context.

> Full details: [docs/reference/ios-pipeline.md](docs/reference/ios-pipeline.md)

## AWS Configuration

> Replace `<ACCOUNT_ID>` with your AWS Account ID.

| Resource | Value |
|----------|-------|
| Region | eu-west-2 (London) |
| Domain | certomatic3000.co.uk |
| ECS Cluster | eicr-cluster-production |
| ECR Backend | `<ACCOUNT_ID>`.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend |
| RDS Database | eicr-db-production.cfo684yymx9d.eu-west-2.rds.amazonaws.com |
| Backend Memory | 2048 MB / 512 CPU |

> Full table: [docs/reference/architecture.md](docs/reference/architecture.md)

## Environment Variables

Cloud keys loaded automatically from AWS Secrets Manager: `eicr/api-keys` (all API keys as a single JSON object) and `eicr/database` (DB credentials). No local `.env` needed for cloud deploys.

> Full details: [docs/reference/architecture.md](docs/reference/architecture.md#environment-variables)

## Certificate Types

- **EICR** - Electrical Installation Condition Report (periodic inspection)
- **EIC** - Electrical Installation Certificate (new installations)

## Commit Rules
- **Auto-commit after every logical unit of work.** Do NOT wait for the user to ask — commit immediately when a meaningful change is complete (a bug fix, a feature addition, a refactor, a config change, etc.). Multiple small commits are always better than one large commit.
- **Commit messages must be detailed and explain the WHY, not just the WHAT.** Every commit message should answer:
  1. **What** changed (a brief summary line)
  2. **Why** the change was needed (what problem existed, what was broken, what feature was missing)
  3. **Why this approach** (why the code is written the way it is — design decisions, trade-offs, alternatives considered)
  4. **Context** — flag any deliberate UI/layout decisions, note if a change fixes a problem caused by a previous refactor, mention if a pattern was chosen for consistency with existing code
- Use multi-line commit messages: a short subject line, then a blank line, then a detailed body paragraph.
- If a change touches multiple concerns, split into separate commits — one per concern.
- Never batch unrelated changes into a single commit.

## Development Notes

- All Node.js uses ES modules (`"type": "module"` in package.json)
- Backend routes split into 14 modules in `src/routes/`
- Route registry: `src/api.js` (197 lines) mounts all routes + legacy aliases
- API documentation: Swagger UI at `/api/docs`
- Pre-commit hooks: eslint + prettier via lint-staged, secrets detection
- Pre-push hooks: full test suite

## Reference Documentation

Detailed docs split into focused reference files:

| Document | Contents |
|----------|----------|
| [architecture.md](docs/reference/architecture.md) | Tech stack, containers, AWS config, environment vars, AI models, costs |
| [ios-pipeline.md](docs/reference/ios-pipeline.md) | Recording pipeline v3, debug runbook (7-step), S3 paths, common issues |
| [field-reference.md](docs/reference/field-reference.md) | All UI fields (29 circuit columns), CSV mapping, field schema, sync rules |
| [deployment.md](docs/reference/deployment.md) | Deploy commands, cloud status, troubleshooting |
| [file-structure.md](docs/reference/file-structure.md) | Directory tree, key files |
| [deployment-history.md](docs/reference/deployment-history.md) | Implementation phases 1-8, resolved items archive |
| [DEVELOPER_SETUP.md](docs/DEVELOPER_SETUP.md) | Full developer setup guide (all platforms) |
| [ADRs](docs/adr/README.md) | Architecture Decision Records (7 ADRs) |
| [OpenAPI](docs/api/openapi.yaml) | OpenAPI 3.1 spec (served at /api/docs) |

## Documentation Sync Rules

When modifying UI fields: update `config/field_schema.json` + [field-reference.md](docs/reference/field-reference.md). When adding extractable fields to Sonnet: (1) add to prompt in `eicr-extraction-session.js`, (2) add case in `applySonnetReadings()`, (3) add keyword boosts in `default_config.json`.

> Full sync checklist: [docs/reference/field-reference.md](docs/reference/field-reference.md#keeping-this-documentation-in-sync)

## Current Focus / Active Work

- Deepgram auto-sleep power saving (3-tier: Active/Dozing/Sleeping) -- live in production
- Server-side Sonnet multi-turn extraction (v3 pipeline) -- live in production
- Session optimizer v3 with URL-based review reports
- iOS PDF generation (local, no server dependency)
- 5-star transformation phases 6-8 (infrastructure, testing, documentation)

## Changelog

| Date | Change | File(s) |
|------|--------|---------|
| 2026-04-17 | Web rebuild Phase 7b — iOS "Add to Home Screen" hint on `/settings`. **Closes Phase 7b.** Final scope-exclusion item from `PHASE_7A_HANDOFF.md` §"Scope exclusions": "No iOS 'Add to Home Screen' hint — Safari never fires `beforeinstallprompt`, a dismissible banner on `/settings` is the planned accommodation." Without this, iPhone/iPad users have no pathway to discover that CertMate is installable — Chrome/Edge/Android get the `<InstallButton />` in the AppShell header (driven by the `beforeinstallprompt` event captured in `install-store.ts`), but Safari desktop + iOS deliberately omit that event per Apple platform policy, so an iOS user would otherwise go their entire app lifetime without ever learning they can pin CertMate to their Home Screen. **`web/src/components/pwa/ios-install-hint.tsx`** is a dismissible banner that guides the user through the iOS install flow: Share icon → Add to Home Screen → Add. **Platform detection**: `/iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window)` — the `MSStream` guard filters out old Windows Phones that spoofed iOS user-agents (vanishingly rare now, but the guard costs nothing and removing it would be a regression-shaped hole). Non-iOS devices already have `<InstallButton />` so double-prompting would be redundant noise. **Already-installed check**: two signals combined — `(navigator as IOSNavigator).standalone === true` (iOS-specific property, typed via a local interface extension rather than a global `declare module` pollute so every `navigator` access across the codebase doesn't gain an unused optional) OR `window.matchMedia('(display-mode: standalone)').matches` (the cross-browser standard that iPadOS 16+ reports reliably). Either one firing suppresses the banner. **Dismissal persistence**: `localStorage` key `cm_pwa_ios_hint_dismissed:v1` — the `:v1` suffix is deliberate: the rule is "show once per user per campaign", not "never again forever", so a future marketing push can reset the pool by bumping to `:v2` without a data-migration step. The try/catch around `setItem` handles private-mode Safari + quota-exceeded (falls through silently; worst case the banner reappears on next navigation, which is strictly better than a thrown exception hitting the error boundary). **First-paint behaviour**: `useState(false)` + effect that flips to `true` only after all the platform gates pass. Defaulting to `false` means SSR renders the no-show case and the client never flashes the banner for a frame on Chrome/desktop before detection runs. **Mount site**: `/settings` page, inserted between the hero profile section and the TEAM SectionGroup. Deliberately **NOT the dashboard** — the dashboard is already dense with hero + recent-jobs list + setup grid, and adding an install prompt there would push Recent Jobs below the fold on a phone for the primary daily task. `/settings` is a low-traffic page by inspector-workflow standards (they hit it once to configure, then rarely), so the banner surfaces at a moment when the user is already in "configure my app" mode and receptive to an install nudge. **Visual design**: `<aside role="region" aria-label="Install CertMate on your iPhone">` — semantic landmark for screen readers so users can jump to or skip the banner. Brand-blue-tinted surface (`color-mix(in srgb, var(--color-brand-blue) 10%, var(--color-surface-2))`) with brand-blue border at 30% opacity — matches the 6b LinkCard accent treatment so the banner feels like part of the settings surface rather than a foreign nag. Plus icon in a blue 12px-rounded tile at 10×10, matching the `LinkCard` icon tile sizing on the same page. Numbered ol with inline Share icon on step 1 (`text-[var(--color-brand-blue)]` so the visual token matches what the user will see in Safari's toolbar), keyword-bolded "Add to Home Screen" and "Add" on step 2. Dismiss is a 32×32 × icon button at top-right with `aria-label="Dismiss install hint"` — 32px ≥ WCAG 2.1 AA / Apple HIG 44pt minimum tap target when accounting for the surrounding padding. **No auto-dismiss-on-install** — we'd need to re-check standalone status on `visibilitychange` or poll, but iOS "installs" don't fire a web-platform event at all; the banner is suppressed on the next navigation after install via the standalone check at mount. One-cycle staleness is acceptable for a once-in-a-lifetime flow. **Settings page integration** (`web/src/app/settings/page.tsx`): one import, one render site between hero and TEAM. The banner self-suppresses in every case where it shouldn't render, so the integration site doesn't need conditional logic — this keeps the settings page free of platform-specific branching and the decision to show/hide lives in one place (the component itself). **Scope exclusions closed by this commit**: all four items from `PHASE_7A_HANDOFF.md` §"Scope exclusions" that were tagged "7b" are now landed — (1) user-initiated SW update handoff (`ce8323a`), (2) IDB read-through cache (`2d3527f`), (3) AppShell offline indicator (`a85487f`), (4) iOS ATHS hint (this commit). **Still deferred**: no outbox / mutation queue (7c — next phase), no offline job-edit UI polish (7d), no push notifications / periodic sync / share-target, no Sentry. **Verification**: `npm run typecheck` clean (main + SW), `npm run lint` at 0 errors / 6 warnings baseline (unchanged from `a85487f`), `npm run build` succeeds — `/settings` still prerenders static. Manual DevTools checks: toggle device emulation to iPhone 14 → banner visible on first `/settings` visit; tap × → banner hidden, localStorage row set; reload → banner stays hidden; Application → Local Storage → clear `cm_pwa_ios_hint_dismissed:v1` → banner returns. On a simulated Pixel 7 → banner never renders (UA doesn't match iOS regex). Phase 7b now closed. | web/src/components/pwa/ios-install-hint.tsx, web/src/app/settings/page.tsx, CLAUDE.md |
| 2026-04-17 | Web rebuild Phase 7b — AppShell offline indicator. Follow-up to the IDB cache (`2d3527f`); closes the next item in `PHASE_7A_HANDOFF.md` §"Scope exclusions" — "No offline indicator in AppShell — the `navigator.onLine` + retry-on-online UX is 7b." Adds a small amber pill to the AppShell header right-cluster that appears whenever the browser reports `navigator.onLine === false`. Pairs with the 7b IDB cache so the inspector knows WHY the list/detail looks the same as last time — the cache may be showing stale data, and the pill is how they know connectivity is the reason. **`web/src/lib/pwa/use-online-status.ts`** is a minimal hook that wraps `navigator.onLine` + `online`/`offline` window events. Returns a plain boolean — most callers just want "am I online right now", and keeping it small avoids tempting consumers to track transient "just came back" state across remounts (which is easy to get wrong). SSR-safe: defaults to `true` (optimistic) on the server and first client render because `navigator` doesn't exist there; the `useEffect` flips to `navigator.onLine` on mount, so a genuinely-offline user sees the pill within one tick. Defaulting to `false` would flash the pill on every cold render even for online users — worse UX. Plain `useState` rather than `useSyncExternalStore` because this is a binary that changes at most a handful of times per session; the subscription cost of the external-store pattern isn't warranted. **`web/src/components/pwa/offline-indicator.tsx`** renders the pill: rounded-full border + 15%-opacity background fill in `--color-status-processing` (amber #ff9f0a, same token as `processing` status pills so the design-system palette stays coherent), `WifiOff` lucide icon, "Offline" text on `sm+` / icon-only below. **Amber, not red** — deliberate: red (`--color-status-failed`) reads as "something broke" / destructive; amber reads as "degraded — be aware". Offline with a cached render is degraded, not broken; the SWR from the IDB cache commit keeps everything browsable. Red would be panic-inducing for a state the system handles gracefully. **Icon-only below `sm`** — the mobile header is 56px tall with Logo + user-name + InstallButton + Sign-out already in the right cluster; forcing the label at 320px wide iPhone SE would push Sign-out off-screen. `title` + `aria-label` always carry the full "You are offline. Showing cached data; changes will not sync until your connection returns." string so hover and screen readers aren't starved by the responsive hide. `role="status"` + `aria-live="polite"` announces transitions to assistive tech without interrupting in-flight speech — deliberately NOT `assertive` because this is informational, not an action the user must take RIGHT NOW. Returns `null` when online, so zero DOM footprint in the common case. **Mounted in `web/src/components/layout/app-shell.tsx`** as the **first** item in the header right-cluster (before user-name → InstallButton → Sign-out) so the inspector's eye lands on connection state before anything else — the SWR cache may be showing stale data and the pill is how they know. Placement inside the existing `flex items-center gap-3` means the 3-unit gap already absorbs the pill's appear/disappear without layout shift for neighbours. **No "back online" confirmation toast** — Serwist's `reloadOnOnline: true` flag (set in `next.config.ts` since 7a) already triggers `window.location.reload()` when the browser fires `online` after being offline. By the time any toast would render, the page is already reloading — the toast would flash for a frame or two and disappear. The visible pill disappearing IS the confirmation. **`navigator.onLine` truthiness caveat** (documented in both files): `true` just means the device has a network interface, NOT that requests succeed. Captive-portal wifi, hotel DNS hijack, and ISP blocks all look "online" to the browser. That's why the UI uses this hook for the visible pill ONLY — actual retry logic should be driven by failed fetches (the SWR paths in `2d3527f`'s dashboard/job-layout), not `onLine` transitions. **Scope exclusions still deferred** (from PHASE_7A_HANDOFF.md §"Scope exclusions"): no iOS "Add to Home Screen" hint on `/settings` (next 7b commit — Safari never fires `beforeinstallprompt` so a dismissible banner on the settings hub is the planned accommodation), no outbox / mutation queue (7c), no offline job-edit UI polish (7d), no Sentry. **Verification**: `npm run typecheck` clean, `npm run lint` at 0 errors / 6 warnings baseline (unchanged from `2d3527f`), `npm run build --webpack` succeeds. Manual DevTools check (Network → Offline → switch off): amber "Offline" pill appears in header; switch on → pill disappears + Serwist `reloadOnOnline: true` reloads the page. Tested at 375px (iPhone mini) and 390px (iPhone 14) — icon-only rendering keeps Sign-out visible; at `sm` (640px+) the "Offline" label surfaces. | web/src/lib/pwa/use-online-status.ts, web/src/components/pwa/offline-indicator.tsx, web/src/components/layout/app-shell.tsx, CLAUDE.md |
| 2026-04-17 | Web rebuild Phase 7b — IDB read-through cache for jobs (offline dashboard + offline job detail). Follow-up to the 7b kickoff (`ce8323a`); closes the biggest scope item in `PHASE_7A_HANDOFF.md` §"Scope exclusions" — "No IDB read-through cache — offline jobs will 404 to `/offline`. That's 7b." Adds stale-while-revalidate reads at the two top-level fetch sites (dashboard job list, job detail layout) backed by a new IDB database at `certmate-cache` so a previously-visited dashboard + any previously-opened job now render from local cache when the network is unreachable (subway, basement CCU cupboard, flaky mobile data, backend outage) instead of falling through to the branded `/offline` shell. **`web/src/lib/pwa/job-cache.ts`** is a vanilla IDB helper — no `idb` package dependency because the surface is tiny (2 stores × 5 operations) and 7c's outbox is the first commit with a real case for a richer wrapper. Database name `certmate-cache`, version 1, two object stores: `jobs-list` (keyPath `userId`, one record per user holding `{userId, jobs: Job[], cachedAt}`) and `job-detail` (keyPath `key`, composite `${userId}:${jobId}` so a single store scales to all users × jobs without an explosion of per-user stores as tenants grow). Module-scoped `dbPromise` caches the open handle for the tab lifetime; on rejection it nulls out so the next call retries instead of being permanently stuck. `onblocked` (concurrent schema upgrade in another tab) surfaces as a reject rather than hanging forever — callers fall back to network-only. **Six exports** — `getCachedJobs(userId)` / `putCachedJobs(userId, jobs)` for the list, `getCachedJob(userId, jobId)` / `putCachedJob(userId, jobId, detail)` for a single job, `clearJobCache()` wipes both stores on sign-out. Every export is SSR-safe via `typeof indexedDB === 'undefined'` early-return so callers can `await` without branching on environment. Errors inside transactions are **swallowed to `null`/`void`** and logged to console — the cache is a best-effort optimisation; a failed read must never break the page because the network fetch is always also in-flight. `wrapRequest<T>` + `wrapTransaction` convert the IDB event API into promises so call sites stay linear (four-deep callback chains would be unreadable). **Dashboard (`web/src/app/dashboard/page.tsx`)** now runs cache-read + network-fetch in parallel. `getCachedJobs(user.id)` fires immediately; if it resolves with data BEFORE `jobs` has been set (the `jobs === null` guard prevents a late cache resolve clobbering fresh network data), it paints the shimmer-replaced list and flips a local `hadCache` flag. The network `.then` always overwrites and fire-and-forget `void putCachedJobs(...)` writes back — ignoring the promise deliberately, the UI already has the fresh data and a cache write failure is logged inside the helper. **Error handling diverges from 7a**: if the network fetch fails but we already painted from cache, we **don't** surface the error banner. The inspector can still browse their cached jobs; the forthcoming AppShell offline indicator (separate 7b commit) will communicate staleness. Only show an error when there's nothing to paint at all. **Job layout (`web/src/app/job/[id]/layout.tsx`)** mirrors the same pattern for `api.job(userId, jobId)`. A cached paint means `<JobProvider>` mounts with realistic data so the inspector can start reviewing observations/circuits/etc. while the network catches up — and the fresh fetch's `setJob` triggers `JobProvider`'s `useEffect([initial])` which resets `isDirty=false` cleanly, so local edits between cache-paint and network-hit aren't silently lost (they just get replaced by the server snapshot, same contract as today). Both sites intentionally omit `job`/`jobs` from the effect deps array with an `eslint-disable` comment explaining why — including them would cause a fetch loop since every `setJob(fresh)` would retrigger the effect. **Shared-device security (`web/src/lib/auth.ts`)**: `clearAuth()` now fires `void clearJobCache()` after localStorage + cookie wipe. Jobs can contain the inspector's notes, site address, and observations text, so if user A signs out and user B signs in, user B must not be able to render A's jobs offline. Fire-and-forget because the caller is about to `router.replace('/login')` — the tab stays alive long enough for the readwrite transaction to commit before navigation. We don't `indexedDB.deleteDatabase()` (would force a schema-upgrade dance on next open and can block under concurrent tabs); a `.clear()` per store in one transaction is faster and safe. **Not partitioned by user at DB level** — one shared DB, records keyed by userId — because a hostile browser profile can read any origin-scoped IDB regardless of partitioning, so per-user DBs wouldn't add meaningful protection; `clearAuth()` is the only durable wipe. **Why vanilla IDB, not React Query's persister**: the app doesn't use React Query despite it being installed — data-fetching is imperative `useEffect` + state throughout Phases 3–6. Introducing RQ here would balloon the diff across every page that reads a job and obscure the actual SWR change. If 7c/7d want to migrate, that's a separate refactor. **Why no update-after-save wiring**: grepped for `api.saveJob` — it's defined in api-client but never called from the UI (Phase 4 shipped the recording/extraction path but stopped short of the debounced save flush). Building a `putCachedJob`-on-save hook now would be speculative code for a hypothetical future caller per CLAUDE.md §"Don't design for hypothetical future requirements"; when saves land, the caller wires `putCachedJob` in the same commit. **Scope exclusions still deferred** (from PHASE_7A_HANDOFF.md §"Scope exclusions"): no AppShell offline indicator (`navigator.onLine` + retry-on-online UX — next 7b commit), no iOS "Add to Home Screen" hint on `/settings` (Safari doesn't fire `beforeinstallprompt` — next 7b commit), no outbox / mutation queue (7c), no offline job-edit UI polish (7d), no Sentry. **Verification**: `npm run typecheck` clean (main + SW), `npm run lint` at baseline 0 errors / 6 warnings (unchanged from `ce8323a`), `npm run build --webpack` succeeds — all routes still prerender, Serwist bundler still emits `public/sw.js`. Manual DevTools verification steps (Application → IndexedDB → `certmate-cache`): visit `/dashboard` → expect one row in `jobs-list` keyed by userId; open any job → expect one row in `job-detail` keyed `{userId}:{jobId}`; Network → Offline → reload `/dashboard` → list still renders from cache (no `/offline` fallback); sign out → both stores empty. | web/src/lib/pwa/job-cache.ts, web/src/app/dashboard/page.tsx, web/src/app/job/[id]/layout.tsx, web/src/lib/auth.ts, CLAUDE.md |
| 2026-04-17 | Web rebuild Phase 7b kickoff — user-initiated service-worker update handoff. Mandatory first commit of Phase 7b per `web/PHASE_7A_HANDOFF.md` §"Kickoff checklist for 7b" — replaces 7a's `skipWaiting: true` with a postMessage-driven prompt BEFORE any other 7b feature lands, because the second-ever prod deploy would otherwise hot-swap the bundle under an active inspector mid-edit (the old tab's JS chunks would 404 as soon as the new SW took over). Flow: new deploy ships `/sw.js` → browser installs it, it sits in `waiting` (old SW still controls the page) → `SwUpdateProvider` detects it and raises a sonner toast "New version available — Reload" (persistent, `duration: Infinity`, dismissible) → user taps Reload → `registration.waiting.postMessage({ type: 'SKIP_WAITING' })` → new `message` listener in `sw.ts` calls `self.skipWaiting()` → SW activates → `clientsClaim: true` (retained from 7a) claims the open tab → browser fires `controllerchange` → provider calls `window.location.reload()` ONCE (guarded by `reloadedRef` so a spec-noncompliant double event can't double-reload during a save). **Why not call `reload()` immediately on click** — reloading before the new SW has activated would just re-serve the old SW to the fresh page and the toast would re-appear; waiting on `controllerchange` guarantees the matching client bundle loads. **Detection covers two races**: (A) page-load scan via `navigator.serviceWorker.getRegistration()` — catches the case where the user closed the tab before the previous deploy's SW finished installing and has now reopened it with a worker already in `waiting`; (B) live `updatefound` → `statechange: installed` while `navigator.serviceWorker.controller` is non-null — catches in-session upgrades. The `controller != null` guard is the first-install distinguisher — a fresh SW landing for a user who's never had one should NOT show a "new version" toast, so the prompt only fires when there was already a previous controller. `toastShownRef` dedupes in case both paths observe the same worker (registration resolves after `updatefound` already fired). `'serviceWorker' in navigator` early-return keeps the provider inert on older Safari and privacy-mode Firefox; Serwist is already `disable`'d in dev (see `next.config.ts`) so this effectively only runs in prod builds. **Toast placement**: `<Toaster position="bottom-right" theme="dark" richColors closeButton />` mounted in root `layout.tsx` (bottom-right clears both the mobile AppShell bottom nav AND the floating `RecordingOverlay` mini-pill that Phase 4 introduced; a bottom-centre or bottom-left toast would overlap). `richColors` so any future `toast.success/error/warning` calls pick up semantic accent without per-call styling — the bare `toast('New version available', ...)` in `SwUpdateProvider` deliberately uses the default dark theme since "new version" is neither success nor warning. `theme="dark"` pins to the app's dark palette (layout already forces `<html class="dark">`). **sw.ts changes**: removed `skipWaiting: true` from `new Serwist({...})` (comment expanded to explain why), kept `clientsClaim: true` / `navigationPreload: true`, appended `self.addEventListener('message', ...)` that calls `void self.skipWaiting()` only when `event.data?.type === 'SKIP_WAITING'`. Listening directly (rather than relying on Serwist's own event handling) keeps the contract explicit: the worker skips waiting because a logged-in client asked for it, never on its own schedule. **eslint config fix** — `public/sw.js` (the Serwist-bundled output) was being picked up by eslint and threw 1 error + 106 warnings on third-party bundler code; `.gitignore` already excluded it from git but eslint's `globalIgnores` didn't. Added `public/sw.js`, `public/sw.js.map`, and defensive `swe-worker-*.js` / `workbox-*.js` glob patterns (same shape as `.gitignore`'s coverage) so lint stays at the documented baseline of 0 errors / 6 warnings. Pre-existing issue — the 7a lint run happened before any Serwist bundle had been emitted to `public/`. **Why this is a separate commit and not bundled with any 7b feature**: the handoff mandates `skipWaiting` gets replaced "BEFORE any other 7b work lands" — reviewers can assess the update-handoff mechanism in isolation, and if we shipped IDB read-through in the same commit, the diff would be too large to verify the SW lifecycle change is correct. Verified: `npm run typecheck` (main + `tsconfig.sw.json`) clean, `npm run lint` back to 0 errors / 6 warnings baseline, `npm run build --webpack` emits `public/sw.js` with the `SKIP_WAITING` handler bundled (grep confirmed 2 occurrences), all 7a routes still listed (`/manifest.webmanifest` static, `/offline` static, error boundary wired). **Scope exclusions** (from PHASE_7A_HANDOFF.md §"Scope exclusions", still deferred): no IDB read-through / offline job list (next 7b commit), no offline indicator in AppShell, no iOS "Add to Home Screen" hint on `/settings`, no outbox / mutation queue (7c), no offline job-edit UI (7d), no Sentry. Only the kickoff checklist is closed in this commit. | web/src/app/sw.ts, web/src/app/layout.tsx, web/src/components/pwa/sw-update-provider.tsx, web/eslint.config.mjs, CLAUDE.md |
| 2026-04-17 | Web rebuild Phase 7a — PWA foundation. Single focused commit that makes the web client installable, version-skew-safe, and resilient to mid-session network drops, without adding any offline read-through or outbox plumbing (those are deliberately deferred to 7b/7c/7d). Installed `@serwist/next@^9.5.7` + `serwist@^9.5.7`; `next.config.ts` wrapped with `withSerwist({ swSrc: 'src/app/sw.ts', swDest: 'public/sw.js', cacheOnNavigation: false, reloadOnOnline: true, disable: NODE_ENV === 'development' })` — `cacheOnNavigation: false` because the SW drives navigation caching itself with stricter rules than Serwist's default. `web/src/app/manifest.ts` is a typed `MetadataRoute.Manifest` export (served at `/manifest.webmanifest`): `start_url: '/dashboard'`, `scope: '/'`, `display: 'standalone'`, `id: '/'` for stable install identity, `theme_color` + `background_color` both `#0a0a0a` (surface-0 token) — aligned with the iOS status-bar tint, Android task-switcher card, and the app's top edge. Icons: geometric SVG masters at `web/scripts/icons/` (rounded-22% brand-blue gradient w/ "CM" glyph rendered as paths, not `<text>`, so build hosts can't drift on font availability) rasterized by `npm run pwa:icons` (sharp-based `scripts/generate-pwa-icons.mjs`) into `public/icons/icon-{192,384,512}.png`, `public/icons/icon-maskable-512.png` (70% safe zone inside full-bleed background for Android adaptive-icon crop), `public/apple-icon-180.png` (**flattened onto `#0066FF` — iOS rejects transparency**), and `public/favicon-32.png` + `public/favicon.svg`. **Service worker `web/src/app/sw.ts`** is authored (not auto-generated) so we control every route. Five runtime-cache rules in priority order: **(1) NetworkOnly** for `/_next/app/*`, `Next-Action` header, and RSC flight payloads (detected via `RSC: 1` header OR `?_rsc=` query) — **never cached**, because a stale flight payload is the #1 cause of mid-session "Failed to find Server Action" errors after a deploy. **(2) StaleWhileRevalidate** for `/_next/static/*` (hash-named, immutable) into `static-<BUILD_ID>` with `ExpirationPlugin` (maxEntries 200, maxAge 30d). **(3) CacheFirst** for fonts (`.woff2/.woff/.ttf/.otf`). **(4) CacheFirst** for `/icons/*`, `/apple-icon*`, `/favicon*`. **(5) NetworkFirst** for public navigations **only** (`/`, `/login`, `/legal*`, `/offline`) with 3s timeout and `/offline` fallback. Auth-gated pages (`/dashboard`, `/job/*`, `/settings/*`) deliberately fall through to default NetworkOnly — a shared device must never replay one user's HTML for another. Build-ID-versioned cache names read `process.env.NEXT_PUBLIC_BUILD_ID` (webpack inlines at build); fallback `local-${Date.now()}` for local prod-builds. Custom `activate` listener purges any cache whose name doesn't end in the current BUILD_ID, preserving `serwist-*` metadata caches. `skipWaiting: true` + `clientsClaim: true` + `navigationPreload: true` — skipWaiting is **safe for the first deploy only** (no prior SW in prod); Phase 7b MUST replace with postMessage-driven skipWaiting + "New version available" toast **before any other 7b work lands** (see PHASE_7A_HANDOFF.md §"Kickoff checklist for 7b"). `web/src/app/offline/page.tsx` is a branded fallback reusing the login page's `cm-orb` + `cm-glass` aesthetic; copy is deliberately truthful ("Reconnect to continue") — "your work will sync automatically" is aspirational and belongs in 7c. `web/src/app/error.tsx` is the root error boundary: if the error matches `'Failed to find Server Action'` OR `digest?.includes('NEXT_SERVER_ACTION')`, auto-reloads once — but with a 30s `sessionStorage` timestamp guard so a consistently-failing action doesn't pin the user in a reload loop. After 30s the fallback card renders instead of reloading again. Logs `error.digest` to console (quotable in bug reports). `web/src/lib/pwa/install-store.ts` is a Zustand slice holding the deferred `BeforeInstallPromptEvent`; the event type interface is declared here because lib.dom doesn't include it. `InstallPromptProvider` (renders null) is mounted at root layout so Chrome's `beforeinstallprompt` is captured **even on `/login`** — mounting it in AppShell would miss the event for users who land on login, sign in, and cruise straight to the dashboard. `preventDefault()` suppresses Chrome's built-in banner; we prefer a low-key ghost/sm `<InstallButton />` in the AppShell header (between user-name span and Sign-out). Button returns null on Safari (never fires the event), once installed, or before the event arrives. Click handler awaits `userChoice` before clearing the store so the button doesn't flicker mid-dialog. `web/src/middleware.ts` gained a CLAUDE.md-mandated guardrail: every non-static page response now carries `Cache-Control: no-cache, no-store, must-revalidate` — forces the browser HTTP cache to always revalidate HTML so the client bundle can never outlive its matching server routes. Static files (dot in path) and `/_next/*` are already early-returned. Independent of the SW's caching. `viewport.themeColor` in `layout.tsx` changed from `#0A0A0F` → `#0a0a0a` (align with manifest + surface-0 token); prevents a visible 1px tint mismatch between the iOS status bar (viewport) and standalone chrome (manifest). `metadata.icons` added so Next emits `<link rel="icon">` + `<link rel="apple-touch-icon">` pointing at the generated PNG/SVG files (explicit URLs, not relying on `app/icon.tsx` conventions, so raster assets live in `public/` with the SW's CacheFirst `icons` rule applied). **TypeScript gotcha**: `sw.ts` uses `lib: ["webworker"]` which overrides `WorkerNavigator` onto `navigator` and breaks `mic-capture.ts`. Fixed with `tsconfig.sw.json` (dedicated SW config) + `src/app/sw.ts` added to the main `tsconfig.json` exclude. Minimal inline `declare const process` shim in sw.ts so webpack's build-time `NEXT_PUBLIC_BUILD_ID` replacement typechecks without pulling `@types/node` into the worker build. `build` script switched from `next build` to `next build --webpack`: Next 16 defaults to Turbopack but Serwist doesn't support it yet (see serwist/serwist#54); webpack build is still a first-class Next target with zero regression. `.gitignore` now covers `/public/sw.js`, `/public/sw.js.map`, `/public/swe-worker-*.js(.map)`, `/public/workbox-*.js(.map)` (Serwist 9 bundles to a single sw.js but the workbox/swe-worker patterns are defensive for future Serwist versions). Verified clean: `npm run typecheck` (main + SW) passes, `npm run lint` at baseline (0 errors, 6 warnings — unchanged from `bc11914`), `npm run build --webpack` succeeds with Serwist bundler log confirming sw.js emission and all 7a routes (`/manifest.webmanifest` static, `/offline` static, error boundary wired). **Scope exclusions** (all in PHASE_7A_HANDOFF.md §"Scope exclusions"): no IDB read-through (7b), no outbox/mutation queue (7c), no offline job-edit UI (7d), no "New version available" toast (7b first-commit), no iOS ATHS hint (7b), no push/periodic-sync/share-target, no offline indicator in AppShell (7b), no Sentry. | web/next.config.ts, web/package.json, web/.gitignore, web/tsconfig.json, web/tsconfig.sw.json, web/scripts/icons/*.svg, web/scripts/generate-pwa-icons.mjs, web/public/icons/*.png, web/public/apple-icon-180.png, web/public/favicon-32.png, web/public/favicon.svg, web/src/app/manifest.ts, web/src/app/sw.ts, web/src/app/offline/page.tsx, web/src/app/error.tsx, web/src/app/layout.tsx, web/src/middleware.ts, web/src/lib/pwa/install-store.ts, web/src/components/pwa/install-prompt-provider.tsx, web/src/components/pwa/install-button.tsx, web/src/components/layout/app-shell.tsx, web/PHASE_7A_HANDOFF.md, CLAUDE.md |
| 2026-04-17 | Web rebuild Phase 6c — system-admin user management. Final sub-phase of Phase 6; ports iOS `AdminUsersListView` / `AdminEditUserView` / `AdminCreateUserView`. New sub-tree at `/settings/admin/users` gated by the JWT `role` check in `middleware.ts` (already in place since 6a) plus a belt-and-braces `isSystemAdmin(user)` client guard per page that renders a friendly "Not authorised" state rather than a 403 flash — same pattern as the 6b dashboard. No backend changes: all five endpoints (`GET /api/admin/users`, `POST`, `PUT /:userId`, `POST /:userId/reset-password`, `POST /:userId/unlock`) already live behind `requireAuth + requireAdmin` at the mount point in `src/api.js`. API client gained five methods (`adminListUsers`, `adminCreateUser`, `adminUpdateUser`, `adminResetPassword`, `adminUnlockUser`) — `adminListUsers` always sends limit+offset so the backend returns the `Paginated<AdminUser>` envelope, matching the `companyJobs` pattern from 6b (backend falls back to a bare array if no pagination params are present). `AdminUser` type was already declared in 6a pre-work so types.ts didn't change. `web/src/app/settings/admin/users/page.tsx` is the paginated list (50/page) — cards with avatar initial, name/email, last-seen hint, and a cluster of pills (Admin / User system role, company-role if non-employee, Inactive if `!is_active`, Locked if `locked_until > now`). Lockout comparison reads `nowMs` from a `useState(() => Date.now())` initializer — React's `react-hooks/purity` rule disallows calling `Date.now()` directly in render, and the lazy state initializer is the sanctioned escape hatch (the value is stable per mount, and the list re-fetches on `window.focus` so an expired lockout clears within one refresh cycle, which is plenty of freshness). Rows are whole-card `<Link>`s to `/settings/admin/users/[userId]`; no inline actions, which match iOS and avoid mis-tap hazards on narrow rows. Top-right "+ New user" button mirrors the Staff list pattern. `web/src/app/settings/admin/users/new/page.tsx` is the create form: three SectionCards (Account / Roles / Company) with FloatingLabelInputs for name, email, password, company_name, company_id; a local `LabelledSelect` primitive (14px label + native `<select>` — built inline rather than adding a new UI primitive per handoff §"Components") for system-role and company-role. Password client-validation shows an inline "At least 8 characters required" hint in error-red below the field so the admin doesn't need to wait for a 400 round-trip; 409 duplicate-email surfaces as "A user with this email already exists." matching the 6b invite sheet. Unlike `inviteEmployee` (which generates the password server-side and shows it once), the admin chooses the password here — same "hand off out-of-band" model since the backend doesn't send email. Company-ID is a free-form UUID field with an "advanced" hint because the handoff §"Scope exclusions" explicitly defers a company picker. `web/src/app/settings/admin/users/[userId]/page.tsx` is the edit + reset + unlock page. Loads the row by scanning paginated pages until found (capped at 20 pages / 1000 users — well beyond any single tenant; backend has no `GET /api/admin/users/:id` and 50-per-page is plenty). Self-edit guard: if `userId === currentUser.id`, the System Role select and Account-active toggle are disabled with a hint banner "You can't demote or deactivate yourself." — the backend enforces both at `admin-users.js:129-135` and 400s anyway, but the client-side disable avoids a round-trip error and signals the intent. Save-patch conditionally omits `role` + `is_active` when editing self so we never even send values that would bounce. If the admin edits their OWN row, we call `refreshCurrent()` on success so `useCurrentUser` re-hydrates and the settings hub header re-renders with the new name/email. Reset-password is a modal sheet — copy of the 6b `InviteEmployeeSheet` pattern, two-phase (form → success state) with an info line "All existing sessions for this user have been signed out." (backend `incrementTokenVersion` invalidates live JWTs at `admin-users.js:180`). NO copy-to-clipboard reveal — the admin typed the password, they don't need it read back. Unlock is inline on the Security SectionCard, rendered only when `locked_until && new Date(locked_until) > nowMs` (same `useState` trick); fires `window.confirm('Unlock this account?')` → POST → `load()` refresh, matching the iOS "confirm then toast" flow without adding a toast infra. Reset + Unlock are separate endpoints because bundling them into the generic PUT would force typing a password just to flip `is_active`. **No delete button** — backend has no delete endpoint and iOS doesn't surface one either; `is_active: false` is the documented soft-delete. Settings hub (`/settings/page.tsx`) drops the `disabled` + `disabledLabel="Coming in Phase 6c"` props on the Manage Users LinkCard to go live. Build verified clean: `next build` lists all three new routes (`/settings/admin/users` static, `/settings/admin/users/new` static, `/settings/admin/users/[userId]` dynamic); `tsc --noEmit` clean; lint at baseline (0 errors, 6 pre-existing warnings — unchanged from `6e85e9e`). **Scope exclusions** (from handoff §"Scope exclusions"): no delete UI, no audit-log surfacing (backend logs every admin action via `logAction` at `admin-users.js:98/140/182/213` but there's no read endpoint — deferred to Phase 7+), no company-picker UI (raw UUID field only), no bulk actions, no email notifications, no failed-login-attempts counter display (Locked badge is enough signal). Phase 6 now closed. | web/src/lib/api-client.ts, web/src/app/settings/admin/users/page.tsx, web/src/app/settings/admin/users/new/page.tsx, web/src/app/settings/admin/users/[userId]/page.tsx, web/src/app/settings/page.tsx, CLAUDE.md |
| 2026-04-17 | Web rebuild Phase 6b — company settings + company-admin dashboard. Ships two new routes: `/settings/company` (branding details form, visible to any authenticated user but read-only for non-admins so inspectors can verify the stamp on their certs) and `/settings/company/dashboard` (3-tab Jobs/Team/Stats view, company-admin only). Backend: added **two** new routes to `src/routes/settings.js` — `POST /api/settings/:userId/logo` (multipart, field `logo`, 10MB, PNG/JPEG, rejects SVG to avoid embedded-script risk when the PDF generator inlines the image) and `GET /api/settings/:userId/logo/:filename` (auth'd read with basename path-traversal guard and `Cache-Control: private, max-age=300`). Route pattern deliberately mirrors the signature upload/download pair — two-step save (upload bytes → get S3 key → merge onto `company_settings.logo_file` → PUT settings blob) because inlining base64 in the settings JSON would bloat reads by ~200KB per cert-generation and bust cache on every save. Types: added `CompanyMember`, `CompanyJobRow`, `CompanyStats`, `InviteEmployeeResponse`, `Paginated<T>` to `web/src/lib/types.ts` — `Paginated<T>` is generic so the same envelope shape can be reused when admin surfaces need pagination in 6c. API client gained five methods: `companySettings` / `updateCompanySettings` (full-blob PUT, no server-side merge), `companyUsers`, `companyJobs` (always sends limit+offset so response shape is consistent), `companyStats`, `inviteEmployee` (returns the plaintext `temporaryPassword` the admin must copy once), `uploadCompanyLogo`, `fetchLogoBlob` (same split-key → basename trick as signatures). New `web/src/components/settings/logo-uploader.tsx` handles the image picker + auth'd blob preview — the `<LogoPreview>` subcomponent uses the same `URL.createObjectURL` + revoke-on-unmount lifecycle as `ObservationPhoto`. Preview box is **~200×60px with white background** to mirror the actual PDF header slot so admins see a realistic rendering. Remove button clears the in-memory key via `onUploaded(null)` but does NOT delete the S3 object — orphans are cheap and there's no delete endpoint for logos (adding one is scope creep). `web/src/app/settings/company/page.tsx` is 4 SectionCards (Branding / Address & Contact / Registration + save bar); fields all disabled for non-admins but still visible — pure hiding would force inspectors to switch to the iOS app just to check the registration number before producing a cert. `web/src/app/settings/company/dashboard/page.tsx` wraps 3 tabs in the existing `SegmentedControl` primitive: **Jobs** (paginated 50/page — client always sends limit+offset so the backend consistently returns the `Paginated<T>` envelope; backend would return a bare array if we passed neither), **Team** (invite sheet with two-phase UI — form first, then success state with copy-to-clipboard password and "only shown once" warning; on close, `setResult(null)` explicitly nulls the temp password so it never outlives the modal), **Stats** (3-card count grid + jobs-by-status breakdown, no charts per handoff §"Scope exclusions"). Dashboard page applies a **triple-layer role gate**: middleware JWT check (blocks system-admin-only paths), belt-and-braces `isCompanyAdmin(user)` client guard with a friendly "Not authorised" state rather than a bare 403 flash, and a defensive "No company linked" state for system admins without a `company_id` so `stats` / `users` / `jobs` don't blast requests that would 404. The `InviteEmployeeSheet` treats the returned `temporaryPassword` as secret-adjacent PII — never logged, never persisted, cleared on close, rendered in a `<code>` block with a copy button that uses `navigator.clipboard` (silently falls back to on-screen copy if the clipboard API is blocked). Hub page (`/settings`) updated: Company section now renders live for every user (not just admins) with a contextual subtitle ("branding…and logo" vs "branding and contact info (view-only)"); the admin-only `LayoutDashboard` link card sits below the Details card so the dashboard is one click away without cluttering the non-admin view. **Scope exclusions** (from handoff §"Scope exclusions"): no logo cropping / aspect-ratio picker, no trend charts, no email invitations, no audit log, no bulk actions — all deferred. | src/routes/settings.js, web/src/lib/types.ts, web/src/lib/api-client.ts, web/src/components/settings/logo-uploader.tsx, web/src/app/settings/page.tsx, web/src/app/settings/company/page.tsx, web/src/app/settings/company/dashboard/page.tsx, CLAUDE.md |
| 2026-04-17 | Fix `next build` failure on `/login`. The page is a client component that calls `useSearchParams()` at the top level to read the `?redirect=` query param. Next.js App Router refuses to statically ship a page using `useSearchParams()` unless the hook is wrapped in a `<Suspense>` boundary — without one, the entire route is forced into client rendering and the build bails out with "should be wrapped in a suspense boundary". Split `LoginPage` into a presentational shell (default export) and a `LoginForm` inner component that actually calls the hook; wrapped `LoginForm` in `<Suspense fallback={<LoginCard disabled />}>`. Next now pre-renders the shell (orbs, card chrome, logo, heading) at build time and streams the form in on the client — `/login` moved from the "forced dynamic, build-breaking" bucket to the statically-prerendered bucket (confirmed in the `next build` route table: `○ /login`). Fallback is the same card with disabled inputs and a disabled button so there's zero layout shift while the search params resolve (effectively instant). Chose this over `export const dynamic = 'force-dynamic'` (loses static benefit for the most-hit page) or reading `window.location.search` in a `useEffect` (clunkier, and breaks SSR-safety assumptions the rest of the codebase leans on). Orbs extracted into `AmbientOrbs`, card into `LoginCard` — both reused by the fallback so the refactor didn't duplicate markup. | web/src/app/login/page.tsx, CLAUDE.md |
| 2026-04-17 | Web rebuild Phase 6a — `/settings` hub + Staff (inspector profiles + signatures). Pre-work: extended `User` with `company_id` + `company_role`, added `InspectorProfile` / `CompanySettings` / `AdminUser` types so the remaining 6b/6c commits can land without churning `types.ts` again. New `web/src/lib/roles.ts` exports `isSystemAdmin` / `isCompanyAdmin` — the entire settings tree calls these instead of inlining `user?.role === 'admin'`, so when the role model evolves (e.g. per-tenant scopes) it's a one-file change. New `web/src/lib/use-current-user.ts` hydrates from `getUser()` for instant first paint then revalidates via `api.me()` — necessary because the `cm_user` localStorage snapshot is frozen at login and a mid-session demotion would otherwise still render admin chrome. Middleware now decodes the JWT payload and redirects non-admins away from `/settings/admin/*`; component-level guards (Phase 6c) are belt-and-braces — the JWT `role` claim is signed by the backend so middleware is the first-line defence without a server round-trip. Backend: added `GET /api/settings/:userId/signatures/:filename` (mirrors the photo download pattern) because the upload route returns an S3 key but there was no auth'd read endpoint — browsers can't attach the bearer header to a bare S3 URL. Guards against path-traversal with a basename check; sets `Cache-Control: private, max-age=300` since signatures are PII. API client gained four methods: `inspectorProfiles`, `updateInspectorProfiles` (full-array PUT — backend has no per-profile endpoint, last-writer-wins matches iOS), `uploadSignature` (multipart field name `signature` to match multer config; wraps raw Blobs in a File so multer writes a sensible on-disk name), and `fetchSignatureBlob` (splits the stored S3 key to just the basename — iOS stores the full key on the profile). New `web/src/components/settings/signature-canvas.tsx` is an HTML5 canvas with Pointer Events, DPR-aware sizing, and quadratic-curve smoothing that mirrors the iOS `SignatureCaptureView` stroke style exactly (2.5px black ink, rounded joins). Imperative handle (`getBlob` / `clear` / `hasContent`) keeps the parent form in control of when uploads fire — we don't auto-POST on every stroke (iOS doesn't either). If an `initialSignatureFile` is passed, the canvas loads it as a background image via the auth'd blob fetch + `URL.createObjectURL` (revoked on unmount) so strokes drawn on top produce a merged PNG on export. Routes: `web/src/app/settings/layout.tsx` reuses `AppShell` (no sub-nav yet — settings tree is shallow), `web/src/app/settings/page.tsx` is the hub with a hero avatar + role pills and role-gated link cards; Company/Admin cards render conditionally even though they route to placeholders ("Coming in Phase 6b/6c") so the gating logic is correct from day one and 6b/6c only need to flip a prop. `web/src/app/settings/staff/page.tsx` ports `InspectorListView` — gradient hero with stacked avatars, card list with inline trash icon + confirm modal (swipe-to-delete is an iOS gesture that doesn't translate; web idiom is explicit), empty-state with UserPlus icon. Refreshes on `window.focus` rather than subscribing to a pub-sub — settings mutations are rare enough. `web/src/app/settings/staff/[inspectorId]/page.tsx` is the shared add/edit form: `new` triggers a blank profile with `is_default: true` when it's the first-ever profile (so there's always a default); existing-id loads the profiles array, finds the row, and splits equipment into a collapsible section (auto-expanded if any slot is populated — matches iOS). Save flow is **two-step**: if the canvas has a fresh blob, upload first to get the S3 key, THEN PUT the full profiles array with the key merged in. Order matters — if we did the array save first and upload failed, the profile would point at a non-existent signature. Setting `is_default` on any profile unsets default on all others client-side (mutex) so the PUT body always reflects exactly one default. Sticky bottom save bar matches the rest of the rebuild's primary-action placement; settings is out of the recording tree so there's no z-index collision with `RecordingOverlay`. **Scope exclusions**: no billing/Stripe, no email invitations (backend doesn't send), no audit-log UI, no logo cropping — all deferred per the handoff §"Scope exclusions". | src/routes/settings.js, web/src/lib/types.ts, web/src/lib/roles.ts, web/src/lib/use-current-user.ts, web/src/lib/api-client.ts, web/src/middleware.ts, web/src/components/settings/signature-canvas.tsx, web/src/app/settings/layout.tsx, web/src/app/settings/page.tsx, web/src/app/settings/staff/page.tsx, web/src/app/settings/staff/[inspectorId]/page.tsx, CLAUDE.md |
| 2026-04-17 | Web rebuild Phase 5d — LiveFillView. Ports iOS `LiveFillView.swift` so the inspector sees every Sonnet-extracted field populate in real time with a brand-blue flash that fades to transparent over 2s. New `web/src/lib/recording/live-fill-state.ts` is a module-level singleton `LiveFillStore` (Map<fieldKey, timestamp>) subscribed via `useSyncExternalStore`. The two hooks it exports — `useLiveFillStore` (snapshot with `lastUpdatedSection` / `lastUpdatedAt` for auto-scroll) and `useIsFieldRecent(key)` (per-field boolean) — give leaves independent subscriptions so a single `markUpdated` call only re-renders the fields whose recency actually flipped. A self-scheduling 3050ms cleanup sweep prunes stale keys (+50ms headroom over the 3s window) and re-emits so the flashing stops; bundling pruning into one delayed sweep avoids a per-key timer storm when large extractions land. Extended `applyExtractionToJob` to return `{patch, changedKeys}` — changedKeys is computed by diffing the pre-patch job against the patch (not derived from the readings array, which would drift if the extractor adds new fields). Scalar sections emit `section.field` keys, circuit cells emit `circuit.{id}.field`, newly-created circuit rows emit both `circuit.{id}` (whole-row flash) and one key per filled cell, new observations emit `observation.{id}`. `hasValue` guard suppresses flashes on no-op reassignments. New `web/src/components/live-fill/live-field.tsx` is a CSS-only primitive (two variants: `LiveField` for scalars, `LiveFieldWide` for long strings) that toggles `data-recent="true|false"` — the CSS `transition: background-color 2s ease-out` re-triggers automatically, no keyframes. `@media (prefers-reduced-motion: reduce)` shortens to a 200ms fade. Empty values render `—` so cells keep layout (spatial-memory parity w/ iOS). New `web/src/components/live-fill/live-fill-view.tsx` renders the full form in iOS section order (Installation → Extent only-if-EIC → Supply → Board → Circuits → Observations only-if-EICR) with `data-section` attributes targeted by a `scrollIntoView` `useEffect` that fires off the `lastUpdatedAt` trigger (so the same section updating twice still scrolls). Section entrance stagger (`cm-live-section` + nth-child delays) in globals.css keeps the initial render calm. Mount site is **Option A** from the handoff: a new `<JobBody>` component in `web/src/app/job/[id]/layout.tsx` reads `useRecording().state` and swaps tab `{children}` for `<LiveFillView>` whenever recording state is `active`/`dozing`/`sleeping`. TranscriptBar + FloatingActionBar + RecordingOverlay stay mounted at their usual positions — no z-index juggling. `liveFill.reset()` fires on `start()` and `stop()` so previous sessions never bleed into a new one. `role="status"` + `aria-live="polite"` on the root so screen readers announce new content. **Scope exclusions** (from handoff §"Scope exclusions"): typing-per-character animation, CCU slot-correction grid, landscape-specific compact layout, per-observation fade-in. Defer until inspectors ask — the background flash already conveys the "just filled" signal. | web/src/lib/recording/live-fill-state.ts, web/src/components/live-fill/live-field.tsx, web/src/components/live-fill/live-fill-view.tsx, web/src/lib/recording/apply-extraction.ts, web/src/lib/recording-context.tsx, web/src/app/job/[id]/layout.tsx, web/src/app/globals.css, CLAUDE.md |
| 2026-04-17 | Web rebuild Phase 5c — observation photos. New `web/src/components/observations/observation-photo.tsx` fetches auth'd image bytes via `api.fetchPhotoBlob` → `URL.createObjectURL` → revokes on unmount (necessary because `<img src>` won't attach the bearer token the photo endpoint requires). New `web/src/components/observations/observation-sheet.tsx` is the add/edit modal — code chip row (C1/C2/C3/FI), location, description, remedial action, and a photo grid with **two buttons** (Camera + Library) matching iOS `EditObservationSheet.swift`. Camera input sets `capture="environment"` for iOS Safari rear-camera hint; Library input omits `capture` for the photo-library picker. Uploads fire immediately on file-select (eager — matches iOS so cancels don't need orphan cleanup; S3 lifecycle handles stragglers); delete also hits the backend before mutating local state so failures don't silently drop filenames. Renamed `ObservationRow.photo_keys` → `photos` for iOS parity (`Observation.photos` JSON key) — safe rename since the field was dormant (grep confirmed zero call-sites). Added three API methods: `uploadObservationPhoto` (multipart POST `/api/job/:userId/:jobId/photos` under field name "photo"), `deleteObservationPhoto` (DELETE), and `fetchPhotoBlob` (bespoke `fetch` — the shared `request` helper returns JSON/text only). Observations page Add button now enables a blank sheet; cards are clickable + keyboard-focusable to edit; inline preview shows up to 3 thumbnails + `+N` chip for overflow. Backend routes (`src/routes/photos.js` upload + delete) already live — **no backend changes**. Accepts HEIC directly via backend `IMAGE_MIMES`, so no client-side conversion on iOS. **Not ported:** bulk upload / drag-drop, photo annotations (iOS doesn't have them either). | web/src/lib/types.ts, web/src/lib/api-client.ts, web/src/components/observations/observation-photo.tsx, web/src/components/observations/observation-sheet.tsx, web/src/app/job/[id]/observations/page.tsx, CLAUDE.md |
| 2026-04-17 | Web rebuild Phase 5b — document extraction on the Circuits tab. New `web/src/lib/recording/apply-document-extraction.ts` folds `/api/analyze-document` responses onto a JobDetail patch across installation, supply, board, circuits, and observations with the **fill-empty-only** 3-tier priority guard applied everywhere (stricter than iOS `CertificateMerger` which overwrites on installation/supply/board). Circuits match by case-insensitive `circuit_ref`; unmatched extracted circuits append as new rows tagged with `board_id`. Observations dedupe by (`schedule_item` + `code`) OR (`location` + first-50-char lowercased text prefix), matching iOS `CertificateMerger.swift:100-122`. Exported `parseObservationCode` from apply-extraction.ts for reuse. New `api.analyzeDocument(photo)` posts multipart; Circuits rail Extract button now opens a library-first image picker (no `capture` hint — inspectors usually photograph docs ahead of time) and renders spinner + merge-summary hint + error banner on the same card-surface pattern as 5a. Images only for now: backend hard-codes `image/jpeg` data URL at `src/routes/extraction.js:1425`, so PDFs deferred to a follow-up that needs either pdfjs-dist client render or a backend JPEG conversion step. | web/src/lib/recording/apply-document-extraction.ts, web/src/lib/api-client.ts, web/src/lib/types.ts, web/src/app/job/[id]/circuits/page.tsx, web/src/lib/recording/apply-extraction.ts, CLAUDE.md |
| 2026-04-17 | Web rebuild Phase 5a — CCU photo capture + GPT Vision analysis on the Circuits tab. New `web/src/lib/recording/apply-ccu-analysis.ts` ports iOS `FuseboardAnalysisApplier.hardwareUpdate`: matches circuits by `circuit_ref`, merges OCPD/RCD hardware via a non-empty-only `mergeField`, preserves all test readings on matched circuits, and appends unmatched existing circuits that have readings so data is never lost. Board patch synthesises a main board if the job has none; SPD fields split between `board.spd_*` (device-level) and `supply.spd_*` (supply-section fallbacks derived from the main switch). RCD-type normalisation mirrors iOS (AC/A/B/F/S/A-S/B-S/B+ only); unresolved RCD-protected circuits auto-generate "What is the RCD type for circuit X?" inspector questions. New `api.analyzeCCU(photo)` posts multipart to `/api/analyze-ccu`. Circuits rail CCU button now opens a camera-first file picker (`capture="environment"` — iOS Safari rear-camera hint with library fallback), shows spinner + merge summary + dismissible question chips. Reuses `hasValue()` from apply-extraction as the shared 3-tier priority guard. | web/src/lib/recording/apply-ccu-analysis.ts, web/src/lib/api-client.ts, web/src/lib/types.ts, web/src/app/job/[id]/circuits/page.tsx, web/src/lib/recording/apply-extraction.ts, CLAUDE.md |
| 2026-04-17 | Start ground-up web frontend rebuild on branch `web-rebuild`. Archive previous `web/` to `_archive/web-legacy/`. Phase 0 complete: fresh Next.js 16 + React 19 + Tailwind 4 scaffold at `web/` with CertMateDesign tokens ported to CSS custom properties (brand #0066FF / #00CC66, surface L0–L4, SF Pro Rounded stack), base UI primitives (Button, Card, Logo), and Playwright visual-verification harness (`npm run verify` screenshots every route at mobile + desktop for side-by-side compare against iOS reference shots in `web/_reference/ios-screenshots/`). Lessons from `../transcript-standalone/` codified in README for Phase 4 (AudioWorklet + direct Nova-3 + resampled ring buffer + no proxy fallback). | web/*, _archive/web-legacy/*, CLAUDE.md |
| 2026-03-04 | Add /api/analyze-document endpoint: GPT Vision extracts all EICR/EIC fields from photos of previous certificates, handwritten notes, or typed test sheets. Returns { success, formData } envelope matching extract-transcript shape. iOS app gets new "Extract Doc" button in recording overlay bar and CircuitsTab. Supports camera, photo library, and file picker (images + PDFs). | src/routes/extraction.js, iOS: CircuitsTab.swift, JobDetailView.swift, RecordingOverlay.swift, JobViewModel.swift, APIClient.swift |
| 2026-02-28 | Fix extraction quality regression: raise COMPACTION_THRESHOLD 6000→60000 to effectively disable compaction for normal sessions. The 6000 threshold caused compaction to fire after ~15-20 utterances, replacing full conversation history with a dry summary — destroying Sonnet's ability to infer circuit assignment from recent conversational flow. With prompt caching (1h TTL, cache reads at 10% rate), full history costs ~$0.25-0.35/session. 60000 threshold preserves full context for all normal inspections. | eicr-extraction-session.js |
| 2026-02-23 | Fix compaction cost blowout: 5 guards on compact() (min messages, min tokens, no-new-turns, failure backoff, 120s rate limit), increase max_tokens 2048→4096, client-side 120s rate limit on session_compact handler | eicr-extraction-session.js, sonnet-stream.js, eicr-extraction-session.test.js |
| 2026-02-23 | Fix audio loss during VAD warm-up: remove premature ring buffer reset, add reconnect audio queue (5s cap), extract shared chunk handler, increase reconnect timeout to 5s, flush queued audio after reconnect. Fix server connection failures: add /api/health/ready readiness endpoint (DB/Deepgram/Anthropic checks), add iOS pre-flight connectivity check with NetworkMonitor + server health, dropped-audio logging in DeepgramService | SleepManager.swift, DeepgramRecordingViewModel.swift, DeepgramService.swift, APIClient.swift, api.js |
| 2026-02-23 | CCU extraction prompt v2: 4-step structured methodology (physical scan, label mapping, extraction, cross-check), RCD waveform type identification, device-face amp reading enforcement, questions-for-inspector TTS, ported to live /api/analyze-ccu endpoint, wired questions into batch pipeline | src/analyze_photos.js, src/routes/extraction.js, src/process_job.js |
| 2026-02-22 | 5-star Phase 8: OpenAPI spec, Swagger UI, pre-commit hooks, dev setup guide, 7 ADRs, CLAUDE.md cleanup | docs/api/openapi.yaml, src/api.js, .husky/, docs/DEVELOPER_SETUP.md, docs/adr/, CLAUDE.md |
| 2026-02-21 | Inspector profiles settings page: full CRUD (name, position, org, enrolment number, signature upload), Inspectors tab in settings nav | frontend/src/app/settings/inspectors/page.tsx, frontend/src/app/settings/layout.tsx |
| 2026-02-21 | Prompt injection guardrail: transcript delimiters + data-vs-instruction rule; remove incomplete-reading WAIT (Sonnet asks immediately, 2s TTS debounce); fix Dockerfile missing files | eicr-extraction-session.js, docker/backend.Dockerfile |
| 2026-02-20 | Web iOS feature parity: live Deepgram streaming, Sonnet extraction, sleep/wake, transcript highlighting, alert TTS, LiveFillView, CCU upload, recording controls -- full pipeline port from iOS to Next.js PWA | frontend/src/lib/recording/*.ts, frontend/src/components/recording/*.tsx |
| 2026-02-20 | CCU photo analysis: revert to GPT-5.2 (Gemini 3 Pro truncating at ~146 tokens), keep v3 prompt, add finishReason guard | api.js |
| 2026-02-20 | Remove silence check (redundant with inline questionsForUser, saves ~$0.20/session) | DeepgramRecordingViewModel.swift, ServerWebSocketService.swift, sonnet-stream.js, eicr-extraction-session.js |
| 2026-02-19 | Deepgram auto-sleep: 3-tier power saving (Active/Dozing/Sleeping), Silero VAD wake, ring buffer replay | SleepManager.swift, AudioRingBuffer.swift, DeepgramService.swift |
| 2026-02-18 | Regex extraction restored alongside Sonnet (3-tier priority) | TranscriptFieldMatcher.swift, DeepgramRecordingViewModel.swift, sonnet-stream.js |
| 2026-02-17 | Server-side Sonnet multi-turn extraction | sonnet-stream.js, eicr-extraction-session.js |
| 2026-02-15 | Session optimizer v3, URL-based review | session-optimizer.sh, analyze-session.js |
| 2026-02-14 | iOS PDF generation, LiveFillView all fields | EICRHTMLTemplate.swift, LiveFillView.swift |

## Future Plans

- Evaluate replacing server-side Python PDF generation with Playwright-only approach
- CCU photo analysis: evaluate newer models as they become available
- Expand E2E test coverage

## API Key
- **Key ID**: M535DA575N
- **Issuer ID**: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- **Key file**: `~/.appstoreconnect/AuthKey_M535DA575N.p8`

## Team
- **Development Team ID**: 3FWR3VC85U
- **Bundle ID**: com.certmate.unified
- **App ID**: 6759958578

## ExportOptions.plist
Located at: `~/Developer/EICR_Automation/_archive/CertMate_EICR_App/ExportOptions.plist`
- Method: app-store-connect
- Signing: automatic (cloud-signed, only Development cert locally)
- Upload symbols: true

## TestFlight
- **External group**: "Electricians" (ID: `0de0a46a-8d23-46f3-be0f-b615e245dfbe`)
- **Public link**: https://testflight.apple.com/join/W2dBKTSc
- **Deploy script**: `~/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`
  - Bumps build number, archives, patches onnxruntime, uploads, waits for processing, adds to external group automatically

## Known Issues
- **onnxruntime.framework** (SPM 1.20.0) ships without `MinimumOSVersion` in its Info.plist — deploy script patches it during archive export
- Only Development signing cert available locally — must use `-allowProvisioningUpdates` with API key for cloud distribution signing


### deploy

# CertMate Deploy to TestFlight

## Script location
`/Users/derekbeckley/Developer/EICR_Automation/CertMateUnified/deploy-testflight.sh`

## What it does
1. Bumps build number in `Sources/Info.plist`
2. Archives with `xcodebuild` (iOS, Release)
3. Patches onnxruntime framework MinimumOSVersion to 17.0 (matches deployment target)
4. Re-signs patched framework with available codesigning identity
5. Exports & uploads to App Store Connect
6. Polls API until build is VALID
7. Adds build to "Electricians" external TestFlight group
8. Submits for beta review

## Key fixes applied (2026-03-05)

### onnxruntime MinimumOSVersion
- The onnxruntime.framework xcframework ships without MinimumOSVersion in Info.plist
- Must patch it to `17.0` (app deployment target) and re-sign before export
- Only "Apple Development: DEREK ALAN BECKLEY (BKRAN3FQXR)" signing identity is available locally
- That's fine — `xcodebuild -exportArchive` re-signs with the distribution cert from the provisioning profile

### Script hang prevention
- Export step now captures output and checks for EXPORT FAILED/Validation failed
- Exits immediately on failure instead of falling through to 30-min polling loop
- Old bug: `|| true` on grep meant failures were silently ignored

## App Store Connect API creds
- Key: `~/.appstoreconnect/AuthKey_M535DA575N.p8`
- Key ID: M535DA575N
- Issuer: fd26ca81-fbad-432a-acf0-3dfb5b266a0e
- App ID: 6759958578
- Bundle ID: com.certmate.unified
- External group ID: 0de0a46a-8d23-46f3-be0f-b615e245dfbe
- TestFlight link: https://testflight.apple.com/join/W2dBKTSc

## How to deploy
Run in background:
```
cd /Users/derekbeckley/Developer/EICR_Automation/CertMateUnified && ./deploy-testflight.sh 2>&1 | tee /tmp/deploy.log
```
Monitor with: `tail -20 /tmp/deploy.log`

### vad-investigation

# VAD Sleep & Re-Wake Investigation — 2026-02-26

## What Was Asked
Derek wanted to check today's logs to verify the VAD sleep and re-wake with the rolling (ring) buffer worked correctly, and that Deepgram data stopped being sent during sleep.

## Findings

### No Runtime Logs Available on Mac
- The app's runtime logs (JSONL files) are stored **on the iPhone** in the app sandbox at `Application Support/CertMateLogs/`
- Del's iPhone (iPhone 15 Pro) was **disconnected/unavailable** from the Mac at the time of investigation
- No simulator logs existed either — the CertMateLogs directory was never created in the simulator container
- macOS unified log had zero CertMate entries for the past 48 hours

### No Backend Logs for VAD Either
- The iOS app connects **directly to Deepgram** (Nova-3), bypassing the backend `ws-recording.js`
- Backend CloudWatch logs (`/ecs/eicr/eicr-backend`) showed zero Deepgram events in the last 3 days
- The backend **does** receive `session_pause` / `session_resume` / `session_compact` via `sonnet-stream.js` (ServerWebSocketService), but these had **no logging** — they were silent

### Git History Unrecoverable
- Both repos (EICR_App and CertMateUnified) have broken git due to iCloud sync conflicts
- `Resource deadlock avoided` errors on `.git/refs/heads/main` and pack files
- Could not recover diffs to see what logging was removed during cleanup

### To Retrieve Runtime Logs
1. Connect the iPhone to the Mac
2. Xcode > Devices & Simulators > Download CertMateUnified container
3. Browse to `AppData/Library/Application Support/CertMateLogs/` for `.jsonl` files

### Code Verification — Implementation Is Correct
Reviewed the actual source code and confirmed the sleep/wake logic does stop Deepgram data:

- **Dozing** (after 60s silence): `pauseAudioStream()` sets `isStreamingPaused = true` — all audio silently dropped, KeepAlive sent instead
- **Sleeping** (after 5min dozing): WebSocket fully disconnected — zero data to Deepgram
- **Wake**: VAD detects 3 consecutive frames above 0.5 threshold → reconnects Deepgram → drains the 3-second ring buffer (48,000 Int16 samples at 16kHz, ~96KB) → replays buffer → resumes live streaming
- **Post-wake safety**: 5-second transcript monitor — if no transcript arrives, TTS asks "Sorry, could you repeat that?"

## Logging Restored — 2026-02-26

Found that logging was missing from several critical files. Added comprehensive logging:

### Backend — `sonnet-stream.js`
- **`session_pause`**: Now logs sessionId, turn count when iOS enters sleep/dozing
- **`session_resume`**: Now logs sessionId, pause duration (ms + sec), turn count on wake

### Backend — `ws-recording.js`
- **`handleDeepgramMessage`**: Now logs final transcripts (confidence, text preview, buffer length) and utterance end events
- **`handleStreamAudio`**: Now logs audio chunk flow every ~10s (count, bytes, elapsed), and warns when audio is being dropped (Deepgram not connected)

### iOS — `SleepManager.swift`
- **`start()`**: Logs VAD loaded, timeout config
- **`stop()`**: Logs final state
- **`enterDozing()`**: Logs state transition with timeout values (AppLogger + DebugLogger JSONL)
- **`enterSleeping()`**: Logs state transition (AppLogger + DebugLogger JSONL)
- **`wake()`**: Logs from-state and consecutive VAD frames (AppLogger + DebugLogger JSONL)
- **`processChunk()`**: Logs VAD probability on speech detection, consecutive frame resets, and ~3s heartbeat during silence

### iOS — `AudioRingBuffer.swift`
- **`drain()`**: Now logs sample count, byte count, and duration in ms

### Key Source Files
- `Sources/Audio/SleepManager.swift` — 3-tier auto-sleep (active/dozing/sleeping)
- `Sources/Audio/AudioRingBuffer.swift` — 3-second circular buffer
- `Sources/Audio/VADStateMachine.swift` — On-device VAD state machine
- `Sources/Audio/SileroVAD.swift` — Silero VAD v3 ONNX wrapper
- `Sources/Services/DeepgramService.swift` — WebSocket service with pause/resume/replay
- `Sources/Recording/RecordingSessionCoordinator.swift` — Orchestrates sleep/wake lifecycle
- `Sources/Services/ServerWebSocketService.swift` — Sends pause/resume/compact to backend
- `Sources/Services/DebugLogger.swift` — JSONL file logger (writes to device sandbox)
- `EICR_App/src/extraction/sonnet-stream.js` — Server-side Sonnet session handler
- `EICR_App/src/ws-recording.js` — Server-side Deepgram proxy (unused for direct connection)

## Session Optimizer Fixed — 2026-02-26

### What It Is
`EICR_App/scripts/session-optimizer.sh` — LaunchAgent that polls S3 for session analytics, pre-processes with `analyze-session.js`, runs Claude Code in read-only mode for recommendations, builds HTML report, uploads to S3, sends Pushover notification.

### What Was Broken
1. **Path bug**: `analyze-session.js` referenced `../src/eicr-extraction-session.js` but file is at `../src/extraction/eicr-extraction-session.js` — **fixed** (2 occurrences)
2. **No VAD/sleep analysis**: The optimizer had no visibility into sleep/wake cycles — **added new section 14**

### What Was Added to `analyze-session.js`
New `vad_sleep_analysis` section in the analysis output that processes:
- Sleep cycle tracking (doze → sleep → wake transitions with timestamps and durations)
- Buffer replay events (ring buffer drained and sent to Deepgram on wake)
- Deepgram cost savings calculation (sleep duration * $0.0077/min)
- Stream pause/resume counts
- Reconnect queue flushes and timeouts
- Post-wake transcript failures (wake happened but no speech captured)

### Optimizer Status
- LaunchAgent is loaded and running (PID active)
- Plist: `~/Library/LaunchAgents/com.certmate.session-optimizer.plist`
- Logs: `~/.certmate/session_optimizer.log`
- Polls S3 every 120 seconds

### Known Issue
Silero VAD v3's LSTM state can get stuck at probability ~1.0 during silence. Workaround: amplitude-based gating in ChunkProcessor forces probability to 0 below amplitude 0.0005.

## Changes — 2026-03-05

### VAD Wake Threshold Raised (iOS)
- **Before**: threshold 0.5, 3 consecutive frames (90ms)
- **Current**: threshold 0.85, 30 consecutive frames (900ms)
- **Why**: False wakes from phone movement/breathing/tools. 900ms latency still within 3s ring buffer.
- Note: Memory previously said 0.75/5 frames — actual code has 0.85/30 frames
- Commit: `34beac4` (and subsequent) in CertMateUnified

### Cost Tracking Fixed — Doze Now Pauses Server Cost Tracker
- `RecordingSessionCoordinator.swift` now sends `serverWS?.sendPause()` on doze entry (was only on sleep)
- Server `CostTracker.pauseRecording()` now called for both doze and sleep states
- Commit: `4c75ccf` in CertMateUnified

### Analyzer: Actual Deepgram Streaming Time
- `analyze-session.js` now tracks total stream pause time from all STREAM_PAUSED/RESUMED pairs
- Doze duration changed from `Math.round()` seconds to millisecond precision (`duration_ms`)
- `deepgram_saved_usd` based on total stream pause time, not just sleep cycle duration
- Commit: `123b038` in EICR_App

### Optimizer Report Auth Fix
- Removed `auth.requireAuth` from POST routes (accept/reject/rerun) in `feedback.js`
- Report HTML fetch calls never included auth headers, so these endpoints silently returned 401
- Commit: `25072cf` in EICR_App

### Question Gate Debounce Increased
- `question-gate.js` GATE_DELAY_MS changed from 2000 to 2500ms
- Tests updated to match (17 tests passing)
- Commit: `b606e21` in EICR_App

### Deployment Notes
- All EICR_App changes deployed to AWS ECS
- Docker must use `--platform linux/arm64` for ECS Fargate Graviton (ARM64 since Apr 2026)
- iOS changes committed, require Xcode rebuild + deploy to device
- Manually accepted 3 outstanding optimizer reports via curl

## Changes — 2026-03-06

### Hybrid VAD: Deepgram for Doze, Silero for Wake Only
- **Before**: On-device Silero VAD handled BOTH doze entry (silence detection) AND wake (speech detection)
- **After**: Deepgram's server-side UtteranceEnd signal drives doze entry; Silero only used for wake from doze/sleep
- **Why**: Silero's LSTM state got stuck at high probability after `wake()`, preventing re-entry to doze. A 7-minute silent gap was observed with zero doze entries — Deepgram kept streaming silence, wasting ~$0.06.
- **Root cause**: `sileroVAD?.reset()` was called in `enterDozing()` but NOT in `wake()`. Even after adding the reset, Deepgram's server-side VAD is fundamentally more reliable for silence detection.
- **Doze flow**: Deepgram UtteranceEnd (2s server silence) → 5s timer (`utteranceSilenceTimeout`) → enterDozing. Any SpeechStarted or transcript cancels the timer.
- **Wake flow**: On-device Silero VAD, 30 frames (900ms) above 0.85 threshold → wake. Ring buffer (3s) replays pre-wake audio.
- Added `vad_events=true` to Deepgram URL — enables `SpeechStarted` events
- Removed: `vadSilenceFramesRequired`, `vadSilenceThreshold`, `consecutiveSilentFrames` from SleepManager
- Files changed: `SleepManager.swift`, `DeepgramService.swift`, `RecordingSessionCoordinator.swift`, `DeepgramRecordingViewModel.swift`, `DeepgramServiceTests.swift`

### Optimizer Bugs Fixed
1. **JSON parse crash** (`session-optimizer.sh`): Perl regex exits 0 on no-match, leaving `JSON_OUTPUT` empty → `generate-report-html.js` crashes on `JSON.parse("")`. Fixed with empty-string check + try/catch safety net.
2. **Duplicate sleep cycle counting** (`analyze-session.js`): Matched both `sleep_enter_dozing` AND `sleep_state_dozing` (same event, different categories). Fixed to only match one event name per type.

### Deployment Notes
- `session-optimizer.sh` + `analyze-session.js` — on Mac, take effect next optimizer cycle
- iOS changes require Xcode rebuild + deploy to device
