# Developer Setup Guide

> CertMate / EICR-oMatic 3000 -- Automated EICR/EIC certificate creation for electrical inspectors.
>
> Related: [CLAUDE.md](../CLAUDE.md) | [Architecture](reference/architecture.md) | [Deployment](reference/deployment.md) | [File Structure](reference/file-structure.md)

## Prerequisites

| Tool | Required Version | Notes |
|------|-----------------|-------|
| **Node.js** | 20.x LTS | Dockerfiles use `node:20-slim` / `node:20-alpine`. Install via [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm). |
| **npm** | 10+ | Ships with Node 20. Workspaces require npm 7+. |
| **PostgreSQL** | 14+ | Local instance or use Docker (see below). |
| **Redis** | 7+ | Only needed for job queue. Docker recommended. |
| **Docker** | 24+ | Required for Docker-based development and deployment. |
| **Docker Compose** | v2+ | Bundled with Docker Desktop on macOS/Windows. |
| **AWS CLI** | v2 | Only needed for cloud deployment. |
| **Git** | 2.30+ | Required for Husky git hooks. |

### Optional (for iOS development)

| Tool | Version | Notes |
|------|---------|-------|
| Xcode | 15+ | For CertMateUnified SwiftUI app |
| CocoaPods / SPM | Latest | iOS dependency management |

---

## 1. Clone and Install

```bash
# Clone the repository
git clone <repository-url> EICR_Automation
cd EICR_Automation/EICR_App

# Install all dependencies (root + workspaces)
npm install
```

This installs dependencies for all four workspaces:

| Workspace | Path | Purpose |
|-----------|------|---------|
| Backend | `src/` | Express API + WebSocket server |
| PWA | `frontend/` | Mobile-first Next.js (recording, live fill) |
| Web | `web/` | Desktop Next.js (dashboard, editing) |
| shared-types | `packages/shared-types/` | TypeScript types (`@certmate/shared-types`) |
| shared-utils | `packages/shared-utils/` | Shared utilities (`@certmate/shared-utils`) |

The `npm install` also runs `husky` via the `prepare` script, which sets up the git hooks automatically.

---

## 2. Environment Configuration

Copy the example environment file and customise it for local development:

```bash
cp .env.example .env
```

### Required variables

```env
# Disable AWS Secrets Manager for local development
USE_AWS_SECRETS=false
AWS_REGION=eu-west-2

# Database -- point to your local PostgreSQL instance
DATABASE_TYPE=postgresql
DATABASE_URL=postgresql://eicr_dev:eicr_dev_password@localhost:5432/eicr_dev

# Storage -- use local filesystem (files saved to data/ directory)
STORAGE_TYPE=local
```

### Optional variables

```env
# Redis (only needed for job queue)
REDIS_URL=redis://localhost:6379

# Error tracking
SENTRY_DSN=

# API keys (only needed if testing AI features locally)
# In production these come from AWS Secrets Manager
OPENAI_API_KEY=sk-...
DEEPGRAM_API_KEY=...
ANTHROPIC_API_KEY=...
```

> **Tip:** You can skip API keys entirely if you are only working on the UI or non-AI backend routes. The server starts without them.

