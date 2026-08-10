# ─── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first — Docker layer cache only invalidates here on dep changes
COPY package*.json ./

# Install all deps (including devDeps needed for nest build)
RUN npm ci --ignore-scripts

COPY . .

# Compile TypeScript → dist/
RUN npm run build

# Prune to production deps only (shrinks the final image)
RUN npm ci --omit=dev --ignore-scripts

# ─── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# wget is needed for the Docker HEALTHCHECK command
RUN apk add --no-cache wget

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only what the runtime needs from the builder stage
COPY --from=builder /app/dist        ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Lock down filesystem ownership
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3001

ENV NODE_ENV=production

# Render / Docker health probe — waits 20 s for the app to warm up
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/main"]
