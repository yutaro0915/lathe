# 敵対的レビュー: routines-foundation-design-v0.md（楽観の検出）

- 立場: 自作案（self-built-foundation-design-v0.md）を守る側からの攻撃。read-only・2026-07-08。
- 凡例: 各指摘は【位置】何が／なぜ。**[事実]**=対象文書・調査文書・実測に接地／**[推測]**=シナリオ構成（前提を明記）／**未確認**=どちらの案でも未実測。
- 対象文書は §7 で自己申告の誠実さが高い。よって攻撃は「注記した未確認が、本文の設計ではいつの間にか前提に昇格している箇所」と「注記同士を突き合わせると設計が自壊する箇所」に集中させる。

---

## A. 致命 — 設計が自分の調査結果と矛盾している

### A-1. envelope の回収経路が存在しない（最終メッセージは API で取得できない）
【位置】§2.1 構成図「最終メッセージ = envelope JSON ────┘」→ posting proxy／§4.3-1「最終メッセージ = envelope JSON 1 個」
**[事実]** rf-transcript-observability §2.2 は cloud session の retrieval API について「**取得不可: messages、tool calls、transcript**」と明記。§2.3 の stream API は「run 中のみ・遡及不可」で、§7-6 が自ら「常駐 listener が要るため cloud-only と両立しない＝hybrid でのみ成立」と注記している。
つまり **基線構成（cloud 全面）では、session の最終メッセージを proxy が読む確認済みの経路が一つも無い**。M4（構造化 I/O）・M5（終端契約）・M9（post-check）・§4.3 の「3 層機械保証」は全部 envelope の受理から始まるのに、その受理の配管が未規定。文書は §7-6 で stream の矛盾に気づきながら、それが envelope 経路を殺すことに気づいていない。
救済案（session 自身が DB に envelope を書く）は可能だが **[推測]**、その場合「最終メッセージ = envelope」という契約・UNPARSABLE 判定の主体・schema 強制の位置づけが全て書き直しになり、§4.3 は現状のままでは実装不能。**Step 0 の実測項目にも「envelope をどう回収するか」が無い**。

### A-2. dispatcher の「spawn」能力が土台なのに Step 0 の spike 項目に入っていない
【位置】§4.0-2「単一 spawn（M6）が allowlist を明示注入」／§2.1「spawn（注入prompt: thin bootstrap→repo scripts）」／§5 Step 0（実測対象 = (d)(e)(g)(c)＋DB 到達のみ）
**[事実]** dispatcher routine が別の cloud session を起こす手段は、(b) 動的生成 API か routine fire API のどちらかに依存し、文書自身が (b) を未確認と分類している（§3.1-M6「動的生成 (b) 未確認」）。ところが **Step 0 の existence proof リストに (b)／spawn 機構が含まれない**。claim INSERT（M1）が成立しても、claim 取得後に session を起こせなければ系は一切動かない——採用可否を左右する未確認が spike から漏れている。
さらに **[推測・仕様依存]**: fire API 経由なら (i) dispatcher session 内に platform API credential が要る（「credential を持たせない」原則と衝突・(d) と同類）、(ii) fire の payload に **run ごとの注入 prompt（issue 本文・前回 findings 全文等）を渡せるかが未確認**。渡せなければ R1 の「注入欠落なら spawn しない（fail-closed）」は「起動後に session 内で自己点検して自殺する」に劣化する＝spawn 課金は発生し、自己点検は LLM 遵守頼み（S2 クラスの再輸入）。

### A-3. posting proxy と watchdog の実行場所が「cloud 全面」と両立しない
【位置】§2.1（proxy が構成図に居るが実行基盤の記載なし）／§4.1 watchdog 行「**LLM なし・決定的スクリプト**」
- **watchdog**: routines の実行単位は LLM session（rf-problem-mapping §0 実測: prompt=SKILL.md の fresh session）。**「LLM なし」の routine はこの platform 上に存在できない**。実体は「LLM が script を叩く」であり、保証の最下層（M2/M5 補償・gov:* 剥がし・検収 4 点）に LLM の指示遵守という確率層が挟まる。自作案の watchdog（systemd oneshot・純プロセス）と等価だという含意は成立しない。
- **proxy**: 「決定的 render・唯一の credential 保持」を LLM session でやるのは自己矛盾（決定性・credential 隔離の両方が崩れる）。ではローカル/自前サーバーで動かすのか——**その瞬間「cloud 全面移行」は偽になり、常駐 or timer の自前プロセス＋宿主管理（E クラス・M8）が戻ってくる**。§3.1-M8「宿主依存が消滅」と正面衝突。OTLP collector も同じ: §2.1 は「OTLP collector → lathe ingest 変換 pipeline」を描くが、collector は self-hosted の常駐サービスであり（rf-transcript §採用リスク 2「Collector infrastructure の導入・保守」）、**routines 案は現行系に無い自前常駐を 2〜3 個（proxy・collector・DB 到達監視）新設しながら「platform が宿主を消す」と集計している**。M8 の [platform] 判定は agent run にしか当てはまらない。

