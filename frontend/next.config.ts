import type { NextConfig } from "next";
import withPWAInit from "@ducanh2912/next-pwa";

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  // Disabled: caching HTML navigation responses caused "Failed to find Server
  // Action" errors after redeploys.  Next.js embeds build-time action IDs into
  // pages; serving a stale cached page means the client sends an ID the new
  // server no longer knows about.  Always fetch fresh HTML from the network.
  cacheOnFrontEndNav: false,
  aggressiveFrontEndNavCaching: false,
  reloadOnOnline: true,
  fallbacks: {
    document: "/offline",
  },
  workboxOptions: {
    skipWaiting: true,
    clientsClaim: true,
    runtimeCaching: [
      {
        // Navigation requests (HTML pages): always go to network so clients
        // always receive the current build's server action IDs.  Short offline
        // fallback TTL keeps the fallback reasonably fresh.
        urlPattern: ({ request }: { request: Request }) =>
          request.mode === "navigate",
        handler: "NetworkOnly",
        options: {
          // No cache for navigation — we never want a stale page served.
        },
      },
      {
        urlPattern: /^https:\/\/.*\.(?:png|jpg|jpeg|svg|gif|webp)$/,
        handler: "CacheFirst",
        options: {
          cacheName: "images",
          expiration: {
            maxEntries: 100,
            maxAgeSeconds: 60 * 60 * 24 * 30,
          },
        },
      },
      {
        urlPattern: /\/api\/jobs\/.*/,
        handler: "NetworkFirst",
        options: {
          cacheName: "api-jobs",
          expiration: {
            maxEntries: 50,
            maxAgeSeconds: 60 * 60 * 24,
          },
          networkTimeoutSeconds: 10,
        },
      },
    ],
  },
});

const nextConfig: NextConfig = {
  output: "standalone",

  turbopack: {
    root: "..",
  },

  // Ensure WASM and ONNX files served from /vad/ have correct MIME types
  // and CORS headers for ONNX Runtime Web (used by Silero VAD)
  async headers() {
    return [
      {
        source: "/vad/:path*",
        headers: [
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
      {
        source: "/manifest.json",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default withPWA(nextConfig);
