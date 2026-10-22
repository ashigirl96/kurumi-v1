# why: nanoclaw の Gateway seam と OneCLI v1.42.0 の形

### The Question

nanoclaw はなぜ Gateway を外部のシステムとして provider seam の向こうに置き（別 process・別 DB）、Credential を agent container に入れず、egress を締め、Gateway Outage の扱いを決めているのか。Console はなぜ OneCLI を直接読むのか（ADR 0003）。OneCLI はなぜ `AppConnection` / `AgentAppConnection` / `AgentSecret` でアカウントを agent に結びつけるのか。1 つの agent に同じ provider の複数アカウントを持たせる要望や、chat の中からアプリを接続する要望は出ていたのか。OneCLI はなぜ Rust の gateway と Next.js の app と postgres に分かれているのか。答えは、gateway を同じ TypeScript のコードベースと 1 つの SQLite に取り込む kurumi の制約にする。

### The Code in Question

- nanoclaw（`~/.ghq/src/github.com/ashigirl96/nanoclaw`）: `src/gateway-providers/onecli.ts`（`ensureSession` L156〜、identifier のコメント L157-158）、`src/gateway-approval-coordinator.ts`、`src/gateway-availability.ts`、`src/gateway-connections.ts`、`src/egress-lockdown.ts`、`docs/gateway-seam.md`（L3-8、L59-69、L192-211）、`docs/onecli-upgrades.md`、`docs/adr/0003-console-reads-onecli-directly.md`、`GLOSSARY.md` L371〜392（Gateway 節）。
- OneCLI v1.42.0（commit 3912c74、tag `v1.42.0`）: `packages/db/prisma/schema.prisma`（`Agent.secretMode @default("all")` L294、`AppConnection`、`AgentAppConnection`、`AgentSecret`）、`packages/api/src/routes/agents.ts`、`packages/api/src/routes/connections.ts`、`packages/api/src/app.ts`、`apps/gateway/src/connect.rs`、`inject.rs`。
- 仕組みの説明は `how.md` §6〜11 と Gotchas に従う。この文書は「なぜ」だけを扱う。

---

### What We Found

#### (a) nanoclaw の Gateway: seam、Credential の隔離、egress、Gateway Outage

