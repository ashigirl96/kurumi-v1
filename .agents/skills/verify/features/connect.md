# Google の同意画面を進める

Google の認可 URL を開き、指定したテストアカウントで同意かキャンセルを選ぶ。callback の本文と、アドレスをぼかしたスクリーンショットが lane の evidence に残る。Google の同意だけなら host の起動は要らない。

## Sub-features

- アドレスによるアカウント選択、未確認アプリの警告、空の scope チェックボックス、パスワードマネージャーのポップアップを処理する。
- `--account <n>` は `KURUMI_VERIFY_GOOGLE_ACCOUNTS` のカンマ区切りリストの n 番目を選ぶ。既定は 1。アカウントの一覧を repo 外で環境変数に設定する。
- `--uncheck gmail` または `--uncheck google-calendar` は、その service のチェックを外して残りを選ぶ。`--cancel` は Google から `access_denied` が戻ると非ゼロで終わる。
- `google-client` は keychain の client id と secret を `account set-client google` に渡す。clientId と clientSecret を持つ JSON を stdin で渡す。この CLI は P3-3 で追加される。

## How to get to it (user POV)

認可 URL は `packages/account/scripts/google-consent.ts` から得る。host が発行する接続リンクも受け付ける。接続リンクは、この lane の `http://127.0.0.1:<web port>/connect/<token>` に限る。

## Driving it with lane.sh

```sh
KURUMI_GOOGLE_CLIENT_ID="$(security find-generic-password -s kurumi-live-google-client-id -w)" \
KURUMI_GOOGLE_CLIENT_SECRET="$(security find-generic-password -s kurumi-live-google-client-secret -w)" \
bun packages/account/scripts/google-consent.ts --services gmail --mask
```

別の terminal から `L consent <n> '<authorize_url>'` を実行する。アカウントの指定は `L consent <n> '<url>' --account 2`、部分同意は `--uncheck google-calendar`、拒否は `--cancel` を付ける。成功時は driver が callback の本文を出力し、元の script が `grantedScopes` と `servicesCovered` を出す。

- スクリーンショットは `/tmp/kurumi-verify/lane-<n>/evidence/consent-*.png`。保存前に同じ helper がページ内のアドレス、入力値、URL と iframe をぼかす。viewport だけを保存するため、ブラウザの URL バーは画像に含まれない。
- 終了時には driver が `kurumi-verify-<n>` session を閉じる。検証後は成功・失敗とも `L down <n>` を流す。
- helper の unit test は `bun test ./.claude/skills/verify`。先頭の `./` は Bun に directory として渡すために必要。

## Gotchas

- agent-browser をインストールし、Brave の `v2`（`Profile 2`）でテストアカウントにログインしておく。全コマンドは lane 固有の session を使う。agent-browser は名前で指定した profile を session ごとに一時複製するため、複数 lane が同時に使える。
- desktop user agent で Google の通常の同意画面を開く。headless の既定 user agent では、Google が旧表示に切り替える場合がある。
- Google が `--uncheck` の対象を既存の許可として扱い、チェックボックスを出さない場合は、元の state と PKCE を保ち、対象 scope を外した認可 URL でやり直す。既存 scope の取り込みも止める。必要な認可パラメーターが見つからなければ失敗する。grant の revoke は他の lane の token も失効させるので、並行検証中は実行しない。
- `google-client` は `account set-client` がない head では、そのコマンド名を示して失敗する。
- 同意回数を報告する。Google は account と client ごとの refresh token 数に上限がある。
