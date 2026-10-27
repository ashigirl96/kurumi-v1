# Contributing

Use the Bun version in `package.json`. Install dependencies with `bun install` and
run `bun run check` before pushing.

## Enable secret scanning

Once per clone, run this from the repository root:

```sh
git config core.hooksPath .githooks
```

Setup is explicit because the repository has no `prepare` script convention.
This enables the committed executable `.githooks/pre-push` without a hook manager
or a new dependency.

Install [gitleaks v8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)
on `PATH`, or install and start [Docker](https://docs.docker.com/get-docker/).
The hook prefers native gitleaks, requires version 8.30.1, and otherwise uses
`zricethezav/gitleaks:v8.30.1` through Docker. Both use CI's
`git --redact --no-banner --log-opts="-m <range>"` scan.

Each updated ref is scanned from the remote's old commit to the local commit.
For new refs, only commits not reachable from any local remote-tracking ref are
scanned (`<local-sha> --not --remotes`). Keep those refs current with `git fetch`.
Deletion pushes skip scanning. An unavailable commit range, finding, scanner
error, missing scanner, or different native version blocks the push. An explicit bypass is
`git push --no-verify`; CI still scans the pushed commits.

Build token fixtures at runtime from their claims, as in
`packages/account/src/fixtures/google/token-responses.ts`. Never commit tokens
captured from a real run or synthetic token-shaped literals, even if a later
commit removes them: the hook scans every commit being pushed.