- **[Direct] nanoclaw は credential gateway を自分では実装せず、seam を定めて Install ごとに provider を 1 つ選ぶ。** Source: `docs/gateway-seam.md:3-8`。commit `249bbe93` = upstream PR #3815「refactor(gateway): centralize the credential gateway contract」（Zvi Fried、2026-09-15 commit、2026-09-23 merge）。"NanoClaw does not implement one. It defines a seam, selects exactly one provider per install, and owns everything about that provider's behavior that is a NanoClaw concern: session lifecycle, human approval, reconciliation…" PR #3815 の本文では「AI tools or agents helped produce this change」に印があり、「A human has reviewed this PR and stands behind every change」には印が無い。この文章は、人が書いた設計判断というより agent が書いた説明として重みを割り引く必要がある。
- **[Direct] seam にした理由は、gateway の差し替えやすさと、gateway 固有のものを core に漏らさないことである。process を分けること自体は理由に挙がっていない。** Source: `docs/gateway-seam.md:59-69`（同 PR #3815）。"The gateway is the single most security-relevant dependency in the system and the one most likely to differ per deployment — a hosted vault, a local proxy, something an enterprise already runs. Baking one in made three things true that should not be: its native protocol leaked into the spawn path, its approval semantics were NanoClaw's approval semantics, and its container flags rode around spec validation as raw argv."
- **[Direct] seam は「OneCLI が重い」という批判への答えとして閉じられたが、DB の要らない構成は約束していない。** Source: [nanocoai/nanoclaw#2437](https://github.com/nanocoai/nanoclaw/issues/2437)。carderne（2026-05-12）: "suddenly lightweight NanoClaw requires a postgres deployment (exposed to more of the network than is necessary) and a Nextjs app, also fully exposed … OneCLI doesn't seem to offer a way to run the Rust gateway only"。案 1 は "Build a small proxy into nanoclaw … Save secrets to sqlite DB/similar"。maintainer glifocat が 2026-10-02 に閉じたときの言葉: "The pluggable gateway interface you proposed is now implemented … this resolves the replaceable-gateway part of your request rather than providing a database-free deployment." carderne の案 1 は kurumi の方針にほぼ等しいが、maintainer はこの案に賛否を示していない。
- **[Direct] 「Credential を container に入れない」は OneCLI より前からあり、最初は host process の中の proxy で実現していた。** Evidence: [nanocoai/nanoclaw#197](https://github.com/nanocoai/nanoclaw/issues/197)（2026-02-13、"This reduces risks like credential leakage through prompt injection attacks"）、upstream PR #798（gabi-simons、2026-03-08 merge、commit `13ce4aaf`: "Real API keys and OAuth tokens are now managed exclusively by the host-side proxy and are never exposed to the container's environment, filesystem, or process tree"。`docs/SECURITY.md` を "Real API credentials **never enter containers**." に書き換えた）。動機はプロンプトインジェクションによる漏洩である。
- **[Direct] OAuth の refresh token も container に入れない理由は、メール経由のプロンプトインジェクションで token を持ち出されることである。** Source: [nanocoai/nanoclaw#1500](https://github.com/nanocoai/nanoclaw/issues/1500)（chiplay、2026-03-28）: "A prompt injection attack via email … could instruct the agent to read and exfiltrate these tokens, granting full account access … Zero tokens mounted into containers"。OneCLI 側にも同じ要望がある。[onecli/onecli#55](https://github.com/onecli/onecli/issues/55)（2026-03-16）: "support for GitHub / Google via the agent without giving the agent the refresh token"。
- **[Direct] 今の upstream の判断では、provider の credential を container に渡す経路はサポートしない。** Source: [nanocoai/nanoclaw#2781](https://github.com/nanocoai/nanoclaw/issues/2781#issuecomment-5954562504)（glifocat、2026-10-02、NOT_PLANNED で close）: "passing provider credentials directly into agent containers is outside the supported credential model, and `NANOCLAW_NATIVE_CREDENTIALS` is not a supported bypass." 判断の範囲は「provider credential を agent container に直接渡すこと」である。
- **[Direct] 外部の OneCLI に移った理由として書かれているのは、構成の単純化と secret の一元管理だけである。** Source: upstream PR #1237（guyb1、2026-03-24 merge、commit `e9369617`）: "Replaces NanoClaw's built-in credential proxy with the OneCLI gateway … simplifying the architecture and enabling centralized secret management." change type は「Simplification」。gavrielc がコメント無しで approve している。議論の記録は無い。
- **[Direct] host 内 proxy は、安全でないと判断されて引退したのではない。** Evidence: commit `fff37d59`（gavrielc、2026-03-28）: "OneCLI is incompatible with Apple Container … Docker → OneCLI, Apple Container → native credential proxy"。`CHANGELOG.md:117`: "The `use-native-credential-proxy` skill is retired: the spec's admission rules refuse credential values in container env on every lane, by design"。引退の理由は「container env に credential の値を入れない」という admission 規則であり、host process の中で注入すること自体は否定されていない。
- **[Direct] gateway は独自のリリース系列を持つ外部の部品として扱われ、版の固定と更新は運用者に任されている。** Source: `docs/onecli-upgrades.md:3,5`（PR #4039 glifocat 2026-10-05、PR #2747 Omri Maya 2026-06-12）: "There is deliberately **no runtime version check, and setup does not migrate the gateway for you**: the gateway is a separate out-of-band component"。
- **[Direct] 1.42.0 という版は、下限と上限に挟まれて決まった。設計上の理由で選ばれた版ではない。** Evidence: upstream PR #3989（2026-10-04 merge、commit `92cde85f`）: "OneCLI 1.42.0 closes a credential-injection host-enforcement bypass ([onecli/onecli#438])" と "Out of scope: 1.43+, which removes the agent-grant API this integration uses"。PR #4036（glifocat）: "OneCLI 1.43 returns `410` on the agent secret-assignment API (`onecli agents set-secrets`)"。nanoclaw の pin は 1.36.0（`3f9e89d3`、2026-06-12）→ 1.41.0（`2ee14588`、2026-08-16）→ 1.42.0（`92cde85f`）と動いた。1.45.0 に上げる commit `350e11fe`（chiptoe-svg）は upstream の未 merge branch `feat/onecli-provider-grants` にしか無い。
- **[Direct] egress lockdown は `HTTPS_PROXY` を無視するクライアントや raw socket が gateway を迂回する穴を、network の層で塞ぐためにある。既定は off である。** Source: upstream PR #2713（omri-maya、2026-06-08、commit `6420c0e2`）: "Today an agent that ignores `HTTPS_PROXY` … can reach the internet directly, bypassing the gateway … On an internal network there is simply no route off the box except the gateway"。"Fail-fast … rather than silently falling back to open egress"。"`NANOCLAW_EGRESS_LOCKDOWN` defaults to **false**"。今の `docs/SECURITY.md` も "Default: egress is open." と書いている。
- **[Direct] Gateway が使えないときに spawn を止めるのは、credential の無い container が意味の分からない 401 を出していたからである。** Source: upstream PR #2110（gavrielc、2026-04-29）: "the host previously logged a warning and spawned a credential-less container, which then surfaced opaque 401s to the user. This PR refuses to spawn in that case and lets the host-sweep retry on its next 60s tick." GLOSSARY の「Gateway Outage: その間 Host は Container を動かさず、届いた Inbound Message は Pending のまま待つ」（`GLOSSARY.md:391-392`）はここから来ている。GLOSSARY のこの節は、ユーザーが upstream の docs を言い換えたものである（commit `97ebc41e`、2026-10-14）。独立した決定の記録ではなく、PR #2110 と #3815 と同じ証拠の連鎖として扱う。
- **[Direct] Outage では admission を閉じるが、閉じたままにはしない。** Source: `docs/gateway-seam.md:192-211`（`771a6cf3` 2026-09-14 で入り、PR #3815 で merge）: "Closure is fail-closed by design — a session whose credentials cannot be authorized must not run — but it must not be terminal. A host that stays up while permanently refusing to spawn anything drops every user message with only a log line to show for it, which is strictly worse than crashing, because nothing restarts it."
- **[Direct] 利用者は gateway の停止で全 agent が黙る障害を報告している。** Evidence: [nanocoai/nanoclaw#2655](https://github.com/nanocoai/nanoclaw/issues/2655)（mshirel、2026-05-31、"all agents silently stop responding"、約 1000 件の並行 Gmail request で EMFILE）、[#2657](https://github.com/nanocoai/nanoclaw/issues/2657)（"a ~2 hour fully silent outage … stop spawning agent containers into a known-broken gateway"）、[#2902](https://github.com/nanocoai/nanoclaw/issues/2902)（spawn に失敗しても利用者に何も返らない）。3 件とも maintainer の返信は無い。
- **[Direct] 1 つの OneCLI を複数の nanoclaw Install が共有しうる。seam の `ownsAgentGroup` はそのためにある。** Source: PR #3815 の review（glifocat、2026-09-22）: "a second NanoClaw copy sharing the local OneCLI gateway gets its approvals denied by the first copy. The SDK poll is gateway-wide (`GET /v1/approvals/pending`, no agent filter)"。[nanocoai/nanoclaw#3874](https://github.com/nanocoai/nanoclaw/issues/3874) も同じ問題を扱う。
- **[Direct] OneCLI の agent を Agent Group ごとに 1 つ作るのは、group ごとに credential の方針を変えるためである。** Source: commit `4c6d9241`（gavrielc、2026-03-26）が SECURITY.md に足した文: "Each NanoClaw group gets its own OneCLI agent identity. This allows different credential policies per group (e.g. your sales agent vs. support agent)." PR #3817 の review（glifocat、2026-09-22）も、OneCLI を選ぶ理由として group ごとの付与を挙げている: "OneCLI grants per agent today (one OneCLI agent per agent group, `secretMode: selective`), so on a multi-user install a key can be limited to one group with no cards at all."
- **[Direct] `gateway-availability.ts` の lease について書かれた理由は、doc の 1 文だけである。** Source: `docs/gateway-seam.md`（PR #3815）: "When approval handling and session admission run in separate processes, the provider can implement `availability.publish` and `availability.read`." これを必要とした実際の配置を述べた PR の議論は見つからなかった。

#### (b) ADR 0003: Console が OneCLI を直接読む理由

- **[Direct] seam に一覧の口を足さなかった理由は、upstream を取り込み続ける fork で merge の衝突を避けるためである。** Source: `docs/adr/0003-console-reads-onecli-directly.md`（commit `4dfe179e`、ashigirl96、2026-10-20、fork だけにある）: 「core と `add-onecli` の payload に手が入り、upstream を取り込み続けるこの fork では衝突の元になるため採らなかった」。
- **[Direct] dashboard へのリンクだけを置く案を採らなかった理由は、Console の中で何がつながっているかが見えないことである。** Source: 同 ADR: 「OneCLI の dashboard へのリンクだけを置く案は、Console の中で何がつながっているかが見えないため採らなかった」。
- **[Direct] Console が書き込まず値を絞るのは、OneCLI の API が認証なしで token まで返すからである。** Source: 同 ADR の Consequences。裏づけとして [onecli/onecli#263](https://github.com/onecli/onecli/issues/263#issuecomment-6014743021)（avakrat、2026-10-06: "Still reproducible on gateway **1.42.0** … `/v1/agents` 200"）、[onecli/onecli#268](https://github.com/onecli/onecli/issues/268) と [nanocoai/nanoclaw#2433](https://github.com/nanocoai/nanoclaw/issues/2433)（glifocat、2026-05-12: "every agent container can reach the unauthenticated admin API and Postgres"）。
- **[Direct] dashboard の origin を `ONECLI_URL` と同じにする判断は、Owner が見る Console の画面に限ったものである。** Source: fork PR #20 でのユーザーの返信（2026-10-19）: 「docs/gateway-seam.md の「No dashboard location is guessed」は、Agent に返す `connections.connect` の契約についての記述です。Owner が見る Console の画面の方針は、ADR 0003 と issue #11 で別に決めています」。
- **[Direct] issue #11 の spec は、chat の中の認証カード、Agent Group ごとの表示、grant の変更、Console からの OAuth 開始を範囲外にしている。** Source: [ashigirl96/nanoclaw#11](https://github.com/ashigirl96/nanoclaw/issues/11#issuecomment-6273844648)（2026-10-19）。この brief には "*This was generated by AI during triage.*" とある。ユーザーが採用した spec であり、ユーザー自身の文章ではない。

#### (c) `AppConnection` / `AgentAppConnection` / `AgentSecret` と複数アカウント

- **[Direct] `AgentSecret` と `secretMode` は、agent ごとに使える secret を絞りたいという初日の要望から入った。** Evidence: [onecli/onecli#50](https://github.com/onecli/onecli/issues/50)（2026-03-16: "Each agent should be allowed to access specific secrets instead of all the vault"）、OneCLI PR #56（guyb1、2026-03-17、commit `7d47647`: "Add per-agent secret permissions … All secrets (default) … Selective mode … Switching from selective → all preserves assignments (dormant)"）。
- **[Direct] `AgentAppConnection` は secret と同じ all / selective の型を app connection に写したものである。最初から provider ではなく connection id への join だった。** Source: OneCLI PR #127（本文は空）、commit `aa8ec62`（2026-03-29）: "Agent-app association (same all/selective model as secrets)"。join を connection id にした理由は書かれていない。
- **[Direct] 同じ provider の複数アカウントは、NanoClaw の利用者からの要望で入った。要望者はすべてのアカウントを 1 つの agent に載せていた。** Source: [onecli/onecli#180](https://github.com/onecli/onecli/issues/180)（califa、2026-04-12）: "I'd like to connect both my work account and my personal account on the same onecli instance … Right now everything would be centralized on the same default agent via NanoClaw"。maintainer johnnyfish（2026-04-15）: "we just opened PR #187 which adds multi-account connections support"。PR #187（2026-04-16 merge）: "Support multiple connections per app provider (e.g., two GitHub accounts). Per-request disambiguation via `x-onecli-connection-id` header. Drops the one-per-provider unique constraint"。issue #180 は今も open である。provider ごとに OAuth client（`AppConfig`）を 1 つしか持てない点が残っている（biztex、2026-07-30: "What's actually missing is only config cardinality and selection"）。
- **[Direct] maintainer は、アカウントを agent ごとに 1 つずつ割り当てる使い方を想定していた。** Source: [onecli/onecli#238](https://github.com/onecli/onecli/issues/238#issuecomment-4369256335)（johnnyfish、2026-05-04）: "In the agent's Manage Access dialog, you can select which specific connections an agent has access to, e.g., give Agent A your personal Gmail and Agent B your work Gmail … The gateway resolves credentials via `appConnectionId`"。利用者が出した選択の案（`ONECLI_APP_ALIAS`、`X-OneCLI-Account` の stub）には返事が無い。
- **[Direct] 1 つの agent が同じ host の credential を複数持つ場合について、generic secret では「最後に一致したものが勝つ」と maintainer が書いている。** Source: [onecli/onecli#129](https://github.com/onecli/onecli/issues/129)（guyb1、2026-03-30）: "today we don't support multiple keys for the same host/path, the last matching one wins"。
- **[Direct] 1 つの agent に Gmail を 2 つ持たせる場合は、v1.42.0 より前に設計されていた。** Source: OneCLI PR #407（guyb1、2026-07-02）: "two same-provider connections (two Gmail accounts) no longer make sibling APIs' requests (Calendar/Drive) falsely ambiguous"。
- **[Direct] selective mode では app connection も allowlist で個別に付与する。2026-05 の時点で、その付与は dashboard からしかできなかった。** Source: [onecli/onecli#299](https://github.com/onecli/onecli/issues/299#issuecomment-4515183201)（johnnyfish、2026-05-22）。vicmike の "is support planned to add it to the cli or api?" には返事が無い。
- **[Direct] `secretMode` の既定が "all" であることの是非は、maintainer に問われたまま答えられていない。** Source: [onecli/onecli#297](https://github.com/onecli/onecli/issues/297)。ZappoMan: 既定が "a one-line change in #199 (Apr 22), after #58 explicitly defaulted new agents to selective. Was that intentional, or a regression?"。johnnyfish は子 agent が全 credential を得ることを "That's a privilege-escalation path" と呼んだ。guyb1 は `parentIdentifier` による継承を足した（2026-05-24）。既定の問いには誰も答えていない。
- **[Direct] upstream の OneCLI は v1.42.0 の後、all / selective と join の二重構造を捨て、connection ごとの明示的な付与と default-deny に移った。** Evidence: OneCLI PR #448（v1.43、2026-07-25: per-agent grants などを "are all expressible as v2 rules"、旧 table は "retained and frozen"）、PR #462（v1.44、2026-07-29: "a new agent starts with no access … two accounts of one app can carry different permissions, selected per request via `x-onecli-connection-id`"）。v1.42.0 自体がこの移行の途中にある。PR #436（2026-07-22、tag の前日）: "Blocklist and credential-assignment writes stay live and re-materialize into the rule set until the legacy model is removed"。
- **[Direct] nanoclaw 側でも、group ごとの付与を nanoclaw が持つべきだという提案が出ているが、決まっていない。** Evidence: [nanocoai/nanoclaw#3205](https://github.com/nanocoai/nanoclaw/issues/3205)（chiptoe-svg、2026-08-08: "No persistent per-group → secret store" と "it needs an explicit maintainer decision"）、[#3532](https://github.com/nanocoai/nanoclaw/issues/3532)、upstream PR #4094（glifocat、open: "new groups get only their model credential … Tool secrets and app connections are opt-in"、"On a 1.42 gateway, new groups still get every key until the gateway is upgraded"）。
- **[Direct] chat の中から接続したいという要望は、ユーザー自身のもの（fork #28）しか見つからなかった。MCP で接続する要望は見つからなかった。** Evidence: [ashigirl96/nanoclaw#28](https://github.com/ashigirl96/nanoclaw/issues/28)（2026-10-20）: 「Chat で Agent に「Notion に接続したい」と頼んでも、Agent は OneCLI の接続 URL を本文に生のまま貼るだけで、押せるボタンにならない … Grok の bot に合わせて、入口を 2 つにする」。commit `6143330f` / fork PR #29 がこれを実装した。follow-up の `69ee3e82`（Codex の P1 指摘への対応）は、他の origin へのリンクを接続ボタンに見せかけられる穴を塞いだ。OneCLI 側の MCP の要望は activity data（[#411](https://github.com/onecli/onecli/issues/411)）と中身の無い "custom MCP Oauth"（#480）だけである。
- **[Direct、仕組み] OAuth callback はどの agent にも付与しない。`agent_name` は表示にしか使われない。** Source: `how.md` §9（`packages/api/src/routes/apps.ts:404-412`、`connect-success.tsx:48`、`use-connect-param.ts`、`apps-tab.tsx` を確認済み）。これは commit `6143330f` の「URL の `agent_name` で OneCLI がその Agent に権限を付けるため」と、`web/src/ConnectApps.tsx:70` のコメントに反する。今「接続したらすぐ使える」のは、全 agent が `secretMode: all` だからである。

#### 矛盾の判定: v1.42.0 OSS で agent ごとの connection 付与はできるか

why-2 が挙げた矛盾（upstream #3118 / fork #11 の「404」対 how.md の「API がある」）を、コードと版の履歴で確かめた。

- **[Direct、仕組み] v1.42.0 OSS には付与の REST API がある。edition による制限は無い。** `packages/api/src/app.ts:132` が `basePath("/v1")` を張り、`app.ts:138,144` が `/agents` と `/connections` を mount する。`routes/agents.ts:145` `PATCH /:agentId/secret-mode`、`:211` `GET /:agentId/connections`、`:223` `PUT /:agentId/connections`、`routes/connections.ts:183,196` `GET|PUT /:connectionId/agents`。route にも `services/agent-service.ts:422-490` の `updateAgentAppConnections` にも OSS / EE の分岐は無い。EE なのは `sessionPolicy` の検証だけである。`apps/web/src/app/api/[[...route]]/route.ts` が `/api/*` を `/v1/*` に書き換えるので、`/api/agents/{id}/connections` も v1.42.0 では同じ handler に届く。`:agentId` は OneCLI の内部 id で、nanoclaw の identifier（Agent Group id）ではない。
- **[Direct、仕組み] この REST API は v1.37.0 で入った。v1.36.0 には無い。** `git log -S'"/:agentId/connections"' -- packages/api` の最初は `622cb26`（PR #366、2026-06-14）、最初に含む tag は v1.37.0。逆向きの `/:connectionId/agents` は `71f13ee`（PR #412、2026-07-06）、最初の tag は v1.41.0。`git show v1.36.0:packages/api/src/routes/agents.ts` の route は `secret-mode` と `secrets` までで、`connections` は無い。v1.36.0 では dashboard の `manage-access-dialog.tsx` が `@/lib/actions/agents` の server action（`updateAgentAppConnections`）で付与していた。REST からは付与できなかった。
- **[Supported] #3118 と #3205 は、nanoclaw が OneCLI 1.36.0 を pin していた期間の報告である。** Evidence: nanoclaw の pin は `3f9e89d3`（2026-06-12）から `2ee14588`（2026-08-16）まで `"onecli-gateway": "1.36.0"`。#3118 は 2026-07-22 に作られた。#3205（2026-08-08）は本文で "`versions.json` pins `onecli-gateway 1.36.0`" と書き、"against the currently-pinned OneCLI (gateway 1.36.x-era API)" で動かしていると述べ、OAuth については #3118 を参照している。#3118 の本文は版を書いていないので、bradfeld が 1.36.0 で試したことは推論である。ただし「`/api/agents/{id}/connections` が 404」「CLI に付与のコマンドが無い」「dashboard では付与できる（maintainer #238）」の 3 つは、v1.36.0 のコードと矛盾なく合う。"appears to be Cloud-only" は報告者の推測で、コードはこれを支持しない。
- **[Direct] fork #11 の「404」は別の API の話で、v1.42.0 の connection 付与 API とは矛盾しない。** Source: fork #11 の brief: 「SDK 3.x の `/v1/org/*` と `/v1/agents/{id}/grants` は 1.42.0 で 404 になる」。`/v1/agents/{id}/grants` は v1.44（PR #462）の grants API で、v1.42.0 に無いのは正しい。brief の「全 agent が `secretMode: all`」も正しいが、理由は nanoclaw が `secret-mode` を一度も呼ばないことにある（`src/` と `.claude/skills/add-onecli` を grep して 0 件、`schema.prisma:294` の既定は `"all"`）。付与ができないからではない。
- **判定.** v1.42.0 OSS は Connected Account（connection）単位の多対多の付与を、データ、REST API、gateway の解決のどの層でも持っている。確信度は高い（route、mount、service を直接読み、版の履歴で裏を取った）。#3118 の「404」は 1.36.0 の時点では正しかったとみられる（確信度は中〜高。報告に版が無いため）。fork #11 は 1.42.0 について誤っていない。したがってユーザーの前提「OneCLI v1.42.0 では複数アカウントを結びつけられない」は、**機能としては誤り、この Install の実際の挙動としては当たっている**。実際の制約は次のとおりである（`how.md` §10）。nanoclaw が selective にしないので全 group が全アカウントを見る。同じ provider の 2 つ目をつなぐと、全 group の呼び出しが 409 `multiple_connections` になる。agent が `x-onecli-connection-id` を付けないと選べない。callback が付与しない。policy、承認カード、request log がアカウントを区別しない。

#### (d) OneCLI が Rust の gateway、Next.js、postgres に分かれている理由

- **[Direct] OneCLI の repo は、AWS 上の cloud backend として始まった。** Source: 最初の commit `bef6893`（2026-03-08）の CLAUDE.md: "# OneCLI Cloud / Cloud backend for OneCLI — manages authentication, integrations, and permissions"。`apps/web/ # Next.js 16 app`、`packages/db/ # Prisma ORM`、`packages/infra/ # AWS CDK infrastructure`、`DATABASE_URL: PostgreSQL`、`NEXT_PUBLIC_COGNITO_*`、`STRIPE_SECRET_KEY` を並べている。
- **[Direct] Rust の proxy は翌日に足された。書かれた理由は README の "fast, memory-safe" だけである。** Evidence: OneCLI PR #4（2026-03-09: "Rust-based HTTPS proxy that intercepts TLS connections and injects credentials"）、README（PR #24、2026-03-12: "fast, memory-safe HTTP gateway with MITM interception for HTTPS"）。比較や計測の記録は無い。
- **[Direct] gateway が postgres を直接読むのは、hot path から Next.js の API を外すためである。** Source: OneCLI PR #46（2026-03-15）: "Add SQLx for direct PostgreSQL queries, eliminating the Next.js API dependency on the hot path"。同じ PR で "AES-256-GCM decryption compatible with Node.js format" を Rust に足している。
- **[Direct] 埋め込みの PGlite は同じ日に外された。理由は書かれていない。** Source: OneCLI PR #43（2026-03-15）: "Remove embedded PGlite database — OneCLI now always uses PostgreSQL"。README から "No external dependencies: runs with embedded PGlite" を消した。本文にもコメントにも理由は無い。
- **[Direct] SQLite 版の要望と、DB を使わない構成の要望は、どちらも答えられていない。** Evidence: [onecli/onecli#121](https://github.com/onecli/onecli/issues/121)（2026-03-27、"consider base version to leverage sqlite"、コメント 0）、[#183](https://github.com/onecli/onecli/issues/183)（2026-04-12、"optional mode where the gateway config comes from a config file"、返事無し）。
- **[Direct] postgres と鍵を別の volume に分けたことで、運用事故が起きている。** Source: [nanocoai/nanoclaw#2286](https://github.com/nanocoai/nanoclaw/issues/2286)（glifocat、2026-05-05）: "If `onecli_app-data` is wiped … every encrypted row in `secrets`/`agent_secrets` becomes unreadable"。きっかけは postgres 17 → 18 の image 更新である。

---

### What We Can Reasonably Infer

- **[Inferred] nanoclaw で Gateway が別 process・別 DB なのは、設計目標というより、他社の製品を採用した結果であるらしい。** Reasoning: 不変条件「Credential は container に入れない」は host process 内の proxy で始まった（#798）。OneCLI への移行理由は「単純化と一元管理」だけである（#1237）。seam の doc が論じているのは差し替えやすさで、process の境界ではない（gateway-seam.md:59-69）。host 内 proxy が引退した理由も、container env に値を入れない規則であって、in-process の注入ではない（CHANGELOG.md:117）。ここから、別 process であることは採用した製品の形を引き継いだもので、守るべき性質そのものではない、と読める。
- **[Inferred] egress lockdown は、OneCLI の policy が credential の無い通信を止められないことを補っている可能性がある。** Reasoning: OneCLI の deny は "request that would receive credential injection" にしか効かない（[onecli#177](https://github.com/onecli/onecli/issues/177#issuecomment-4537446388)）。[onecli#372](https://github.com/onecli/onecli/issues/372) は「deny の agent でも `evil.com` に届く」と書いている。PR #2713 が挙げる理由は proxy 迂回の穴だけで、この 2 件には触れていない。
- **[Inferred] ADR 0003 の主な理由（fork の merge 衝突）は kurumi では成り立たない。** Reasoning: ADR が退けた理由は「upstream を取り込み続けるこの fork」に特有のものである。kurumi は core を自分で持つ。もう 1 つの理由「dashboard へのリンクだけでは何がつながっているか見えない」は、kurumi にもそのまま当てはまる。
- **[Inferred] OneCLI が nanoclaw の既定になったのは、技術的な比較だけでなく人のつながりにもよるらしい。** Reasoning: guyb1 は nanoclaw PR #1237 と OneCLI の commit の大半を書いている。johnnyfish と glifocat も両方の repo で書いている（why-1 I2）。誰もそうだとは書いていない。
- **[Inferred] OneCLI の agent ごとの token と group ごとの付与は「信頼しない group」に対する境界として価値があるが、この Install のように Owner が 1 人なら、その価値は付与の既定次第になる。** Reasoning: glifocat は multi-user install を理由に OneCLI を勧めた（PR #3817 review）。#3205 も multi-user を前提にしている。単独利用のこの Install では全 group が `all` で動いており、group 間の境界は実際には効いていない。

### Competing Hypotheses

**問い: OneCLI はなぜ PGlite をやめて postgres にしたか**

- **Hypothesis 1:** 別 process の Rust gateway が同じ DB を読む必要があり、Node の process に埋め込まれた PGlite は共有できなかった。
  - Evidence for: PR #43（PGlite 削除）と PR #46（gateway が SQLx で直接読む）が同じ日（2026-03-15）。
  - Evidence against or missing: どちらの PR にも理由が書かれていない。
- **Hypothesis 2:** 元が multi-tenant の cloud 製品（Cognito、Stripe、AWS CDK）で、postgres が前提だった。self-hosted 版はそれを引き継いだ。
  - Evidence for: `bef6893` の CLAUDE.md。pre-#43 の entrypoint の "In cloud mode … Secrets Manager" と "Cloud edition uses AWS KMS"。schema の `scope` "organization" / "partner"。
  - Evidence against or missing: なぜ self-hosted で軽い選択肢を残さなかったかは書かれていない。
- **Hypothesis 3:** Prisma と PGlite の adapter の相性、性能、運用の問題。
  - Evidence for: 無い。
  - Evidence against or missing: 記録が無い。

**問い: なぜ nanoclaw は Gateway を外部に置くのか**

- **Hypothesis A:** credential を持つ部品を agent の orchestration と別の process に置き、境界を強くするため。
  - Evidence for: "the single most security-relevant dependency"（gateway-seam.md:61）。
  - Evidence against or missing: 同じ段落の結論は差し替えやすさである。host 内 proxy は安全上の理由で否定されていない（CHANGELOG.md:117）。
- **Hypothesis B:** 単純化のために既製品を採り、その後 Iron など他の gateway も入れるため seam を切った。
  - Evidence for: #1237 の "Simplification"、#2437 の閉じ方、Iron provider の存在。
  - Evidence against or missing: 特に無い。今ある記録とはこちらがよく合う。

### What We Don't Know

- **OneCLI が Rust を選んだ理由**: PR #4 の本文とコメント、`bef6893..ff81af5` の commit message、`-S memory-safe` を調べた。README の "fast, memory-safe" 以外に無い。計測も無い。TypeScript で MITM proxy を書いた場合の性能の比較は、どこにも無い。
- **PGlite をやめた理由**: PR #43 の本文とコメント、`--grep pglite|sqlite|embedded postgres|single binary|single container`、`-S PGlite`、onecli の issue（rust、pglite、embedded、why postgres、architecture）を調べた。理由は無い。#121（sqlite）は返事が無い。
- **`AgentAppConnection` を provider ではなく connection id への join にした理由**: PR #127 は本文が空で review も無い。"same all/selective model as secrets" だけ。
- **`secretMode` の既定が selective から all に変わった理由**: #297 で問われたが答えが無い。PR #199 は読んでいない。
- **1 つの agent が同じ provider の複数アカウントを持つとき、どう選ばせるべきか**: OneCLI は 409 と header で agent に選ばせる（PR #187、#462）。利用者の案（`ONECLI_APP_ALIAS`、`X-OneCLI-Account`）には返事が無い（#238）。既定アカウントや From アドレスで選ぶ案は記録に無い。
- **nanoclaw が OneCLI を選んだ比較**: #1237 は承認だけで議論が無い。他の vault（Composio、Nango、Arcade）との比較は upstream の issue にも無い（"composio" 1 件、"nango" 0、"arcade" 0）。
- **`gateway-availability.ts` の lease を必要とした配置**: doc の 1 文だけで、PR の議論は見つからない。
- **egress lockdown を入れた issue**: "egress lockdown"、"lockdown"、"internal network" で検索したが、`NANOCLAW_EGRESS_LOCKDOWN` を求めた issue は無い。理由は PR #2713 の本文だけ。
- **#3118 の報告者が使った版**: 本文に版が無い。pin の期間から 1.36.0 と推定した。bradfeld 本人にしか確かめられない。
- **in-chat 接続や MCP による接続の upstream の要望**: "connect from chat"、"in-chat"、"card"、"connect app"、"connect an app" を onecli と upstream nanoclaw の両方で検索して 0 件。ユーザーの fork #28 だけ。
- **ユーザー自身が複数アカウントを必要とした場面**: 接続できた Slack workspace（`<work-org>` のもの 1 つ）を `Gmail`、`アカウント`、`"Agent Group"`、`onecli` で検索したが、ユーザーの発言は無い。nanoclaw の Agent Group が投稿する Slack workspace はこの MCP から届かない。この workspace にユーザーと agent の会話があれば、そこが最も有力な証拠になる。
- **Claude Docs**: ユーザーが持つ doc は 0 件。title で照合した 3 件は無関係。kurumi や nanoclaw の設計メモは見つからない。別 org の Docs は一覧に出ない。
- **聞けば分かりそうな人**: Zvi Fried（seam の doc の作者。ただし AI 支援の PR）、glifocat（outage、ownsAgentGroup、Iron の判断）、guyb1 と johnnyfish（OneCLI の schema と stack）、bradfeld（#3118 の版）。

### Sources Consulted

- **Source control history**: nanoclaw fork（HEAD 3149 commit）の `docs/gateway-seam.md`、`GLOSSARY.md`、`src/gateway-providers/*`、`src/gateway-*.ts`、`src/egress-lockdown.ts`、`docs/onecli-upgrades.md`、`docs/isolation-model.md`、`.claude/skills/add-onecli/versions.json` の `git log --follow` / `--diff-filter=A` / pickaxe / blame。upstream PR #798、#1237、#1399、#2110、#2713、#2747、#3815、#3816、#3817、#3824、#3948、#3964、#3966、#3989、#4015、#4036、#4082、#4094、#4106 と fork PR #20、#29 の本文・review・comment。OneCLI（375 commit）の schema と `apps/gateway/src` の pickaxe、PR #4、#5、#7、#24、#43、#46、#56、#127、#170、#187、#204、#264、#407、#436、#448、#462、#497。synthesizer として追加で確かめたもの: v1.42.0 の `packages/api/src/app.ts`、`routes/agents.ts`、`routes/connections.ts`、`services/agent-service.ts:415-490`、`apps/web/src/app/api/[[...route]]/route.ts`、`schema.prisma:294`。OneCLI の `git log -S'"/:agentId/connections"'`、`-S'"/:connectionId/agents"'`、`git tag --contains`、`git show v1.36.0:…`（routes/agents.ts、manage-access-dialog.tsx）。nanoclaw の pin の履歴（`-G'"onecli-gateway": "1\.'`）、`git branch -a --contains 350e11fe`、`src/` と `add-onecli` の `secret-mode|secretMode` の grep、`docs/gateway-seam.md` と ADR 0003 の本文、`gh pr view 3989`。
- **Issue / ticket tracker**: GitHub Issues の onecli/onecli（145 件）、nanocoai/nanoclaw（904 件、Discussions 含む）、ashigirl96/nanoclaw（13 件）。全 title を走査し、約 90 の検索語（multiple accounts、multi-account、second account、app connection、connect url、mcp、sqlite、postgres、egress、credential、selective、per-agent、grant、outage、lockdown、agent_name、secretMode、1.42.0 など）で検索した。全文を読んだのは onecli #50 #51 #55 #121 #129 #177 #180 #183 #238 #263 #268 #297 #299 #372 #509 #588 #617 ほか、upstream #197 #458 #1500 #2195 #2286 #2433 #2437 #2655 #2657 #2731 #2781 #2902 #3118 #3205 #3532 #3874 #4068 ほか、fork #5〜#13 #22 #25 #27 #28、Discussions #3880 #2436。synthesizer は #3118、#3205、fork #11 の dump を読み直し、#238、#129、#2437 の引用を照合した。
- **Long-form documents**: Claude Docs MCP。keyword 検索の機能が無いため、Artifact の一覧（scope all、type Docs）を title で照合した。Docs は 3 件（すべて org 共有で無関係）。隣接する資料として HTML artifact「agent と OneCLI の経路」（2026-10-20、agent が書いたとみられる仕組みの説明）と「1Password 承認ポップアップと executor」を読んだ。deepwiki はコードの AI 要約で作者の意図の証拠にならないため使っていない。
- **Real-time team chat**: Slack MCP（`<work-org>` の workspace のみ）。`onecli`、`nanoclaw`、`gateway`、`kurumi`、`connect_url`、`"Gateway Outage"`、`grok`、`muse`、`Gmail`、`接続`、`credential`、`"Agent Group"`、`MCP`、`OAuth`、`mcporter`、`composio` など 28 の検索と、ユーザーのメモ用 channel と 1 つの thread の通読。nanoclaw の agent が投稿する workspace は届かず、検索できていない。
- **Infrastructure observability**: Not searched. No matching MCP available in this environment.
- **Error / exception tracking**: Not searched. Sentry MCP は一覧にあるが未認証で、`authenticate` の tool しか出ていない。
- **Product analytics warehouse**: Not searched. No matching MCP available in this environment.

### kurumi の設計制約（Preserve / Change / Avoid / Risk）

前提（context.md）: 1 つの SQLite、TypeScript のみ、gateway を同じコードベースに取り込む、Connected Account 単位の多対多の付与、chat の中からの接続。各項目の末尾に根拠を書く。根拠が推論のものは「推論」と書く。

**Preserve（守る）**

1. Credential の値は container の env、filesystem、process tree に入れない。container には placeholder を渡し、network の境界で注入する。根拠: #197、PR #798、#1500、#2781、onecli #55。host process の中で注入してもこの性質は守れる（PR #798 がそうだった）。
2. gateway が使えないときは fail-closed にする。credential の無い container を起動しない。届いた Inbound Message は pending のまま再試行する。根拠: PR #2110、gateway-seam.md:192-211。
3. 閉じた状態を終わりにしない。gateway の部分が復旧したら自動で admission を開く。止まっている間は利用者に分かるようにする。根拠: gateway-seam.md:207-211 の "strictly worse than crashing"、#2655、#2657、#2902。
4. agent が proxy を迂回して外に出られないようにする選択肢を残す。lockdown を使うときは、準備に失敗したら open egress に戻さず spawn を拒否する。根拠: PR #2713。
5. 管理用の API（アカウント一覧、token、付与の変更）に container から届かないようにする。container から届くのは proxy の口だけにする。根拠: onecli #263（1.42.0 で再現）、#268、nanoclaw #2433。
6. agent の身元を gateway で 1 つずつ見分け、Agent Group ごとに使える Credential を変えられるようにする。根拠: commit `4c6d9241`、PR #3817 の review。
7. 同じ provider の複数アカウントを、1 つの Agent Group が同時に持てるようにする。要望は実在する（onecli #180 は NanoClaw の利用者が 1 つの agent に全アカウントを載せていた例）。
8. 1 つの Agent Group に同じ provider のアカウントが複数あるときは、黙ってどれかを選ばず、選べないことを agent に明示する。根拠: OneCLI PR #187 と #462 の 409 + header の型。onecli #129 の "last matching one wins" は、その逆の振る舞いとして避けるべき例。
9. 暗号鍵と MITM の CA を、データと同じバックアップと復元の単位に入れる。根拠: nanoclaw #2286。

**Change（変える）**

1. Agent Group と Connected Account の付与を kurumi の DB に持ち、既定は付与なし（default-deny）にする。付与は 1 つの table に 1 か所だけ置く。根拠: OneCLI 自身が v1.43〜1.44 でそちらへ移った（PR #448、#462）。nanoclaw でも提案されている（#3205、#3532、PR #4094）。`all` の既定は特権昇格の経路と呼ばれた（onecli #297）。OneCLI v1.42.0 の join table と v2 equipment rule の二重化はずれの元である（how.md Gotcha 13）。
2. OAuth の callback で、接続を求めた Agent Group に付与する。OneCLI v1.42.0 はこれをしない（how.md §9）。fork #28 と commit `6143330f` はこれを前提にしていたが、実際には `all` mode で動いていただけだった。state には Agent Group と要求者を署名して入れる。
3. 承認カードを、要求を出した chat に出せるようにする。そのために、gateway で token から Session まで引けるようにする（how.md Gotcha 3）。OneCLI の要求に Session が無いのは、外部の gateway だったことの制約である（推論）。
4. policy、承認カード、request log に、どのアカウントを使ったか（connection の label）を残す。OneCLI v1.42.0 はこれを残さない（how.md Gotcha 7）。
5. Console は gateway の module を直接呼んで一覧を作り、付与の変更も Console から書けるようにする。ADR 0003 の主な理由（fork の merge 衝突）は kurumi では無くなる（推論）。残る理由「何がつながっているか見える」は満たす。
6. Agent Group を消したら、付与と token も消す。根拠: fork #27（今の seam には lifecycle の hook が無く、消した group の agent が `secretMode: all` の token とともに残る）。
7. 複数の Install が 1 つの gateway を共有する前提（`ownsAgentGroup`、identifier の衝突、#3874）は捨ててよい。gateway が Host と同じ DB を持つなら、この問題は起きない（推論）。

**Avoid（避ける）**

1. gateway が使えないときに credential 無しで起動したり、open egress に戻したりしない。根拠: PR #2110、PR #2713。
2. 認証の無い管理 API を、container から届く場所に置かない。根拠: onecli #263、#268。
3. OneCLI の旧モデル（`AgentSecret` + `secretMode` + `AgentAppConnection` + v2 rule への再生成）を写さない。upstream はこれを凍結した（PR #448）。
4. 新しい group や新しいアカウントを、既定で全 group に見せない。2 つ目の Gmail をつないだ瞬間に全 group の Gmail 呼び出しが 409 になる、という今の挙動を再現しない（how.md §10）。
5. agent が書いた本文の URL をそのまま接続ボタンにしない。接続カードは host が持つ信頼できる情報から作る。根拠: commit `69ee3e82`（他の origin のリンクを接続ボタンに見せかけられる穴）。
6. 表示用の値（`agent_name` のようなもの）に、付与の意味を負わせない。根拠: commit `6143330f` の思い込みと `ConnectApps.tsx:70` のコメントが、実際の挙動と違っていた。

**Risk（リスク）**

1. **process の境界が無くなる。** gateway の不具合や EMFILE（#2655）が、Host 全体の停止になる。復号した Credential が orchestration と同じ address space に乗る。nanoclaw の文書は、別 process であることを安全の理由として挙げていない（gateway-seam.md:59-69、CHANGELOG.md:117）。それでも、壊れたときの影響範囲は変わる（推論）。
2. **SQLite の書き込みが集中する。** gateway の hot path は、request log の insert と token refresh の書き戻しで DB に書く（how.md §7）。Host の書き込みと 1 つの writer を取り合う。how.md Gotcha 1（container の mailbox と 1 ファイルの SQLite が両立しない）とも絡む。
3. **TypeScript で MITM proxy を書く性能と正しさ。** OneCLI が Rust を選んだ理由として記録にあるのは "fast, memory-safe" だけで、計測は無い（Unknown）。TLS の終端、leaf cert の cache、CA の管理、WebSocket、AWS SigV4 などを自前で持つことになる。
4. **token refresh の競合。** OneCLI v1.42.0 は lock 無しで request の中で refresh する（how.md Gotcha 12）。refresh token を回転させる provider で、同じアカウントを複数の group が使うと競合しうる。多対多の付与をすると、この競合は増える（推論）。
5. **self-hosted の OAuth は手間が大きい。** provider ごとに自分の OAuth client が要る。private IP の callback を Google が拒む（Discussion #3880、onecli #301）。1 つの provider に OAuth client が 1 つしか無いと、別 workspace のアカウントをつなげない（onecli #180 の残課題）。in-chat 接続の体験は、callback の URL をどこに置くかで決まる。
6. **chat から接続や付与を始められると、prompt injection の経路になる。** agent が「アカウント B をこの group に付けて」と言える場合が危ない。OAuth の同意は人が押すが、既に接続済みのアカウントを group に付ける操作は人の承認なしに済みうる（推論）。MCP にするかどうかに関係なく、付与は人の操作で確定させる。MCP を gateway 側に置く案について、upstream の要望や議論は見つからない（Unknown）。
7. **複数アカウントの選択の負担。** OneCLI の型では、agent のすべての HTTP client（curl、MCP server、SDK）が header を付ける必要がある。custom header を付けられない client は使えない（how.md §10）。kurumi で別の選び方（アカウントごとの placeholder token など）を取るなら、その案に先例は無い（Unknown）。
8. **container から host の listener に届くか。** OneCLI は docker の port forwarder 経由で `host.docker.internal:10255` に届いている。Host process が自分で 127.0.0.1 に bind した listener に同じように届くかは未検証である（how.md Gotcha 16）。

### Confidence Summary

v1.42.0 OSS に connection 単位の付与 API があることは、コードと版の履歴で直接確かめた（確信度高）。#3118 の 404 が 1.36.0 の時点の話だという判断は、pin の履歴と #3205 の記述から導いたもので、確信度は中〜高（報告に版が無い）。「Credential を container に入れない」「fail-closed だが終わりにしない」「egress の迂回を塞ぐ」「seam は差し替えやすさのため」は、PR と doc の直接の記述がある。ただし seam の doc は AI 支援の PR で入り、人の review に印が無い。Gateway が別 process であること、OneCLI が Rust と postgres に分かれていることは、理由の記録がほとんど無い。どちらも cloud 製品の系譜と既製品の採用による経緯として読むのが最も記録に合うが、推論にとどまる。in-chat 接続の要望はユーザー自身のものしか無く、MCP 化の先例は見つからない。nanoclaw の agent が投稿する Slack workspace は検索できていない。
