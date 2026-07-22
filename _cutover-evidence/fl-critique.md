# 敵対検証: fl-* 4 設計の横断 critique（2026-07-08）

- 対象: `fl-velocity-requirements.md`／`fl-temporal-design-v0.md`／`fl-alternatives.md`／`fl-github-role-redesign.md`（本 scratchpad）
- read-only。検証手段: 保存済み gh JSON の再計算・gh API 読み取り（issue #256/#281・branch protection・issue 検索）・repo 正本（ci.yml・ADR 0035/0036）・Temporal 公式一次情報の fetch（URL は各所）。
- 記法: 【確認】= 本検証で機械照合済み／【推測】【未確認】明記。重大度 = 高／中／低（裁定の結論を変えうるか基準）。
- 構成: A=velocity 目標値（重点①）／B=Temporal platform 保証（重点②）／C=やりすぎ検出（重点③）／D=統治の操作性（重点④）／E=文書間矛盾（重点⑤）／F=攻撃して耐えた点／G=本 critique 側の未確認。

---

## A. velocity 目標値は実測から正当化されているか（重点①）

### A-1【高】V1 の錨「PdM 発言そのまま」の一次出典が資料束のどこにも無い
- 位置: fl-velocity §2 表頭「PdM『1 日 10〜20 PR・動的で高速』の翻訳」・V1 行「PdM 発言そのまま」。
- 何が: この発言の出所（issue/Discussion/charter の URL・日時）が無い。scratchpad 全ファイル grep で「10〜20 PR」を含むのは fl-velocity 自身のみ【確認】。charter material・discipline 系・repo issue 検索（`gh search issues`）にも該当発言なし【確認】。
- なぜ問題か: fl-velocity 自身の記法宣言（【引用】= 出所つき他者計測値）に反する。V1 は V5（同時数）・V7（バースト）・V8（予算）の導出根拠であり、要件体系全体の根が未接地。orchestrator の口頭指示由来なら「PdM 発言（2026-07-08 口頭・記録なし）」と明記して裁定時に本人照合すべきもの。
- 注: V2（#256「1,2,3 承認」・p95 15 分）と V3（#281「いいだろう」・1 パス 5 分）は issue 本文で実在確認済み【確認】＝この 2 つは接地している。未接地なのは V1 の錨だけであり、だからこそ目立つ。

### A-2【中】「能力の背伸びではない」は自分の数字と緊張している
- 位置: fl-velocity §2 前提文「目標は能力の背伸びではなく『単日ピークを事故なしで毎日再現する』ことの定式化」。
- 何が: 実証は単日ピーク 22（inner 17＋explain 5。branch prefix 分類で再計算し一致【確認】）。同日は事故多発日かつ outer bootstrap 38 件併走日（ADR 0035/0036 着地日）【確認】。直近 5 日の自律 loop 産は 9・2・0・22・11（部分日）＝平均 ≈8.8/日・中央値 ≈9。
- なぜ問題か: 「持続 10〜20（5 営業日移動平均）」は実測持続力の 1.1〜2.3 倍の外挿。attainability（1 回到達）と sustainability（毎日再現）は別の主張で、後者の律速（issue 供給・PdM 承認・A-3）は機械側要件 V2〜V8 では解決しない。V1 行自身が「中央値はるかに下」と書いており、前提文のレトリック（ピークを床に読み替える）が実測の飾りとして機能している。目標としては可（PdM が望むなら）、「実測に正当化された」とは言えない。

### A-3【高】4 文書のどこにも「人間律速の予算」が数値化されていない
- 位置: 束全体（fl-velocity §2 に不在・fl-github §5「先に折れるのは読む人間」は定性のみ）。
- 何が: ADR 0035 は重要 task に PdM の plan 読解＋Ready 承認を要求する【確認】。V1=20 PR/日 は 20 件/日の plan・教材読解（fl-github 自身が O(数分〜数十分)/件と置く）＝**PdM 時間 1〜数時間/日** を毎日要求する。この予算が成立するかの検討・実測（07-07 に PdM が承認に費やした時間）がゼロ。
- なぜ問題か: 1 人＋agent 群の系で束縛制約が人間なら、V1 持続は基盤選定と独立に不成立で、V2（15 分反応）や Temporal 級投資は**非拘束制約の最適化**になる。「velocity 要件 → 基盤が壊れる → 強い基盤」という 4 文書の論理連鎖は、最初の矢（velocity が機械律速である）を検証していない。実測の Ready→着手 p95 52 分の内訳（機械遅延 vs PdM 不在時間）の分解が先。

