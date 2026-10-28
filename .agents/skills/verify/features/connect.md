# Google の同意画面を進める

hostが発行した接続リンクを開き、指定したaccountで同意かキャンセルを選ぶ。callback の本文と、アドレスをぼかしたスクリーンショットが lane の evidence に残る。接続リンクの発行からcallbackまでhostを起動しておく。

## Sub-features

- アドレスによる account 選択、未確認アプリの警告、空の scope チェックボックスを処理する。
- `--account <n>` は `KURUMI_VERIFY_GOOGLE_ACCOUNTS` のカンマ区切りリストの n 番目を選ぶ。既定は 1。account の一覧は repo 外で環境変数に設定する。
- `--uncheck gmail` または `--uncheck google-calendar` は、元の認可requestからそのserviceのscopeだけを除き、`include_granted_scopes=false`で狭いtokenを要求する。残りのscopeとstate、PKCE、redirect URIなどのパラメータは保つ。Googleの既存grantはrevokeしない。`--cancel` は Google から `access_denied` が戻ると非ゼロで終わる。
- `google-client` は keychain の client id と secret を `account set-client google` に渡す。clientId と clientSecret を持つ JSON を stdin で渡す。
- `account connect` は5分・1回限りの接続リンクを発行する。使用済み・期限切れのリンクは再実行を案内する。
- callbackはGoogleのcodeを交換し、暗号化したOAuth accountと、要求したserviceのうち許可された分のgrantを保存する。部分同意では許可されなかったserviceもページに表示する。
- 完了・キャンセル後のcallbackの再読込はcodeを交換せず、それぞれ成功・キャンセルを表示する。`access_denied`だけがキャンセルになり、ほかのOAuthエラーは接続失敗を表示する。交換失敗や、要求したserviceが一つも許可されなかった場合は`open`に戻る。利用者は`account connect`をもう一度実行し、新しい接続リンクからやり直す。

- chatで接続を頼むと、`connect_account`がgroup名・Google・要求serviceを示すカードを投稿する。カードとtool応答にURLは含まれない。承認者が`kurumi chat press <ref> connect`を実行すると、そのコマンドだけに5分・1回限りのリンクを返す。
- 同じsessionで同じserviceを頼むとrequestとカードを再利用し、tool応答の`reused: true`で新しいカードを投稿していないと知らせる。serviceが変わると旧requestをキャンセルし、期限切れなら新しいrequestを作る。

## How to get to it (user POV)

`L kurumi <n> account connect --services gmail --agent-group-id <group-id>`から接続リンクを得る。接続リンクは、この lane の `http://127.0.0.1:<web port>/connect/<token>` に限る。

## Driving it with lane.sh

chatからは、`L add-key <n>`とagent作成後、`L google-client <n>`を先に実行し、次の順で進める。

```sh
L chat <n> work 'Gmail つないで'
L kurumi <n> chat press <card-ref> connect
L consent <n> '<private-connect-link>' --account 2
L kurumi <n> account list
L kurumi <n> db query 'select agent_group_id, service, granted_by from account_grant'
L kurumi <n> db query 'select kind, status from outbound_message'
```

replyとカードのpress行を確認する。リンクはpressのstdoutだけに出て、cardの保存行やtool応答には出ない。存在しないref、CLIから作ったrequest、期限切れ・終了したrequest、不明なactionはnoticeになり、link行を作らない。terminalのcallerはhostなので、非承認者の拒否はhuman callerのunit testで確認する。認可中に別の承認者がリンクを開くと、その承認者の新しいstateとPKCEでやり直す。以前の承認者のcallbackではgrantを作らない。同じ承認者の複数リンクはstateを共有する。noticeを返すpressは非ゼロで終了し、同じnoticeを1回だけ表示する。

再接続はこのgroupにgrantのあるすべての`needs_reauth` Google accountのserviceを同意対象に含め、groupには要求分だけを付与する。狭い同意が別groupのgrantを失わせる場合は保存を拒否し、不足serviceを名前で示す。requestを`open`に戻し、同意対象だけを広げる。もう一度カードをpressすると、それらも求める同意に進み、元のgroupだけがそのgrantを保つ。カードの無いCLI requestでは、拒否ページに要求分と不足分を含む`kurumi account connect --services <services> --agent-group-id <group>`を表示し、不足serviceもこのgroupに付与されると説明する。Google handleを含む出力はアドレスを伏せて保存する。

CLIから接続を始めるときは、次の順で実行する。`<group-id>`には`agent create`が返したidを使う。

```sh
L up <n>
L doctor <n>
L google-client <n>
L kurumi <n> agent create --name work
L kurumi <n> account connect --services gmail --agent-group-id <group-id>
L consent <n> '<connect-link>' --account 1
L kurumi <n> account list
L kurumi <n> db query 'select agent_group_id, service from account_grant'
```

