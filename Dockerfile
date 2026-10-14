# Multi-stage Dockerfile for WhatsApp Gateway Dashboard

# ================================
# Stage 1: Build & Dependencies
# ================================
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install native build tools for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY package*.json ./

# Install all dependencies (including devDependencies for Tailwind compilation)
RUN npm install

# Copy application files
COPY . .

# Compile Tailwind CSS bundle for production
RUN npm run build:css

# Prune devDependencies to keep image lightweight
RUN npm prune --omit=dev

# ================================
# Stage 2: Production Runner
# ================================
FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    SESSION_DIR=/app/sessions \
    DB_PATH=/app/data/data.db

# Create persistent storage directories
RUN mkdir -p /app/sessions /app/data

# Copy built node_modules and files from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./package.json

# Declare persistent volumes
VOLUME ["/app/sessions", "/app/data"]

EXPOSE 3000

# Healthcheck to verify the server is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/login', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["npm", "start"]
