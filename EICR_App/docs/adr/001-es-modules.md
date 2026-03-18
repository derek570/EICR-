# ADR-001: ES Modules for Backend

**Date:** 2026-01-15
**Status:** Accepted

## Context

The EICR-oMatic 3000 backend is a Node.js Express server (`src/server.js`) that handles API routes, WebSocket connections, job processing, and S3 storage. When the project was started, we needed to choose between CommonJS (`require()`) and ES Modules (`import/export`) for the module system.

Node.js has supported ES modules natively since v12 (behind a flag) and stably since v16. The project runs on Node.js 20 in production (AWS ECS Fargate via `node:20` Docker images). The frontend workspaces (`frontend/` and `web/`) both use Next.js with TypeScript, which uses ES module syntax natively.

Key considerations:

- The backend imports from `@anthropic-ai/sdk`, `@aws-sdk/*`, `openai`, `express`, `ws`, and other modern packages that all publish ES module builds.
- Shared packages (`packages/shared-types/`, `packages/shared-utils/`) are consumed by both the backend and the Next.js frontends, making a consistent module system valuable.
- Jest test runner requires the `--experimental-vm-modules` flag for ES module support, adding a minor inconvenience to the test command.
- All route modules in `src/routes/` use `import`/`export default` syntax.
- The team has a preference for modern JavaScript idioms and top-level `await`.

## Decision

Use ES Modules throughout the backend by setting `"type": "module"` in the root `package.json`. All `.js` files use `import`/`export` syntax. Node built-in modules are imported with the `node:` protocol prefix (e.g., `import fs from "node:fs/promises"`, `import path from "node:path"`).

The Jest test command uses `--experimental-vm-modules`:

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js
```

## Consequences

### Positive

- **Consistent syntax across the entire monorepo.** Backend, PWA frontend, web frontend, and shared packages all use the same `import`/`export` syntax, reducing cognitive overhead when working across workspaces.
- **Top-level `await` support.** Server startup, AWS Secrets Manager loading, and database initialization can use `await` at the module level without wrapping in async IIFEs.
- **Tree-shaking potential.** ES modules enable static analysis, which benefits bundled workspaces (Next.js frontends) and could benefit backend bundling if adopted later.
- **Modern ecosystem alignment.** Newer npm packages increasingly ship ESM-only. Using ES modules avoids dual-module interop issues with packages like `@anthropic-ai/sdk`.
- **Explicit `node:` imports.** The `node:` protocol prefix makes it unambiguous when importing Node.js built-ins versus npm packages (e.g., `node:fs` vs a hypothetical `fs` package).

### Negative

- **Jest requires a flag.** The `--experimental-vm-modules` flag is still required for Jest ESM support as of Node.js 20. This adds a minor complexity to the test script and means Jest ESM support could theoretically change between Node versions.
- **No `__dirname` / `__filename`.** ES modules do not provide these CommonJS globals. Code that needs file paths must use `import.meta.url` with `fileURLToPath()` and `path.dirname()`, which is more verbose.
- **Dynamic imports.** Conditional or lazy imports must use `await import()` instead of `require()`, which is slightly more verbose but functionally equivalent.
- **Some older packages may need workarounds.** A small number of npm packages only export CommonJS. Node.js handles this via automatic CJS-to-ESM wrapping, but default imports may need adjustment (e.g., `import pkg from "legacy-package"` instead of named imports).
