# kurumi の設計

この文書が引く how.md、why.md、context.md は `grounding/` にある。型と署名は `sketch/`、repo の形と機能の置き場は `module-map.md` にある。

## Problem

kurumi は nanoclaw の全機能を TypeScript だけで持ち直し、OneCLI v1.42.0 の credential gateway を取り込み、host 側のデータを 1 つの SQLite に入れる。形が自明でないのは、今の 3 者がそれぞれ別の前提で境界を引いているからである。nanoclaw は VirtioFS をまたぐ WAL を避けるため、Session ごとに 1 writer の SQLite を 2 つ（`inbound.db` / `outbound.db`）置き、host がそれを 1 秒ごとに poll する。OneCLI は別 process・別 DB で、agent の身元は Agent Group 単位の `aoc_` token、grant は join table と v2 rule の 2 か所にあり、callback は付与せず、既定の `all` mode が「つないだらすぐ使える」をたまたま成り立たせている。Gmail と Calendar は同じ Google アカウントでも別 provider の別行になる。monica は `locking_mode=EXCLUSIVE` で Backend 以外に DB を開かせず、デスクトップの寿命（孤児自殺、不在は正常、boot ごとの token）を前提にしている。守る制約は why.md の Preserve 1〜9（credential は container に入れない、fail-closed だが閉じっぱなしにしない、egress の迂回を塞げる、管理 API に container から届かせない、group ごとに身元を分ける、同じ provider の複数アカウント、黙って選ばない、鍵と CA をデータと同じ backup 単位に）と、Change 1〜7 である。

## Usage (caller's view)

### Owner が読む README

```sh
kurumi setup                                   # Docker 確認、vault.key と CA 生成、launchd 登録、owner 登録
kurumi account add-key anthropic --label main --value sk-ant-… --auto-grant
kurumi account set-client google --client-id … --client-secret …
kurumi agent create --name work --template assistant
kurumi agent create --name home

# 1 回の Google の同意で Gmail と Calendar を取る。リンクは自分用で 5 分・1 回限り
kurumi account connect --services gmail,google-calendar --agent-group-id ag-work
kurumi account grant google/bob@home.example --service gmail --agent-group-id ag-work
kurumi account set-default google/alice@work.example --service gmail --agent-group-id ag-work
kurumi account grant google/bob@home.example --service gmail --agent-group-id ag-home --default
kurumi account grant google/alice@work.example --service google-calendar --agent-group-id ag-home
kurumi account list --agent-group-id ag-work
#  google/alice@work.example   oauth  gmail(default) google-calendar
#  google/bob@home.example     oauth  gmail
#  google/carol@club.example   oauth  gmail
#  anthropic/main              key    anthropic-api (auto-grant)

kurumi gateway rules add --priority 10 --target '{"account":"google/alice@work.example"}' \
  --method POST --path '/gmail/v1/users/me/messages/send' --effect '{"kind":"approve"}'
```

Console では Agent Group ごとの Accounts 画面で同じこと（service ごとの付与、既定、取り消し、接続）ができる。

### chat の中での接続（ユーザーと agent から見たもの）

```
user   > Notion つないで
agent  ⟶ tool connect_account({ services: ["notion"] })
         ← { kind: "card_posted", requestId: "cr-0193…" }
agent  > Notion を接続します。下のボタンから進めてください。
card   [Notion] この agent（work）に Notion アカウントをつなぎます
         [Notion アカウントを接続]         ← action ボタン。URL は載っていない
         (既に別 group でつないだ Notion があれば) [Workspace X を使う]
… 承認者（group の admin か owner）がボタンを押す …
（押した人にだけ）Slack: ephemeral の「Notion の同意画面を開く」リンク / Console: そのまま遷移
         ← https://kurumi.example.ts.net/connect/<token>（5 分、1 回限り）
… 承認者でない人が押すと、その人にだけ「この group の承認者だけが接続できます」…
… OAuth が終わる …
card   ✅ notion/Workspace X を work につなぎました（notion）
agent  ← <system>Account notion/Workspace X is now connected for notion. Continue the task that needed it.</system>
agent  > つながりました。Notion のページ一覧を取ってきます…
```

### container の中の agent が Gmail を使う

```sh
# 名指し: 本物の token が入る場所（credential slot）に selector を書く。service ごとに書く場所は 1 つ
curl -H 'Authorization: Bearer kurumi:google/carol@club.example' \
  https://gmail.googleapis.com/gmail/v1/users/me/messages
# → 200、response header に x-kurumi-account: google/carol@club.example

# 名指し無し: work の gmail には 3 つあり既定が alice なので alice が使われる
curl https://gmail.googleapis.com/gmail/v1/users/me/profile
# → 200、x-kurumi-account: google/alice@work.example

# 既定の無い group で名指し無し
# → 409 {"error":"account_ambiguous","service":"gmail",
#        "granted":["google/bob@home.example","google/carol@club.example"],
#        "next":"put kurumi:<handle> where the token goes"}

# 付与されていない handle、または gmail を付与されていない account
# → 403 {"error":"account_not_granted","service":"gmail","named":"google/alice@work.example","granted":[…]}

# service 自体の付与が無い
# → 404 {"error":"account_not_connected","service":"notion","next":"call connect_account with services=[\"notion\"]"}
```

agent は `list_accounts` tool で、自分の group の handle、service、既定、slot に書く `selector` そのものを知る。他 group のアカウントは agent に一切見えない。SDK が credential の形を検証する vendor（Anthropic の `sk-ant-` など）では、vendor の `selectorShape` が形を変える（例 `sk-ant-kurumi-<base64url(handle)>`）。agent は `selector` を写すだけなので、形の違いを知らなくてよい。

### host のコードでの呼び出し（3 か所）

```ts
// packages/gateway/src/forward.ts — MITM の中の 1 request
const target = serviceFor(url.hostname, url.pathname) // { vendor, service } | null
const decision = await deps.accountLedger.credentialFor(principal, { ...target, headers: req.headers, url })
if (!decision.ok) return refusalResponse(decision.refusal) // status は REFUSAL_STATUS[code]
const effect = evaluate(deps.rules(), { agentGroupId: principal.agentGroupId, accountId: decision.injection.accountId, … })
decision.injection.apply(decision.stripped)

// packages/account/src/server.ts — agent の connect_account（同期 transaction。session への書き込みは deps 経由）
db.transaction((tx) => {
  const id = insertOpenRequest(tx, { agentGroupId, vendor, services, sessionId, expiresAt })
  const cardMessageId = deps.sessions.postCard(tx, sessionId, connectCard(request, existingUngranted))
  setCardMessage(tx, id, cardMessageId)
})

// apps/host/src/main.ts — 全 domain の router を 1 つにし、全 procedure の前に guard を置く
const router = guardRouter<HostContext>().router({ agent: agentRouter, account: accountRouter, … })
```

## Shape

### 1. process と保存先

process は kurumi host（Bun、launchd の KeepAlive）1 つと、Session ごとの container だけである。gateway は host の中の domain package で、別 process にしない。forward の engine（`gateway/src/forward.ts` の `forward`）は必要なものをすべて `ForwardDeps` で受けるので、計測で必要になれば後から別 process に切り出せる。`kurumi.db` を開くのは host だけで、`locking_mode=EXCLUSIVE` + WAL を monica のまま使う。2 つ目の host は最初の query で SQLITE_BUSY になり、`kurumi.lock` の flock がそれを分かる文で止める。

host は listener を 3 つ持つ。`kurumi.sock`（0600、caller=host）、web（127.0.0.1 のみ、Console と OAuth の口）、Agent Port（container が届く唯一の口、固定 port）。Agent Port は 1 つの node:http server で、`CONNECT` は egress proxy、`GET /probe/:nonce` は起動時の到達確認、それ以外は agent caller の oRPC である。proxy と RPC は同じ Session Token で認証する。Bun 1.4.3 の node:http が `'connect'` と `TLSSocket({ isServer: true })` で MITM できることは sonnet の spike で確認済みである。

host↔container の通信路は SQLite の mailbox をやめ、この Agent Port 上の oRPC（`session.channel.pull / complete / post / heartbeat / state`）にした。理由は 4 つある。

- **VirtioFS と WAL.** mailbox を残せば `journal_mode=DELETE` と 1 file 1 writer で VirtioFS の問題は避けられるし、別 file なので kurumi.db の EXCLUSIVE とも衝突しない。だから決め手はそこではない。
- **敵対的な file を host が開く.** `outbound.db` は container が書く。container を敵対的とみなすなら、host は攻撃者が作った SQLite file を毎秒 parse している。RPC なら container から来るのは zod で検証する JSON だけになる（per boundary-discipline）。
- **状態が 2 か所に分かれる.** nanoclaw は `processing_ack` を host の sweep が `messages_in.status` に写し、`on_wake` 行で古い container が follow-up を奪うのを防いでいる。RPC にすると inbound / outbound は kurumi.db の 1 table ずつになり、pull が `claimedBy = container` を同じ transaction で書く。古い container は token を失効されるので pull できず、`on_wake` は要らない（per separate-before-serializing-shared-state、writer は host だけ）。
- **poll が push になる.** container が動いていれば pull の long poll が即座に起き、post は即座に配達に入る。1 秒と 60 秒の delivery poll は失敗の再試行だけに残る。

decision 3 との関係は単純で、container は SQLite を 1 つも持たないので、host のデータはすべて kurumi.db にある。受信添付（`inbox/`）は host だけが書く普通の file、送信 file は RPC の multipart で上げる。unix socket の bind mount は container から connect できないので（spike）、口は TCP に決まる。

Gateway Outage の意味は nanoclaw から引き継ぎ、検出を強くした。admission は `binding → probing → open` と進み、bind の後に probe container を agent と同じ network で 1 つ走らせて `http://host.docker.internal:<port>/probe/<nonce>` を読ませ、nonce が返って初めて開く（fable から）。bind か probe に失敗すれば `bind_failed` / `unreachable` で閉じたまま owner に一度知らせ、gateway の system Job が backoff で再試行する。閉じている間 session は spawn せず、inbound は pending に残る（Preserve 2・3）。「host が listener を開いた」と「container がそこに届く」は別の事実で、後者を毎回確かめるので、Docker Desktop の到達性（how.md Gotcha 16）が環境の変化で崩れても黙って壊れない。

### 2. Account、Grant、request ごとの選択

データの核は 5 table（`packages/account/src/schema.ts`）。vendor と service の 2 階層は sonnet から取り込んだ。

