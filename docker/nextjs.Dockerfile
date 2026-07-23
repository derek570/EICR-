# Unified Dockerfile for Next.js apps (frontend PWA + web)
# Usage: docker build --build-arg APP_DIR=frontend ...
#        docker build --build-arg APP_DIR=web ...

# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

# Upgrade the image's npm to the 11.x line (2026-07-23). node:20-alpine
# bundles npm 10.x, whose vendored `tar` 6.2.1 trips the Trivy CRITICAL gate
# on CVE-2026-59873 (gzip-bomb DoS; fixed in tar 7.5.19) at
# usr/local/lib/node_modules/npm/node_modules/tar — the EXACT class the
# 2026-07-22 backend.Dockerfile fix (0d863b50) closed for the backend image;
# the frontend image was missed and started blocking every deploy once the
# fixed tar version landed in the vulnerability DB (ignore-unfixed:true means
# an advisory only blocks once a fix exists). npm 11.18+ vendors tar ^7.5.19.
# Placed BEFORE any npm usage so the whole build runs one npm.
RUN npm install -g npm@11

ARG APP_DIR
ARG NEXT_PUBLIC_API_URL=https://api.certmate.uk
# NEXT_PUBLIC_* vars are inlined at `next build` time from process.env, so
# every flag the client reads has to be declared as ARG + ENV here. Build-args
# passed without an ENV bridge are silently dropped — see 2026-05-15 incident
# where NEXT_PUBLIC_REGEX_HINTS_ENABLED was passed in deploy.yml but never
# reached the bundle, and NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED missed the
# same way, leaving the Sonnet WS auto-reconnect machinery dormant in prod.
ARG NEXT_PUBLIC_REGEX_HINTS_ENABLED
ARG NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED
# Emergency kill switch for the Silero VAD model (~30MB ONNX WASM heap).
# Set to '0' to revert wake-from-doze to the SleepManager's RMS gate
# fallback. Field-test 2026-05-17 (sess_mpa3zvkn_1bfc / sess_mpa419j6_9yac)
# showed iPad Safari WebContent process reap at ~40s — the Silero heap is
# the single largest memory consumer the PWA carries and is the first
# thing to drop when chasing per-tab memory budget. RMS fallback at
# `SleepManager.processAudioLevel` produces functionally equivalent wake
# behaviour (iOS canon uses Deepgram VAD as its de facto fallback in
# the same way).
ARG NEXT_PUBLIC_SILERO_VAD

# Copy workspace root package files for workspace resolution
COPY package.json package-lock.json ./

# Copy workspace packages that the frontend depends on
COPY packages/ ./packages/

# Copy the target app's source
COPY ${APP_DIR}/ ./${APP_DIR}/

# Install all workspace dependencies (resolves @certmate/* packages locally)
# --ignore-scripts skips the root "prepare" hook (husky) which isn't needed in Docker
RUN npm ci --ignore-scripts

WORKDIR /app/${APP_DIR}

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_REGEX_HINTS_ENABLED=$NEXT_PUBLIC_REGEX_HINTS_ENABLED
ENV NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED=$NEXT_PUBLIC_RECORDING_RECONNECT_ENABLED
ENV NEXT_PUBLIC_SILERO_VAD=$NEXT_PUBLIC_SILERO_VAD

# Remove any local env files that might override
RUN rm -f .env.local .env

# Build the Next.js app
RUN npm run build

# Production stage
FROM node:20-alpine AS runner
WORKDIR /app

ARG APP_DIR
ENV APP_DIR=${APP_DIR}

# Install wget for health checks
RUN apk add --no-cache wget

# Same npm@11 upgrade as the builder stage: the RUNNER is the scanned/shipped
# image and node:20-alpine's bundled npm 10.x carries the tar 6.2.1
# CVE-2026-59873 CRITICAL into the final layer even though the runtime never
# invokes npm (CMD is a bare `node server.js`). Upgrading (rather than
# deleting npm) keeps parity with the backend image's 0d863b50 fix.
RUN npm install -g npm@11

# Don't run as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built application
# Standalone output in a monorepo preserves the workspace directory structure
COPY --from=builder /app/${APP_DIR}/.next/standalone ./
COPY --from=builder /app/${APP_DIR}/.next/static ./${APP_DIR}/.next/static
COPY --from=builder /app/${APP_DIR}/public ./${APP_DIR}/public

# Set ownership
RUN chown -R nextjs:nodejs /app

USER nextjs

# Runtime environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

EXPOSE 3000

CMD ["sh", "-c", "exec node ${APP_DIR}/server.js"]
