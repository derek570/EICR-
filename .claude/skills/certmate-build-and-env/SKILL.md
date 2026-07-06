---
name: certmate-build-and-env
description: >
  Recreate the CertMate/EICR_Automation working environment from scratch and keep a local
  dev setup healthy. Load this when you need to: clone/lay out the repo(s), install
  dependencies, pick the right Node version (the Node 20 pin story), start the backend
  (:3000) or web PWA (:3001) locally, set up .env vs AWS Secrets Manager, understand the
  husky/.githooks hook systems, understand why dev uses Turbopack but build uses webpack,
  or diagnose "works on my machine" install/boot failures. Do NOT load this for deploying
  to AWS/CI operations (use certmate-run-and-operate), for the env-var/flag catalog and
  their prod values (use certmate-config-and-flags), for test-harness footguns (use
  certmate-validation-and-qa), or for change-control policy (use certmate-change-control).
---

# CertMate Build & Environment — from bare Mac to running dev stack

All paths repo-relative to the repo root (`EICR_Automation/`). All volatile facts date-stamped **as of 2026-07-06**.

## 1. Repo layout — TWO git repos, not one

| Repo | Remote | What it is |
|---|---|---|
| `EICR_Automation/` (this repo) | `git@github.com:derek570/EICR-.git` | Backend + web PWA + shared packages monorepo |
| `EICR_Automation/CertMateUnified/` | `git@github.com:derek570/CertMateUnified.git` | **SEPARATE nested git repo** — the iOS SwiftUI app (canon for the data contract) |

`CertMateUnified/.git` is a full independent repo dir (own object store, own remote). It is NOT a submodule — the outer repo does not track it. Clone both to recreate the full environment:

```bash
git clone git@github.com:derek570/EICR-.git EICR_Automation
cd EICR_Automation
git clone git@github.com:derek570/CertMateUnified.git CertMateUnified
```

Any `git log`/`git diff` run from inside `CertMateUnified/` hits the iOS repo, not this one. Wrong-repo diffing is the project's documented default explanation for "all my changes vanished" confusion — always `git rev-parse --show-toplevel` before concluding anything from a diff.

**Outer-repo history starts 2026-02-23** (`a421194f` "fresh repo baseline — recover after hardware failure"). Anything earlier survives only as changelog prose in `docs/reference/changelog.md`.

### npm workspaces (root `package.json` → `"workspaces": ["packages/*", "web"]`)

| Workspace | Path | Notes |
|---|---|---|
| Backend | `src/` (root package, not a workspace) | Express API + WebSocket. `"type": "module"` — native ESM everywhere |
| Web | `web/` | Next.js 16 / React 19 PWA |
| shared-types | `packages/shared-types/` | `@certmate/shared-types` — consumed as raw TS source (`main: src/index.ts`), **no build step** |
| shared-utils | `packages/shared-utils/` | `@certmate/shared-utils` — same, no build step |

There is NO `frontend/` workspace. See §8 trap 1.

## 2. Node version — the 20-pin story

| Fact | Value |
|---|---|
| Pin source of truth | `.nvmrc` = `20` (repo root) |
| Web hard-ish pin | `web/package.json` `"engines": { "node": ">=20 <21" }` |
| CI | Node 20 at 4 sites in `.github/workflows/deploy.yml` |
| Dev boxes | may run a newer major (the primary dev Mac runs v25) — this is tolerated, not endorsed |

**Why 20 matters:** jsdom / Storage / experimental-webstorage behaviour differs across Node majors. This produced the WS7 class of bug — web tests **green locally on Node 25, red in CI on Node 20** — because jsdom's real `Storage` silently ignored per-instance overrides. So a web test run on the wrong major proves nothing.

**The guard:** `web/scripts/check-node.mjs`
- Runs automatically as web `pretest` (every `npm test --workspace=web`) and again inside `.husky/pre-push` (double warning is expected and harmless).
- **WARN-only by design** — exits 0 on mismatch so it never blocks unrelated work or a GUI-git-client push. Reads the expected major from `.nvmrc`.
- Opt-in hard gate: `CHECK_NODE_STRICT=1 node web/scripts/check-node.mjs` exits non-zero on mismatch.
- Deliberately scoped: `engines` lives in `web/package.json` only, and root does NOT set `engine-strict` — so backend `npm ci` still works on a Node-25 box. Do not "tidy" this into a root-level strict pin.

**Rule for agents:** before trusting any local `npm test --workspace=web` result, be on Node 20 (`nvm use`). Backend Jest is less version-sensitive but CI truth is Node 20 for both.