- `account`: 1 つの vendor での 1 つの identity（Google のログイン、Notion の workspace、貼った Anthropic key）。Google は 1 行で、Gmail と Calendar はその service である。`UNIQUE(vendor, subject)` と `UNIQUE(vendor, label)`。同じ人が再接続すると行を更新し、別のメールなら行を足す。`services` はその credential で呼べる service（同意された scope から `servicesCovered` で導く）。
- `account_grant(agentGroupId, accountId, vendor, service)`: 多対多の付与。PK `(group, account, service)` がそのまま「付与」の定義で、grant がある場所はここだけ（OneCLI の join table + v2 rule の二重化はやめる。per single source of truth）。`service ∈ vendor` は catalog から生成した CHECK が、`vendor = account.vendor` は `account(id, vendor)` への複合 FK が DB で保証する。`service ∈ account.services` は JSON なので制約にできず、grant を書く唯一の関数 `grant` が検証する（fable から）。既定は deny で、`all` mode は無い。Anthropic key のように全 group に要るものは `account.autoGrant=true` を人が付け、Agent Group の作成時に grant 行が作られる（普通の grant なので個別に外せる）。
- `default_account(agentGroupId, service, accountId, vendor)`: PK が「group × service に既定は 1 つ」を、grant 行への複合 FK が「既定は付与済み」を、`account(id, vendor)` への複合 FK が「既定の vendor はアカウントの vendor」を保証する。revoke すれば cascade で既定も消える。
- `connection_request` と `connect_link`: 次節。

agent がアカウントを指す名前は Account Handle `<vendor>/<label>`（例 `google/alice@work.example`）で、保存せず導出する。label は vendor 内で unique である。judge が挙げた「label の変更で handle が変わる」は受け入れた（Tradeoffs）。

1 つの外向き request は次の順に処理される（`packages/account/src/select.ts`）。

1. gateway が host と path から `(vendor, service)` を 1 つに決める（`serviceFor`。同じ host を共有する service は必ず pathPrefix で分かれていることを catalog を走査する test で保証する）。
2. `readSelector` が、その service の credential slot（Bearer header、`x-api-key`、basic の password、query param）から vendor の `selectorShape` で handle を読み、slot を空にする。名指しの手段はこれ 1 つで、header による選択は持たない。SDK や curl が token を設定できれば、custom header を付けられない client でもアカウントを選べる。SDK が token の形を検証する場合は `selectorShape` がその形に合わせる（fable から。Anthropic で要るかは unit 4 で確かめる）。
3. `credentialFor(principal, target)` が `account_grant ⋈ account WHERE agent_group_id = principal.agentGroupId AND service = ?` を毎回引き（同 process、index 付き、cache なし）、純粋関数 `selectAccount` に渡す。名指しがあればそれ、無ければ 1 件ならそれ、既定があればそれ、どれでもなければ `account_ambiguous`。名指しが候補に無ければ `account_not_granted`、候補が 0 件なら `account_not_connected`。
4. 選ばれたものだけを復号する。期限切れなら account ごとの single-flight（`Map<accountId, Promise>`）で refresh し、network は transaction の外、書き戻しは行を読み直す同期 transaction で行う。Google の 1 行を複数の group と service が共有しても、refresh は 1 本にまとまる（why Risk 4）。

grant の検査は `credentialFor` の 1 か所だけで、credential material を外に出す関数は package の中にこれしか無い。`Injection` は secret を closure に閉じた opaque な値で、`apply` しか持たず、`toJSON` は throw する。contract の zod schema にも material の field は無い。

OneCLI の欠けていた点はこう埋まる。既定アカウントが無い → `default_account`。`all` mode が全アカウントを漏らす → mode 自体が無い（default deny + 明示の autoGrant）。policy と承認がアカウントを区別しない → Egress Rule の target に `accountId` を持ち、評価をアカウント選択の後に行う。承認カードと `egress_log` にも handle と service が入る。callback が付与しない → `connection_request` が group と services を持ち、完了の transaction で grant を書く。Secret が connection を隠す → key も OAuth も同じ `account` で、service ごとに 1 本の選択経路しか無い。同じ Google に 2 回同意する → 1 回の同意で scope の和集合を取る（`include_granted_scopes` による後からの追加は未検証で、unit 2 で確かめる）。

### 3. chat の中での接続

pending-connection の状態を持つのは account domain の `connection_request` だけである。状態は `open → authorizing → completed`、ほかに `expired` と `cancelled`。遷移はどれも行を読み直す同期 transaction の中で起きる（`packages/account/src/connect.ts`）。

接続リンクの認可は sonnet から取り込んだ。カードのボタンは URL ではなく action である。押されると host が押した人を `accessLedger.isApprover`（group の approver chain）で確かめ、approver にだけ 5 分・1 回限りの `/connect/<token>` を発行して、その人にだけ返す（Slack は ephemeral、Console は遷移。`CardActionReply` の `private-link`）。`connect_link` には token の hash だけを保存する。Slack の共有 channel で他の人がカードを見ても、自分のアカウントをその group につなぐことはできない。既に別の group でつないだアカウントを使う「◯◯を使う」ボタンも、同じく approver だけが押せる。

- agent が `connect_account` を 2 回呼ぶと、部分 unique index `(group, vendor, session) WHERE state IN (open, authorizing)` に当たり、同じ request とカードが返る。
- ボタンを 2 回押すと link が 2 本できるが、どちらも同じ authorize URL に行く。`authorizing` の行は保存済みの state と PKCE verifier を使い回すからである。
- 使用済みの link や 5 分を過ぎた link は「もう一度ボタンを押して」のページになる。
- callback を再読込すると、`completed` の行を見て同じ成功ページを返す。OAuth の code は使わない。
- 2 つのタブで別々に認可した場合は、exchange を transaction の外で行い、transaction の中で行が `authorizing` のままか見直す。後から来た方は token を捨てて現在の状態を表示する。
- 期限切れ（30 分）は system Job がカードを「期限切れ、もう一度頼んで」に書き換える。
- host が再起動しても、request、state、verifier（vault で暗号化）、link、カードの outbound id は DB にあるので、再起動後の callback はそのまま完了する。

完了の transaction は、account の upsert（`services` の更新を含む）、要求された service のうちアカウントが持つものの grant、request の `completed`、`sessions.replaceCard`（カードを「✅ つなぎました」に）、`sessions.notifySession`（trigger 付きの system message）を 1 つにまとめる。`sessions` は host が session ledger から作って account に渡す関数で、account は session の server entry を import しない（judge の指摘への対処。monica ADR-0013 の形）。notify が container を起こすか、動いている container の pull を即座に返すので、agent はユーザーが頼み直さなくても続きを始める。gateway は grant を毎回 DB から引くので、OneCLI の 60 秒 cache と invalidate の取りこぼしは起きない。

**MCP にするか.** gateway 側の MCP server にはしない。connect は既存の host channel 上の tool（`account.connect` procedure の `meta.tool`）にする。4 候補とも独立にこの結論に至った。

- この操作に要るのは Session の身元（どの chat にカードを出し、どの Session を再開するか）で、Agent Port の Session Token がそれを既に証明している。gateway に MCP server を足すと、同じ container に 2 つ目の認証と 2 つ目の口ができる。
- カードの配達と Session の再開は chat と session の知識で、gateway に置くと gateway が chat を知ることになる（information leakage）。
- runner の tool は contract の `meta.tool` から導出されるので（`apps/runner/src/tools.ts`）、tool を足す作業は contract に 1 行足すことになる。monica ADR-0003 の「同じ contract から MCP adapter を生成する」をそのまま実装した形である。
- gateway の役割は、`account_not_connected` の本文で `connect_account` を呼ぶよう agent に知らせるところまでにする。URL は返さない。

### 4. Credential Approval の往復

`approve` effect の Egress Rule に当たった request は、gateway が TCP を保留したまま、approval domain の `pending_approval` に kind `gateway.request` の行を書く（同期 transaction）。principal が Session を持つので、カードの本文には account の handle と service、method / host / path、service の summarizer の要約、どの chat のどの Session が頼んだか（`origin.chatName`）が出る。

カードの宛先は haiku の形の純関数 `cardTarget(policy, { origin, approvers })` が決める。既定の policy は `origin`（元の chat にその場で出す。Grok Bot と同じ見え方）で、元の chat が無い Scheduled Task の Session だけ approver の DM に出す。`approver-dm`（nanoclaw の挙動）と `origin-if-owner-only` も同じ関数の分岐で、host の config 1 値で切り替わる（ユーザーの決定、2026-10-22）。押せる人は行の作成時に解決して `approvers` に焼く（sonnet から）。カードがどこに出ても、クリックはこの集合で認可され、後で role が変わっても発行時の集合のままである。

hold は 180 秒で `approval_pending`（403、approval id 付き）を返して終わる。agent が切断した場合と host が止まった場合も同じ扱いになる。approval の行は残るので、カードは答えられるままになる。後から approve されると、gateway の handler が `egress_allowance`（fingerprint = method、host、path、account、全 body の sha256、10 分、1 回限り）を書き、`sessionLedger.notify` で「承認されたので、同じ request を同じ本文のまま 10 分以内に送り直して」と Session に伝える。reject なら理由付きで伝える。fingerprint に全 body を含めるのは、承認を人が見た内容に結びつけるためである。LLM が本文を作り直すと一致せず新しい hold になるが、それは「人が見ていない本文を通さない」側に倒れた結果として受け入れ、頻度を unit 5 で確かめる（Open questions）。nanoclaw の「host 再起動で全部 deny」は「承認すれば再送で通る」に変わる。hold と approval 行が同じ process にあるので、bridge の障害という失敗の種類そのものが無くなる。

拒否の status は `REFUSAL_STATUS: Record<GatewayRefusal['code'], number>`（haiku から）で、refusal を足して status を書き忘れると compile が通らない。

approval の decide は「行が pending のときだけ遷移する」同期 transaction で、二度押しは何もしない。kind ごとの handler は commit の後に走り、`handledAt` で完了を記録する。handler の途中で落ちても起動時に再実行される（handler は冪等に書く。per make-operations-idempotent）。

### 5. gateway での agent の身元

container が持つ credential は Session Token 1 つだけである。container incarnation（spawn 1 回）ごとに 32 byte を作り、`container.token_hash` に sha256 だけを保存し、平文は container の env（`HTTPS_PROXY` の basic password と `KURUMI_TOKEN`）にだけ置く。scope は Session で、Agent Group は Session から導く。grant は group 単位で引き、承認カード、egress log、通知は Session 単位で扱う。型 `AgentPrincipal` は session の contract entry にあり、account と gateway は session の server entry を import せずにこれを受け取れる。

lifetime は container 行と同じである。host が再起動しても hash は DB にあり、Agent Port は固定 port なので、adopt された container はそのまま認証を通る（monica の boot ごとの token と port 0 はここで捨てた）。container が reap されると行が消え、同じ瞬間に proxy と RPC の両方で token が失効する。開いている tunnel も内側の request ごとに認証し直す。Agent Group を消すと FK の cascade で session、container 行、grant が消える（why Change 6）。

### 6. package 構成と monica の規約

package と entry と依存の向きは `module-map.md` に書いた。domain は agent、access、chat、approval、session、schedule、account、gateway、console、slack で、domain を持たない package として rpc、ui、job がある。credential の知識（誰がどのアカウントのどの service を使えるか、どう選ぶか、どう更新するか）は account に、通信の知識（tunnel、TLS、rule、hold、log、admission）は gateway に分けた。gateway は account の `credentialFor` だけを呼ぶ。

router は 1 つである。各 domain は `implement(contract).$context<KurumiContext & { <d>Ledger }>()` で自分の router を作り、host が `guardRouter<HostContext>().router({ agent, access, chat, approval, session, schedule, account, gateway, console, slack })` で package 名の下に mount する。oRPC は builder の middleware を `.router()` に渡した全 procedure に付けるので、guard はここで全 procedure の前に入る（`packages/rpc/src/server.ts` の `guarded`）。CLI（host）、Console（human）、container（agent）のどれもこの 1 つの router を呼び、違うのは transport が決める `caller` だけである。

