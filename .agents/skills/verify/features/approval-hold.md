# approve rule と保留された request

owner は、container の request を、kurumi が credential を付けて upstream に送る前に人の判断で待たせられる。approve rule に合う request は保留され、pending の approval になる。approval の card は method、URL、account、rule、body の先頭 1 KiB を示す。approve すると送られ、deny すると 403 `approval_denied` が返る。180 秒たつと 403 `approval_pending` が返り、そのあとで approve すると、同一の再送が 10 分以内に 1 回だけ通る。

## Sub-features

- `rules` account か service に対する approve と allow の rule を追加・一覧・削除する。
- `hold-approve` 保留された request は、approve のあと upstream の応答で終わる。
- `hold-deny` 保留された request は 403 `approval_denied` を受け、upstream の行は残らない。
- `late-approve` 180 秒の timeout のあとの approve は、同一の再送を 1 回許し、session に通知する。

## How to get to it (user POV)

- `kurumi gateway rules add --account anthropic/main --method POST --path /v1/messages [--effect approve|allow] [--priority <n>]`
- `kurumi gateway rules list`、`kurumi gateway rules remove <rule id>`
- `kurumi approval list [--status pending|decided]`、`kurumi approval show <id>`、`kurumi approval decide <id> --approve|--deny`

## Driving it with lane.sh

前提: README の基本の状態。rule を足す前に chat を 1 回済ませ、container を起動しておく。そうしないと最初の turn が保留される。

- **Rule.** `L kurumi <n> gateway rules add --account anthropic/main --method POST --path /v1/messages` が `"effect": "approve"` の rule を出力する。
- **保留.** `L probe <n> > /tmp/kurumi-verify/lane-<n>/evidence/held-probe.txt &` を流す。数秒以内に、`L kurumi <n> approval list` が `POST https://api.anthropic.com/v1/messages as anthropic/main` という title の `gateway.request` の approval を 1 つ示し、`gateway log --decision held` に保留の行が出る。
- **Approve.** `L kurumi <n> approval decide <apr-id> --approve` が `"status": "approved"` を出力する。裏の probe は `x-kurumi-account: anthropic/main` と `status=200` で終わり、`time=` は待ち時間を含む。
- **Deny.** 保留を作り直し、`--deny` で判断する。probe は `status=403` を出力し、`gateway log` にはその request の `injected` 行が出ない。
- **遅れた approve.** `kurumi chat <n> work` を stdin を開けたまま付けておき、probe を 180 秒より長く保留させ（`status=403`）、そのあとで approve する。chat に再送の notice が出て、同一の `L probe <n>` が新しい approval なしで通る。

## Gotchas

- この rule の下では、Claude の turn が送る `/v1/messages` がすべて保留され、それぞれが別の approval になる。出てくるたびに approve するか、chat の前に rule を消す。
- `rules add` は、`*.suffix` の host、kurumi が横取りしない host、知らない handle、decode 済みで `/` から始まる形でない path を拒否する。
- 保留中に host を再起動すると、probe は TLS EOF で終わる。approval は再起動のあとも判断できる。
- chat の turn を 30 秒より長く保留させるとき、`KURUMI_STALE_AFTER_MS=30000` で lane を起動するのは reap を試す場合だけにする。既定の値なら container はそのまま残る。