---

## B. 相関故障 — 監視者と被監視者が同じ未確認の上に立つ

### B-1. 系外監視の不在（自作案 §4.6 の対応物が無い）
【位置】§3.1-M2／§4.1 watchdog／rf-problem-mapping §9-7
**[事実]** dispatcher と watchdog は相互 dead-man's switch だが、両方とも (i) 同一 platform の routine 発火、(ii) 同一の未確認 (d)（cloud→managed Postgres 到達）に依存する。platform 障害・egress 遮断・quota 枯渇（(c) 未確認）のどれでも**両者が同時に沈黙し、その沈黙を報じる者が系内に居ない**。rf-problem-mapping §9-7 は「両方同時死は platform 通知（未確認）頼み」と正直に書くが、routines 設計 v0 の watchdog-checks 9 項目に**系外 heartbeat が無い**。自作案は GitHub Actions cron の外部突合（§4.6）を最終段に置いており、この一点で「silent death を人間より先に機械が報じる」（charter M2 の核）の充足度が構造的に違う。cloud-full ではこの Actions 突合を足すこと自体は可能なのに、設計に入っていない＝S1-1 の再演シナリオがそのまま残る。

### B-2. fail-closed の副作用: DB 不達 = 全停止、かつ全停止が silent
【位置】§3.1-M1「DB 不達時は実行しない」
fail-closed 自体は正しい。しかし cloud session からの DB 到達は経路・egress とも自分で制御できない（(d) 未確認）。**[推測]** 一時的な到達不能が起きると dispatcher は「正常に何もしない」で終了し、outcome も heartbeat も DB に書けない（書く先が落ちている）。watchdog も同じ DB を見る。結果「全 routine が定刻に発火し、全パスが no-op」という**最も検知しにくい停止形態**が新設される。自作案（ローカル Postgres・同一ホスト）では到達不能は即ちホスト異常＝外部 heartbeat が拾う。routines 案はこの縮退モードの検知経路を規定していない。

---

## C. cap・silent drop の実害シナリオ

### C-1. run 上限 × stage 粒度再開 = 長尺 IMPLEMENT の livelock（課金だけ増える）
【位置】§2.1 要点「run 上限接近・CI 待ちで graceful 終了」／§5 数値パラメータ
**[事実]** 「上限接近」を検知できる前提で書かれているが、(c) は上限値どころか**接近を知るシグナルの有無ごと未確認**。警告なしで kill されるなら graceful 終了は走らず、ledger に terminal 行が無いまま lease TTL 満了まで停止→watchdog が dead 判定→再 claim。
**[推測・実測接地]** 再開粒度は stage 単位なので、**1 stage が run 上限より大きい場合、毎回ゼロから再実行して毎回同じ地点で殺される**。実測には 306 turn・$7.70 の単発 IMPLEMENT が存在する（meta-audit-agent-efficiency §③(c)）。claims は (issue, stage, attempt) で attempt が増えるが、**attempt の上限・cross-pass breaker が §4 のどこにも規定されていない**（plan 再試行 2 回・CHANGES 2 周はあるが cap-kill 起因の再 claim には効かない）。現行 orchestrator が持つ outcomes.jsonl breaker（rf-problem-mapping 冒頭で実測確認済み）の後継が消えている。検知は G9 のコスト異常のみ＝それ自体が C-2 の劣化観測の上。

### C-2. OTel 経路は at-most-once — 証拠が「一番要る瞬間」に永久消失する
【位置】§1-1「5〜60 秒 batch・過去遡及不可」／§4.1 watchdog 検査 9「観測突合」
**[事実]** rf-transcript §3.3「Historical retrieval は不可（export 時点で完成）」。したがって collector 停止・ネットワーク断・**session 死亡時の最終 batch 未 flush**（flush 保証は未確認）の間のデータは**再取得手段が存在しない**。watchdog 検査 9 は「欠落の検知」はできるが**回復ができない**——検知しても打つ手が「欠落と記録する」だけ。
実害の具体形 **[推測]**: silent death した run では、死因を語る最後の 5〜60 秒（エラー・最終 tool call）がまさに落ちる。M2 は「死んだこと」は検知できても「なぜ死んだか」の証拠が構造的に欠ける。ローカル JSONL は file として残り ingest はいつでも追いつける（at-least-once・自作案は無劣化）のと対照的に、**観測プラットフォームの自己観測が lossy stream に格下げされる**。これは「劣化」という言葉が示唆する量的低下でなく、durable log → best-effort stream という**質の変更**。