### A-4【低中】V5「定常 3〜5」の導出は過小見積り側に偏る
- 位置: fl-velocity §2 V5 行＋【推測】注。
- 何が: 20 PR/日 × active **median** 18.3 分 ≈ 6.1h。分布は右裾（p90 46.2・max 107）で平均は median を大きく超え、1 PR=1 run 仮定（escalation・失敗 run の busy 無視）も同方向に甘い。
- なぜ問題か: 同時 3〜5 という結論自体は多分保つ（平均 25〜30 分でも 8〜10h/日＝3 並列で日中に収まる）が、V5 は V6 排他の設計点と B 系事故の再現条件に使われる数字であり、導出は mean ベース＋PR/run 実測比で締め直すべき。【推測】明記は誠実。

### A-5【中】V8「$70〜200/日を許容包絡」は予算裁定の先取り
- 位置: fl-velocity §2 V8 行。
- 何が: 月換算 $2,100〜6,000 の支出包絡を「許容」と書くが、PdM の予算承認の引用が無い。charter D1「コスト削減は選定理由にならない」は**選定理由の統制**であって、支出上限の承認ではない。
- なぜ問題か: 要件表に載ると下流設計が既承認予算として扱う。V8 は「目標」でなく「PdM 裁定が要る点」へ降格すべき（工数・スコープ判断をユーザー指示なく行わない規律とも整合しない）。

### A-6【低中】V1 の計数定義は Goodhart 脆弱
- 位置: fl-velocity §2 V1（inner+explain 合算）と §3 B8（教材も 10〜20 本/日）。
- 何が: 教材 PR は auto-merge される自動生成物。合算定義では「task 8 本＋教材 7 本＝15 PR/日達成」が成立する。
- なぜ問題か: 移動平均を目標化した瞬間、系は最も安い PR（教材・docs）で目標を満たすよう最適化されうる。V1 は task loop PR に限定するか、inner/explain を別指標にすべき。

---

## B. Temporal 案の「platform 保証」タグは公式仕様に裏付くか（重点②）

### B-1【高】M1「hard guarantee」のスコープが要件 V6 の窓と重なっていない — Reuse Policy の欠落
- 位置: fl-temporal §0-2「claims テーブル自前実装が丸ごと消える」・§6 M1 行「両案より強い」。
- 何が: 公式仕様の実照合【確認・https://docs.temporal.io/workflow-execution/workflowid-runid 】: 保証は「**running な execution は同時に最大 1 本**」（Conflict Policy 既定 Fail）。一方 **Workflow ID Reuse Policy の既定は Allow Duplicate**＝closed（完了・失敗・terminate）後は同 ID で新 execution を**開始できる**。fl-temporal は Reuse Policy に一切触れていない。
- なぜ問題か: fl-velocity §1.5 の定理は「evidence 着地 lag（run 完走〜投影着地）> pass 間隔 → gh 導出の再実行判定が二重を生む」であり、危険窓は **run 終了後**にも延びる。fl-temporal は M10 で「task 状態は gh 導出を維持」＋intake schedule が gh 導出で startWorkflow する設計のため、workflow close 後に投影（issue close・comment）が lag すれば、intake が「未完了」と誤読して task-N を再 start する——**既定設定の platform はこれを止めない**。EXPLAIN#236 型（同時 open）は防げるが、S1-2 クラス全体が消えるわけではない。RejectDuplicate にすれば塞がるが正当な再走（失敗後の再 dispatch）も塞ぐ＝どの Policy でどう再走を許すかは**消えたはずの claims 設計判断がそのまま残る**。「claims テーブルが丸ごと消える」は過大広告。routines の時と違い仕様自体は実在・URL 付きだが、**保証のスコープを自分の要件（V6: in-flight 全期間＋投影 lag）に重ねる検算を省いた**点は同型の楽観。
- 修正方向: (a) Reuse/Conflict Policy の明示裁定 (b) intake の再開始判定を「gh 導出」でなく Temporal 側照会（同 ID の execution 履歴）or posting 台帳に変える＝E-1 の解消と同件。

