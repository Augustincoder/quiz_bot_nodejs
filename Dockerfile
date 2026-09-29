# syntax=docker/dockerfile:1

# ==============================================================================
# Quiz Bot Node.js - Enterprise Production Multi-Stage Dockerfile
# Optimized for Northflank (Kubernetes Cloud Infrastructure)
# ==============================================================================

ARG NODE_VERSION=22-bookworm-slim

# ------------------------------------------------------------------------------
# Stage 1: Dependencies Builder
# ------------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps

WORKDIR /app

ENV NODE_ENV=production

# Copy dependency manifests first to maximize Docker layer cache
COPY package.json package-lock.json ./

# Install only production dependencies
# --ignore-scripts=false ensures native modules (sharp, @sentry/profiling-node)
# download or compile correct prebuilt binaries for linux glibc
RUN npm ci --omit=dev --ignore-scripts=false \
    && npm cache clean --force

# ------------------------------------------------------------------------------
# Stage 2: Hardened Production Runner
# ------------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner

WORKDIR /app

# 1. System packages:
#    - dumb-init: PID 1 supervisor (forwards SIGINT/SIGTERM, reaps zombies)
#    - fontconfig: Enables librsvg/sharp font discovery for timetable images
#    - ca-certificates: TLS/SSL trust store for Telegram, Supabase, Redis, Gemini
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        dumb-init \
        fontconfig \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2. Production Environment defaults
ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS="--expose-gc --max-old-space-size=384"

# 3. Create required runtime directory structure & permissions
RUN mkdir -p /app/data /app/logs /home/node/.fonts \
    && chown -R node:node /app /home/node

# 4. Copy custom project fonts and register with fontconfig
COPY --chown=node:node assets/fonts/ /usr/local/share/fonts/
COPY --chown=node:node assets/fonts/ /home/node/.fonts/
RUN fc-cache -fv

# 5. Copy pre-built production node_modules from deps stage
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# 6. Copy application code and resources
COPY --chown=node:node package.json ./
COPY --chown=node:node index.js ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node data/ ./data/
COPY --chown=node:node assets/ ./assets/
COPY --chown=node:node scripts/ ./scripts/

# Ensure all files in /app are owned by unprivileged node user
RUN chown -R node:node /app

# 7. Drop root privileges - Run as unprivileged node user (Least Privilege)
USER node

# 8. Expose default service port (Northflank maps this port)
EXPOSE 8080

# 9. Native Zero-dependency Container Health Check
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# 10. Process execution via dumb-init for graceful shutdown & signal handling
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "index.js"]