### C-3. dispatch のコストと quota が未見積
【位置】§4.1 dispatcher（cadence 5 分）／§6-3「コスト削減は選定理由にしない」
cadence 5 分 = **288 LLM session/日**が「gh 導出→述語評価→INSERT」という決定的作業のためだけに回る（＋watchdog 毎時＋毎パス軽量版）。自作案の同じ仕事は oneshot node プロセス＝限界費用ほぼゼロ。金額を選定理由にしない裁定は課金の話であり、**(c) の並列数・コスト上限に polling が食い込めば dispatch 飢餓（=スループット崩壊）という機能問題**になる。文書にはこの見積りが一行も無い。

---

## D. M3 未解決の帰結 — 文書の自己申告より重い

### D-1. (g)=本人身元なら、承認検証機構そのものが自壊する
【位置】§4.4「承認の効力判定（3 層）」
actor 検証は「labeled イベントの actor ∈ 人間 allowlist」を効力根拠にする。しかし (g) が「本人身元実行」だった場合、**全 routine の gh 操作の actor が PdM＝allowlist 内の人間として記録される**。つまり M3 が platform 仕様で解決しない世界では、(2) actor 検証は bot を弾くどころか**bot の誤投・暴走 approve を「人間の承認」として通す**。S2-11（承認汚染）は「悪化しうる」（§6-1）ではなく、**本設計の防御装置が汚染を正規化する**——防御が攻撃面に反転する。3 層のうち (1) credential 分離が platform 依存で建たなければ (2)(3) は独立の防御ではなく同じ穴の投影。

### D-2. Step 1〜3 は権能分離なしの実弾運転
【位置】§5（権能分離は Step 4・「D2(c) 裁定後」）
Step 1〜3 で実 issue を plan→merge まで通し、全書込 proxy 化（Step 3）まで進める。この間 inner も proxy も分離なし＝**現行と同じかそれ以上の session 数が PdM 身元で gh に触れる**。しかも Step 3 の proxy は credential 分離の実現可否を知る前に建てる——(d)(g) が不成立なら、proxy は「fail-closed の権能分離」から「PdM token で動く書込ログ装置」に silent に格下げされ、**設計図の M3 行だけが [自前] のまま残る**。自作案は Step 0 (i)（OS user 分離の existence proof）を最初に置き、不成立なら採用裁定に戻す——順序が逆。

### D-3. M11 が API 経由の自己改修に開く
【位置】§3.1-M11「routine 定義の作成・削除・cron 変更だけはゲート外」
**[推測・(b)(g) 依存]** 現行系で loop 本体を触るにはホストへの到達が要る。cloud routines は定義変更が platform API/UI で完結するため、(g)=本人身元＋(b)=動的生成可なら、**任意の inner session が理論上 routine 定義（＝loop そのもの）を作成・改変できる**。M11 の残余は「運用規律」で済む規模ではなく、M3 未解決と掛け算で「loop が loop を書き換える」経路が現行より広がる。

---

## E. OTel 判定 B の実運用での意味 — 今日の meta-audit は再現できたか

【位置】§6-2（D4）「tool span・token・cost は取れるが full message history・事後遡及は不可」——この一行が隠している中身を、**今日（2026-07-08）実際に行った 2 本の meta-audit** で照合する。

### E-1. agent 効率監査（meta-audit-agent-efficiency.md）: **ほぼ全滅**

| 今日の分析 | 必要だった観測 | 判定 B での再現 |
|---|---|---|
| §0 コスト表（stage 別 $/turn/cache-read） | token・cost metrics | **可**（ただし cloud 単価一致は未検証・D4 材料） |
| §① #229 の 44 tool-call 列（発掘 22 call の同定） | call 順序＋**入力内容**（どのファイルを読んだか） | tool span で順序は可の見込み（traces beta・cloud 適用**未確認**）。**入力は full I/O opt-in 依存** |
| §③(a) 同一ファイル再読 3.0/session・最悪 19 | Read の対象パス | **不可**（opt-in 無しでは tool 名しか残らない） |
| §③(a) bash 613 回の 37%=explore 分類 | コマンド文字列 | **不可**（同上） |
| §② #224「reviewer が diff を渡されず再発掘」という構造欠陥の発見 | transcript の call 列＋内容 | **不可** |
| §③(c) #254 **Stop hook 二重課金**の発見（result_text の「改めて正式フォーマットで…」という文言が証拠） | **message history** | **不可**——message history は判定 B で最初に切り捨てられる層 |