```bash
nvm use          # picks up .nvmrc → Node 20
node -v          # expect v20.x
```

## 3. Install

```bash
cd EICR_Automation
nvm use
npm ci           # installs root + ALL workspaces (web, packages/*) in one shot
```

- `npm ci` at root is the whole install — no per-workspace installs, no build step for `packages/*` (they are consumed as TypeScript source).
- `prepare: husky` runs on install and sets `core.hooksPath` to `.husky/_` (see §7).
- Root `overrides`: `bn.js >= 5.2.3` (security pin). Root devDeps include jest, eslint 9, prettier, husky, lint-staged.
- iOS: open `CertMateUnified/` in Xcode separately; it has its own `CLAUDE.md` and TestFlight script (out of scope here — see `certmate-run-and-operate`).

## 4. Local dev startup

### 4a. Backend (:3000)

Needs a `.env` (backend loads it via `import 'dotenv/config'` in `src/app.js`) and a local PostgreSQL.

```bash
cp .env.example .env    # then fill in the API keys you need
# key local-dev values already in the template:
#   USE_AWS_SECRETS=false      ← makes the backend read keys from .env, not AWS
#   APP_PORT=3000
#   DATABASE_TYPE=postgresql
#   DATABASE_URL=postgresql://eicr_dev:eicr_dev_password@localhost:5432/eicr_dev
#   STORAGE_TYPE=local         ← files land in data/, no S3 needed
#   REDIS_URL=redis://localhost:6379   (optional — only for the job queue)
npm run migrate:up      # node-pg-migrate, applies migrations/ (13 files as of 2026-07-06)
npm start               # node src/server.js → http://localhost:3000
```

Uncomment/fill only the API keys the feature you're touching needs (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`). Never commit `.env`; the pre-commit hook greps staged diffs for secret patterns.

### 4b. Web (:3001)

```bash
PORT=3001 npm run dev --workspace=web    # next dev --turbopack
```