See [architecture.md](reference/architecture.md#environment-variables) for the full list of environment variables and how secrets are managed in production.

---

## 3. Database Setup

### Option A: Local PostgreSQL

```bash
# macOS (Homebrew)
brew install postgresql@16
brew services start postgresql@16

# Create the development database and user
createuser -s eicr_dev 2>/dev/null || true
psql -c "ALTER USER eicr_dev WITH PASSWORD 'eicr_dev_password';"
createdb -O eicr_dev eicr_dev
```

Verify the connection:

```bash
psql postgresql://eicr_dev:eicr_dev_password@localhost:5432/eicr_dev -c "SELECT 1;"
```

### Option B: Docker PostgreSQL

If you prefer not to install PostgreSQL locally, add a Postgres service to your `docker-compose.yml` or run it standalone:

```bash
docker run -d \
  --name eicr-postgres \
  -e POSTGRES_USER=eicr_dev \
  -e POSTGRES_PASSWORD=eicr_dev_password \
  -e POSTGRES_DB=eicr_dev \
  -p 5432:5432 \
  postgres:16-alpine
```

The `DATABASE_URL` in `.env` works with both options as-is.

### Database migrations

The backend applies migrations automatically on startup. No manual migration step is needed.

---

## 4. Running the Application

The project is a monorepo with three runnable services. Start them in separate terminals:

### Backend (Express API + WebSocket)

```bash
npm start
# Runs: node src/server.js
# Available at: http://localhost:3000
# API docs (Swagger): http://localhost:3000/api/docs
# Health check: http://localhost:3000/health
```

### PWA Frontend (Mobile-first Next.js)

```bash
npm run dev --workspace=frontend
# Available at: http://localhost:3002
```

### Web Frontend (Desktop Next.js)

```bash
npm run dev --workspace=web
# Available at: http://localhost:3001
```

### All three at once (separate terminals recommended)

```bash
# Terminal 1
npm start

# Terminal 2
npm run dev --workspace=frontend

# Terminal 3
npm run dev --workspace=web
```

> **Note:** The PWA and Web frontends both depend on the backend API. Start the backend first.

---

## 5. Running Tests

### Backend tests (Jest)

```bash
# Run all backend tests
npm test

# Run with coverage
npm run test:coverage
```

The backend uses Jest with ES module support (`--experimental-vm-modules`).

### PWA frontend tests (Jest)

```bash
npm test --workspace=frontend

# With coverage
npm run test:coverage --workspace=frontend
```

### Web frontend tests

```bash
npm test --workspace=web
```

### PWA end-to-end tests (Playwright)

```bash
npm run e2e --workspace=frontend

# With browser visible
npm run e2e:headed --workspace=frontend
```

---

## 6. Linting and Formatting

### ESLint

```bash
# Lint backend and packages
npm run lint

# Lint PWA frontend
npm run lint --workspace=frontend

# Lint web frontend
npm run lint --workspace=web
```

ESLint is configured in `eslint.config.js` (flat config, ESLint 9):
- ECMAScript 2022 with ES modules
- `no-console` set to warn (allows `console.warn` and `console.error`)
- `no-unused-vars` set to warn (ignores args prefixed with `_`)
- Jest globals enabled for test files

### Prettier

```bash
# Format backend and packages
npm run format
```

Prettier configuration (`.prettierrc`):
```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "es5",
  "tabWidth": 2,
  "printWidth": 100
}
```

---

## 7. Git Hooks

Git hooks are managed by [Husky](https://typicode.github.io/husky/) and installed automatically via `npm install` (the `prepare` script).

### Pre-commit hook

Runs on every commit. Two checks:

1. **lint-staged** -- Runs ESLint (with `--fix`) and Prettier (with `--write`) on staged files only:

   | File pattern | Actions |
   |-------------|---------|
   | `src/**/*.js` | `eslint --fix`, `prettier --write` |
   | `packages/**/*.{ts,tsx}` | `eslint --fix`, `prettier --write` |
   | `frontend/src/**/*.{ts,tsx}` | `eslint --fix`, `prettier --write` |
   | `web/**/*.{ts,tsx}` | `eslint --fix`, `prettier --write` |

2. **Secrets detection** -- Scans staged diffs for common secret patterns:
   - AWS access keys (`AKIA...`)
   - API keys (`sk-...`)
   - Hardcoded passwords (`password = "..."`)

   If a potential secret is detected, the commit is blocked.

### Pre-push hook

Runs the full backend test suite (`npm test`) before any push. If tests fail, the push is rejected.

### Bypassing hooks (use sparingly)

```bash
# Skip pre-commit hooks
git commit --no-verify -m "emergency fix"

# Skip pre-push hooks
git push --no-verify
```

---

## 8. Docker Development Workflow

The `docker-compose.yml` provides a full local environment with Redis, the backend, the web frontend, and the PWA frontend.

### Start all services

```bash
docker-compose up --build
```

This starts:

| Service | Port | Description |
|---------|------|-------------|
| `redis` | 6379 | Redis 7 (Alpine) for job queue |
| `backend` | 3000 | Node.js API server |
| `web` | 3001 | Desktop Next.js app |
| `pwa` | 3002 | Mobile-first Next.js PWA |

### Service dependencies

```
redis (healthy) -> backend (healthy) -> web
                                     -> pwa
```

The backend waits for Redis to be healthy before starting. The frontends wait for the backend.

### Volumes

- `./data` is mounted to `/app/data` in the backend container (persistent job data)
- `./config` is mounted to `/app/config` in the backend container (configuration files)
- Redis data is persisted in a Docker volume

### Build individual services

```bash
# Rebuild only the backend
docker-compose up --build backend

# Rebuild only the PWA
docker-compose up --build pwa
```

### View logs

```bash
# All services
docker-compose logs -f

# Single service
docker-compose logs -f backend
```

### Stop and clean up

```bash
# Stop all services
docker-compose down

# Stop and remove volumes (resets Redis data)
docker-compose down -v
```

### Dockerfiles reference

| Dockerfile | Base Image | Purpose |
|-----------|-----------|---------|
| `docker/backend.Dockerfile` | `node:20-slim` | Backend API. Includes libvips, ImageMagick, ffmpeg, Playwright/Chromium for PDF generation. |
| `docker/nextjs.Dockerfile` | `node:20-alpine` | Unified Dockerfile for both Next.js apps. Uses `APP_DIR` build arg (`frontend` or `web`). |

---

## 9. Project Conventions

### ES Modules

The entire backend uses ES modules (`"type": "module"` in `package.json`). Use `import`/`export` syntax, not `require()`.

### Monorepo workspaces

npm workspaces are used. To run a command in a specific workspace:

```bash
npm run <script> --workspace=<name>
# Examples:
npm run dev --workspace=frontend
npm test --workspace=web
npm run build --workspace=frontend
```

### Code style

- Single quotes, semicolons, trailing commas (ES5 style)
- 2-space indentation, 100-character line width
- Backend: plain JavaScript (ES modules)
- Frontends: TypeScript with Next.js App Router
- State management: Zustand (PWA and Web)
- Data tables: TanStack Table
- UI components: Radix UI primitives with Tailwind CSS

---

## 10. AWS Deployment Basics

> Full deployment instructions: [docs/reference/deployment.md](reference/deployment.md)

Production runs on **AWS ECS Fargate** at **https://certomatic3000.co.uk**.

### Quick deploy (backend)

```bash
# Build, tag, push, and deploy
docker build -f docker/backend.Dockerfile -t eicr-backend .
aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.eu-west-2.amazonaws.com
docker tag eicr-backend:latest <ACCOUNT_ID>.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend:latest
docker push <ACCOUNT_ID>.dkr.ecr.eu-west-2.amazonaws.com/eicr-backend:latest
aws ecs update-service --cluster eicr-cluster-production --service eicr-backend --force-new-deployment --region eu-west-2
```

Changes go live in approximately 2 minutes.

### Check cloud status

```bash
aws ecs describe-services \
  --cluster eicr-cluster-production \
  --services eicr-frontend eicr-backend \
  --region eu-west-2 \
  --query "services[*].{Service:serviceName,Running:runningCount,Status:deployments[0].rolloutState}" \
  --output table
```

### View logs

```bash
aws logs tail /ecs/eicr/eicr-backend --region eu-west-2 --since 10m
```

### Key AWS resources

| Resource | Value |
|----------|-------|
| Region | eu-west-2 (London) |
| ECS Cluster | eicr-cluster-production |
| Backend Memory | 2048 MB / 512 CPU |
| Database | RDS PostgreSQL |
| Storage | S3 |
| Secrets | AWS Secrets Manager |

---

## 11. Troubleshooting

### `npm install` fails

- Ensure you are using Node.js 20.x: `node --version`
- Clear the npm cache: `npm cache clean --force`
- Delete `node_modules` and `package-lock.json`, then re-run `npm install`
- On macOS, if `sharp` fails to build, install `vips`: `brew install vips`

### Backend fails to start

- Check that PostgreSQL is running and the `DATABASE_URL` in `.env` is correct
- Verify the database exists: `psql -l | grep eicr_dev`
- Check that port 3000 is not in use: `lsof -i :3000`

### Frontend `dev` command fails

- Run `npm install` from the root directory (not inside `frontend/` or `web/`)
- Ensure the backend is running first (frontends connect to `http://localhost:3000`)

### Pre-commit hook fails

- **Lint errors:** Run `npm run lint` to see all issues. Use `npm run format` to auto-fix formatting.
- **Secrets detected:** Review the flagged lines. If it is a false positive, use `git commit --no-verify` (with caution).
- **lint-staged not found:** Run `npm install` from the project root.

### Pre-push hook fails (tests failing)

- Run `npm test` locally to identify failing tests.
- Check that your `DATABASE_URL` is set and the database is accessible.

### Docker issues

- **Port already in use:** Stop local services using the same ports (3000, 3001, 3002, 6379).
- **Build fails:** Ensure Docker Desktop is running and has enough memory allocated (4 GB minimum).
- **Container keeps restarting:** Check logs with `docker-compose logs backend` -- usually a missing environment variable.

### Redis connection refused

- Redis is optional for local development (only needed for the job queue).
- If you need it: `docker run -d --name redis -p 6379:6379 redis:7-alpine`

### Database connection errors in Docker

- The Docker Compose backend uses `DATABASE_URL` from your `.env` file.
- If using a local PostgreSQL (not in Docker), change `localhost` to `host.docker.internal` in `DATABASE_URL` so the container can reach your host machine.

### `--experimental-vm-modules` warning

This is expected. The backend test command uses `--experimental-vm-modules` because Jest requires it for ES module support. The warning is harmless.

---

## Quick Reference

| Task | Command |
|------|---------|
| Install dependencies | `npm install` |
| Start backend | `npm start` |
| Start PWA dev | `npm run dev --workspace=frontend` |
| Start web dev | `npm run dev --workspace=web` |
| Run backend tests | `npm test` |
| Run frontend tests | `npm test --workspace=frontend` |
| Run web tests | `npm test --workspace=web` |
| Run E2E tests | `npm run e2e --workspace=frontend` |
| Lint all | `npm run lint` |
| Format all | `npm run format` |
| Docker up | `docker-compose up --build` |
| Docker down | `docker-compose down` |