### B-2【低】検証して耐えた点（公平のため明記）
- Worker Versioning **GA は事実**【確認・https://temporal.io/blog/ga-worker-versioning-public-preview-upgrade-on-continue-as-new 2026-03-30「Generally Available across all Temporal SDKs」。Public Preview は Upgrade on Continue-as-New の方】。pinned の引用文言も docs に実在【確認】。
- ただし self-host は **server ≥ v1.29.1・CLI ≥ v1.4.1・UI ≥ v2.38.0 が条件**（docs 記載【確認】）——設計書はこの最低版数を書いておらず、Step 0 spike の検証項目にも無い（小穴・低）。
- activity 内 checkpoint なし・worker 常駐 stale・history 上限・TS sandbox の記述は公式と整合【確認】。「正直な代償」§7 の自己申告も含め、routines 案で批判された「未確認を基線に置く」楽観は概ね回避されている。B-1/B-3 が例外。

### B-3【中】V3 適合の設定値と移行窓の隔離手順が未記述
- 位置: fl-temporal §3（heartbeat 30 秒毎・start-to-close 90 分）・§9 Step 1〜4。
- 何が: (a) M2 が V3（検知 ≤5 分）を満たすのは heartbeat timeout をその値に設定した場合のみ——設計に timeout 数値が無く、V3 との対応も書かれていない。(b) Step 1〜4 の間、旧 launchd orchestrator と Temporal が併走する（退役は Step 5）。旧 fs 排他×新 platform 排他の非共有＝S1-2 再発窓は critique-self-built D-2 が自作案に当てた指摘と同型だが、Temporal 案には隔離手順（gov:hold 等・自作案 D-1e 相当）が書かれていない。Step 2 の「並列 2 issue で二重不発」は新系内の検証であり、**旧新併走の二重**を検証しない。

### B-4【低中】規模の自己記述が束内で 1 桁ずれている
- 位置: fl-temporal §7-3「実測 66 run/期・数 task/日」vs fl-velocity（79 run manifest・起票ピーク 42 件/日・V1 10〜20 PR/日＋教材同数）。
- なぜ問題か: overkill 論（C 節）はどちらの数字でも成立するが、同日作成の裁定資料で負荷の自己記述が 10 倍ずれているのは、PdM が「規模ミスマッチ」の大きさを見誤る素地になる。fl-velocity §1.6 が数え方の差を説明済みなのだから fl-temporal 側が引き直すべき。

---

## C. 「やりすぎ」の検出 — 軽量代替との突き合わせ（重点③）

### C-1【高】4 文書は合流していない: Temporal と軽量代替が同じ物差しで比較されていない
- 位置: fl-temporal 冒頭の入力列（fl-alternatives が**無い**）・fl-alternatives 全体（M1〜M13 への写像が**無い**）。
- 何が: Temporal には M1〜M13・R1〜R8 の full 対応表があるが、DBOS/Restate/pg-boss には無い。逆に fl-alternatives の評価軸（常駐物最小・既存 PG 活用・TS 親和）には charter の存在理由である M1（物理排他）・M2（silent death 検知）が**含まれていない**＝DBOS 1 位はこの軸選択の産物。critique-self-built E が自作案に当てた「比較枠を切った時点で結論が半分決まる」批判が、fl-alternatives 自身に適用される。
- なぜ問題か: PdM は「Temporal vs DBOS vs 自作」を同解像度で見られない。特に DBOS の急所——**プロセス生存中 hang の検知が未確認**（fl-alternatives 自認）——は M2/V3・事故 #281（PdM が自ら発見した silent death）そのものに刺さる論点なのに、spike 提案（Temporal Step 0 相当）が無く「要検証」で放置。裁定前に「M1〜M13 × {Temporal, DBOS, 自作}」の 1 枚表と DBOS hang 検知の 1 日 spike が要る。

