# ── Stage 1: Build ───────────────────────────────────────────────────────────
# Why node:20-alpine: Minimal base. Alpine is ~5 MB vs ~150 MB for the full
# Debian image. We only need Node to run the compiled JS — no build tools in prod.
FROM node:20-alpine AS builder

WORKDIR /build

# Copy manifests first — Docker layer caches node_modules unless these change.
# Re-running npm install only when package.json or package-lock.json changes
# saves minutes on every non-dependency build.
COPY package*.json ./

# Install ALL deps (including devDependencies) — needed for tsc
RUN npm ci --include=dev

COPY . .

# Compile TypeScript → dist/
RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Security: create a non-root user. Running as root in a container is a
# privilege escalation risk — a container escape gives root on the host.
RUN addgroup -S stagepass && adduser -S event-svc -G stagepass

WORKDIR /app

# Copy only production dependencies — devDependencies are excluded.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder stage
COPY --from=builder /build/dist ./dist

# Drop to non-root user before the final CMD
USER event-svc

# Health check — Kubernetes also has its own probes; this is for docker inspect
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8082/health/live || exit 1

EXPOSE 8082

# Start the compiled service
CMD ["node", "dist/main"]
