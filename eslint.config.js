import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

/**
 * Root ESLint config (flat). Covers the backend (`src/`, plain ESM JavaScript)
 * and the two shared workspaces (`packages/`, TypeScript). `web/` has its own
 * Next.js config and is ignored here.
 *
 * WHY packages/ IS LINTED HERE (2026-09-23): it previously sat in the ignore
 * list below while `package.json`'s lint script still passed `packages/` as a
 * target. ESLint 9 treats "you gave me a path matching only ignored files" as a
 * hard error, so `npm run lint` exited 2 on its own arguments BEFORE linting
 * anything — for months, because CI never ran it. Deleting the argument made
 * the command work but left `shared-types` and `shared-utils` checked by
 * nothing, which is worse: they sit on the wire contract between the backend,
 * iOS and web. The parser and plugin were already devDependencies; they were
 * simply never wired up. They are now.
 *
 * File selection comes from the `files` patterns below, NOT from a `--ext`
 * flag. `--ext` is a legacy eslintrc concept; under flat config the config
 * decides what gets linted, so the two can never disagree.
 */
export default [
  {
    // Ignores first so nothing below has to repeat them. `web/` is linted by
    // web/eslint.config.mjs (Next.js). Nothing else is built into packages/ —
    // both workspaces publish TypeScript source directly (`main: src/index.ts`)
    // — so there is no dist/ to exclude.
    ignores: ["node_modules/", "coverage/", "frontend/", "web/"],
  },
  js.configs.recommended,
  {
    // Backend + scripts: plain ESM JavaScript on Node.
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Shared workspaces: TypeScript. Deliberately NOT type-aware linting
    // (no `project:` / `projectService`) — that needs a full type build on
    // every run and would put a multi-second tsc pass in the pre-commit path.
    // `tsc --noEmit` per workspace is the type gate; this is the lint gate.
    files: ["packages/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        // shared-utils spans both runtimes: `impedance.ts` and
        // `number-normaliser.ts` run server-side, `download-blob.ts` and
        // `cn.ts` run in the browser.
        ...globals.node,
        ...globals.browser,
        ...globals.es2021,
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // The base rules must yield to their TypeScript-aware equivalents.
      // `no-undef` in particular is actively wrong on TS: it cannot see type
      // positions and reports every interface and type alias as undefined.
      // The compiler already covers both, better.
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-redeclare": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["**/*.test.*", "**/__tests__/**", "**/tests/**"],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
];