つまり今日の改善提案（anchor 注入・diff 注入・Stop hook 修正＝IMPLEMENT/REVIEW バケットの 30〜40% 削減見積り）は、**そのどれ一つとして判定 B の観測からは導出できなかった**。metrics は「IMPLEMENT が turn 108 で高い」までしか言えず、「なぜ高いか（発掘・再読・書式再生成）」は全て I/O とメッセージ本文から出ている。

### E-2. duration 監査（meta-audit-189-duration.md）: 半分生存
stage 別時間・idle 分解は DB ledger で代替可（むしろ改善）。ただし **#229 の 53.7 分 in-process stall の死因同定（API socket error）は transcript/log 依存**＝判定 B では「長かった」までで止まる。

### E-3. 帰結: 「劣化」ではなく改善ループの証拠基盤の喪失
lathe の存在理由は「既存 agent の観測・改善・評価」（AGENTS.md）であり、機能 1 はトランスクリプト表示・分析。判定 B の受容は (i) **自系の開発ループから、今日実際に成果を出した種類の分析を恒久に除外**し、(ii) lathe が自分自身を dogfood できない製品になる、という二重の意味を持つ。§6-2 はこれを「tool I/O 全文が必須なら hybrid へ」と条件文で書くが、E-1 の照合が示す通り**必須かどうかはもう実証済み（今日の監査が existence proof）**——D4 は開いた裁定ではなく、B 単独では要件を満たさないことが本 scratchpad 内の証拠で閉じている。基線構成（§2.1）を cloud-full に置くこと自体が、この閉じた証拠に反する楽観。

---

## F. 中〜小粒（設計の穴として記録）

1. **stage 別 allowlist × run-internal の両立不能**【§4.1】: plan-review（Bash なし）・verify（selector コマンドのみ）は run-internal＝同一 session 内遷移。**単一 cloud session の途中で permission セットを切り替える機構は未確認**。取れる形は (i) 全 stage の union を許す（最小権限の主張が崩れる: review 中に Edit/Write が生きる）か (ii) session 内で nested headless spawn（cloud sandbox 内の CLI 実行可否・課金とも未確認）のどちらかで、文書はどちらとも書いていない。
2. **verify の動的 allowlist**【§4.1 verify 行】: 「selector 選定の検証コマンド列」は run ごとに変わる。spawn 時に per-run allowlist を注入できるかは (e) と同類の未確認で、静的 pattern しか許されないなら「列挙外 deny」は絵になる。
3. **watchdog の bot credential**【§4.1 watchdog 行】: 「gh **bot** credential」を持つと明記されるが、これは M3（未解決）の解決後にしか存在しない資格情報。M3 未解決のまま Step 2 で watchdog を常設すると、gov:* 剥がし・escalation 起票も PdM 身元で走る（D-1 と同根）。
4. **「イベント trigger 無しでも成立」の非対称な適用**【§1-2 分岐規則】: (a) 未確認には「cron だけで成立する基線」という防御を張るのに、(b)(d)(e) には同型の防御（無しでも成立する形）が無い——未確認の扱いが恣意的に選別されている。
5. **数値パラメータの継承**【§5 末尾】: cadence 5 分・lease TTL 等を「現行値の継承」とするが、現行値はローカル実行（spawn 遅延ゼロ・cap なし）で測った値。発火→session 起動のレイテンシも (c) の cap も未知の環境に、旧環境の定数を初期値として持ち込むこと自体が S2-2（stale 定数）の型。

---

## 総括（守る側の結論）

routines 案の §7 は誠実だが、本文は**「未確認 (b)(d)(e)(g) がすべて都合よく解決した世界」を基線と呼んでいる**。確認済みの事実だけで組めるのは §2.2 hybrid のみで、その hybrid は自作案から transcript 主権と M3 の構造解と R5 を引き算し、E クラス管理をそのまま残した劣化形にしかならない。さらに A-1（envelope 回収経路の不在）は仕様確認以前の**設計内部の矛盾**であり、Step 0 を通っても解消しない。判定 B の実運用上の意味は E 節の照合で閉じており、「劣化の受容」ではなく「今日やった仕事を明日からできなくする」選択である。
