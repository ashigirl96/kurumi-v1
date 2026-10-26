# host の再起動と container の引き継ぎ

agent の container は host より長く生きる。host が SIGTERM で止まっても container は動き続ける。次に起動した host は、同じ runtime 向けに自分が作った container を引き継ぎ（adopt）、消えた container を片付ける（reap）。次の chat の行は、同じ container か新しい container に届く。

## Sub-features

- `adopt` host の再起動をまたいで動いていた container を引き継ぎ、次の行に答える。
- `reap-missing` host が止まっているあいだに消された container を片付け、次の行で新しい container を起動する。
- `isolation` 別の home を持つ 2 つ目の host は、1 つ目の host の container に触れない。

## How to get to it (user POV)

- host を SIGTERM で止め、同じ `KURUMI_HOME`、image、Agent Port、runner bundle で起動し直す。

## Driving it with lane.sh

前提: README の基本の状態。`docker ps --filter label=kurumi.install=<install>` で container id を控えておく。

- **停止.** `kill -TERM "$(cat /tmp/kurumi-verify/lane-<n>/home/kurumi.lock)"` を流す。`L doctor <n>` は `FAIL  host process` を出し、`docker ps` では agent の container がまだ `Up` のまま。
- **引き継ぎ.** `L up <n>` を流す。`evidence/host.log` にその container 名の `session.container.adopted` が出て、`L chat <n> work 'hi'` は同じ container id から返る。
- **片付け.** もう一度 host を止め、`docker rm -f <container>` を流してから `L up <n>` を流す。`host.log` に `"reason":"container missing"` 付きの `session.container.reaped` が出て、次の `L chat` が新しい container を起動する。
- **分離.** lane `m` を自分の agent 付きで起動し、lane `n` を再起動する。lane `m` の container は動き続け、lane `n` の `host.log` には一度も出てこない。

## Gotchas

- host の pid は `kurumi.lock` から読む。shell の `$!` は使わない。
- `up` は image と runner を作り直す。`container/`、runner bundle、`KURUMI_AGENT_IMAGE`、Agent Port、`KURUMI_DOCKER_NETWORK` のどれかが変わると runtime revision が変わる。そのとき `host.log` は `container was created for another runtime` と出し、container を引き継がずに作り直す。引き継ぎを試すときは、同じ checkout のまま再起動する。
- `host.log` は起動のたびに追記される。最新の `host.start` より後の行を読む。
