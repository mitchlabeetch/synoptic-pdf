# synoptic-pdf/Dockerfile
# Professional PDF Engine for Synoptic Studio - v3.1.0 Production Ready
# 
# ARCHITECTURE: Paged.js + Ghostscript Pipeline
# ✓ dumb-init for proper signal handling (prevents zombie Chrome processes)
# ✓ Paged.js for CSS Paged Media polyfill (proper pagination)
# ✓ Ghostscript for RGB → CMYK/PDF-X conversion (print-ready)
# ✓ Google Fonts pre-installed (Geist, Outfit, Quicksand, Spectral)
# ✓ Non-root user for security
# ✓ Font cache pre-generated

FROM node:20-slim

# Install dumb-init first (critical for signal handling in containers)
# This prevents zombie Chrome processes when container is stopped
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Install Chrome dependencies for Puppeteer + font utilities + Ghostscript
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    procps \
    unzip \
    # Ghostscript for PDF/X and CMYK conversion (THE PRO TOOL)
    ghostscript \
    # Chrome dependencies
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
    # Font packages for fallback
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    # Font utilities
    fontconfig \
    && rm -rf /var/lib/apt/lists/*

# ═══════════════════════════════════════════════════════════════════
# CUSTOM FONTS INSTALLATION
# Download and install Google Fonts used by Synoptic Studio
# This ensures PDF output matches the web app exactly
# ═══════════════════════════════════════════════════════════════════
RUN mkdir -p /usr/share/fonts/truetype/synoptic

# Download Geist (Vercel's font)
RUN wget -q -O /tmp/geist.zip "https://github.com/vercel/geist-font/releases/download/1.3.0/Geist-1.3.0.zip" \
    && unzip -q /tmp/geist.zip -d /tmp/geist \
    && find /tmp/geist -name "*.ttf" -exec cp {} /usr/share/fonts/truetype/synoptic/ \; \
    && rm -rf /tmp/geist /tmp/geist.zip \
    || echo "Warning: Could not download Geist font, using fallback"

# Download Outfit from Google Fonts
RUN wget -q -O /usr/share/fonts/truetype/synoptic/Outfit-Regular.ttf \
    "https://github.com/nicolehuang3/outfit-font/raw/main/fonts/ttf/Outfit-Regular.ttf" \
    && wget -q -O /usr/share/fonts/truetype/synoptic/Outfit-Medium.ttf \
    "https://github.com/nicolehuang3/outfit-font/raw/main/fonts/ttf/Outfit-Medium.ttf" \
    && wget -q -O /usr/share/fonts/truetype/synoptic/Outfit-Bold.ttf \
    "https://github.com/nicolehuang3/outfit-font/raw/main/fonts/ttf/Outfit-Bold.ttf" \
    || echo "Warning: Could not download Outfit font, using fallback"

# Download Quicksand from Google Fonts
RUN wget -q -O /tmp/quicksand.zip \
    "https://fonts.google.com/download?family=Quicksand" \
    && unzip -q /tmp/quicksand.zip -d /tmp/quicksand \
    && find /tmp/quicksand -name "*.ttf" -exec cp {} /usr/share/fonts/truetype/synoptic/ \; \
    && rm -rf /tmp/quicksand /tmp/quicksand.zip \
    || echo "Warning: Could not download Quicksand font, using fallback"

# Download Spectral (serif font for body text)
RUN wget -q -O /tmp/spectral.zip \
    "https://fonts.google.com/download?family=Spectral" \
    && unzip -q /tmp/spectral.zip -d /tmp/spectral \
    && find /tmp/spectral -name "*.ttf" -exec cp {} /usr/share/fonts/truetype/synoptic/ \; \
    && rm -rf /tmp/spectral /tmp/spectral.zip \
    || echo "Warning: Could not download Spectral font, using fallback"

# Download Crimson Pro (elegant serif for publications)
RUN wget -q -O /tmp/crimson.zip \
    "https://fonts.google.com/download?family=Crimson+Pro" \
    && unzip -q /tmp/crimson.zip -d /tmp/crimson \
    && find /tmp/crimson -name "*.ttf" -exec cp {} /usr/share/fonts/truetype/synoptic/ \; \
    && rm -rf /tmp/crimson /tmp/crimson.zip \
    || echo "Warning: Could not download Crimson Pro font, using fallback"

# Refresh font cache
RUN fc-cache -f -v

# Verify Ghostscript installation
RUN gs --version && echo "Ghostscript installed successfully"

# ═══════════════════════════════════════════════════════════════════
# ICC COLOR PROFILES (for CMYK conversion)
# ═══════════════════════════════════════════════════════════════════
RUN mkdir -p /usr/share/color/icc

# Download standard CMYK profiles (FOGRA39 for European printing)
RUN wget -q -O /usr/share/color/icc/ISOcoated_v2_300_eci.icc \
    "https://www.eci.org/_media/downloads/icc_profiles_from_eci/isocoated_v2_300_eci.zip" \
    || echo "Note: ICC profile download may require manual setup for full CMYK support"

# ═══════════════════════════════════════════════════════════════════
# APPLICATION SETUP
# ═══════════════════════════════════════════════════════════════════

# Create app directory
WORKDIR /app

# Create non-root user for security
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
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false

# Configurable environment variables (can be overridden at runtime)
ENV PORT=3000
ENV MAX_CONCURRENT_JOBS=3
ENV DEFAULT_TIMEOUT_MS=120000
ENV MAX_TIMEOUT_MS=600000
ENV BROWSER_RESTART_THRESHOLD=100
# PDF_SERVICE_SECRET should be set at deploy time for authentication

# Enable Paged.js and Ghostscript features
ENV ENABLE_PAGEDJS=true
ENV ENABLE_CMYK_CONVERSION=true
ENV PDF_X_STANDARD=PDF/X-1a

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Use dumb-init as PID 1 to properly handle signals and reap zombie processes
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "index.js"]
