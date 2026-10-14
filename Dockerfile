FROM node:22-bookworm-slim

WORKDIR /app

# Install native build tools for compiling better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY package*.json ./

# Install dependencies (better-sqlite3 compiles natively on Node 22)
RUN npm install

# Copy application files
COPY . .

# Compile Tailwind CSS bundle
RUN npm run build:css

# Create persistent storage directories
RUN mkdir -p /app/sessions /app/data

ENV NODE_ENV=production \
    PORT=3000 \
    SESSION_DIR=/app/sessions \
    DB_PATH=/app/data/data.db

EXPOSE 3000

# Healthcheck to verify the server is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/login', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["npm", "start"]
