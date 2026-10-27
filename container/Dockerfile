FROM oven/bun:1.4.4-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --omit=peer \
  && bun add --no-save --omit=peer zod@4.6.7 \
  && rm -rf /root/.bun/install/cache /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl
WORKDIR /workspace/group
USER bun
CMD ["bun", "/app/runner.js"]
