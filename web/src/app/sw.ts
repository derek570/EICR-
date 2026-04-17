/// <reference types="@serwist/next/typings" />
// Service-worker scoped TS: `tsconfig.sw.json` wires up `lib: ["webworker"]`
// and excludes this file from the main `tsconfig.json` so its ambient types
// don't pollute the rest of the app (otherwise `navigator` resolves to
// `WorkerNavigator` everywhere and breaks DOM-side code like
// `mic-capture.ts` that reads `navigator.mediaDevices`).

import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import {
  CacheFirst,
  ExpirationPlugin,
  NetworkFirst,
  NetworkOnly,
  Serwist,
  StaleWhileRevalidate,
} from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// Minimal `process.env` shim — webpack replaces `process.env.NEXT_PUBLIC_*`
// at build time with string literals, so at runtime this read is just a
// constant. We declare the shape here rather than pulling `@types/node`
// into the service-worker build because Node's process type is enormous
// and irrelevant to a browser worker.
declare const process: { env: { NEXT_PUBLIC_BUILD_ID?: string } };

// Build ID threaded through via Next's build system. When this is undefined
// (local prod build without CI env), fall back to a timestamp so dev builds
// don't share caches. The string is part of every runtime cache name so a
// fresh deploy fully invalidates the previous cache set on activate.
const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? `local-${Date.now()}`;

/**
 * Matcher helpers — kept small and explicit so the priority order in the
 * Serwist constructor below reads as a routing table, not a puzzle.
 */
const NEVER_CACHE_PATHS = /^\/_next\/app\//;
const STATIC_ASSET_PATHS = /^\/_next\/static\//;
const FONT_EXTENSIONS = /\.(?:woff2?|ttf|otf)$/i;
const ICON_PATHS = /^\/(?:icons\/|apple-icon|favicon)/;
// Navigation cache is scoped to PUBLIC paths only — authenticated pages
// (`/dashboard`, `/job/*`, `/settings/*`) must never be written to a cache
// because the device may be shared between inspectors and the HTML can
// contain the signed-in user's name/email.
const PUBLIC_NAVIGATION_PATHS = /^\/(?:$|login|legal|offline)/;

function isRscRequest(request: Request, url: URL): boolean {
  // Next emits the RSC flight as a separate fetch when you click a <Link>.
  // It sets `RSC: 1` on the request, and often appends `?_rsc=<token>` for
  // cache-busting. Either signal is enough to know this isn't a regular
  // HTML navigation — caching the flight payload while the matching JS
  // chunk URLs rev on deploy is the #1 cause of "Failed to find Server
  // Action" errors mid-session.
  return request.headers.get('RSC') === '1' || url.searchParams.has('_rsc');
}

function isServerActionRequest(request: Request): boolean {
  // Next sends the `Next-Action` request header on server-action POSTs.
  // Belt-and-braces with the `/_next/app/` URL match — the header catches
  // the dispatch even if Next changes the endpoint path.
  return request.headers.has('Next-Action');
}

const serwist = new Serwist({
  // Serwist's build plugin injects the precache manifest here. In 7a we
  // deliberately keep the list short (just the /offline shell + manifest
  // icons from `public/`), so a cold-cache install is fast on mobile data.
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true, // safe on the first deploy — no prior SW exists to
  // hand off from. Phase 7b must switch to postMessage-driven skipWaiting
  // with a "New version available" toast BEFORE the second deploy lands,
  // otherwise active users get hot-swapped mid-edit.
  clientsClaim: true,
  navigationPreload: true,
  disableDevLogs: true,
  runtimeCaching: [
    // 1. NEVER CACHE — server actions + RSC + cross-origin.
    //    These must hit the network every time; caching them causes
    //    version-skew, auth leakage, or silent failure.
    {
      matcher: ({ request, url }) =>
        isServerActionRequest(request) ||
        isRscRequest(request, url) ||
        NEVER_CACHE_PATHS.test(url.pathname) ||
        url.origin !== self.location.origin,
      handler: new NetworkOnly(),
    },

    // 2. STATIC ASSETS — hash-named chunks, safe to serve stale then
    //    revalidate. Keyed to the build so old caches get purged on
    //    activate.
    {
      matcher: ({ url }) =>
        url.origin === self.location.origin && STATIC_ASSET_PATHS.test(url.pathname),
      handler: new StaleWhileRevalidate({
        cacheName: `static-${BUILD_ID}`,
        plugins: [
          new ExpirationPlugin({
            maxEntries: 200,
            maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
            purgeOnQuotaError: true,
          }),
        ],
      }),
    },

    // 3. FONTS — immutable, long-lived.
    {
      matcher: ({ url }) => FONT_EXTENSIONS.test(url.pathname),
      handler: new CacheFirst({
        cacheName: 'fonts',
        plugins: [
          new ExpirationPlugin({
            maxEntries: 32,
            maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
            purgeOnQuotaError: true,
          }),
        ],
      }),
    },

    // 4. ICONS — PWA install icons + favicons. Identical to fonts in
    //    shape, separate cache so storage-eviction pressure doesn't
    //    purge one because of the other.
    {
      matcher: ({ url }) => url.origin === self.location.origin && ICON_PATHS.test(url.pathname),
      handler: new CacheFirst({
        cacheName: 'icons',
        plugins: [
          new ExpirationPlugin({
            maxEntries: 32,
            maxAgeSeconds: 365 * 24 * 60 * 60,
            purgeOnQuotaError: true,
          }),
        ],
      }),
    },

    // 5. PUBLIC PAGES — NetworkFirst with a 3s timeout, falls back to
    //    the precached /offline shell when the network hasn't answered.
    //    Scope is strictly the denylisted public routes — auth-gated
    //    paths skip this rule and get the default handler (network).
    {
      matcher: ({ request, url }) =>
        request.mode === 'navigate' && PUBLIC_NAVIGATION_PATHS.test(url.pathname),
      handler: new NetworkFirst({
        cacheName: `pages-${BUILD_ID}`,
        networkTimeoutSeconds: 3,
        plugins: [
          new ExpirationPlugin({
            maxEntries: 16,
            maxAgeSeconds: 24 * 60 * 60, // 1 day
            purgeOnQuotaError: true,
          }),
        ],
      }),
    },
  ],
  fallbacks: {
    entries: [
      {
        // Any navigation that fails (times out, offline) falls through to
        // the branded `/offline` shell. Precached so it's always available.
        url: '/offline',
        matcher: ({ request }) => request.mode === 'navigate',
      },
    ],
  },
});

serwist.addEventListeners();

// Purge stale runtime caches on activate so old `static-<BUILD_ID>` and
// `pages-<BUILD_ID>` caches don't leak across deploys. The current SW's
// caches are left alone; every other build-scoped cache is deleted.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const currentCaches = new Set([`static-${BUILD_ID}`, `pages-${BUILD_ID}`, 'fonts', 'icons']);
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => {
            // Keep Serwist-managed precache caches (they name themselves)
            // and our current build's runtime caches. Drop everything else.
            if (key.startsWith('serwist-')) return false;
            return !currentCaches.has(key);
          })
          .map((key) => caches.delete(key))
      );
    })()
  );
});