guard の約束は型と middleware の両方で表した。`guarded` は caller が agent で `meta.agent` が無ければ handler の前に `FORBIDDEN` を投げる。この判定は approval が注入する `Guard` より前に rpc の中で行うので、`Guard` の実装を誤っても「meta が無い procedure に agent が届く」ことは起きない。それ以外の判定（CLI Scope、`own-group`、`hold`、`humanHold`）は approval の純関数 `verdict` が行い、hold は `pending_approval` 行を書いて `APPROVAL_PENDING` で返る。承認されると host の `replay` が同じ router を、approval id を `grant` に入れた context で呼び直す。domain は guard を呼ばず、contract の `meta` で宣言するだけである。`guardRouter` を通さない router の mount は host に無く、domain が `@orpc/server` の `os` を使うことは lint で止める。

monica から外したもの:

| monica の規約 | kurumi | 理由 |
|---|---|---|
| 孤児自殺（ADR-0007） | 使わない。SIGTERM でだけ止まる | launchd 配下では最初から ppid が 1 |
| 遅れた Job を飛ばす（ADR-0016） | Scheduled Task は再起動後に 1 回だけ走らせる。inbound は pending に残す | Slack の message や定期 Task を落とせない |
| boot ごとの token と backend.json、port 0 | host CLI は 0600 の socket（token 無し）、container は DB に hash を持つ Session Token と固定の Agent Port | container は数日生き、host の再起動をまたぐ |
| loopback だけに bind | Agent Port は container が届く address（毎回 probe で確認）。web は loopback のみ（OAuth は Mac の前でだけ行う） | container と OAuth の callback がある |
| user Job（shell の cron） | 持たない | 定期実行は agent の Scheduled Task が担う |
| Shell への stdout JSON 行 | 無し。通知は channel で届ける | Shell が無い |

そのまま使うもの: entry の切り方、一方向の依存と isolated linker、domain ごとの Ledger（`start / stop / events` + `tx` 第 1 引数の同期メソッド）、package ごとの migration 履歴 table、EXCLUSIVE + WAL、同期 transaction と await 後の読み直し、子 process の作法、login shell の PATH 回復、DB を fake しないテスト。

### インターフェースの深さ

いちばん深いのは `credentialFor(principal, target)` で、引数 2 つの裏に grant の検査、selector の形、アカウント選択の規則、復号、refresh の single-flight、needs_reauth への遷移が入っている。gateway はこのどれも知らない。`connect` は agent から見ると引数 1 つの tool で、裏に state machine、approver の検査と 1 回限りの link、OAuth、PKCE、scope の和集合、カードの作成と書き換え、Session の再開がある。session と gateway の境界は `egress.contribution`、`egress.admission`、`probe` の 3 関数で、OneCLI の seam（`ensure`、`subscribe`、`connect`、`availability`、lease）より小さい。

### red flag の自己点検

- 浅い module: `ApprovalLedger.request` は approver の解決と焼き込み、宛先の決定、DM 解決を隠し、呼び手は kind と本文を渡すだけ。7 package にあった `declare const router: unknown` は、procedure 名と meta を持つ typed contract と router に置き換えた。
- 情報の漏れ: vendor と service の知識（host、slot、scope、selector の形、要約、container env、grant の CHECK）は `catalog.ts` の 1 object にまとめた。gateway は catalog を読まず、account の server entry が出す `serviceFor`、`interceptedHosts`、`summarizeRequest` だけを使う。wire 型（Slack SDK、node:http）は adapter と gateway の中に閉じ、公開型は `InboundEvent`、`Card`、`CardActionReply`、`Request/Response` だけにした。account は session の server entry を import しない。
- 状態の分有: grant は `account_grant` 1 table。connection と link は account だけ、approval の行は approval だけ、inbound / outbound は session だけが書く。`account_grant.vendor` と `default_account.vendor` はアカウントの vendor の写しだが、複合 FK が一致を DB で強制するので、ずれた行は書けない。
- 同じ仕事の 2 通りの手段: アカウントの名指しは slot の selector だけで、header は無い。`selectorShape` は同じ slot の中の形を vendor ごとに変えるだけで、2 本目の経路ではない。tool の一覧は contract からの導出だけ。agent が host に頼む経路も RPC だけ。
- 手で同期するリスト: vendor / service は 1 object（ServiceId 型、zod の enum、CHECK の SQL はそこから導出）、channel は host の `adapters()` 1 か所、card owner は `CardOwnerSchema` から型を導き、approval kind・card owner・refusal status は union で閉じた `Record` なので書き忘れは compile error になる。migration の順序だけは host の配列で手書きになる（monica と同じ）。
- 外から import できる内部: `catalog.ts`、`select.ts`、`connect.ts`、`forward.ts` は entry に出さない。lint の entry 境界 test を monica から写す。

## Synthesis decision

4 つの候補（opus、fable、sonnet、haiku）を同じ課題で並行に作り、fable の審査役が匿名のラベルで採点した。opus 案を base にした。審査役の採点（29 点）と orchestrator の読みが一致した。

**base を opus 案にした理由**

- 拡張点が contract の `meta` 1 か所で、guard、CLI command、agent の tool がそこから導かれる。`meta.agent` の無い procedure は agent から拒否されるので、書き忘れが「開く」方向に倒れない。
- credential material の出口が `credentialFor` 1 つで、返す `Injection` は closure に閉じて `toJSON` が throw する。
- 1 process で、決定 3（1 つの SQLite）と monica の Backend の形に最も近い。
- 承認の hold が切れた後も、`egress_allowance` と Session への通知で「承認すれば再試行が通る」。

sonnet 案は 28 点で僅差だった。base にしなかったのは、2 process（kurumid と proxyd）が request ごとの IPC、CA 鍵の受け渡し、launchd job 2 つという可動部を足すためである。sonnet 自身も「spike が通らなければ 1 process に戻す」と書いている。

**4 候補が独立に収束した点（強い合意として採る）**

- container は SQLite を開かない。mailbox（`inbound.db` / `outbound.db`）をやめ、container が client の HTTP long poll にする。
- container の身元は Session 単位の token で、DB には hash を置き、host 再起動をまたぐ。
- grant は 1 表で、既定は付与なし。アカウントの選択は純関数で行う。policy はアカウントを選んだ後に評価する。
- **gateway 側に MCP server は置かない。** 接続は host への既存の通信路の上の tool にする。

**graft**

- sonnet から:
  - vendor / service のアカウントモデル（Google は 1 行、付与は `(group, account, service)`）。
  - 接続リンクの認可（押した人が承認者かを確かめ、1 回限りで 5 分のリンクを渡す）。
  - 承認者を承認の行に焼く方式。
  - spike で確かめた事実（Bun の MITM、Docker の到達性、unix socket は不可）。
- fable から:
  - 起動時の probe container（container から Agent Port に届くまで admission を開かない）。
  - vendor ごとの `selectorShape`。
  - `service ⊆ account.services` の検証。
- haiku から:
  - `REFUSAL_STATUS` の網羅的な Record。
  - 承認カードの宛先を決める純関数 `cardTarget`。

**移植しなかったもの**

- proxyd の 2 process 構成。forward の engine を関数 1 つに閉じ、後から切り出せる形だけ残した。
- 2 つ目の grant 表（`secret_grant`）。
- 汎用の `action.invoke` と、文字列で dispatch する `system.request`。
- `X-Kurumi-Account` header による選択。credential slot と 2 通りになるため。
- `port: 0`。container の env に焼いた port が再起動で変わる不具合になる。
- `Provider = string`。
- nonce を含まない接続リンク。
- `host_lease`。

**注記**

opus の runner は、runner に見せない採点基準（rubric）を誤って一度読んだと自己申告した。審査役には D の prose をその前提で割り引くよう伝え、審査役は中身で採点した。

## Tradeoffs accepted

- gateway の不具合や file descriptor の枯渇が host 全体を止めうることを受け入れ、代わりに hold と approval、grant と注入が同じ process と同じ transaction にあることを得る（why Risk 1）。対策は Agent Port の接続数上限と、container が host 再起動を生き延びて再接続すること。forward の engine は関数 1 つに閉じてあるので、後から別 process に出せる。
- 復号した credential が orchestration と同じ address space に乗ることを受け入れ、代わりに container に入らないこと（本当に守るべき性質）を、別 process の管理 API なしで満たす。
- container から host の RPC に届くことを受け入れる（why Preserve 5 を文字どおりには満たさない）。nanoclaw も `outbound.db` の `cli_request` で同じ能力を container に与えていた。違いは、口が Session Token で認証され、guard が全 procedure にかかり、credential material を返す procedure が存在しないことである。
- 名指しの手段を slot の selector 1 つにしたので、token を設定できず proxy の header だけで済ませたい client は既定アカウントに頼るしかない。その代わり「どの header を使うか」を agent と skill に教える必要が無くなる。
- 既定アカウントは人が明示したときだけ効く。2 つ目の Gmail を付与した group は、既定を決めるまで名指し無しの呼び出しが 409 になる。黙って選ぶより良いと判断した（why Preserve 8）。
- handle は `<vendor>/<label>` で読みやすいが、label（email）が変わると handle も変わり、他 group の handle を推測はできる（推測しても拒否される）。sonnet の不透明な grant handle は採らなかった。2 通りは作らない。
- MITM するのは service の host と、method / path を見る rule が名指しした host だけで、他は tunnel にする。未知の host の 401 を actionable な error に書き換えることはやめ、代わりに CPU、cert pinning、WebSocket の問題を減らす。
- 接続は approver しか始められない。Slack の channel で一般 member が自分のアカウントをつなぎたい場合も、approver に頼む必要がある。
- 承認後の再送は全 body の一致を要求する。LLM が本文を作り直すと、もう一度承認が要る。
- 起動のたびに probe container を 1 つ走らせる（数秒の遅れ）。代わりに「container が gateway に届かないのに admission が開いている」状態を無くす。
- 送信ファイルを outbox ディレクトリから RPC upload に変えたので、50 MiB の上限ができる。

## Alternatives considered