Googleの同意後、callbackは`Connected. Granted: gmail.`を表示する。`L kurumi <n> db query 'select state from connection_request'`で`completed`を確認する。GmailとCalendarを要求する場合は`--services gmail google-calendar`と空白で区切る。`account list`のGoogle行は`oauth`になり、accountが持つserviceが並ぶ。groupへの付与は`account_grant`の読取queryで確認する。

chatを1回流してcontainerを起動し、そのcontainerからgateway経由でGmailを読む。

```sh
L chat <n> work 'Reply with OK.'
docker exec <container-id> curl -sS -D - -o /dev/null https://gmail.googleapis.com/gmail/v1/users/me/profile
```

200と`x-kurumi-account: google/<test-account>`を確認する。Gmail本文にはアドレスが入るため保存せず、headerと`account list`の出力もアドレスを伏せてからevidenceに保存する。callbackの再読込後も`host.log`の`account.connect.completed`は1行で、`transactionMs`にGoogleとの通信を除いた保存時間が残る。Calendarを許可しなかった場合はページに`Not granted: google-calendar`が出て、Calendarへのprobeは`account_not_connected`になる。

使用済みリンクと不明なstateは従来の410で再実行を案内する。期限切れのrequestは専用の410で期限切れと再依頼を案内し、code交換もgrantも行わない。`--cancel`ではcallbackがキャンセルを表示し、requestは`cancelled`になりaccountは作られない。期限後も、別のtabの遅い応答や再読込で完了・キャンセルの結果を表示する。cardの無い期限切れrequestは`kurumi account connect`の再実行を案内する。何も許可されなかった場合は`Nothing was granted`を表示し、既存accountも変更しない。失敗後は同じcallbackを再読込せず、`L kurumi <n> account connect --services gmail --agent-group-id <group-id>`で新しいrequestとリンクを作る。検証後は`L down <n>`を実行する。

accountの指定は`L consent <n> '<connect-link>' --account 2`、部分同意は`--uncheck google-calendar`、拒否は`--cancel`を付ける。driverは表示されたscope checkboxごとにserviceと設定後の状態を出力する。`--uncheck`ではcheckboxのない追加アクセス画面も進め、hostのcallback本文に`Connected. Granted:`と対象serviceの`Not granted:`があることを確認する。callbackのscope queryだけでは成功と判定しない。hostを止めた場合や、狭いtokenの保存をhostが拒否した場合は非ゼロで終わる。

access tokenの期限が60秒以内なら、gatewayはaccountごとに1回だけrefreshし、同時に来たGmailとCalendarのrequestもその完了を待つ。`host.log`の`account.refresh`（`durationMs`はGoogleとのrefresh往復時間）と、読取queryで`access_expires_at`が進んだことを確認する。

```sh
L kurumi <n> db query 'select id, status, access_expires_at from account where vendor = "google"'
L kurumi <n> gateway log
```

`unexpected_response`を除くOAuthの4xx（`invalid_grant`、`invalid_client`、`unauthorized_client`など）ではstatusが`needs_reauth`になり、probeは403の`account_needs_reauth`を返す。本文の`next`は、拒否されたserviceだけを含む`mcp__kurumi__connect_account`の呼び出しをagentに案内する。同じGoogle accountで同意すると`active`に戻る。network障害、5xx、30秒のtimeoutではstatusを変えず、503の`account_refresh_failed`を返す。`x-should-retry: false`は付かず、次のprobeはrefreshを再試行する。code交換にも同じ30秒のtimeoutがある。

grantをrevokeすると、有効期限内のaccess tokenでもGoogleは401を返す。gatewayはその応答を返し、注入したOAuth情報が保存中のものと同じ場合だけ期限を切る。次のprobeでrefreshが`invalid_grant`となり、403の`account_needs_reauth`を返す。先に完了した再接続やrefreshのtokenを、遅れて来た401で失効させない。再接続がrefresh中に完了した場合も、現在のgrantと有効なtokenを読み直して使う。

revokeの自己検証は、そのaccountを専有する`alone` laneでのみ行う。repo外のscratch scriptでlaneの`vault.key`とDBから保存tokenを開き、Googleの`https://oauth2.googleapis.com/revoke`へPOSTする。tokenは出力・保存・argvに渡さず、HTTP statusだけを記録する。containerからGmailを2回probeし、最初の401と次の403、本文の拒否されたserviceだけを含む接続案内、`account list`の`needs_reauth`をアドレスを伏せて残す。成功・失敗とも`L down <n>`で終了する。

