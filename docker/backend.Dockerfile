# Dockerfile for Node.js Backend
# EICR-oMatic 3000 - API Server

FROM node:20-slim

WORKDIR /app

# Install system dependencies for sharp image processing, health checks, and Playwright
RUN apt-get update && apt-get install -y \
    libvips-dev \
    libheif-dev \
    imagemagick \
    ffmpeg \
    curl \
    # Playwright dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install Python PDF generation library
RUN pip3 install reportlab --break-system-packages

# Update ImageMagick policy to allow HEIC conversion
RUN sed -i 's/pattern="{GIF,JPEG,PNG,WEBP}"/pattern="{GIF,JPEG,PNG,WEBP,HEIC,HEIF}"/' /etc/ImageMagick-6/policy.xml || true

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Install Playwright browsers (chromium only for PDF generation)
RUN npx playwright install chromium

# Download AWS RDS CA bundle for SSL verification
RUN mkdir -p ./certs && \
    curl -so ./certs/rds-combined-ca-bundle.pem \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

# Copy application code
COPY src/ ./src/
COPY config/ ./config/
COPY assets/ ./assets/

# Create data directories
RUN mkdir -p ./data/INCOMING ./data/OUTPUT ./data/DONE ./data/FAILED

# Copy server entry point (app.js + server.js + api.js already in src/ from above)
# This line is kept for Docker cache layering — server.js changes more often than src/
COPY src/server.js ./src/

# Create non-root user
RUN groupadd --system --gid 1001 nodejs
RUN useradd --system --uid 1001 --gid nodejs certmate

# Set ownership of app directory
RUN chown -R certmate:nodejs /app

# Switch to non-root user
USER certmate

# Set environment
ENV NODE_ENV=production
ENV PORT=3000
ENV USE_AWS_SECRETS=true

# Expose API port
EXPOSE 3000

# Health check using the API endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Run API server
CMD ["node", "src/server.js"]