### C-2【中高】Temporal の限界優位は「行数」でなく 3 点に縮む——それを 4 コンテナ＋新バグクラスで買う構図
- 位置: fl-temporal §0-8（1.2〜1.8k 行 vs 自作 2.5〜3.5k 行）・§6 規模見積り。
- 何が: (a) 保証の中身で比べると、M1 相当は 3 案とも達成可能（claims の `INSERT ON CONFLICT` は数十行の確立部品。B-1 のとおり Temporal でも再開始判定の設計は残る）。M2 の突合も #281 の PdM 承認済み plan では**純関数 5 個**。つまり「platform 化で消える保証コード」は薄い。(b) 行数比較には critique-self-built A の「会計境界」批判がそのまま適用される: Temporal service の運用（podman 4 コンテナ・専用 PG・schema migration）・replay test・学習 1〜2 週（自認・実測なし）は行数外。(c) fl-velocity の負荷要件（V5 同時 ≤10・V7 分単位バースト・V1 20/日）は **fl-alternatives の全候補が余裕で満たす**——throughput は選定を一切弁別しない。
- なぜ問題か: 差し引きで Temporal 固有の実利は ①M11 pinned の機械強制＋replay test ②activity heartbeat による hang 検知 ③保証実装の bus factor 緩和、の 3 点に縮む。これは「採る理由が無い」ではなく「**この 3 点に 常駐系 1 式＋non-determinism という新バグクラス＋学習週の値札が付く**」という交換であり、fl-temporal §7 は値札を正直に書いたが、**3 点それぞれに軽量代替（DBOS の workflow fork/replay 相当・自作 watchdog）でいくら掛かるか**の対置が無いため、交換の妥当性を PdM が判定できない。
- 補: 「プロジェクト外のハーネスは必要ない」（PdM 裁定 2026-07-08）に最も適合する形態は app 内ライブラリ＋既存 PG（DBOS 型）であり、この整合性軸でも対比が裁定材料に出てこない（fl-temporal は自案の緊張だけ §8-1 で申告している——誠実だが比較が無い）。

---

## D. GitHub 再設計は統治の操作性を壊していないか（重点④）

### D-1【中高】B 案（gov:approve label）は「未確認 vs 未確認」の比較で優位を宣言している
- 位置: fl-github §4 3 案比較・「= 当面の優位案」。
- 何が: B 案を推す決め手は (a) actor の機械検証可能性 (b) S2-2（Projects option id）面の消滅。しかし (a) は B 側も **timeline actor 網羅性が未確認**（M12 第 1 号・自認）、(b) は同じ表の A 行で「名前解決＋contract test で緩和済み」と自認＝限界利得。一方、人間側は「issue 画面・モバイルで 1 タップ」（GitHub Mobile の label 付与は実際には issue を開いて label picker を操作する複数タップ・**未実測**）vs 盤面 drag（既習・ADR 0035 で「PdM の操作面は Projects に一元化」と**裁定済み**【確認・adr/0035 §7】）で、§10 が自認する通り操作性は両側とも裏取りなし。
- なぜ問題か: ADR 0035 は **前日（2026-07-07）の PdM 裁定**であり、「Ready 待ちの列にあるのは重要で読み物付きの needs-review だけ」という認知モデルは運用で価値が確認された統治資産。それを翌日、未確認の機械側利得と未確認の操作性主張で覆す推奨は結論先行。§9 で裁定に載せている（A 継続の選択肢も明記）のは正しい作法だが、「推奨」の重み付けは実測（PdM の実際の承認動線・デバイス・所要）を取ってからにすべき。承認は本系で最も高頻度の人間操作（V1=20/日なら 20 回/日×毎日）であり、1 遷移の増加も年間で大きい。

### D-2【中】移行ハザード: 既習動作（drag）が「承認したつもりで発火しない」に化ける
- 位置: fl-github §4 推奨（盤面は純投影へ降格）・§7 新設リスク列挙（本件が**無い**）。
- 何が: B 案でも盤面は投影として残る＝Ready 列は見える。しかし機械が読まなくなるため、既習の drag は**無効な儀式**になる。PdM が drag だけして label を忘れると、承認は永久に発火せず、系は正しく待ち続ける（fail-closed なので機械は誤動作しないが、**統治が silent に止まる**——S3-1 の人間版）。
- なぜ問題か: 新設リスク節（§7 末尾）に (i)〜(iv) を正直に列挙しながら、この最も起きやすい人為事故が漏れている。対策（watchdog が「Ready 列在中 × gov:approve 不在 ×N 分」を検出して issue に注意コメント／移行期間は両入力を等価に読む等）の設計が要る。

