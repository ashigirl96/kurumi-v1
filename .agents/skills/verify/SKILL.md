---
name: verify
description: 使い捨ての kurumi host を起動し、live の Claude subscription で `kurumi` CLI から動かす（key の追加、agent の作成、chat、`gateway log` の確認、approval の判断）。終わったら片付ける。変更を unit test ではなく実際の host・Docker の runner・gateway で確かめるとき、plan の live lane を走らせるときに使う。
---

# kurumi を live の host で確かめる

kurumi は host process（`apps/host`）で、`$KURUMI_HOME/kurumi.sock` 越しに `kurumi` CLI（`apps/cli`）に応える。session ごとに Docker container を 1 つ動かし、container の request はすべて Agent Port の gateway を通す。1 回の検証は 1 つの **lane** を持つ。lane は番号付きの独立した host で、home・port・container を lane ごとに分ける。操作はすべて [`lane.sh`](lane.sh) から行う。この repo のどの checkout や worktree からでも動く。

```sh
.claude/skills/verify/lane.sh <command> <lane> [args]
```

| Command | やること |
| --- | --- |
| `smoke <n>` | 最初から最後まで通す。`up`、`doctor`、`add-key`、`agent create --name work`、`chat` 1 往復、`gateway log`、`down` の順に走る。Claude が返事をし、log に `anthropic/main … injected 200 … POST api.anthropic.com/v1/messages` の行が出たときだけ成功する。 |
| `up <n>` | `bun install --frozen-lockfile`、`container/` の `docker build`、`scripts/build-runner.ts` を流し、host を起動して **ready** まで待つ。ready は、`host.log` に新しい `host.runtime` 行が出て、`kurumi gateway status` が `admission open` を示した状態をいう。 |
| `doctor <n>` | 読むだけの確認。`kurumi.lock` の pid が生きた `apps/host/src/main.ts` であること、`kurumi status` が応えること、admission が open であること、host が Agent Port を持っていること、image があることを見て、lane の container を並べる。`FAIL` が 1 つでもあれば exit 1。 |
| `kurumi <n> <args…>` | この lane に向けて CLI を呼ぶ。例: `kurumi 3 approval list`。 |
| `add-key <n>` | owner の subscription token を macOS の keychain（service `kurumi-live-claude`）から読み、`account add-key anthropic --auth oauth-token --label main --auto-grant` に stdin で渡す。`anthropic/main` を出力する。 |
| `chat <n> <agent> <line>` | `kurumi chat` で 1 行送り、返事か error の行が届くまで stdin を開けておく（`KURUMI_VERIFY_REPLY_TIMEOUT`、既定 180 秒）。transcript を保存する。exit 0 は行が返ってきたことしか意味しない。`Provider error …` の notice も 1 行に数えるので、Claude が答えたかは transcript を読んで確かめる。 |
| `probe <n>` | lane にただ 1 つある agent container から、gateway 経由で `POST https://api.anthropic.com/v1/messages`（`max_tokens` 1）を送り、`x-kurumi-account` と `status=` を出力する。model は `KURUMI_VERIFY_PROBE_MODEL`、既定は `claude-haiku-4-5`。 |
| `down <n>` | lane の host に SIGTERM を送り、install label で container を `docker rm -f` し、home を消す。evidence は残す。 |

まず `smoke` を流す。通れば、この checkout で host・image・runner・key・chat の経路が動いている。そのうえで、変えた feature を個別のコマンドで動かす。

## Launch

lane `n` は `/tmp/kurumi-verify/lane-<n>/` に置く。`home/` が `KURUMI_HOME` で、`evidence/` は残す。Agent Port は `41000+10n`。image は `kurumi-agent:verify-<HEAD の short SHA>` で、`KURUMI_AGENT_IMAGE` を設定すればそちらを使う。lane は並べて動かせるので、同時に走る検証にはそれぞれ別の番号を割り当てる。`up` の前に設定した host の環境変数（`KURUMI_STALE_AFTER_MS`、`KURUMI_DOCKER_NETWORK` など）は、そのまま host に渡る。

lane の path を短くしているのは、macOS が unix socket の path を 104 byte までに制限するからだ。長い scratch directory の下に home を置くと、`kurumi.sock` の bind に失敗する。

owner の普段の host は `~/.kurumi` を使う。`lane.sh` は必ず `KURUMI_HOME` を設定するので、その host には触れない。同じ理由で、CLI は必ず `lane.sh kurumi` 経由で呼ぶ。

## Doctor

様子がおかしいときは、まず `doctor <n>` を流す。同じ lane で host が生きていると `up` は起動を断るので、先に `down` する。`up` が失敗すると `evidence/host.log` の末尾 20 行を出力する。そこに原因（lock の取り合い、vault key の不一致、環境変数の値の誤り）が書いてある。

## Evidence

証拠はすべて `/tmp/kurumi-verify/lane-<n>/evidence/` に置き、`down` のあとも残る。

- `lane.txt`: `up` のたびに 1 行足す。pid、Agent Port、image、install label を持つ。install label は `docker ps --filter label=kurumi.install=<install>` に渡す。
- `host.log`: host の起動ごとに追記する JSON lines。`host.runtime`、`session.inbound.*`、`session.outbound.delivered`、`session.container.*`、`gateway.admission` が出る。
- `chat-<UTC 時刻>.txt`: `queued (session ses-…)` と返事の行。ここの時刻はすべて UTC で、`gateway log` の行と揃う。
- `smoke` はほかに `add-key.txt`、`agent.json`、`gateway-log.txt` を書く。個別のコマンドが保存するのは `lane.txt`、`host.log`、chat の transcript だけなので、それ以外は `| tee /tmp/kurumi-verify/lane-<n>/evidence/<slug>.txt` で自分で残す。

証拠の基準:

- 利用者の経路で動かす。owner の操作は `kurumi` CLI、agent の操作は probe か chat の turn で行う。`kurumi db query '<select>'` は読むだけの別の見え方で、操作には使わない。
- 変更は両側を残す。コマンドの出力と、あとから読んだ結果（`gateway log`、`approval list`、`account list`、`host.log`）を揃える。
- owner が気にする副作用（container の起動や削除、credential 付きで upstream に出た request）は、それ自体を観測する。`docker ps -a --filter label=kurumi.install=<install>`、`gateway log`、`x-kurumi-account` header を使う。
- subscription token は表示しない。pipe で渡し、evidence を人に渡す前に `grep -c sk-ant` で確かめる。

## Cleanup

失敗した回も含め、毎回 `down <n>` を流す（`smoke` は終了時に自分で流す）。`down` が kill するのはこの lane の `kurumi.lock` にある pid だけで、kurumi の host だと確かめてから送る。container はこの lane の `kurumi.install` label で消す。label は home の path から計算し直すので、`kill -9` で落ちた host の container も片付く。SIGTERM だけでは agent container は動き続ける。`kurumi-agent:verify-*` の image は次の lane のために残すので、使い終えたら `docker rmi` で消す。evidence directory は報告を読む側のものだ。subagent は消さずに path を報告し、最上位の session がユーザーに結果を渡したあとで `/tmp/kurumi-verify/lane-<n>/` を消す。

## Features

[`features/README.md`](features/README.md) が、利用者から見える feature ごとの手順をまとめている。feature を確かめたと報告する前に、その file が挙げる入口をすべて動かす。
