FROM oven/bun:1.4.3-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --omit=peer \
  && rm -rf /root/.bun/install/cache /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl
WORKDIR /workspace/group
USER bun
CMD ["bun", "/app/runner.js"]
