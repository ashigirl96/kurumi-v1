# account と grant

owner は vendor の key を一度追加し、kurumi はそれを vault に封じる。agent の container が持つのは selector だけで、gateway が vendor の host への request でそれを本物の credential に差し替える。差し替えるのは、account が grant された group の request だけだ。grant が無いと agent は 403 を受け、JSON の `next` が owner に何を頼めばよいかを伝える。

## Sub-features

- `add-key` stdin から読んだ key を保存し、handle を出力する。
- `auto-grant` 以後に作った agent group に account を grant する。
- `grant-revoke` 1 つの group と service に対して account を grant または revoke する。
- `refusal` 使える grant の無い request は、`next` 付きの 403 `account_not_connected` を受ける。
- `remove` account を、その grant と default ごと消す。

## How to get to it (user POV)

- `security find-generic-password -s kurumi-live-claude -w | kurumi account add-key anthropic --auth oauth-token --label main --auto-grant`
- `kurumi account list`、`kurumi account grant|revoke <handle> --service anthropic-api --agent-group-id <id>`、`kurumi account remove <handle>`、`kurumi account set-default|clear-default`。

## Driving it with lane.sh

前提: README の基本の状態（key を追加し、`work` を作り、chat を 1 回済ませた）。

- **追加.** `L add-key <n>` が `anthropic/main` を出力する。`L kurumi <n> account list` が `anthropic/main  oauth-token  anthropic-api  auto-grant` を示す。
- **差し替え.** `L probe <n>` が `x-kurumi-account: anthropic/main` と `status=200` を出力する。
- **container は key を持たない.** `docker exec <container> sh -c 'echo $CLAUDE_CODE_OAUTH_TOKEN'` は本物の token ではなく `sk-ant-kurumi-`（selector）で始まる。evidence に値の全体を残さないよう、`cut -c1-14` を通す。
- **Revoke.** `L kurumi <n> account revoke anthropic/main --service anthropic-api --agent-group-id <id>` のあと、`L probe <n>` が `status=403` を出力する。`L kurumi <n> gateway log --decision refused` にその行が出る。
- **Grant し直す.** `L kurumi <n> account grant anthropic/main --service anthropic-api --agent-group-id <id>` のあと、`L probe <n>` がまた `status=200` を出力する。
- **agent から見た結果.** grant を revoke した状態で `L chat <n> work 'hi'` を流すと、返事は `Provider error 403 account_not_connected: <next>` になる。

## Gotchas

- `add-key` は key を stdin からしか読まない。stdin が TTY だと `BAD_REQUEST: value is read from stdin` で失敗する。token を引数に渡したり表示したりしない。
- gateway が読めない selector は 400 `selector_unreadable` を受け、`accepted` に group が書ける形が並ぶ。
- probe の model は subscription が許すものにする。`claude-haiku-4-5` は 200 を返す。plan の外の model は 429 を返すが、account の header は付く。
