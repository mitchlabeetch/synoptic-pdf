# synoptic-pdf/Dockerfile
# Professional PDF Engine for Synoptic Studio - v3.1.1
# Simplified for DigitalOcean App Platform compatibility

FROM node:20-slim

# Install all dependencies in one layer for easier caching
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Process management
    dumb-init \
    # Download utilities
    wget \
    ca-certificates \
    # Ghostscript for PDF post-processing
    ghostscript \
    # Chrome/Puppeteer dependencies
    libxss1 \
    libxtst6 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    # Fonts
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f -v

# Create app directory
WORKDIR /app

# Create non-root user
RUN groupadd -r synoptic && useradd -r -g synoptic synoptic

# Create temp directory for PDF processing
RUN mkdir -p /app/tmp && chown synoptic:synoptic /app/tmp

# Install dependencies first (for better layer caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Change ownership to non-root user
RUN chown -R synoptic:synoptic /app

# Switch to non-root user
USER synoptic

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV MAX_CONCURRENT_JOBS=3
ENV DEFAULT_TIMEOUT_MS=120000
ENV MAX_TIMEOUT_MS=600000
ENV BROWSER_RESTART_THRESHOLD=100
ENV ENABLE_PAGEDJS=true
ENV ENABLE_CMYK_CONVERSION=true
ENV PDF_X_STANDARD=PDF/X-1a

# Expose port
EXPOSE 3000

# Health check with longer start period for Puppeteer browser download
HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Use dumb-init as PID 1
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "index.js"]
