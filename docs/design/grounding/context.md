# kurumi: shared context for every subagent

The user is building **kurumi** (repo `~/.ghq/src/github.com/ashigirl96/kurumi-v1`, currently empty apart from skills), a personal AI agent that replaces two systems they run today:

- **nanoclaw**: their fork at `~/.ghq/src/github.com/ashigirl96/nanoclaw` (TypeScript host + per-agent containers + Console web UI; glossary in `GLOSSARY.md`, docs in `docs/`, ADRs in `docs/adr/`).
- **OneCLI v1.42.0**: the credential gateway nanoclaw uses today. It runs as docker image `ghcr.io/onecli/onecli:1.42.0` (ports 10254-10255) with its own postgres (`postgres:18-alpine`). The exact v1.42.0 source (commit 3912c74) can be extracted with `git -C ~/.ghq/src/github.com/onecli/onecli archive v1.42.0 | tar -x -C <dir>` (Rust gateway in `apps/gateway`, Next.js web in `apps/web`, Prisma schema in `packages/db/prisma/schema.prisma`, `docs/nanoclaw-integration.md`). A newer checkout (v2.14.0) lives at `~/.ghq/src/github.com/onecli/onecli`; use it only for history, never as the description of v1.42.0.

Decisions already made by the user:

1. kurumi ports **all** nanoclaw features; the user is happy with them. The motivation is control: nanoclaw's rule is "don't change features, add skills", and the user wants to own the core and the architecture.
2. kurumi absorbs the gateway (OneCLI's role) instead of running OneCLI separately.
3. **One SQLite file on the host** holds everything (agent data and gateway data). No postgres.
4. **TypeScript only** (no Rust).
5. Architecture follows `~/.ghq/src/github.com/ashigirl96/monica` (Bun monorepo; `docs/packages.md`, `GLOSSARY.md`, `docs/adr/`, `CODING_STANDARDS.md`).
6. **Existing data is not migrated.** kurumi starts empty; Agent Groups are recreated and accounts reconnected by OAuth.

Two new capabilities the user wants:

- **Many-to-many account binding.** Bind individual Connected Accounts (not apps) to Agent Groups. Example: Agent Group 1 gets Gmail A, B, C; Agent Group 2 gets Gmail B and Calendar A. The user believes (unverified) OneCLI v1.42.0 cannot do this.
- **In-chat connection.** Like Grok Bot: the user says "connect Notion", the agent replies "I'll connect Notion" and a card with an auth button appears in the chat; after OAuth the agent can use it immediately. The user asked whether this should be an MCP server on the gateway side.