- Backend owns :3000; the web dev server must sit on :3001. Setting `PORT=3001` explicitly is the house convention (Playwright's `webServer` does exactly this). Without it Next will still auto-increment to 3001 when 3000 is busy, but don't rely on that.
- Web → backend URL: `web/src/lib/api-client.ts:76` — `process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'`. Local dev needs no env var; the default is correct.

### 4c. Environment-secrets model (`USE_AWS_SECRETS`)

| Mode | Trigger | Behaviour |
|---|---|---|
| Local | `USE_AWS_SECRETS=false` (or unset) | All keys + `DATABASE_URL` read from `.env` |
| Prod (ECS) | `USE_AWS_SECRETS=true` on the task def | Keys from AWS Secrets Manager `eicr/api-keys` (one JSON object), DB creds from `eicr/database`, region `eu-west-2` |

The switch is checked in `src/app.js:28` and `src/services/secrets.js:100,135` (`process.env.USE_AWS_SECRETS?.toLowerCase() === 'true'`). There is no third mode. No local `.env` is ever used in cloud deploys.

## 5. Turbopack dev vs webpack build — DO NOT "FIX"

- `web` `dev` script: `next dev --turbopack`
- `web` `build` script: `next build --webpack`

This asymmetry is deliberate (commit `eb72acc7`, 2026-04-17, Phase 7a): **Next 16 defaults `next build` to Turbopack, but Serwist (`@serwist/next`, the PWA service-worker plugin) does not support Turbopack builds** (serwist/serwist#54) — it injects a webpack plugin to emit `public/sw.js` from `web/src/app/sw.ts`. A Turbopack build would silently ship without a service worker. Dev is safe on Turbopack because Serwist is disabled in development (`disable: NODE_ENV === 'development'` in `web/next.config.ts`).

If a future session sees `--webpack` and is tempted to "modernise" it: first verify Serwist has shipped Turbopack support AND that `sw.js` is actually emitted by a Turbopack build; otherwise leave it.

Related build facts (`web/next.config.ts`): `output: 'standalone'` is mandatory (the Docker runner stage copies `.next/standalone`); `serverExternalPackages: ['onnxruntime-web']` avoids a webpack fs-trace failure.

## 6. Docker — local compose vs CI images

**`docker-compose.yml` is LOCAL-DEV ONLY** (redis:7 + backend :3000 + web mapped :3001→3000). It reads `.env` for the backend. Nothing in production uses compose.

**Production images are built ONLY in CI**, on `ubuntu-24.04-arm` runners, `platforms: linux/arm64` (matches ECS `runtimePlatform.cpuArchitecture: ARM64` in both `ecs/task-def-*.json`):

| Image | Dockerfile | Base | Notes |
|---|---|---|---|
| eicr-backend | `docker/backend.Dockerfile` | `node:20-slim` | libvips/ffmpeg + Playwright chromium + `pip3 install reportlab` (Python PDF fallback); non-root `certmate`; HEALTHCHECK curls `/health` |
| eicr-frontend (PWA) | `docker/nextjs.Dockerfile` | `node:20-alpine` multi-stage | `ARG APP_DIR` (=web); standalone output; non-root `nextjs` |

**Critical `nextjs.Dockerfile` gotcha (documented in-file):** every `NEXT_PUBLIC_*` client flag must be declared as BOTH `ARG` and `ENV` in the builder stage, or it is **silently dropped at `next build`** (inlined as undefined). This bit the project in 2026-05 with `NEXT_PUBLIC_REGEX_HINTS_ENABLED`. Adding a new `NEXT_PUBLIC_*` var = Dockerfile ARG+ENV + deploy.yml build-arg + (see `certmate-config-and-flags`).

Root-level `Dockerfile.backend` and `Dockerfile.hotpatch` exist but **CI does not use them** — the `docker/` pair is canonical.

**NEVER run local `./deploy.sh`.** It exists in the repo but is banned by CLAUDE.md: Docker Desktop is not kept running on the dev Mac, so it fails immediately, and its `tee`-wrapped invocation masks the failure as exit 0. CI (push to `main` → GitHub Actions) is the only deploy path. Deploy mechanics live in `certmate-run-and-operate`.

## 7. Git hooks — two systems, one active

`git config core.hooksPath` on this clone → `.husky/_` (husky is ACTIVE, wired by the root `prepare` script).

### `.husky/pre-commit`
```
export PATH="/opt/homebrew/bin:$PATH"   ← LOAD-BEARING, see below
npx lint-staged                          ← eslint --fix + prettier on staged src/packages/web files
<secrets grep>                           ← blocks commit on AKIA…/sk-…/password= patterns in staged diff
```

### `.husky/pre-push`
```
export PATH="/opt/homebrew/bin:$PATH"
source nvm (best-effort, || true) && nvm use     ← selects Node 20 when nvm exists
node web/scripts/check-node.mjs                  ← WARN on non-20 major
npm test && npm test --workspace=web             ← BOTH suites (backend Jest AND web vitest)
```

**Do NOT delete the Homebrew PATH export.** Husky hooks run under a minimal, non-login shell; GUI git clients (Tower, GitHub Desktop) don't inherit a login PATH, so without `/opt/homebrew/bin` prepended, `node`/`npx` are unresolvable and every commit/push from a GUI client fails (or worse, silently skips). The nvm sourcing is best-effort on top; Homebrew is the no-nvm baseline. The hook file's own comments say exactly this — treat them as authoritative.

Pre-push runs both suites because the pre-WS7 hook ran backend-only, so a broken web suite was never gated locally (2026-07-03 hardening).

### `.githooks/` — LEGACY, opt-in, different job
`.githooks/pre-push` is a branch-divergence guard (refuses push when the remote has commits you don't, born from a 2026-04-10 two-machine divergence incident). It only activates if you run `./.githooks/install.sh`, which sets `core.hooksPath=.githooks` — **which would DISABLE all husky hooks** (test gate, lint-staged, secrets scan). Do not run `install.sh` on a clone where husky is active. As of 2026-07-06 husky is the canonical system; `.githooks/` is historical.

## 8. Known traps (each has cost real time)

| # | Trap | Truth |
|---|---|---|
| 1 | **`docs/DEVELOPER_SETUP.md` is STALE** (untouched since the 2026-02-23 baseline). It says "four workspaces" including a `frontend/` PWA workspace, `cd EICR_Automation/EICR_App`, `npm run dev --workspace=frontend`, etc. | `frontend/` does not exist (retired legacy frontend — remnants only in `_archive/`). The live workspaces are `web` + `packages/*`; the repo dir is `EICR_Automation`, not `EICR_App`. Prefer THIS skill + `CLAUDE.md` over DEVELOPER_SETUP.md for anything they disagree on. |
| 2 | Local `./deploy.sh` | Banned — see §6. CI only. |
| 3 | Testing web on Node ≠ 20 | Results untrustworthy (jsdom/Storage per-major drift). `nvm use` first; `CHECK_NODE_STRICT=1` to hard-fail. |
| 4 | "Fixing" `next build --webpack` → Turbopack | Silently drops the service worker. See §5. |
| 5 | Running `.githooks/install.sh` | Disables husky (test gate + secrets scan). See §7. |
| 6 | Removing the `/opt/homebrew/bin` PATH export from hooks | Breaks every GUI-git-client commit/push. See §7. |
| 7 | Repo (or worktree) under **iCloud Drive** | iCloud stubs/evictions corrupt `.git` (EDEADLK on dataless files). Keep clones outside synced folders. |
| 8 | Xcode/CoreSimulator data on an **NTFS** volume | Breaks CoreSimulator; keep iOS tooling on APFS. |
| 9 | **APFS case-insensitivity** | Default macOS volumes are case-insensitive; two paths differing only by case collide (symlink self-destruction seen historically). Don't create case-twin files; CI's Linux runners ARE case-sensitive. |
| 10 | Diffing from inside `CertMateUnified/` | You're in the OTHER repo. §1. |

## 9. Fresh-machine checklist (condensed)

```bash
# 1. Clone both repos                       (§1)
git clone git@github.com:derek570/EICR-.git EICR_Automation && cd EICR_Automation
git clone git@github.com:derek570/CertMateUnified.git CertMateUnified

# 2. Node 20 + install                      (§2, §3)
nvm install 20 && nvm use && npm ci

# 3. Backend env + DB                       (§4a)
cp .env.example .env                        # fill keys as needed; USE_AWS_SECRETS=false
createdb eicr_dev 2>/dev/null; npm run migrate:up
npm start                                   # :3000 — verify: curl -s localhost:3000/health

# 4. Web                                    (§4b)
PORT=3001 npm run dev --workspace=web       # :3001

# 5. Sanity: both suites green on Node 20
npm test && npm test --workspace=web
```

(`createdb` assumes a local PostgreSQL with a matching role; adjust `DATABASE_URL` in `.env` to whatever local Postgres you have. UNVERIFIED here: exact minimum Postgres version — prod is RDS PostgreSQL; any recent major works for dev.)

## 10. When NOT to use this skill

| You need… | Use sibling |
|---|---|
| Deploying, CI job anatomy, ECS status/logs, rollback, TestFlight | `certmate-run-and-operate` |
| The full env-var/flag catalog, prod values, NEXT_PUBLIC build-time trap in depth, drift guards | `certmate-config-and-flags` |
| Test-harness footguns (vitest flags, storage shim, fake timers, React dedupe), what CI blocks | `certmate-validation-and-qa` |
| Change classification, MANDATORY blocks, commit/push policy | `certmate-change-control` |
| Symptom→triage for runtime failures | `certmate-debugging-playbook` |
| Voice WS protocol, CCU pipeline, latency work | `certmate-voice-wire-protocol` / `certmate-ccu-pipeline` / `certmate-latency-campaign` |

## Provenance and maintenance

All claims verified against the repo on 2026-07-06. Re-verify before relying on:

| Fact | One-line re-verification |
|---|---|
| Workspaces list | `node -e "console.log(require('./package.json').workspaces)"` |
| Node pin | `cat .nvmrc && node -e "console.log(require('./web/package.json').engines)"` |
| check-node behaviour (WARN / `CHECK_NODE_STRICT`) | `sed -n '1,25p' web/scripts/check-node.mjs` |
| dev=turbopack, build=webpack | `node -e "console.log(require('./web/package.json').scripts)"` |
| Serwist still webpack-only rationale | `grep -n serwist web/next.config.ts` + check serwist/serwist#54 upstream |
| Active hooksPath is husky | `git config core.hooksPath` (expect `.husky/_`) |
| Hook contents (PATH export, both suites) | `cat .husky/pre-commit .husky/pre-push` |
| USE_AWS_SECRETS switch sites | `grep -rn USE_AWS_SECRETS src/app.js src/services/secrets.js` |
| Web API base default | `grep -n "API_BASE_URL" web/src/lib/api-client.ts` |
| CI ARM64 + Node 20 | `grep -n "ubuntu-24.04-arm\|linux/arm64\|node-version" .github/workflows/deploy.yml` |
| CertMateUnified is a separate repo | `git -C CertMateUnified remote -v` |
| DEVELOPER_SETUP.md still stale | `grep -n "frontend/\|EICR_App" docs/DEVELOPER_SETUP.md` |
| Migration count | `ls migrations/ \| wc -l` (13 as of 2026-07-06) |