### D-3【低中】教材の issue comment 一次配信は「読む面」を自分で劣化させる
- 位置: fl-github §6 一次配信の移設。
- 何が: issue スレッドには既に plan 全文・escalation report・投影 comment が堆積する（#281 実物: plan×3＋escalation＋教材リンク×2＋解除 comment【確認】）。そこへ数千語級の教材本文が加わると、20 PR/日ペースでは issue の可読性（特にモバイル）が承認の場で劣化する。
- なぜ問題か: 「承認材料と承認操作の 1 面化」という狙いは正しいが、1 面化の実装が「同一スレッドへの全文投下」である必然は無い（collapsed section・固定 comment の更新・先頭 100 語＋リンク等の設計余地）。ADR 0035 の認知モデルを置換する具体設計（label フィルタビューで「読み物付き待ち行列」を再現する等）も未記述。

### D-4【低】§2「実測パラメータ」の 07-04 = 5 件は窓切れの誤り
- 位置: fl-github §2 着地件数/日。
- 何が: `--limit 100` の窓が 07-04 の途中で切れており、実際は 31 件（gh-prs-merged.json n=132 で再計算【確認】。fl-velocity の表とも一致）。
- なぜ問題か: 結論（ρ 計算は 20/日と peak 60 を使用）への影響は無いが、「実測」を掲げる章の数字の誤りは、同じ束の fl-velocity と矛盾したまま PdM に届く。裁定資料としての信頼を削る種類の傷。

---

## E. 4 文書間の前提矛盾（重点⑤）

### E-1【高】状態の読み戻し方向が正反対 — fl-github の根治規律を fl-temporal が破っている
- 位置: fl-github §5 方向規律 2「**状態を GitHub から読み戻さない**（正は engine DB）」 vs fl-temporal §6 M10「**task 状態は gh 導出を維持**」＋「workflow は毎判断 gh を activity で読み直す」を規律化。
- 何が: fl-github は S1-2（二重 dispatch/生成）の再発火条件を「gh からの状態読み戻し」と特定し、その禁止を根治としている。fl-temporal は逆に、二重台帳回避のために gh 再読を規律化する。両立しない。
- なぜ問題か: PdM が「GitHub 再設計＋Temporal」を同時採用すると、どちらの規律が正か未定義のまま実装に入る。B-1 と連成: Temporal 案が gh 導出を維持する限り、close 後の投影 lag 窓で S1-2 残余を持つ。解消は「intake の再開始判定だけは engine 側（Temporal 照会 or posting 台帳）・人間入力（起票・承認）だけ gh から読む」という fl-github 規律への fl-temporal M10 の書き換え＝設計修正が必要で、これは裁定前に文書側で揃えるべき矛盾。

### E-2【中高】fl-github の「CI 1 分」定数は、自分たちの charter（M13/S2-12）が壊す予定の前提
- 位置: fl-github §2（ρ≈1.4%）・§3（A' 「+1 分/件」・batch 棄却）vs charter M13（CI 検証資産全量）・S2-12（#279 CI ザル）。
- 何が: ci.yml 実測【確認】: heavy 層（e2e/storybook/integration/judge）は**意図的に CI 外**（「verifier 段の責務のまま。CI 昇格は #69 / TASK-16 系で再訪」とコメント明記）。つまり現在の 51 秒は軽量 tier の速さ。M13 を果たして heavy を CI に上げれば CI 所要は桁で伸び、fl-github 自身が「batch が効く条件は CI ≥ 30–70 分」と書く領域に近づく。
- なぜ問題か: ①の裁定（A' 推奨・batch 棄却・direct-to-main 棄却）のうち定量根拠部分が「M13 をやらない世界」の数字で組まれている。A' の update-before-arm は 1 merge ごとに CI 1 本を直列挟むので、CI が 10 分になれば +10 分/件・wave 尾は k×10 分。棄却結論自体は D 案・C 案とも定性理由（ゲート迂回の制度化・S2-4 再輸入）で保つ可能性が高いが、**M13 後の CI 時間予算を置いた感度分析**なしに「ほぼ無料」とは言えない。judge を CI に上げる場合の LLM key 配置（M3 との緊張）も未記述。

### E-3【中】V4（着地 p95 ≤5 分）と A' 直列 arm の wave 尾が衝突する
- 位置: fl-velocity §2 V4 vs fl-github §3 A' 行「wave k=15 でも尾 15 分」。
- 何が: V7 は「1 pass 6+ dispatch のバーストを正常系として設計せよ」と定める。バーストが正常なら k≥6 の同時 arm 待ちも正常に起き、CI 1 分でも尾は 6 分超＝V4 の p95 5 分を破る（CI が E-2 で伸びればさらに）。
- なぜ問題か: 要件（V4/V7）と推奨機構（A' 直列 arm）が同じ束の中で数値照合されていない。V4 を「正常系 p95」と再定義するか、A' の直列度を並列 arm＋strict 保証の別形にするか、どちらかの調整が要る。