- **mailbox（inbound.db / outbound.db）を残す.** VirtioFS とも EXCLUSIVE とも両立はする。退けたのは、host が敵対的な SQLite file を parse すること、状態を 2 つの file と中央 DB に分けて写し合うこと、poll と `on_wake` の複雑さが残ることのためである。interface は「file の schema」という最も広い面になり、container 側の実装が host の table 形を知る。
- **gateway を別 process にする（sonnet の proxyd）.** host 再起動中も in-flight の LLM stream が続く利点はある。退けたのは、request ごとの IPC の往復、CA 鍵の受け渡し、launchd job 2 つ、冪等 key に boot id を含めるといった可動部が増えるためである。engine は `forward` に閉じてあるので、計測で必要になれば切り出す。
- **header による選択（`x-kurumi-account` + 409）.** 全 HTTP client に custom header を要求し、付けられない SDK では選べない（how.md §10）。slot の selector なら、token を設定できる client はすべて選べる。header と slot の両方を持つ案は「同じ仕事の 2 通りの手段」になるので採らない。
- **provider ごとに 1 行のアカウント（base の元の形）.** 同じ Google に Gmail と Calendar で 2 回同意させ、Group 2 の「Gmail B + Calendar A」を別々の行の付与で表すことになる。vendor / service に分けると、1 行のアカウントの service ごとに付与でき、refresh も 1 本になる。
- **grant を account 単位にして service の部分集合を持つ（fable の形）.** JSON の部分集合は FK と PK で既定を表せない。`(group, account, service)` の行にすると、既定が複合 FK で閉じる。
- **Agent Group 単位の token（OneCLI の `aoc_` と同じ）.** host 再起動では安定するが、承認カードに元の chat を出せず、container を殺しても token が生き残り、Session ごとの log も取れない。
- **gateway 側の MCP server で接続する.** 前節のとおり、2 つ目の認証、gateway が chat を知ること、tool の定義場所が 2 つになることのため退けた。
- **カードに URL を載せる（base の元の形、fable の nonce 無し link）.** 共有 channel の誰でも自分のアカウントを group につなげる。action → approver 検査 → 1 回限りの link に変えた。
- **guard を各 domain が呼ぶ（nanoclaw の `runGuarded`）.** 書き忘れた procedure が開く。host が composed router 全体に middleware を 1 つ置く形にした。

## Implementation reconciliation

