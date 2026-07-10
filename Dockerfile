# NotebookLM MCP Server - Multi-stage Docker Image
#
# Build: docker build -t notebooklm-mcp .
# Run:   docker run -p 3000:3000 -p 6080:6080 -v notebooklm-data:/data notebooklm-mcp
#
# Ports:
#   3000 - MCP HTTP API
#   6080 - noVNC web interface (for initial Google auth setup)

# ============================================================
# Stage 1: Builder - compile TypeScript to JavaScript
# ============================================================
FROM node:20-bookworm-slim AS builder

WORKDIR /build

# Copy package files first for better caching
COPY package*.json ./

# Install ALL dependencies (including devDependencies for tsc)
RUN npm ci --ignore-scripts

# Copy source code and tsconfig
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript -> dist/
RUN npx tsc && npm run build:i18n

# ============================================================
# Stage 2: Runtime - production image with Chromium + noVNC
# ============================================================
FROM node:20-bookworm-slim

# Install dependencies for Playwright/Chromium + noVNC
RUN apt-get update && apt-get install -y \
    # Playwright dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    # noVNC dependencies
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fluxbox \
    nginx \
    # Additional utilities
    fonts-liberation \
    fonts-noto-color-emoji \
    wget \
    ca-certificates \
    procps \
    # Clean up
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd -r notebooklm && useradd -r -g notebooklm -d /home/notebooklm notebooklm \
    && mkdir -p /home/notebooklm /app /data \
    && chown -R notebooklm:notebooklm /home/notebooklm /app /data \
    # Create X11 socket directory with proper permissions for Xvfb
    && mkdir -p /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix

# Set working directory
WORKDIR /app

# Copy package files first (better caching)
COPY --chown=notebooklm:notebooklm package*.json ./

# Switch to non-root user
USER notebooklm

# Install production dependencies only (--ignore-scripts to skip husky prepare)
RUN npm ci --omit=dev --ignore-scripts

# Install browsers via patchright (must match the patchright version)
RUN npx patchright install chromium

# Copy compiled output from builder stage
COPY --from=builder --chown=notebooklm:notebooklm /build/dist/ ./dist/

# Copy scripts
COPY --chown=notebooklm:notebooklm scripts/ ./scripts/

# Make scripts executable
USER root
RUN chmod +x /app/scripts/*.sh

# WE WILL LEAVE THE USER AS ROOT SO THE ENTRYPOINT CAN CHOWN THE VOLUME,
# AND THEN THE ENTRYPOINT WILL DROP PRIVILEGES TO 'notebooklm' WHEN RUNNING NODE
# USER notebooklm

# Environment variables
ENV NODE_ENV=production \
    HTTP_PORT=3000 \
    HTTP_HOST=0.0.0.0 \
    # Use the same headed VNC browser profile for Google login and runtime jobs.
    # A headless runtime presents a different browser context and can invalidate
    # an otherwise valid NotebookLM Google session.
    HEADLESS=false \
    NOTEBOOKLM_DATA_DIR=/data \
    # Playwright/Chrome settings for Docker
    PLAYWRIGHT_BROWSERS_PATH=/home/notebooklm/.cache/ms-playwright \
    # Display for noVNC
    DISPLAY=:99 \
    NOVNC_PORT=6080

# Expose HTTP port and noVNC port
EXPOSE 3000 6080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider "http://localhost:${HTTP_PORT:-3000}/health" || exit 1

# Data volume
# VOLUME ["/data"]

# Start with entrypoint (VNC + Node.js)
CMD ["/app/scripts/docker-entrypoint.sh"]
