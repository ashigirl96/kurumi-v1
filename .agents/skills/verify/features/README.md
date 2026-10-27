# kurumi の検証 map

live の host で kurumi の利用者から見える振る舞いを確かめるための、保守される情報源。この索引を読んでから、対応する feature の file を手順として使う。

## 前提

- Docker が動いていて、macOS の keychain の service `kurumi-live-claude` に owner の Claude subscription token が入っている。
- lane が起動している。`.agents/skills/verify/lane.sh up <n>` を流し、`lane.sh doctor <n>` が `FAIL` を出さない。
- 各手順は、断りがなければ次の状態から始める。`lane.sh add-key <n>`、`lane.sh kurumi <n> agent create --name work`、`lane.sh chat <n> work '<line>'` を 1 回ずつ流し、agent の container が動いている状態。
- 以下では `L` は `.agents/skills/verify/lane.sh`、`n` は自分の lane 番号を指す。

## 動かし方の決まり

- owner の操作は `L kurumi <n> …`、agent の操作は `L chat`（Claude の turn）か `L probe`（container からの生の request 1 本）で行う。
- `kurumi chat` は返事が届くまで stdin を開けておく。`L chat` はそうする。stdin を早く閉じると stream が終わり、返事を取りこぼす。
- 読むだけの見え方: `L kurumi <n> gateway log`、`approval list`、`account list`、`agent list`、`db query '<select>'`、`evidence/host.log`、`docker ps -a --filter label=kurumi.install=<install>`。

## 証拠と未確認の報告

- CLI の証拠は、コマンド、stdout と stderr、exit code で、`evidence/` に保存する。
- 変更には、あとから別の見え方で読んだ結果を必ず添える。
- 届かなかった入口は、流したコマンドと欠けていた前提を書いて報告する。別の経路で確かめたことにはしない。

## feature の file の決まり

各 feature の file は H1 と、利用者から見える振る舞いを書いた 1 段落で始め、次の 4 つの H2 をこの順に置く: `Sub-features`、`How to get to it (user POV)`、`Driving it with lane.sh`、`Gotchas`。

## Features

- [Google の同意画面](./connect.md): 指定した account で同意、部分同意、キャンセルを行う。
- [agent と chat する](./chat.md): agent を作り、`kurumi chat` で Claude の返事を受け取る。
- [account と grant](./accounts.md): key を追加し、grant と revoke をして、grant の無い agent が受ける拒否を見る。
- [gateway の log と status](./gateway-log.md): 横取りした request は account 付きの egress 行を 1 行ずつ残す。status は admission と CA を示す。
- [approve rule と保留された request](./approval-hold.md): rule に合う request は owner が approve か deny するまで待つ。
- [host の再起動と container の引き継ぎ](./host-restart.md): 再起動した host は動いている container を引き継ぎ、消えた container は作り直す。