### E-4【低中】rework 率が束内で二重定義（36% vs 50%）・fl-github の脚注は誤記
- 位置: fl-velocity §1.3（25/70 run = 36%・run 単位）vs fl-github §2（CHANGES 18/LAND_REVIEW 36 = 50%・stage 件数単位。出典 meta-audit-agent-efficiency で確認【確認】）・fl-github §10 脚注「実測 rework 率 50% は run 単位の集計」＝**誤記**（stage 単位が正）。
- なぜ問題か: batch 棄却の P≈97% は 50% 独立仮定の産物で、36% なら ≈89%＝結論は保つ。ただし同じ語で別の分母を持つ数字が 2 本裁定資料に併存し、片方の脚注が出自を取り違えているのは、数字で語る資料として要修正。

### E-5【低】run 母数の不一致（66 vs 79）
- B-4 と同件。fl-velocity §1.6 に説明があるので、fl-temporal §7-3 側の引き直しで解消する軽微な傷。

---

## F. 攻撃して耐えた点（脆くなかった箇所の明記）

1. V2/V3 の PdM 承認引用: issue #256（「1,2,3 承認」・p95 15 分）・#281（「いいだろう」・1 パス 5 分）の本文に実在・数値一致【確認・gh 読み取り】。
2. fl-velocity の日次着地表・07-07 の inner 17＋explain 5 = 22・merged 132 件: 保存 JSON（gh-prs-merged.json）の branch prefix 再分類で一致【確認】。
3. fl-github の branch protection 実測（strict:false・required check `gate` のみ・enforce_admins:true・force-push 禁止）・ci.yml `on: pull_request` のみ: 本日 gh API / repo で追認【確認】。「merge 後の合成状態が無検査」という A' の動機は実在する穴。
4. Temporal の公式仕様照合: 同時 open 1 本の uniqueness・heartbeat による activity 死検知・pinned 文言・**Worker Versioning GA（2026-03-30）**・TS sandbox・history 上限——いずれも一次情報と整合【確認】。routines 案型の「未確認仕様を基線に置く」楽観は、B-1（Reuse Policy）と B-3（設定値・移行窓）を除き回避されている。
5. fl-alternatives の「queue だけ買うと durable execution 自作が戻る」分析・Restate/Inngest の license と常駐増の指摘は、候補間の利害を正直に切り分けており、単体としては良質（欠けているのは C-1 の合流だけ）。

## G. 本 critique 側の未確認

- PdM「1 日 10〜20 PR・動的で高速」発言が記録外チャネル（口頭・別セッション）に存在する可能性は排除できない。本検証が言えるのは「資料束・repo issue・charter に見つからない」まで（A-1 は「未接地」の指摘であり「発言が無い」の断定ではない）。
- GitHub Mobile での label 付与・Projects 盤面操作の実タップ数/所要: 未実測（D-1 は「両案とも未実測のまま優位を宣言した」ことへの指摘）。
- fl-alternatives 記載の各候補の版・日付・license 条文: URL 記載を信頼し独立再取得はしていない。
- Temporal Cloud 価格（$100/月 Essentials・$50/1M actions）: 未照合（保証タグではないため優先度を落とした）。
- M13 実施後の CI 所要の実値（E-2 は「感度分析が無い」ことの指摘であり、CI が何分になるかの予測ではない）。

## 総括（裁定前に文書側で直すべき順）

1. **E-1＋B-1**（状態読み戻しの方向と Reuse Policy）— Temporal 案の看板保証のスコープ修正。採否判断そのものに効く。
2. **A-1＋A-3**（V1 の接地と人間律速の予算）— 要件体系の根。ここが崩れると「強い基盤が必要」の前提強度が変わる。
3. **C-1**（M1〜M13 × 全候補の 1 枚表＋DBOS hang 検知 spike）— 「やりすぎ」かどうかを判定可能にする唯一の装置。
4. **E-2**（M13 後 CI 時間の感度分析）— GitHub ①裁定の定量根拠の寿命明示。
5. **D-1/D-2**（承認動線の実測と移行ハザード設計）— 統治資産を未確認情報で置換しないための最低条件。
