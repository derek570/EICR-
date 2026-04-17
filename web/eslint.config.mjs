import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Serwist-generated service-worker bundle. Source lives in
    // `src/app/sw.ts` (own tsconfig, typechecked separately); the bundled
    // output at `public/sw.js` is minified/rolled and not meaningful to
    // lint. Already in `.gitignore`; adding here so a local build doesn't
    // surface thousands of "errors" in third-party bundler output.
    "public/sw.js",
    "public/sw.js.map",
    "public/swe-worker-*.js",
    "public/swe-worker-*.js.map",
    "public/workbox-*.js",
    "public/workbox-*.js.map",
  ]),
]);

export default eslintConfig;
