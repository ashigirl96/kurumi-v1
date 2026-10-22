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

- P01 `catalog.ts`: default の `selectorShape` は label を `encodeURIComponent` で percent-encode し（`/`、`@`、`:` は戻す）、`kurumi:` を付ける。`parse` は prefix を大文字小文字を区別せずに読み、percent-decode する。HTTP の header の値は Latin1 の範囲しか持てず、日本語の label は Bun の `Headers` が投げ、curl で送ると文字化けで届く。query では `&`、`#`、`+` が値を切るため。`+`、`&`、空白、`%` を含む label は `selector` を写した文字列と手で書いた文字列で形が違う（`a b` は `a%20b`）。query の slot での読み方は `select.ts` の行に書く。
- P01 `catalog.ts`: `SelectorShape.parse` は、vendor の prefix を持つのに壊れた値（anthropic の base64url が正規の形でない、など）を `null` にせず、値そのものを handle として返す。`none` にすると default の account に落ち、名指しの失敗が別の account の使用になるため。どの grant の handle にも一致しないので `account_not_granted` で拒否される。SDK 自身の placeholder は prefix が無いので `none` のまま。
- P01 `catalog.ts`: `HostRule.host` は完全一致だけにし、`*.example.com` は持たない。使う service が無く、`interceptedHosts()` の集合に載せられないため。host は `normalizeHost`（小文字、末尾の `.` を除く）で比べ、port は hostname に含めない。`isInterceptedHost` を足して、gateway が `serviceFor` と同じ比べ方で MITM の可否を決められるようにした。
- P01 `catalog.ts`: Gmail は `www.googleapis.com` の `/upload/gmail/`、`/resumable/upload/gmail/`、`/batch/gmail/`、Calendar は `/batch/calendar/` も `pathPrefix` に持つ。discovery document の `mediaUpload` と `batchPath` の path が service の path の外にあるため。
- P01 `catalog.ts`: `serviceFor` は、1 つの service だけが使う host（`api.github.com`、`api.notion.com`、`api.anthropic.com`、`gmail.googleapis.com`、`github.com`）では、path が何であってもその service を返す。`pathPrefix` で service を分ける host（`www.googleapis.com`）では、query を除いた path の unreserved 文字の `%XX` だけを戻して照合し、dot segment、`%2F`、`%5C`、`\`、`;` を含む path は null にする。GitHub は `/repos/o/r/branches/feature%2Fx` のように `%2F` を path に使うので、1 つの service の host で null にすると credential を付けずに転送してしまう。Google は unreserved の escape を戻して route し、dot segment には redirect を返す（`curl --path-as-is` で確認）。path を畳んで読むと Google の解釈とずれる（`..;`）ので、疑わしい path は service を決めない。gateway は注入した credential を付けたまま redirect を辿ってはならない（`redirect: 'manual'`）。
- P01 `catalog.ts`: 照合を `createServiceFinder` に切り出して export した。長い `pathPrefix` が先に合うことを、catalog に無い重なりで test するため。`defineCatalog` は `as const satisfies` に置き換えた。`OAuthSpec.identify`、`ServiceSpec.summarize`、`ApprovalSummary` は P02 と P18 で足すので、この PR の型に無い。`serviceBelongsToVendorSql` は全体を括弧で囲む。
- P01 `select.ts`: `accountHandle(vendor, label)` を足した。`AccountHandle` の brand を付ける場所を 1 か所にするため。
- P01 `select.ts`: `bearer` と `basic` の slot は、どちらも `Authorization` の `Bearer`、`token`、`Basic`（password）から selector を読む。`gh` や Octokit は `api.github.com` に `token` か `Bearer` を送り、git は `Basic` を送るため、slot を 1 通りに決めると名指しが黙って無視される。default が複数あるときは、最初の行を取らず `account_ambiguous` にする。
- P01 `select.ts`: query の slot は、値をまず shape が書いたとおりに読み、読めなければ percent-decode して読み直す。`format` の出力をそのまま貼った場合と、URL builder が再 encode した場合のどちらも元の handle に戻り、`%` を含む label を 2 回 decode して別の account の handle にすることはない。`:` を残したまま `%` だけを再 encode する encoder（`encodeURI`）が書いた値は、貼った形と区別できない。同じ名前の parameter が複数あれば全部を読み、全部を slot から取り除く。selector を持つ値が 1 種類ならその handle、placeholder だけなら `none`、2 種類以上で食い違えば、どの grant にも一致しない handle にして `account_not_granted` で拒否する。後ろの値が無視されて default に落ちることも、先頭の値が黙って勝つこともない。
- P01 `.oxlintrc.json`: `no-restricted-imports` で、他の package から import してよい entry を `schema`、`contract`、`server`、`ui`、`cli`、`testing` に限り、`src/` の中の import も拒否する。entry の名前を足す PR は `.oxlintrc.json` も直す。
- P01 `scripts/oxlint/kurumi.js`: 相対 path で別の package の file を import することは、`no-restricted-imports` の pattern ではなく rule `kurumi/no-relative-package-import` が拒否する。pattern は specifier の文字列しか見ず、`../` がどの深さで package を出るかは import する file の場所で決まるため。rule は import する file の path に specifier を足して package（`packages/<名前>` か `apps/<名前>`）を比べ、深さにも file の種類（`drizzle.config.ts` など）にも依らず、`import`、`export … from`、`import()` を拒否する。
- P01 `scripts/oxlint/entry-boundaries.test.ts`: `no-restricted-imports` を設定した override は、その file では top-level の設定を丸ごと置き換える。そのため override が top-level の pattern をすべて並べ直していないと test が落ちる。`exports` の無い package は、manifest の path を示して落ちる。

## ユーザーが決めたこと（2026-10-22）

- アカウントの接続（OAuth）は Mac の前でだけ行う。web listener は `127.0.0.1` だけに bind し、callback は `http://127.0.0.1:<port>/oauth/callback`。`tailscale serve` は使わない。承認ボタンは Slack の Socket Mode で届くので、iPhone からも押せる。
- 承認カードは元の chat に出す（`cardTarget` の既定 `origin`）。
- 接続ボタンと承認ボタンを押せるのは owner だけ。`approvers` は owner 1 人に解決される。
- Google の OAuth client は公開状態を「Testing」以外にして使う。Testing の refresh token は 7 日で切れるため（Google の文書）。

