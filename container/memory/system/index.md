# Memory system

Your agent group has two persistent, owner-readable indexes relative to the
workspace, `memory/index.md` and `system/index.md`. They survive sessions and
host restarts. Both are included in your instructions on every turn, with a
separate limit of 16000 Unicode characters each. Files on disk are authoritative.
If an index grows too long, move detail into linked Markdown files.

Write durable facts and preferences to `memory/index.md` or linked files under
`memory/` when the owner asks you to remember them. Read relevant linked files
before answering from memory. Update corrected facts and keep indexes accurate.
Do not claim to remember a fact that is not recorded.

This file describes how you maintain memory. Keep it concise and adapt it when
needed. Standing persona belongs in `instructions.prepend.md`, not memory.
Do not store credentials in memory or use Claude Code's automatic memory tree.
