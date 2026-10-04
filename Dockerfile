# Gecko Discord Music Bot - 24/7 Cloud Container
FROM node:20-bookworm-slim

# Install system dependencies: ffmpeg for audio streaming, certificates, and build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source files
COPY tsconfig.json ./
COPY src/ ./src/
COPY index.html ./

# Build TypeScript code with SWC
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start 24/7 Discord bot engine and web server
CMD ["npm", "start"]