## 試作で確かめた事実（2026-10-22、Bun 1.4.3、Docker Desktop 29.6.1）

- Bun 1.4.3 の server 側の `tls.TLSSocket` は `SNICallback` を呼ばない。既定の証明書を渡すと、どの host にもそれを返した。`tls.createServer` に socket を渡す方式は握手に失敗した。CONNECT の行の host で leaf を選び、`secureContext` に渡す方式なら、host ごとに別の証明書が出て curl の検証が通った。gateway はこの方式を使う。
- host の `127.0.0.1` だけに bind した listener に、container の中の curl から `host.docker.internal` で届いた。平文の HTTP も、kurumi の CA で検証する MITM 越しの HTTPS も通った。listen していない port は exit 7 で届かなかった。
- Google の文書によると、`scope` は空白区切りで複数を 1 回の同意で求められる。`include_granted_scopes=true` で後から足すと、新しい token と refresh token は合わさった許可を表す。ユーザーは一部の scope だけを許可でき、許可された scope は token の応答の `scope` に出る。localhost の redirect URI は HTTP でよい。

## Open questions and risks

- HTTP/2・WebSocket・長い SSE の背圧で Bun の MITM が崩れないか。崩れた場合、forward の engine だけを Node の子 process に出す必要があり、そのとき account との境界は `credentialFor` の RPC になる（unit 1）。
- leaf cert は CONNECT の host で選ぶので、SNI と CONNECT の host が違う client では名前が合わない。curl は一致した。食い違う client が見つかったら、Client Hello を自分で読んで SNI を取り出す。
- Linux の Docker Engine で、container から host の 127.0.0.1 bind に届くか。macOS の Docker Desktop では届く（試作で確認）。Linux では docker0 の address に bind する必要があるかもしれない（未検証）。
- Google の project を「本番環境」にした（2026-10-22）。Gmail（制限付き）と Calendar（機密性の高い）の scope があるので、Console は「アプリの検証が必要です」と表示する。審査には出していない。Google の文書「When is verification not needed」では、100 人未満の personal use は未審査のまま使え、ログインのたびに「未確認のアプリ」の警告を押し進める。実際のログインでこれを越えて token を得られるかと、refresh token が 7 日を超えて生きるかは未観察（unit 2）。refresh token は 1 つのアカウントと client の組で 100 本までで、超えると古いものが黙って無効になる（Google の文書）。prompt=consent で接続し直すたびに 1 本増えるので、接続し直しを繰り返す試験では上限に注意する。
- 1 回の同意で gmail と calendar を 1 行のアカウントにまとめる流れは、文書では成り立つ。実際のログインで確かめるのは unit 2 の残り。
- Anthropic / Google の SDK が `kurumi:…` を credential として受け入れるか。受け入れない vendor には `selectorShape` を足す（unit 4）。
- 承認後の再送で、agent が本文を作り直す頻度。多ければ「承認時に body を保存しておき、gateway が承認済みの body で送る」案（replay）を検討するか（unit 5）。
- generic な Secret（任意の host に任意の header）を vendor `custom` として行に host を持たせるか。持たせると「vendor / service の一覧は 1 object」の例外になる。
- `autoGrant` を Anthropic key 以外にも使う運用になるか。なるなら「新しい group に既定で見せない」（why Avoid 4）との境界を Console でどう見せるか。
- request log の書き込み（1 秒ごとの batch）と token refresh の書き戻しが、Slack の大量受信と 1 writer を取り合ったときの latency。計測してから batch 間隔を決めたい。

## Next implementation step

Agent Port の残りの spike を書く。host ごとの leaf cert と container からの到達は確認済みなので、HTTP/2・WebSocket・長い SSE の背圧を、container 内の client から fake upstream への通信で確かめる。
