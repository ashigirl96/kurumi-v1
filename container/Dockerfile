FROM oven/bun:1.4.3-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/group
CMD ["bun", "/app/runner.js"]
