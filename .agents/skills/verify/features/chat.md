# agent と chat する

owner は agent group を作り、terminal から話しかける。stdin の 1 行が inbound message になり、host は group の container を起動する。runner は gateway を通して Claude で答え、返事は `queued` の受領行の下に出る。

## Sub-features

- `agent-create` 名前付きの agent group を作り、folder を `$KURUMI_HOME/groups/` の下に置く。
- `chat-turn` 1 行送り、Claude の返事を出力する。
- `chat-continue` 別の `kurumi chat` で送った 2 行目も、同じ会話の続きになる。

## How to get to it (user POV)

- `kurumi agent create --name <name>`
- `kurumi agent list`
- `kurumi chat <name か id>`。stdin の 1 行が 1 message。

## Driving it with lane.sh

前提: lane が起動していて、`L add-key <n>` が `anthropic/main` を出力した。

- **全体.** `L smoke <n>` を流す。`smoke passed` で終わり、evidence に `chat-*.txt` と `gateway-log.txt` が残る。
- **作成.** `L kurumi <n> agent create --name work` を流す。`id` が `ag-…`、`name` が `work`、`folder` が lane の home の下にある JSON が出る。
- **Turn.** `L chat <n> work 'Reply with exactly one word: kurumi'` を流す。transcript に `queued (session ses-…)`、続けて `kurumi` が出る。`host.log` には同じ `inboundId` の `session.inbound.committed` と `session.outbound.delivered` が増える。
- **Container.** `docker ps --filter label=kurumi.install=<install> --filter label=kurumi.role=agent` が `kurumi-agent-…` の container を 1 つ示し、その `kurumi.session` label が session id と一致する。
- **続き.** `L chat <n> work 'What word did you just reply with?'` を流す。返事が `kurumi` を挙げ、`queued` 行の session id が前と同じになる。
- **Upstream.** `L kurumi <n> gateway log --agent-group-id <id>` に `anthropic/main  anthropic-api  injected  200 … POST api.anthropic.com/v1/messages` が出る。

## Gotchas

- 同じ agent group への `L chat` と `kurumi chat` は、1 つの共有 session（`mode: shared`）に入る。session を 2 つ要する確認では agent group を 2 つ作る。
- key は最初の chat の前に追加する。account が grant されていないと、返事は Claude の答えではなく `Provider error 403 account_not_connected: …` のような notice になる。
- Claude Code の 1 turn は `GET /api/claude_code/policy_limits` と `GET /api/claude_code/settings` も送る。`/v1/messages` の行を数えるときは path で絞る。
- 最初の turn には container の起動が含まれる。返事が `KURUMI_VERIFY_REPLY_TIMEOUT` より遅いと、返事があとで `host.log` に届いても `L chat` は失敗する。
- token の消費を抑えるには、派生 image を作って `up` の前に lane をそちらに向ける: `printf 'FROM %s\nENV CLAUDE_CODE_MAX_OUTPUT_TOKENS=16\n' kurumi-agent:verify-<sha> | docker build -t kurumi-agent:verify-<sha>-cap16 -` と `KURUMI_AGENT_IMAGE=kurumi-agent:verify-<sha>-cap16`。
