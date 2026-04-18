import type { NextConfig } from 'next';
import withSerwistInit from '@serwist/next';

/**
 * Phase 7a: wrap the Next config with Serwist so every production build
 * emits `public/sw.js` from `src/app/sw.ts`. Serwist auto-registers the SW
 * on the client (no manual registration component needed).
 *
 * - `cacheOnNavigation: false` is the default, but set explicitly so a
 *   future reader doesn't flip it without noticing. We never want Serwist
 *   stashing authenticated HTML in a runtime cache — every auth-gated
 *   navigation falls through to the network-only default in `sw.ts`.
 * - `reloadOnOnline: false` (pre-deploy hardening). Phase 7a defaulted this
 *   to true because there was no outbox; a reload after a flaky connection
 *   was the cheapest way to resync. That logic inverted once Phase 7c
 *   shipped the mutation outbox + SWR read cache: an `online` event on a
 *   recording page would now force-reload, tearing down the Deepgram WS +
 *   Sonnet session mid-utterance AND losing whatever local edits haven't
 *   yet drained to the outbox (the debounced save in JobProvider hasn't
 *   fired). Offline recovery is now handled explicitly — the SWR read
 *   path re-hydrates from cache + refetches on mount, the replay worker
 *   drains the outbox on 'online'. The dedicated update handoff
 *   (`sw.ts` + sonner toast) owns the "new SW available → reload" path
 *   for deploy rollouts. Leaving `reloadOnOnline: true` on top of all
 *   that is a hazard, not a safety net.
 * - `disable: process.env.NODE_ENV === 'development'` keeps the dev server
 *   clean; HMR and the SW don't mix, and we don't want a stale dev SW
 *   serving cached assets after `npm start`.
 */
const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  cacheOnNavigation: false,
  reloadOnOnline: false,
  disable: process.env.NODE_ENV === 'development',
});

const nextConfig: NextConfig = {
  // `docker/nextjs.Dockerfile` copies `.next/standalone` + `.next/static`
  // into the runner stage and invokes `node web/server.js`. That layout
  // only exists when Next emits a standalone build, so this flag is
  // mandatory for the production image — without it, the Docker build
  // fails in buildx with "/app/web/.next/standalone: not found".
  output: 'standalone',
};

export default withSerwist(nextConfig);
