/**
 * Minimal type shim for the root-hoisted `js-yaml` dependency (no
 * @types/js-yaml in the tree; a full install would churn the lockfile for
 * two call sites). Harness-scoped — production web code never imports
 * js-yaml.
 */
declare module 'js-yaml' {
  export function load(input: string): unknown;
  export function dump(obj: unknown, opts?: { lineWidth?: number }): string;
  const yaml: { load: typeof load; dump: typeof dump };
  export default yaml;
}
