# Google の同意画面を進める

Google の認可 URL を開き、指定した account で同意かキャンセルを選ぶ。callback の本文と、アドレスをぼかしたスクリーンショットが lane の evidence に残る。Google の同意だけなら host の起動は要らない。

## Sub-features

- アドレスによる account 選択、未確認アプリの警告、空の scope チェックボックスを処理する。
- `--account <n>` は `KURUMI_VERIFY_GOOGLE_ACCOUNTS` のカンマ区切りリストの n 番目を選ぶ。既定は 1。account の一覧は repo 外で環境変数に設定する。
- `--uncheck gmail` または `--uncheck google-calendar` は、その service のチェックを外して残りを選ぶ。`--cancel` は Google から `access_denied` が戻ると非ゼロで終わる。
- `google-client` は keychain の client id と secret を `account set-client google` に渡す。clientId と clientSecret を持つ JSON を stdin で渡す。
- `account connect` は5分・1回限りの接続リンクを発行する。使用済み・期限切れのリンクは再実行を案内する。
- callbackはGoogleのcodeを交換し、暗号化したOAuth accountと、要求したserviceのうち許可された分のgrantを保存する。部分同意では許可されなかったserviceもページに表示する。
- callbackの再読込はcodeを交換せず同じ結果を表示する。キャンセルは`cancelled`、交換失敗は再試行できる`open`になる。

## How to get to it (user POV)

認可 URL は `packages/account/scripts/google-consent.ts` から得る。host が発行する接続リンクも受け付ける。接続リンクは、この lane の `http://127.0.0.1:<web port>/connect/<token>` に限る。

## Driving it with lane.sh

CLIから接続を始めるときは、次の順で実行する。`<group-id>`には`agent create`が返したidを使う。

```sh
L up <n>
L doctor <n>
L google-client <n>
L kurumi <n> agent create --name work
L kurumi <n> account connect --services gmail --agent-group-id <group-id>
L consent <n> '<connect-link>' --account 1
L kurumi <n> account list --agent-group-id <group-id>
```

Googleの同意後、callbackは`Connected. Granted: gmail.`を表示する。`L kurumi <n> db query 'select state from connection_request'`で`completed`を確認する。GmailとCalendarを要求する場合は`--services gmail google-calendar`と空白で区切る。`account list`のGoogle行は`oauth`になり、groupに付与したserviceが並ぶ。

chatを1回流してcontainerを起動し、そのcontainerからgateway経由でGmailを読む。

```sh
L chat <n> work 'Reply with OK.'
docker exec <container-id> curl -sS -D - -o /dev/null https://gmail.googleapis.com/gmail/v1/users/me/profile
```

200と`x-kurumi-account: google/<test-account>`を確認する。Gmail本文にはアドレスが入るため保存せず、headerと`account list`の出力もアドレスを伏せてからevidenceに保存する。callbackの再読込後も`host.log`の`account.connect.completed`は1行で、`transactionMs`にGoogleとの通信を除いた保存時間が残る。Calendarを許可しなかった場合はページに`Not granted: google-calendar`が出て、Calendarへのprobeは`account_not_connected`になる。

使用済みリンクや不明・期限切れのstateは410で再実行を案内する。`--cancel`ではcallbackがキャンセルを表示し、requestは`cancelled`になりaccountは作られない。検証後は`L down <n>`を実行する。

OAuth helperだけを検証する場合は、次のscriptを使う。

```sh
KURUMI_GOOGLE_CLIENT_ID="$(security find-generic-password -s kurumi-live-google-client-id -w)" \
KURUMI_GOOGLE_CLIENT_SECRET="$(security find-generic-password -s kurumi-live-google-client-secret -w)" \
bun packages/account/scripts/google-consent.ts --services gmail --mask
```

別の terminal で、ログイン済み profile の表示名を `KURUMI_VERIFY_BROWSER_PROFILE` に設定し、`L consent <n> '<authorize_url>'` を実行する。account の指定は `L consent <n> '<url>' --account 2`、部分同意は `--uncheck google-calendar`、拒否は `--cancel` を付ける。driver は scope checkbox ごとに service と設定後の状態を出力する。成功時は callback の本文を出力し、元の script が `grantedScopes` と `servicesCovered` を出す。

- スクリーンショットは `/tmp/kurumi-verify/lane-<n>/evidence/consent-*.png`。同じ helper がページ内のアドレス、入力値、placeholder、SVG、open shadow root、URL と iframe を撮影前と各 frame でぼかす。viewport だけを保存するため、ブラウザの URL バーは画像に含まれない。失敗時もその画面を保存する。
- driver は正常終了、失敗、SIGINT、SIGTERM で `kurumi-verify-<n>` session を閉じる。検証後は成功・失敗とも `L down <n>` を流す。`down` もこの session を閉じる。
- helper の unit test は `bun test ./.agents/skills/verify`。先頭の `./` は Bun に directory として渡すために必要。`bun run check` にも含まれる。

## Gotchas

- agent-browser をインストールし、使う profile で test account にログインしておく。driver は `agent-browser profiles` で表示名を directory に解決し、BraveSoftware 配下の場合に Brave を使う。拡張は無効にして起動する。全コマンドは lane 固有の session を使う。agent-browser は名前で指定した profile を session ごとに一時複製するため、複数 lane が同時に使える。
- desktop user agent で Google の通常の同意画面を開く。headless の既定 user agent では、Google が旧表示に切り替える場合がある。
- account chooser は profile に複数の account が sign in しているため表示される。Google が chooser を省略した場合、driver は選択対象を確かめられないため失敗する。
- `--uncheck` は認可 URL で要求した service に限る。Google が既存 grant のため checkbox を出さない場合は失敗する。その service をまだ許可していない account を使う。grant の revoke は他の lane の token も失効させるため実行しない。
- `google-client` は `account set-client` がない head では、そのコマンド名を示して失敗する。
- `google-client`は進行中のGoogle requestをすべてキャンセルするため、必ず接続リンクの発行前に実行する。
- access tokenのrefreshは未実装。期限を過ぎる前にprobeする。
- 同意回数は完了したcode交換をaccountごとに報告する。Googleはaccountとclientごとのrefresh token数に上限がある。grantのrevokeは行わない。
