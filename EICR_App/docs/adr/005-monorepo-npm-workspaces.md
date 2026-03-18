# ADR-005: Monorepo with npm Workspaces

**Date:** 2026-01-20
**Status:** Accepted

## Context

EICR-oMatic 3000 consists of multiple JavaScript/TypeScript packages that need to work together:

- **Backend** (`src/`) -- Node.js Express API server with WebSocket support, job processing, S3 storage, and AI extraction orchestration.
- **PWA Frontend** (`frontend/`) -- Next.js App Router mobile-first progressive web app for recording, live certificate fill, and job management. Uses Zustand for state and TanStack for data fetching.
- **Web Frontend** (`web/`) -- Next.js App Router desktop-focused web application for dashboard, certificate editing, and client management.
- **Shared Types** (`packages/shared-types/`) -- TypeScript type definitions (`@certmate/shared-types`) shared across all workspaces.
- **Shared Utilities** (`packages/shared-utils/`) -- Common utility functions (`@certmate/shared-utils`) used by both frontends and the backend.

Additionally, the iOS app (`CertMateUnified/`) lives in the same repository but outside the npm workspace structure (it is a Swift/Xcode project).

### Alternatives considered

1. **Separate repositories.** One repo per package with npm publishing for shared code. Rejected because the team is small (1-2 developers), cross-package changes are frequent, and publishing shared packages for internal use adds overhead.
2. **Turborepo / Nx.** Monorepo tooling with build caching and task orchestration. Rejected as over-engineered for the current team size. npm workspaces provide sufficient dependency hoisting and cross-workspace scripts.
3. **npm workspaces (chosen).** Native Node.js/npm feature, zero additional tooling, simple workspace declarations in root `package.json`.

## Decision

Use a **single repository** with **npm workspaces** declared in the root `package.json`:

```json
{
  "name": "eicr_automation",
  "type": "module",
  "workspaces": [
    "packages/*",
    "frontend",
    "web"
  ]
}
```

Each workspace has its own `package.json` and can be targeted independently:

```bash
npm start                          # Backend (port 3000)
npm run dev --workspace=frontend   # PWA (port 3002)
npm run dev --workspace=web        # Web (port 3001)
npm test                           # Backend tests
npm test --workspace=frontend      # Frontend tests
npm test --workspace=web           # Web tests
```

Shared packages are referenced by workspace name in `dependencies`:

```json
{
  "dependencies": {
    "@certmate/shared-types": "*",
    "@certmate/shared-utils": "*"
  }
}
```

The backend is the root workspace (scripts in root `package.json` target `src/`), while the PWA and web frontends are named workspaces.

Linting and formatting run from the root across all workspaces:

```bash
npm run lint     # ESLint across src/, packages/
npm run format   # Prettier across src/, packages/
```

Pre-commit hooks (Husky + lint-staged) run ESLint and Prettier on staged files. Pre-push hooks run the full test suite.

## Consequences

### Positive

- **Single `npm install`.** All dependencies across all workspaces are installed and hoisted with one command. No need to `cd` into each package and install separately.
- **Cross-workspace imports just work.** Frontend code can `import { CertificateField } from "@certmate/shared-types"` without npm publishing or manual linking. npm resolves workspace dependencies via symlinks.
- **Atomic commits.** A change that modifies the backend API, the shared types, and both frontends can be a single commit. No cross-repo coordination required.
- **Shared tooling configuration.** ESLint, Prettier, Husky, and lint-staged are configured once at the root and apply to all workspaces. TypeScript `tsconfig.json` files in each workspace can extend a shared base.
- **Simple CI/CD.** Docker builds copy the entire workspace (`COPY . .`) and run `npm install` once. No multi-repo checkout or dependency resolution needed.
- **iOS coexistence.** The CertMateUnified Xcode project lives alongside the npm workspaces without interference. Xcode ignores `node_modules` and npm ignores `.xcodeproj`.

### Negative

- **Large `node_modules`.** All workspace dependencies are hoisted to the root `node_modules`, making it larger than any individual package would need. Docker builds must use `.dockerignore` to exclude frontend-only dependencies from backend images.
- **No build caching.** Unlike Turborepo/Nx, npm workspaces do not cache build outputs. Rebuilding all workspaces after a clean is slower. Acceptable at current project size.
- **Backend is the root workspace.** The backend's scripts and dependencies live in the root `package.json` alongside workspace configuration. This is slightly unconventional (some monorepos put all packages in subdirectories) but keeps the backend as the primary/default workspace, matching the Docker deployment model.
- **Workspace-aware commands required.** Developers must remember to use `--workspace=frontend` or `--workspace=web` when targeting specific packages. Forgetting this runs the command against the backend by default.
- **Version alignment.** All workspaces share the same hoisted dependency versions. If the PWA needs a different version of a dependency than the web frontend, npm workspaces may not handle this cleanly without `overrides` or nesting.
