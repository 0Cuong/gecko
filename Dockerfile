# Gecko Discord Music Bot - production container
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional

COPY tsconfig.json ./
COPY src/ ./src/
COPY index.html ./
RUN npm run build

# Run with an unprivileged account and a writable runtime directory only.
RUN useradd --system --create-home --uid 10001 gecko \
    && mkdir -p /app/cache \
    && chown -R gecko:gecko /app
USER gecko

ENV NODE_ENV=production
ENV PORT=3000
ENV BIND_HOST=127.0.0.1

EXPOSE 3000
CMD ["npm", "start"]
