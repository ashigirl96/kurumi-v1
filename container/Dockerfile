FROM oven/bun:1.4.3-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_AGENT_SDK_VERSION=0.3.309
WORKDIR /app
RUN bun add --omit=peer "@anthropic-ai/claude-agent-sdk@${CLAUDE_AGENT_SDK_VERSION}" \
  && rm -rf /root/.bun/install/cache /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl
WORKDIR /workspace/group
CMD ["bun", "/app/runner.js"]