- P10 `apps/host/src/main.ts` and `driver/docker.ts`: SIGTERM and SIGINT detach the host instead of cleaning up. Running agent containers and their rows stay for the next host to adopt; the driver removes only containers that are still starting, ends its own `docker wait` and `docker events` processes, and cleans up the probe. The driver's `stop()` keeps its full-teardown meaning because `docker.test.ts`, outside the Files box, relies on it; the host calls the new `detach()`. The host installs its signal handlers before startup, so a signal that arrives while it starts waits for startup and then stops it. This supersedes the P09 lines below where they say the host removes containers on shutdown.
- P10 `session/server.ts` and `reconcile.ts`: `authenticate` accepts only an incarnation this host created or adopted, kept in an in-memory registry, so a container that an earlier host started keeps no valid token until a listing adopts it. The Agent Port binds only after the first pass whose `docker ps` answered and whose every decision applied (`adopted()`), because a runner refused with 401 exits for good. Adoption records the incarnation before the driver starts its `docker wait`, so a pass that fails partway can retry without a second driver adoption. The pass is one loop in `createSupervisor`: it waits the interval between passes, wakes early on a `docker events` line or a resubscription after a loss, and until the first clean pass retries from 250 ms (or the interval, if shorter), doubling to the interval. No probe can open admission while Docker cannot be listed, so the wait costs nothing. The CLI socket does not wait for it. `stop()` no longer revokes: parked and new channel calls get 503 so runners retry, and the rows stay. Shutdown is not a reap.
- P10 liveness: the P09 runner never calls `heartbeat`, so every authorized channel call (each pull's arrival, complete, post, heartbeat and state) counts as a sign of life, and so does the end of a successful create. The registry measures silence in time the host was running: each gap between two observations (a channel call or a pass) counts for at most three intervals. A suspended laptop, a stalled event loop or a clock step therefore adds at most that much silence, whichever way `performance.now()` treats suspend, and a host that stalls again and again still reaps a container that never calls. A gap longer than three intervals while the host is awake, for example a `docker ps` that takes the full driver timeout with a short interval, makes reaping late, never early. A running container is stale when it has been silent longer than `KURUMI_STALE_AFTER_MS` and no tool deadline from `heartbeat` is pending. Adoption carries over a pending `tool_deadline_at`. The limit defaults to 30 minutes, after nanoclaw's absolute ceiling, and must be at least 30 seconds. The host refuses to start unless the limit is at least 25 seconds (the long poll) plus three intervals, so one stall cannot reap an idle runner. `KURUMI_RECONCILE_INTERVAL_MS` sets how often the pass runs; it defaults to 10 seconds, or less when the limit needs it (1333 ms for a 30-second limit). Both are parsed in `main.ts` because `config.ts` is outside the Files box.
- P10 `docker events`: one subscription per driver, with one listener, filtered by the install label and the create, die and destroy actions, in 60-second windows (`--until`). An orphan left by a host killed with SIGKILL therefore lives at most 60 seconds. After a subscription that ran for at least one second, the next one resumes with `--since` from one second before that subscription started, so a clock difference between the host and the daemon smaller than the window loses no event, and a replayed event only wakes one more pass. An exit 0 after at least one second is the end of a window and resubscribes at once. Any other end resubscribes after 1 second, doubling to 30 seconds. Durations use the monotonic clock; only `--since` and `--until` use the wall clock. A subscription counts as subscribed only after it has run for one second, and only a subscription after a loss wakes the gap pass. If the daemon clock runs more than a window ahead of the host, every window ends at once and the stream degrades to the 30-second retry, with the periodic pass still covering state. `detach()` waits for the killed events process. Exits of supervised containers still come from their `docker wait`. The stream and the gap pass catch containers without one: late creates, hand-made containers and rows no host has adopted.
- P10 adoption and leftovers: a row claims only the container whose name its container id derives, and adopts it only when its labels match the row and the driver's `kurumi.revision` label matches. The driver stamps the revision at create, next to the install label. The host derives it from the agent image name, the egress object that `contribution()` returns (Agent Port URL, mounts and network), and the bytes of `runner.js`. A restart after any of them changed, including a runner rebuild, therefore replaces the container instead of adopting a runner that cannot reach the host or runs old code. An image rebuilt under the same tag is still adopted; tag a new image to roll one out. Containers from P09 carry no revision and are replaced once. A pass removes every container with this install's label that no live row claims, whatever its role label (agent, probe or none), so a stray that copies a row's labels is removed. A listing leaves out the driver's own probe and names whose removal is in flight. `session.container.stopped` is logged after the removal succeeds. A `stopping` row of an active session is cleaned up by the per-session spawn path; for a session that is no longer active, the pass retries the cleanup.
- P10 unconfirmed creates: a sweep settles a create that ended without a daemon answer once a listing starts after the CLI ended. Cleanup then removes the container if the daemon made it, and a later pass removes one that appears even later. A `docker create` that exits 2 now counts as ended without an answer, because Go's runtime exits 2 on SIGQUIT and SIGABRT. This closes the P09 notes on unconfirmed names and exit 2. Every docker command except `create` and `wait`, which last as long as their container needs, is now killed after `timeoutMs`.
- P10 orphan waits: a host killed with SIGKILL leaves its `docker wait` running for as long as the container lives (about 29 MB each, measured on Docker 29.6.1). After the adoptions of one pass, one `ps` scan ends every `docker wait <name>` for an adopted name whose parent is not this host.
- P10 lock: adoption reads only the flock and the Docker listing. The pid in `kurumi.lock` is never treated as a live owner, and `lock.ts` is unchanged.
- P10 module layout: `list()` is superseded by `sweep()` and has no production caller, but `docker.test.ts` and `testing.ts`, both outside the Files box, still use it. `driver/docker.ts` is at 998 lines and `driver/conformance.test.ts` at 1373, because the Files box allows no new module or test file. A later PR should move the inventory and the events stream into their own driver module, move the fake daemon next to `FakeCli` with its tests, and delete `list()`. The reconciliation pass itself lives in `reconcile.ts` (`planReconciliation` and `createSupervisor`), not in the ledger.
- P10 logs: `host.start` (pid, `timeOrigin`, `monotonicMs`), `session.adoption.done` (counts, written once Docker answered), `session.container.adopted`, `.stopped` and `.reaped` (name, session id, container id, reason), `session.events.subscribed` and `.lost`, and `session.reconcile.failed`. `monotonicMs` is `performance.now()` in the host process; add `timeOrigin` to compare with another process.
- P10 verification: trunk at P09 also keeps serving a line through the old container after `kill -9`, because its row and token survive. Container id and reply alone therefore do not separate trunk from this PR in lane 1, and after `kill -9` the restart-to-reply time ties at about 0.31 s on both, set by the runner's reconnect backoff, which retries 100, 300 and 700 ms after its connection breaks. The plan's baseline, where trunk starts a new container, holds for a SIGTERM restart: trunk 0.73 s against 0.30 s here (medians of 5, measured). The separation after `kill -9` shows when the container is then killed: this PR starts a new one, while trunk leaves the row running and the next line unanswered. In lane 7 the killed container is reaped through its `docker wait`, and the gap pass finds nothing left.

- P09 fix-forward 2 `driver/docker.ts`: the driver starts every docker CLI in its own process group, so a signal sent to the host's process group, such as Ctrl-C in a terminal or `kill -TERM -<pgid>`, does not reach it. A service manager that signals every process in the host's cgroup, such as systemd's default `KillMode=control-group`, still reaches it; when a create is in flight the rule below then makes stop reject, and a `docker wait` it reaches reports its container as exited with code -1. Stop and probe abort wait for the create CLI to exit, and treat an exit code from 0 to 128 as the daemon's answer. A CLI ended by a signal exits with no code or above 128 and no answer, and the daemon can still create the container afterwards (`docker create` sent SIGTERM or SIGINT 20 ms after start left a `created` container in 9 of 10 trials). The wait is bounded by `timeoutMs` (10 seconds by default); when it expires the driver kills the CLI. In both cases the name stays unconfirmed: the driver runs no `rm` on it, `kill()` and `stop()` reject with cleanup unconfirmed, and the driver does not replace that container. A CLI exit from 1 to 128 after a dropped daemon connection, and a CLI result that rejects instead of exiting, still count as settled. This PR does not check an unconfirmed name again; P10's reap by install label clears it. A host that dies without running stop leaves its in-flight docker CLIs running and a create among them can still leave a container for P10's reap. For SIGKILL to the host's pid or a crash this was already true; detaching extends it to signals delivered to the whole group, such as a terminal hangup's SIGHUP. When `rm` answers `removal already in progress`, the driver polls for absence for up to another `timeoutMs`, so stop can take about twice the bound. This supersedes P06's create-abort cleanup rule below.
- P09 fix-forward 2 `apps/host/src/main.ts`: SIGINT stops the host the same way as SIGTERM, so Ctrl-C in a terminal runs the driver's cleanup instead of exiting at once. A repeated SIGINT or SIGTERM during shutdown does not end the host early. This supersedes the 孤児自殺 row's "SIGTERM でだけ止まる"; Signals the host does not handle, such as SIGKILL, SIGQUIT and SIGHUP, end it without cleanup.

- P05 `forward.ts`: upgrade は通常の request と宛先検査と注入の準備を共有する。WebSocket の GET だけを受け、body を指定する handshake は 400 にする。hop header を除いてから Connection と Upgrade を設定し、両側の head byte を送って pipeline につなぐ。upstream の拒否は status と body を返す。
- P05 `testing.ts`: P04 の raw header と upload の fake を保ち、`startFakeStreamUpstream` を同じ testing entry に追加した。Bun の native WebSocket echo と close code、送信 byte を数える `/sse?bytes=N`、`/sse-idle?ms=N`、`setSseResponse(path, body)`、`/stats` を持つ。呼び手は upstream と gateway を別 process で起動でき、両方の helper が PID を出す。計画の 200 MB は 209,715,200 byte（200 MiB）として扱う。
- P05 ALPN test: CI と host の `/usr/bin/curl` を使う。`--http2-prior-knowledge` は curl 8.10.0 未満なら h1 の 200、それ以降なら ALPN 不一致による TLS error を検査する。h2 専用の client を h1 に変換するものではない。container の curl lane は P04 と同じ digest の image を使う。
- P04 `port.ts`: CONNECT の socket に `TLSSocket` を被せる sketch を、host ごとの loopback `tls.createServer` と `stream.pipeline` に替えた。TLS listener は host ごとに共有し、復号後の `http.Server` は tunnel ごとに作る。loopback の送信側と受信側で TCP の address と port の組を照合して元の token と CONNECT の行き先を結び、TLS の byte を送る前に登録する。各 request で同じ token を認証し直す。listener は停止まで保持し、24 時間後の新しい tunnel には更新した leaf を渡す。
- P04 `forward.ts`: sketch の Fetch Request/Response を Node の request/response stream に替えた。`inject` は型を固定しない principal、CONNECT の host/port、method、正規化していない path、hop header を除いた `Headers`、元の `rawHeaders` を受け、path と headers を返す。`rawHeaders` は P12 の slot header の重複検査に残す。絶対 URL の request target と CONNECT に一致しない Host は 400 にする。`credentialFor`、service が null の拒否、slot の重複拒否、slot 外の selector、`/batch`、Basic piece rule の削除は P12 に残す。
- P04 `forward.ts`: upload は `PassThrough` を介して pipeline に渡す。upstream の接続失敗で pipeline が client socket まで破棄し、502 の JSON を送れなくなるのを防ぐため。body の framing は元の request から再設定し、GET や DELETE の chunked body も保つ。client の Connection の指定は注入前に除き、注入後の credential を消させない。response も stream で返し、302 は追わない。upstream の接続は `agent: false` で request ごとに閉じ、idle socket を残さない。latency の判定は root の perf lane が行う。
- P04 `package.json` と `testing.ts`: `./server` は Files box にある `port.ts` に直接割り当て、`server.ts` は作らない。root の devDependencies に `@kurumi/gateway: workspace:*` を足し、isolated linker でも `lane/` の script が testing entry を名前で import できるようにする。testing entry は Agent Port、別 CA の fake upstream、leaf 作成を単独で起動できる。fake.test の解決は host 名に一致する `forward.upstream` で TCP の address/port と信頼する CA だけを替え、Host と TLS の検証名は CONNECT に保つ。testing の Agent Port は既定で `0.0.0.0` に bind し、PID と CA PEM を返す。
- P04 live lane 9: host ごとの TLS listener は最初の CONNECT で作り、Agent Port の停止まで保持する。fd の比較は対象 host に 1 回接続して閉じてから baseline を取り、50 本の client をすべて閉じた後と比べる。cold start 直後の fd 数には host listener がまだ含まれない。
- P04 live lane 10: 計画の `openssl s_client` の例には proxy 認証が無いため、そのままでは 407 になる。SNI の不一致を調べるときは `-proxy_user s -proxy_pass pass:<token>` を足す。コード準備の回では self-proof と live/perf lane を実行せず、SNI の観察結果は root の lane 10 が Open questions に記録する。
- P01 `catalog.ts`: default の `selectorShape` は label を `encodeURIComponent` で percent-encode し（`/`、`@`、`:` は戻す）、`kurumi:` を付ける。`parse` は prefix を大文字小文字を区別せずに読み、percent-decode する。HTTP の header の値は Latin1 の範囲しか持てず、日本語の label は Bun の `Headers` が投げ、curl で送ると文字化けで届く。query では `&`、`#`、`+` が値を切るため。`+`、`&`、空白、`%` を含む label は `selector` を写した文字列と手で書いた文字列で形が違う（`a b` は `a%20b`）。query の slot での読み方は `select.ts` の行に書く。`parse` は、どの vendor でも `kurumi:` の形を読み（anthropic の `x-api-key` に `kurumi:anthropic/b` と書いても名指しになる）、`sk-ant-kurumi-` の形は anthropic の shape だけが読む。他の vendor の slot に書いた `sk-ant-kurumi-` の形は語を含むので拒否される。prefix は両方とも大文字小文字を区別しない。
- P01 `catalog.ts`: `SelectorShape.parse` は、値が 2 つの形のどちらか（`kurumi:` に percent-encode した handle が続く形、`sk-ant-kurumi-` に正規の base64url が続く形）で始まり、残りが decode できるときだけ handle を返し、それ以外は `null` を返す。prefix を持つのに壊れた値（`kurumi:`、`kurumi:%E0`、base64url が正規でない値）も `null` である。残りに 2 つ目の selector や語が入っていないか（`kurumi:google/a, kurumi:google/b` は handle `google/a, kurumi:google/b` になる）は `parse` では見ず、`readSelector` が handle の語で拒否する。`null` の値を placeholder として無視するか拒否するかも `readSelector` が決める（次の `select.ts` の行）。
- P01 `catalog.ts`: `HostRule.host` は完全一致だけにし、`*.example.com` は持たない。使う service が無く、`interceptedHosts()` の集合に載せられないため。host は `normalizeHost`（小文字、末尾の `.` を除く）で比べ、port は hostname に含めない。`isInterceptedHost` を足して、gateway が `serviceFor` と同じ比べ方で MITM の可否を決められるようにした。
- P01 `catalog.ts`: Gmail は `www.googleapis.com` の `/upload/gmail/`、`/resumable/upload/gmail/`、`/batch/gmail/`、Calendar は `/batch/calendar/` も `pathPrefix` に持つ。discovery document の `mediaUpload` と `batchPath` の path が service の path の外にあるため。
- P01 `catalog.ts`: `serviceFor` は、1 つの service だけが使い、`pathPrefix` の無い rule を持つ host（`api.github.com`、`api.notion.com`、`api.anthropic.com`、`gmail.googleapis.com`、`github.com`）では、path が何であってもその service を返す。`pathPrefix` で service を分ける host（`www.googleapis.com`）では、query を除いた path の unreserved 文字の `%XX` だけを戻して照合し、dot segment、`%2F`、`%5C`、`\`、`;` を含む path は null にする。GitHub は `/repos/o/r/branches/feature%2Fx` のように `%2F` を path に使うので、1 つの service の host で null にすると credential を付けずに転送してしまう。Google は unreserved の escape を戻して route し、dot segment には redirect を返す（`curl --path-as-is` で確認）。path を畳んで読むと Google の解釈とずれる（`..;`）ので、疑わしい path は service を決めない。gateway は注入した credential を付けたまま redirect を辿ってはならない（`redirect: 'manual'`）。
- P01 `catalog.ts`: 照合を `createServiceFinder` に切り出して export した。長い `pathPrefix` が先に合うことを、catalog に無い重なりで test するため。`defineCatalog` は `as const satisfies` に置き換えた。`OAuthSpec.identify`、`ServiceSpec.summarize`、`ApprovalSummary` は P02 と P18 で足すので、この PR の型に無い。`serviceBelongsToVendorSql` は全体を括弧で囲む。
- P01 `select.ts`: `accountHandle(vendor, label)` を足した。`AccountHandle` の brand を付ける場所を 1 か所にするため。
- P01 `select.ts`: `bearer` と `basic` の slot は、どちらも `Authorization` の `Bearer`、`token`、`Basic`（password）から selector を読む。`gh` や Octokit は `api.github.com` に `token` か `Bearer` を送り、git は `Basic` を送るため、slot を 1 通りに決めると名指しが黙って無視される。default が複数あるときは、最初の行を取らず `account_ambiguous` にする。
- P01 `select.ts`: selector は形ではなく `kurumi` という語で見分ける。slot の値がこの語を含むとは、書かれたままの値か、`decodeURIComponent` で 1 回 percent-decode した値が、大文字小文字を区別せずに `kurumi` を含むことをいう。query の値は `URLSearchParams` と同じく `+` を空白にしてから decode する。decode できない値（壊れた escape を持つ値）は、書かれたままの形だけを見る（`URLSearchParams` なら残りを decode するが、ここでは壊れた escape が 1 つあれば decode した形は見ない）。Basic の credential は、空白を除いた全体を base64 として decode した `user:password` も、その percent-decode も見る。この decode は Buffer の緩い decode で、標準と url-safe のどちらの alphabet も、`=` の過不足も受け入れるが、コンマは読み飛ばし、最初の `=` の後は読まない。同じ header が 2 本つながると credential にコンマが入り、2 本目は base64 のままなので、credential が 1 つの base64 でない（空白を除いて base64 以外の文字を持つか、`=` の後に base64 が続くか、header に空白に囲まれた `Basic` がもう 1 つある）ときは、piece ごとにも見る。piece とは、コンマ（直後に空白 1 つ、`Basic`、空白 1 つが続けばそれも含む）か、空白に囲まれた `Basic` で区切った field から、先頭の `Basic` と空白を除き、末尾以外の `=` の連続の後で分けたものである。field は先頭から 17 個まで、field の中の分割も 17 個までしか見ず、piece が 17 個以上になる credential は語の有無を見ずに拒否する（黙って default に落とさない。これは「どの値も語を含まなければ `none`」の例外である）。8 文字以上の piece を先頭から 16 個まで decode して語を探す。7 文字以下の piece は 6 byte の語を持てない。全体を decode した文字列も語を探す view に残す（コンマで語を 2 つに割った値はそこでしか見えない）が、`written` には載せない。これ以外の見方（Basic の credential の外の base64、decode した Basic の中の base64、escape を 1 つずつ戻す decode、Kelvin 記号のような似た文字、scheme の無い値の先頭の語の除去）はしない。それらでしか見えなかった値、たとえば `Bearer` の後に base64 で書いた selector や、`%6Burumi:…%E0` のように壊れた escape と並んだ値、Basic の blob の前に base64 の文字か空白を 4 の倍数でない数だけ置いて decode をずらした値（`Basic Bearer <base64>` のように scheme の語を重ねた値も）、語の base64 を 2 本の header の境目で割った値は `none` で、default の account が使われる。blob の前に base64 以外の文字を置いた値は piece の経路で語が見え、拒否される。selector を書かなかったのと同じ結果なので、他の account には当たらない。実装は、語の文字の escape（`%6B` など）を持たない値では percent-decode を省く。decode で語が現れるのはその escape のある所だけなので、結果は変わらない。1 回の判定は、plan の 20 µs の p99 を、round 4 の bench の値（代表的な値と、語の文字の escape を持たない 8 KB・16 KB の Bearer の値）と、decode した bytes が ASCII に近い 8 KB までの 1 つの base64 の Basic（約 11〜15 µs）と、コンマだらけの 8 KB の Basic（約 11 µs）で満たす。それを超えるのは次の値で、数字はすべて owner-fix4 の bench（`evidence/p01/owner-fix4/scripts/decide.bench.ts`）の p99 である。decode する view ごとの 1 回の `decodeURIComponent`（語の文字の escape を何千個も持つ Bearer の値で、8 KB で約 21 µs、16 KB で約 17 µs）。Basic の blob の base64 decode と `toString`（ASCII に近い 16 KB で約 29 µs。decode した bytes が乱数や壊れた UTF-8 だと置換文字の分だけ増え、乱数の 8 KB で約 44 µs、壊れた 16 KB で約 100 µs）。Basic の中の何百もの空白の除去（1 つの base64 の 8 KB で約 22 µs）。1 つの base64 でない Basic は、全体の decode に加えて piece を 16 個まで decode するので、base64 以外の文字と空白を散らした 8 KB は約 119 µs、16 KB の空白や `=` の連続は約 32 µs と約 39 µs、語の文字の escape を詰めた 16 個の piece（16 KB）は約 159 µs である。piece を切る pattern はどれも 1 文字の連続に対して線形で、連続の長さの 2 乗では増えない（test が 16 KB の連続で確かめる）。本物の第三者の credential はこの語を含まないので、SDK の placeholder や本物の token は拒否されない。slot のどの値も含まなければ `none` で、slot は空にして返す。1 つでも含めば、agent が account を名指ししたと見なし、次の条件がすべて揃うときだけ読む。slot の値がちょうど 1 つであること。その値が、slot が credential を置く場所（`Bearer` か `token` と 1 つ以上の空白文字（tab も）の後、Basic の password、header の値の全体、query の値の全体）に、その vendor の shape か `kurumi:<handle>` の形の selector をちょうど 1 つ置いたものであること。Basic は、credential が上の意味で 1 つの base64 で、decode した文字列にコロンがあり、user が語を含まないときだけ password を読む。コロンの無い Basic は拒否する。できた handle が語を含まないこと。それ以外はすべて拒否し、`none` にも他の account にもしない。拒否は `Selector` の `unreadable` で、語を含む値だけを `written` に持つ（語を含まない値、たとえば隣の本物の key は載せない）。Basic の値は、1 つの base64 なら語を含む decode した `user:password` を、そうでなければ語を含む最初の piece の decode を載せ、どれも語を含まなければ header の値をそのまま載せる。`selectAccount` はこれを `account_not_granted` にし、`named` に書かれた文字列、`granted` に group の handle を載せる。P12 は、handle の名指しが未付与の場合と読めなかった場合を区別せず、「`<named>` という account は無い。credential の場所に `kurumi:<granted の handle>` を 1 つだけ書く。granted は …」という 1 つの文面で足りる。header は 1 つの値として読み、コンマは label の一部である（`Bearer kurumi:notion/Acme, Inc.` は label `Acme, Inc.`）。同じ header が複数あるとコンマでつながって届くが、つながった値（`Bearer kurumi:notion/a, Bearer kurumi:notion/b`、`Bearer placeholder, Bearer kurumi:notion/a`、`a` を 2 回）は、label が語を含むか、credential の場所が selector でないので拒否する。Basic を 2 本つないだ値は、語の base64 が header の境目で割れていなければ、piece を decode すると語が見えるので拒否する。Bearer の後に Basic をつないだ値（`Bearer placeholder, Basic …`）は Bearer として読むので、2 本目の base64 の中の語は見えず `none` になる。2 行で届けば下の「同じ header が 2 回届く」限界として gateway の事前の確認が止めるが、1 行にコンマで書いた値はその確認を通る。見えない値の 1 つとして残る限界である。query の slot の値は、`%2F` を含むなら再 encode された値として先に percent-decode して読み、含まなければ shape が書いたとおりに読んでから、decode して読み直す。handle は必ず `/` を持ち、`format` は `/` を `%2F` にしないが、`URLSearchParams` や axios のような component encoder は `%2F` にするので、`format` の出力をそのまま貼った場合と、そうした encoder が再 encode した場合のどちらも元の handle に戻り、`%` を含む label を 2 回 decode して別の account の handle にすることはない。`/` も `:` も残したまま `%` だけを再 encode する `encodeURI` が書いた値は、貼った形と区別できない。この読む順が、その `encodeURI` の限界そのものである。1 回 decode してから読む定義と結果が違うのは、`%` を含む label と、それを percent-encode した label の両方を grant したときだけで、そのときは `encodeURI` が書いた値が貼った値として読まれる。同じ名前の parameter が複数あれば全部を slot から取り除き、語を含む値があって値が 2 つ以上なら拒否する（どの値も語を含まなければ `none`）。service の slot が別の header（`x-api-key`）でも、SDK は auth token を `Authorization` に送るので、語を含む `Authorization` はその slot の 2 つ目の値として読む（`x-api-key` にも値があれば拒否する）。`Authorization` は他の slot と同じ見方で調べ、Basic の decode も含む。語を含まない `Authorization` は触らない（piece が 17 個以上の Basic だけは、語を含む値として扱う）。限界がある。語を含む label の account は名前で選べない（書いた形が拒否される）ので、label を決める PR（P11、P14）はそれを許すか拒否するかを決める。語を含む本物の credential（`kurumi` という user 名の Basic）も拒否される。JWT の claim に語を持つ Bearer token は、base64 を decode しないので `none` で、以前の head と違って拒否されない。slot の外の場所（`x-goog-api-key`、`?access_token=`、`Proxy-Authorization`）に書いた selector は読まれず、default の account が使われる。同じ header が 2 回届き、2 つ目が語を含まないとき（`Authorization: Bearer kurumi:notion/Acme` と `Authorization: Inc.`）、つないだ値 `Bearer kurumi:notion/Acme, Inc.` は label にコンマを持つ 1 つの selector と区別できないので、gateway は raw の slot header が 2 回以上届いた request を `readSelector` の前に拒否する（P04、P12）。Bun 1.4.3 の `node:http` の `req.headers.authorization` は、2 本の `Authorization` のうち最初の 1 本だけを持つので、gateway（P04、P12）は `req.rawHeaders` から `Headers` を作って `readSelector` に渡す。この事前の確認には raw の header の行が要る。`node:http` は `rawHeaders` で行を渡すが、`Bun.serve` の `Request.headers` はつながった後の値しか持たないので、`Bun.serve` の上ではこの確認を作れない。
- P01 `.oxlintrc.json`: `no-restricted-imports` で、他の package から import してよい entry を `schema`、`contract`、`server`、`ui`、`cli`、`testing` に限り、`src/` の中の import も拒否する。entry の名前を足す PR は `.oxlintrc.json` も直す。
- P01 `scripts/oxlint/kurumi.js`: package の外へ出る相対 path の import は、`no-restricted-imports` の pattern ではなく rule `kurumi/no-relative-package-import` が拒否する。pattern は specifier の文字列しか見ず、`../` が package を出るかは import する file の場所と、行き先が実際にどこにあるかで決まるため。rule は、import する file の directory に specifier を足して `./` と `../` を字句のまま畳み、symlink を辿った先（まだ無い file は、あるところまでを辿る）が、その file 自身の package の中かを比べる。package は `packages/<名前>` と `apps/<名前>` で、それ以外は root の package にまとめる。`scripts/`、repo の root、`node_modules`、他の package、repo の外、symlink の先は、package の外なら拒否する。`../` で出て戻る path と、package の中を指す symlink は通す。畳んでから辿るのは Node、Bun、tsc の解決と同じで、symlink の直後の `..` は畳んだ後の path で読む。rule が拒否するのは、static な `import`、`export … from`、`import x = require('…')`、型の位置の `import('…').T`、および `require()`、`import()`、`import.meta.require()`、`import.meta['require']()` に文字列（か式を持たない template literal）で書いた specifier で、行き先が package の外か、他の package の export していない module のもの。計算した specifier、間接の load（`createRequire`、別名を付けた `require`、`.call`）、別名の経路、lint が見ない file（`ignorePatterns` の folder）は、gate ではなく review が止める。root は oxlint の作業 directory なので、repo の root 以外で動かすと package を判別できず、他の package への import を見逃すことがある。
- P01 `scripts/oxlint/entry-boundaries.test.ts`: `no-restricted-imports` を設定した override は、その file では top-level の設定を丸ごと置き換える。そのため override が top-level の pattern をすべて並べ直していないか、`kurumi/no-relative-package-import` を error 以外にすると test が落ちる。root の `.oxlintrc.json` 以外の oxlint の設定 file が `node_modules` の外のどこにあっても落ちる。nested の設定は root の設定を置き換えるため。対象は oxlint 1.86 が読む名前の `.oxlintrc.json`、`.oxlintrc.jsonc`、`oxlint.config.ts`、`oxlint.config.mts`（実際に置いて確かめた。`oxlint.config.js` などは読まれない）。top-level の `ignorePatterns` が `packages/` か `apps/` の下を覆いうる pattern を持つと落ちる。末尾以外に `/` を含まず repo のどこにでも当たる pattern（`node_modules`、`docs/` など）、`packages` か `apps` で始まる pattern、最初の segment に glob 文字を持つ pattern がそれで、`docs/**` のように別の directory に固定した pattern は通る。root の `.oxlintrc.json` が `extends` を持つか、root の `tsconfig.json` が `paths` か `extends` を持つと落ちる。前者は他の設定で境界を外せ、後者は bare specifier を境界の外に向けられるため。lint や TypeScript の設定を書き換えて境界を外す変更は、この 2 つの guard 以外は review が止める。`exports` が無いか、entry の file path の map でない package は、manifest の path を示して落ちる。
- P02 `catalog.ts`: `identityScopes` は `VendorSpec` でなく `OAuthSpec` に置いた。key で接続する vendor には identity が無いため。`identify` は sketch の `async (accessToken, tokenResponse: unknown)` でなく、解析済みの `TokenResponse` を取る同期関数にした。Google は `id_token` だけで足り、Notion のように応答の別の field で名前が決まる vendor は、その PR で `TokenResponse` を広げる。`TokenResponse`、`Identity`、`IdentifyError` は `OAuthSpec` の型が要るので `catalog.ts` に置く（`oauth.ts` が `catalog.ts` を import するので、逆にすると循環する）。Notion の `identify` は、まだ誰も呼ばないので「未対応」を投げる。
- P02 `oauth.ts`: `OAuthVendorId` は `'google'` だけにした。token の解析は `expires_in` を必須とし、client の渡し方は form の body 固定で、Notion の応答（`expires_in` が無い）と token endpoint（Basic 認証）に合わない。Notion を足す PR が `OAuthSpec` に client の認証方式を持たせて広げる。
- P02 `oauth.ts`: `authorizeUrl` は `mergesEarlierGrant: false` で、catalog の `include_granted_scopes` を外せる。製品の接続は常に付ける。script の `--services` が前の同意と混ざらない新しい同意を取り、`--add` が混ぜた同意を取るために使う。
- P02 `tsconfig.json`: `include` に `packages/*/scripts` を足した。足す前は `bun run check` が `packages/account/scripts/google-consent.ts` の型を見なかった（oxlint は見た）。今は `tsc` がこの script を検査する。script は P14 で消える。
- P02 `fixtures/google/`: JSON でなく `.ts` にした。unsigned の JWT を文字列で commit すると、CI の gitleaks の `jwt` rule が検知するため。`id_token` は読み込むときに claims から組み立てる。
- P02 `google-consent.ts` の `--revoke`: 同じ実行で得た最初の refresh token を 1 本だけ取り消し、その run の refresh token すべてについて、refresh が `invalid_grant` になることを確かめる。Google は 1 本の revoke でそのアカウントと client の grant 全体を終わらせ、同じ grant の別の refresh token の revoke は 400 になるため、2 本目以降は revoke せず refresh で確かめる。token は file にも画面にも出さないので、別の実行へ渡せない。計画の lane 10 の「8 日後の確認に使う 1 本」は、この script では残せない。
- P03 `account/server.ts`: `candidates(agentGroupId, service)` は第 1 引数の `tx` を持たない。1 本の prepared statement は接続に結びつき、`tx` を渡しても使われないため。gateway の `credentialFor` も transaction の外で live に引く。`createAccountLedger` が受けるのは `{ db }` だけで、`vaultKey` などは P11 以降で足す。`createAccountLedger` は作るときに query を prepare するので、`migrateAll` を先に走らせてから ledger を作る。table が無いうちに作ると `no such table: account_grant` で throw する。
- P03 `account/server.ts`: `grant` は throw せず `{ ok: true }` か `{ ok: false, refusal }`（`agent_group_not_found`、`account_not_found`、`service_not_covered`）を返し、`setDefault` は `grant_not_found` を返す。拒否は caller が RPC の error に写す普通の結果で、throw にすると caller の transaction まで rollback するため。`grant`、`revoke`、`setDefault` はどれも 2 回呼んでも同じ状態になる。`revoke` は、その grant に載っていた default も外す（`default_account` から grant への foreign key の cascade）。`candidates` は label の順に返す。
- P03 `account/package.json`: `./testing` も export する。`.oxlintrc.json` の entry の一覧に `testing` があり、`scripts/oxlint/entry-boundaries.test.ts` が export の無い `testing.ts` を内側の module と数えるため。使えるのは `testing-entry` の rule が許す test と `testing.ts` だけ。
- P03 `agent/src/server.ts`: `migrations` の re-export 1 行だけを置く。host が package の migration を引く道は、lint が許す entry の `server` だけだから。残りは P07 が足す。`migrations/index.ts` は sketch の `latest` を持たない。使う側が無い。
- P03 `apps/host/src/db.ts`: `openKurumiDb` に `busy_timeout` を置かない。2 つ目の host は待たず、`PRAGMA journal_mode = WAL` を流す open の途中で `SQLITE_BUSY` になる（最初の query ではない）。`journal_mode` が `wal` にならなければ throw する。`migrateAll` は package ごとに drizzle の `migrate` を呼び、drizzle が自分で `BEGIN` を発行するので package ごとに commit される。そのため migrate の前にも `foreign_key_check` を見て、すでに孤児のある DB を先へ進めない。migrate の後に違反が見つかると、それまでの migration は commit 済みで、DB は違反を持ったまま host を止める。transaction の中で呼ばれると `foreign_keys = OFF` が無効になるので throw する。
- P03 `scripts/oxlint/kurumi.js`: `sync-transaction` が報告するのは、callback が async function、同じ file の async function の名前、または同じ file の async function を呼ぶ式本体の arrow である 3 つの形だけである。それ以外は review が見る。

- P06 `admission.ts`: gateway の system Jobs ができるまでは、controller がキャンセル可能な local timer で完了後から capped exponential backoff を数え、`retry()` を将来の Job と lane 8 の呼び出し口にする。実行中の `retry()` は同じ Promise を返すため、lane 8 は probe の途中に再試行を要求できる。
- P06 live lane: `testing.ts`、gateway の exports、root の dependency metadata は Files box の外なので、lane script は一時的に `packages/gateway/src/admission.ts` と `packages/session/src/server.ts` を直接 import し、既存の `@kurumi/gateway/server` と組み合わせる。Agent Port の bind address は呼び出し側が指定する。Docker Desktop では `127.0.0.1` への到達を live lane で確認したので、PR の lane script はこれを既定にする。Linux での到達は未検証。
- P06 `admission.ts`: stop 後は 5 状態の union を保ち、`unreachable` の `stopped` reason に `Admission stopped` を残す。最後の probe の時刻と所要時間も保持する。
- P06 `docker.ts`: create の通信失敗後も名前を保持し、Docker が応答して同じ名前の削除または不在を確認できたら所有を解除する。Docker が応答しない間は cleanup failure を返し、次の試行で同じ名前を確認する。stop は create と attach の process を中断して cleanup を待つ。自動削除と rm が競合した場合は、不在を確認してから完了する。listener の停止も失敗した場合は、admission が両方の原因を AggregateError に残す。

- P07 `rpc/server.ts`: oRPC 1.15.4 は error の status 202 を拒むため、hold は code `APPROVAL_PENDING`、status 409、data `{ approvalId }` で返す。`guard.test.ts` が 202 の拒否と 409 の応答を確かめる。
- P07 `rpc/server.ts` と `.oxlintrc.json`: procedure の書き込みは同期の `transaction` helper を通す。`guard.test.ts` の compiler probe は通常の Promise return と明示した `void`、`object`、`unknown` の result 型を拒む。値を返さない callback は `undefined` の overload を使い、値を返す callback は `then` property を持てない。`void` に型を消した callback と広い object 型の明示指定は使わず、具体的な戻り値を推論させる。lint probe は文として書いた `(tx) => { void write(tx) }` を `typescript/no-floating-promises` の `ignoreVoid: false` で拒むことと、前記の `sync-transaction` の 3 形を確かめる。それ以外は review が見る。
- P07 `agent/server.ts`: Workspace は `groups/<folder>` を先に排他的に作り、行の insert が失敗したら自分で作った空 folder だけを消す。DB の `folder` は basename のままにし、create/list は絶対 path を返す。folder 作成後から DB commit 前までに process が落ちると folder が残り、同名の再作成は拒む。template と残りの agent 操作は後続 PR に残す。
- P07 `rpc/contract.ts` と `apps/cli/src/main.ts`: `hostContract` に診断用の `db.query` と起動確認用の `status` を置く。CLI は sketch の host 不在時 exit 2 を brief の exit 1 に替え、`status` だけに 750 ms の応答期限を設ける。
- P07 `apps/host/src/fronts.ts`: Bun 1.4.3 に `Statement.readonly` が無いため、`columnTypes` が内部で呼ぶ `sqlite3_stmt_readonly` で書き込みを拒む。PRAGMA は prepare 中にも接続設定を変えるので、診断は呼び出しごとに別の Bun process を起こし、readonly の DB snapshot 上で実行する。SQL の prepare は子 process だけで行い、process 全体に効く PRAGMA も host から隔離する。子 process は 1 秒を上限にし、超過は error にする。SQLite の deserialize に合わせて snapshot の header bytes 18/19 を 1 にし、行を返す最初の statement だけを扱う。`main.test.ts` が WAL の読み出し、書き込みの拒否、host の接続設定と process 設定の維持、blob の転送、子 process の上限を確かめる。
- P07 `apps/host/src/main.ts`: `bun:ffi` の flock で lock を保持し、migration の後に ledger を作る。P07 は Unix socket だけを開き、Agent Port と Web Port の環境変数は検証して保持する。両 listener と追加 domain の router は後続 PR で組み立てる。

- P07 `gateway/src/admission.ts`: `retry()` の scheduler が例外を投げると Promise は reject する。起動時と timer の呼び出し側で reject を受け、既存の `bind_failed`、`probe_failed`、`nonce_mismatch` を保持する。child process の test が両経路で未処理の reject が無いことを確かめる。

- P08 `access/package.json`: the migration-only `./server` entry points to `migrations/index.ts`. The Files box permits the access schema and migrations but does not include `access/src/server.ts`.
- P08 `chat/schema.ts`: an absent adapter instance is stored as `''`, with `null` retained at the adapter boundary. `messaging_group_key` therefore compares no NULL values. `wiring_key` makes the messaging-group and agent-group pair unique.
- P08 `chat/contract.ts` and `chat/terminal.ts`: `terminalAdapter` lives in chat. The shared adapter types live in the contract entry, and text delivery takes `{ id, text }` so a reply retains its durable outbound ID. The terminal procedure requires a host caller and returns an oRPC iterator of `queued` and `reply` events. `follow: false` returns only the receipt; one `follow: true` call can receive replies while later lines use receipt-only calls. A subscriber that buffers 128 replies is disconnected on the next reply instead of silently losing an event. Delivery fails when no subscriber accepts the reply.
- P08 scope includes the minimal dependency and export entries in `packages/session/package.json`, `apps/host/package.json`, and `apps/cli/package.json`, plus `bun.lock`. These paths are missing from the Files box, but Bun's isolated linker needs them to complete the requested integration. No import-boundary rule changes are needed.
- P08 `session/contract.ts`: `AgentPrincipal` includes the authenticated `containerId`. The RPC `Caller` stays unchanged. Future `channel.*` handlers resolve the live container from `caller.sessionId` and check its agent group and the ownership of every requested row. The `agent: 'channel'` transport permission does not grant access to another session. P09 must reauthenticate after a parked pull before it mutates rows.
- P08 `session/schema.ts`: `session_key` indexes `coalesce(messaging_group_id, '')` and `coalesce(thread_id, '')` so absent values compare equal while foreign-key columns remain nullable. Shared terminal sessions use a NULL thread. Empty strings are reserved for absent indexed values. drizzle-kit 0.31.11 misquoted the expression fragments in its initial SQL, so the migration corrects those two expressions by hand. Repeated generation produces no schema change, and tests reject duplicate NULL keys.
- P08 `session/server.ts`: the optional runtime reserves a container and token hash with the inbound transaction, then calls the driver after commit. Failed startup revokes that reservation without losing the accepted inbound row. The host supplies no runtime, so production input stays pending. P09 adds the Docker run implementation and channel procedures to this seam.
- P08 `apps/cli/src/main.ts`: `chat` accepts an exact agent ID or an unambiguous name. LF delimits lines and is not stored. All other valid UTF-8 text, including CR, tab, NUL, and spaces, is preserved when piped. A final line without LF is accepted. EOF waits for every queued receipt, closes the one reply subscription, and exits. A terminal may consume control characters before the CLI receives them, so byte-exact control-character checks use a pipe.
- P08 `apps/host/src/main.ts`: each accepted line emits JSON records with `kind` equal to `session.inbound.received` and `session.inbound.committed`, the same `inboundId`, and `monotonicMs` from `performance.now()`. Subtract the received timestamp from the committed timestamp for persistence latency in milliseconds. The commit timestamp precedes optional container startup.

- P09 `session/server.ts`: the channel context carries the authenticated `AgentPrincipal` separately from the unchanged RPC `Caller`. Every channel transaction checks the exact live container, session, and group, including after a parked pull wakes. Strict inputs reject a supplied target session. Pull holds one FIFO claim, post supports text replies to that claim, and state remains session-scoped. The echo runner derives a stable reply UUID from the inbound ID so a replacement can retry delivery without a duplicate reply.
- P09 `session/server.ts`: `start()` enables a 100 ms reconciliation timer until system Jobs exist. Warm delivery wakes parked pulls directly. Inbound commit precedes a separate container reservation transaction, and `routeInbound` still awaits an immediate startup for P08 compatibility. Exit changes the row to `stopping`, revokes authentication, and releases processing claims before Docker cleanup. Replacement waits for confirmed removal and retries with 250 ms to 30 s backoff, reset by completed work. Restart adoption remains P10.
- P09 `driver/docker.ts`: driver types live with the driver and are re-exported by the session server to avoid a type import cycle. `ContainerSpec` adds `sessionId`. Agent containers use explicit removal and `docker wait`, rather than the probe's `--rm` and attached output. Creation includes install, session, role, and container labels. Conformance adapts nanoclaw's image, environment, mount-mode, label, hardening, network, idempotency, exit, and teardown checks. Its auxiliary-container and mount-class APIs are outside this single-container spec.
- P09 verification: channel regressions and FakeCli conformance initially live in `driver/conformance.test.ts` because the Files box excludes `session/server.test.ts`. Fix-forward 1 explicitly authorizes that server test file and adds measured pull latency, reaped-token HTTP 401, and cross-session HTTP isolation assertions. Runner tests exercise a real Agent Port, guarded oRPC router, and SQLite ledger in process.
- P09 `apps/host/src/main.ts`: image and network settings are parsed here because `config.ts` is outside the Files box. `KURUMI_AGENT_IMAGE` selects the agent image, `KURUMI_PROBE_IMAGE` can select a missing tag and later recover when that tag is loaded, and `KURUMI_DOCKER_NETWORK` applies to both. The install label is the first 24 hex digits of SHA-256 of the canonical home path. The host uses the root's existing gateway dependency. The runner bundle is mounted read-only from the home, and the image includes curl for verification.
- P09 timing: `session.inbound.received` and `session.outbound.delivered` are JSON records with `inboundId` and `monotonicMs`. Delivery means acceptance by the terminal adapter, not arrival at the CLI. The CLI is outside the Files box, so the perf lane must timestamp its observed terminal output to measure the requested end-to-end round trip. EOF retains P08's receipt-only exit behavior; keep stdin open while observing replies.

## ユーザーが決めたこと（2026-10-22）

- アカウントの接続（OAuth）は Mac の前でだけ行う。web listener は `127.0.0.1` だけに bind し、callback は `http://127.0.0.1:<port>/oauth/callback`。`tailscale serve` は使わない。承認ボタンは Slack の Socket Mode で届くので、iPhone からも押せる。
- 承認カードは元の chat に出す（`cardTarget` の既定 `origin`）。
- 接続ボタンと承認ボタンを押せるのは owner だけ。`approvers` は owner 1 人に解決される。
- Google の OAuth client は公開状態を「Testing」以外にして使う。Testing の refresh token は 7 日で切れるため（Google の文書）。

## 試作で確かめた事実（2026-10-22、Bun 1.4.3、Docker Desktop 29.6.1）

- Bun 1.4.3 で CONNECT の socket に server 側の `TLSSocket` を被せた試作は、CONNECT の host の leaf で curl の検証に通ったが、応答の背圧を伝えず、大きな応答を memory に溜めた。P04 は host ごとの loopback `tls.createServer` に `stream.pipeline` でつなぐ方式を使う。ALPN は `['http/1.1']` に固定する。Bun の `https.createServer` は ALPN 設定を無視するため使わない（2026-10-22 の `proto-mitm` の試作）。
- host の `127.0.0.1` だけに bind した listener に、container の中の curl から `host.docker.internal` で届いた。平文の HTTP も、kurumi の CA で検証する MITM 越しの HTTPS も通った。listen していない port は exit 7 で届かなかった。
- Google の文書によると、`scope` は空白区切りで複数を 1 回の同意で求められる。`include_granted_scopes=true` で後から足すと、新しい token と refresh token は合わさった許可を表す。ユーザーは一部の scope だけを許可でき、許可された scope は token の応答の `scope` に出る。localhost の redirect URI は HTTP でよい。
- 1 回の同意で gmail と calendar を 1 行のアカウントにまとめる流れは、実際のログインで成り立った（2026-10-22、P02）。Google の test account と、別の Google アカウント 1 つで観察した。Google の project は「本番環境」で、ログインのたびに「このアプリは Google で確認されていません」の画面が出る。「詳細」を開いて「kurumi（安全ではないページ）に移動」を押すと同意画面に進み、token が取れた。
  - 1 回の同意で `scope` に Gmail と Calendar の scope が並び、`id_token` の `sub` は 1 つだった。同じアカウントの 5 回の同意で `sub` は同じで、別のアカウントでは違った。`(vendor, subject)` での upsert はこの事実に立てる。
  - 同意画面で Calendar の checkbox を外すと、token 応答の `scope` に Calendar の scope が出なかった。その token で Gmail は 200、Calendar は 403（`ACCESS_TOKEN_SCOPE_INSUFFICIENT`）だった。scope の一部だけを許可する接続は、通常の経路として起こる。
  - `include_granted_scopes=true` で Calendar を後から足すと、2 回目の token 応答の `scope` も、その refresh token で refresh した応答の `scope` も、Gmail と Calendar の両方を持った。逆に `include_granted_scopes` を付けない同意は、前の Gmail の同意が生きているあいだも、その同意で許可した Calendar の scope だけを返した（応答も、その refresh token で refresh した応答も同じ）。そのとき前の refresh token は、そのまま refresh できた。前の同意を取り消した後の再同意も同じだった。
  - 同意画面は、まず「kurumi にログイン」（メールアドレスの確認）を出し、その後に scope の checkbox を出す。最初の同意では checkbox が全部入っていたが、その後の同意では全部空で出た。接続の画面は、許可されなかった service を前提にして作る。
  - token 応答の body の key と `id_token` の claim の key は、fixture の写しと同じだった。code 交換は `access_token`、`expires_in`、`refresh_token`、`scope`、`token_type`、`id_token` を返し、refresh は `refresh_token` を除いた同じ形を返す。`id_token` の header は違う。Google は `alg`、`kid`、`typ` を送り、fixture は `{alg: 'none', typ: 'JWT'}` だけである。refresh の応答にも `id_token` があり、`sub` と `email` は交換のときと同じだった（2 回の同意の両方で確認）。`refresh_token_expires_in` は出なかった。
  - 同じ code の 2 回目の交換は、1 回目の直後だけ通った。0.2 秒後と 0.3 秒後の 2 回は受け付けられ、1 回目とは別の access token と refresh token が出た。0.5 秒後から 103.7 秒後までの 16 回は、すべて `invalid_grant` で失敗した（3 回の同意で観察。1 回目を送ってからの秒数は 0.5、0.9、1.2、1.3、1.6、2.2、2.4、3.3、3.4、3.5、4.5、6.6、9.7、13.4、43.5、103.7）。1 回目の token は、その後も revoke できた（200）。script は 5 秒待ってから 2 回目を送る。
  - refresh token を revoke すると 200 が返り、その refresh token での refresh は `invalid_grant` になった。
  - 1 本の revoke は、そのアカウントと client の grant 全体を終わらせた。同じアカウントで 2 回同意して得た refresh token A と B のうち B を revoke すると、B も A も refresh が `invalid_grant` になり、A の revoke は 400 を返した（2 組で同じだった。1 組は A も B も Gmail、もう 1 組は A が Gmail で B が Calendar）。この grant の token は、1 本を revoke すると全部使えなくなる。
  - 同意画面でキャンセルすると、callback は `error=access_denied` を受け、code は出ない。
  - Gmail API と Calendar API は、Google の project で有効にするまで 403 `SERVICE_DISABLED`（`accessNotConfigured`）を返す。scope があっても通らないので、project の前提に加える。

## Open questions and risks

- HTTP/2 は解決済み（P05）。loopback の `tls.createServer` は ALPN で `http/1.1` だけを返す。`port.sse.test.ts` は `curl --http2` と curl 8.10.0 未満の `--http2-prior-knowledge` が HTTP/1.1 の 200 を受けることを確かめる。新しい curl の prior-knowledge は ALPN 不一致で拒否されることを検査する。HTTP/2 の frame 自体は処理しない。[curl 8.10.0 以降の prior-knowledge](https://curl.se/docs/manpage.html#--http2-prior-knowledge) は h2 だけを申し出るので接続できない。
- WebSocket は解決済み（P05）。内側の HTTP server の upgrade ごとに token を認証し直し、通常の request と同じ宛先の検査と header 注入を行う。upstream の 101 の後は両向きの pipeline で frame をそのまま運ぶ。`port.ws.test.ts` は 100 通の順序、注入、両方向の close code、upgrade と同時に届く frame、認証の失効、拒否、停止時の切断を確かめる。
- 長い SSE の背圧は解決済み（P05）。P04 の loopback の形を保ち、`port.sse.test.ts` は client の読み取りを止めた間の upstream 送信量と client 受信量の差が 32 MiB 以下で、再開後に 200 MiB 全部が届くことを確かめる。RSS はこの test の判定に使わない。root の live と perf lane は別 process の upstream と gateway で実行する。
- leaf cert は CONNECT の host で選ぶので、SNI と CONNECT の host が違う client では名前が合わない。curl は一致した。食い違う client が見つかったら、Client Hello を自分で読んで SNI を取り出す。
- Linux の Docker Engine で、container から host の 127.0.0.1 bind に届くか。macOS の Docker Desktop では届く（試作で確認）。Linux では docker0 の address に bind する必要があるかもしれない（未検証）。
- Google の project を「本番環境」にした（2026-10-22）。Gmail（制限付き）と Calendar（機密性の高い）の scope があるので、Console は「アプリの検証が必要です」と表示する。審査には出していない。Google の文書「When is verification not needed」では、100 人未満の personal use は未審査のまま使え、ログインのたびに「未確認のアプリ」の警告を押し進める。警告を押し進めて token を得られることは、P02 の実際のログインで確かめた。refresh token が 7 日を超えて生きるかは未観察。refresh token は 1 つのアカウントと client の組で 100 本までで、超えると古いものが黙って無効になる（Google の文書）。prompt=consent で接続し直すたびに 1 本増えるので、接続し直しを繰り返す試験では上限に注意する。
- Anthropic / Google の SDK が `kurumi:…` を credential として受け入れるか。受け入れない vendor には `selectorShape` を足す（unit 4）。
- 承認後の再送で、agent が本文を作り直す頻度。多ければ「承認時に body を保存しておき、gateway が承認済みの body で送る」案（replay）を検討するか（unit 5）。
- generic な Secret（任意の host に任意の header）を vendor `custom` として行に host を持たせるか。持たせると「vendor / service の一覧は 1 object」の例外になる。
- `autoGrant` を Anthropic key 以外にも使う運用になるか。なるなら「新しい group に既定で見せない」（why Avoid 4）との境界を Console でどう見せるか。
- request log の書き込み（1 秒ごとの batch）と token refresh の書き戻しが、Slack の大量受信と 1 writer を取り合ったときの latency。計測してから batch 間隔を決めたい。

## Next implementation step

Agent Port の残りの spike を書く。host ごとの leaf cert と container からの到達は確認済みなので、HTTP/2・WebSocket・長い SSE の背圧を、container 内の client から fake upstream への通信で確かめる。
