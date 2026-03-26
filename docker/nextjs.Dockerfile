# Unified Dockerfile for Next.js apps (frontend PWA + web)
# Usage: docker build --build-arg APP_DIR=frontend ...
#        docker build --build-arg APP_DIR=web ...

# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

ARG APP_DIR
ARG NEXT_PUBLIC_API_URL=https://certomatic3000.co.uk

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

# Remove any local env files that might override
RUN rm -f .env.local .env

# Build the Next.js app
RUN npm run build

# Production stage
FROM node:20-alpine AS runner
WORKDIR /app

ARG APP_DIR
ENV APP_DIR=${APP_DIR}

# Upgrade Alpine packages to patch OS-level CVEs (e.g. zlib) and install wget for health checks
RUN apk upgrade --no-cache && apk add --no-cache wget && npm install -g npm@latest

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

CMD node ${APP_DIR}/server.js
