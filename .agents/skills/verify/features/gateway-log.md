# gateway の log と status

owner は各 agent が外に何を送ったかを見られる。container が横取り対象の host に送った request は、それぞれ egress 行を 1 行残す。行は時刻、account、service、decision、status、所要時間、method、URL、agent group を持つ。`gateway status` は、container を受け入れているか、Agent Port の address、kurumi の CA の fingerprint を示す。

## Sub-features

- `log-rows` 横取りした request が 1 回ずつ、古い順に出る。
- `log-filter` agent group、account、decision、件数で絞る。
- `status` admission、Agent Port、CA の SHA-256 を示す。

## How to get to it (user POV)

- `kurumi gateway log [--agent-group-id <id>] [--account <handle>] [--decision injected|passed|refused|held] [--limit <n>]`
- `kurumi gateway status`

## Driving it with lane.sh

前提: README の基本の状態。

- **request ごとの行.** `L probe <n>` のあと `L kurumi <n> gateway log --limit 1` を流す。行は `<time>  anthropic/main  anthropic-api  injected  200  <ms>  POST  api.anthropic.com/v1/messages  ag-…` になる。
- **絞り込み.** `--account anthropic/main` と `--agent-group-id <id>` では行が残り、`--decision refused` では消える。
- **Status.** `L kurumi <n> gateway status` が `admission  open`、`agent port  127.0.0.1:<41000+10n>`、`ca sha256  <hex>` を出力する。CA は消える home の中にあるので、同じ lane で `down` してから `up` し直すと fingerprint が変わる。

## Gotchas

- `gateway log` は読む前に未書き込みの行を flush する。`kurumi db query 'select … from egress_log'` は flush しないので、それで数えるときは最後の request から 1 秒以上待つ。
- `held` の行は account を `-` と出す。account は、request を最終的に送ったときに書く行に出る。
- 30 日より古い行は host の起動時に消える。
