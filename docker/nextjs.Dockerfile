# Unified Dockerfile for Next.js apps (frontend PWA + web)
# Usage: docker build --build-arg APP_DIR=frontend ...
#        docker build --build-arg APP_DIR=web ...

# Build stage
FROM node:20-alpine AS builder
WORKDIR /app

ARG APP_DIR
ARG NEXT_PUBLIC_API_URL=https://certomatic3000.co.uk

# Copy package files
COPY ${APP_DIR}/package*.json ./

# Install dependencies
RUN npm ci

# Copy app source
COPY ${APP_DIR}/ ./

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Remove any local env files that might override
RUN rm -f .env.local .env

# Build the Next.js app
RUN npm run build

# Production stage
FROM node:20-alpine AS runner
WORKDIR /app

# Install wget for health checks
RUN apk add --no-cache wget

# Don't run as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built application
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Set ownership
RUN chown -R nextjs:nodejs /app

USER nextjs

# Runtime environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

EXPOSE 3000

CMD ["node", "server.js"]