- スクリーンショットは `/tmp/kurumi-verify/lane-<n>/evidence/consent-*.png`。同じ helper がページ内のアドレス、入力値、placeholder、SVG、open shadow root、URL と iframe を撮影前と各 frame でぼかす。viewport だけを保存するため、ブラウザの URL バーは画像に含まれない。失敗時もその画面を保存する。
- driver は正常終了、失敗、SIGINT、SIGTERM で `kurumi-verify-<n>` session を閉じる。検証後は成功・失敗とも `L down <n>` を流す。`down` もこの session を閉じる。
- helper の unit test は `bun test ./.agents/skills/verify`。先頭の `./` は Bun に directory として渡すために必要。`bun run check` にも含まれる。

期限切れと既存accountの再利用は、同じlaneの`work`と`home`で確かめる。`up`に`KURUMI_CONNECT_REQUEST_TTL_MS=60000`を渡し、Google clientはリンクを出す前に設定する。60000未満、整数でない値はhostの起動時に変数名を含むerrorになる。既定は30分。

```sh
KURUMI_CONNECT_REQUEST_TTL_MS=60000 L up <n>
L doctor <n>
L add-key <n>
L google-client <n>
L kurumi <n> agent create --name work
L kurumi <n> agent create --name home
L chat <n> work 'Gmailを接続して。接続後にprofileを読んで。'
```

カードを押さず、chatを接続したまま最長2分待つ。元のrefに`期限切れです。もう一度頼んでください`が出て、`connection_request`は`expired`、`pkce_verifier`はnullになる。agentへのsystem noticeは無い。host logの`account.connect.expired`には`count`と`durationMs`がある。hostを止めて期限を越した場合も、次の起動時にsweepする。

再び`work`に頼むと新しいカードが出る。期限内に`connect`をpressし、`L consent <n> '<private-connect-link>' --account 2`でgmailだけ同意する。続いて`home`に同じ依頼を送ると、カードは接続ボタンの後に`google/<test-account> を使う`を表示する。カードにある`use:<accountId>`をpressすると、追加の同意なしでhomeのgrant、✅置換、system noticeが同じtransactionで保存され、agentが続きを始める。CLIは成功時もnoticeを表示してexit 1なので、結果はgrantと再開で確認する。

```sh
L chat <n> home 'Gmailを接続して。接続後にprofileを読んで。'
L kurumi <n> chat press <home-card-ref> use:<accountId>
L kurumi <n> db query 'select agent_group_id, service, granted_by from account_grant'
L kurumi <n> db query 'select state, pkce_verifier is null as verifier_cleared from connection_request'
L kurumi <n> gateway log
L down <n>
```

再利用はactiveなGoogle accountが要求serviceを全て持ち、その全てがgroupに付与済みでない場合に提案する。press時にもref、期限、承認者、ownerの付与権限、coverageを確認する。scoped adminは承認者でも再利用できない。CLIはhost callerなので、この拒否はhuman callerのunit testで確認する。期限切れ、非承認者、削除済み・再認可が必要・coverageが狭くなったaccountはnoticeで拒否し、何も保存しない。Googleの`account_not_connected`と`account_needs_reauth`の`next`にはmodelに見える`mcp__kurumi__connect_account`と拒否されたserviceだけの配列を返す。key vendorはadd-keyまたは同じhandleの再追加を案内する。

## Gotchas

- agent-browser をインストールし、使う profile で test account にログインしておく。driver は `agent-browser profiles` で表示名を directory に解決し、BraveSoftware 配下の場合に Brave を使う。拡張は無効にして起動する。全コマンドは lane 固有の session を使う。agent-browser は名前で指定した profile を session ごとに一時複製するため、複数 lane が同時に使える。
- desktop user agent で Google の通常の同意画面を開く。headless の既定 user agent では、Google が旧表示に切り替える場合がある。
- account chooser は profile に複数の account が sign in しているため表示される。Google が chooser を省略した場合、driver は選択対象を確かめられないため失敗する。
- `--uncheck`は元の認可URLで要求したserviceに限る。laneの接続リンクは302を1回だけ取得し、Googleの元のauthorize URLであることを検証してからscopeを変更する。Googleの途中のchooserやconsent URLは入力に使えない。`--uncheck`なしではrequestを変更しない。既存grantを持つaccountでも狭いtokenを要求するが、Google側の許可を取り消す操作ではない。別groupのgrantを失うtokenの保存はhostが拒否する。grantのrevokeは他のlaneのtokenも失効させるため、専有する`alone` laneでのみ行う。
- `google-client` は `account set-client` がない head では、そのコマンド名を示して失敗する。
- `google-client`は進行中のGoogle requestをすべてキャンセルするため、必ず接続リンクの発行前に実行する。
- `account list`に`--agent-group-id`はない。一覧のserviceはaccountが持つ範囲を示すため、groupへの付与は読取queryかagentの`list_accounts`で確認する。
- 同意回数は完了したcode交換をaccountごとに報告する。Googleはaccountとclientごとのrefresh token数に上限がある。grantのrevokeは専有する`alone` laneでのみ行う。
