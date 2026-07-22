# 高速ループ時代の GitHub の使い方 再設計（fl-github-role-redesign）

- 作成: 2026-07-08／read-only（repo・issue・PR への書き込みなし。gh は読み取りのみ使用）
- 前提（与件）: **状態機械は GitHub から出て行く（エンジン所有の DB claim / stage-ledger / posting 台帳）**。
  GitHub に残る役割 = ①コード着地＋CI（単一ゲート）②人間の読む面 ③承認入力 ④（本書で追加検討）起票面。
- 入力: `code-red-charter-material.md`（S 系事故台帳）・`cr-github-defects.md`・`self-built-foundation-design-v0.md`・
  `routines-foundation-design-v0.md`・`foundation-decision-material.md`（いずれも本 scratchpad）＋ repo 正本
  （ADR 0026/0031/0034/0035・design/loops.md・.github/workflows/ci.yml）＋ gh API 実測（本日）＋外部一次情報（§8）。
- 記法: **事実（実測・一次情報 URL つき）／設計提案（PdM 裁定前）／未確認** を峻別。

---

## 0. TL;DR

1. **① PR 単位: 1 task 1 PR を維持**。実測 CI 1 分に対し着地間隔は 72 分（20 件/日）＝直列化利用率 ρ≈1.4%（peak 60 件/日でも 4.2%）で、**束ねる理由（CI 希少性）が数値上存在しない**。batch 統合 branch は rework 率 50% の実測下で「ほぼ毎 batch 15 分停止＋他 task 巻き添え＋non-FF 書き換え（S2-4 再発）」になり棄却。direct-to-main は ADR 0026 事故クラスの制度化で棄却。merge queue は**個人アカウント repo では利用不可**（一次情報）。
2. 補強 2 点: **(a) エンジンによる直列 arm＋update-before-arm（+1 分/件）で「merge 後の合成状態が無検査」の現存穴を塞ぐ**（ci.yml は `on: pull_request` のみ・strict=false を実測確認）。**(b) push:main CI の追加**（防御の重ね）。
3. **② 承認入力: 応答遅延は決め手にならない**（人間の教材読解 O(分〜十分) ≫ polling 5 分 ≫ webhook 数秒）。決め手は**承認 actor の機械検証可能性**。今 = GitHub 面継続だが、機械が読む入力を Projects Ready 列から **label（`gov:approve`・repo webhook 可・REST・actor 検証可能性あり）へ寄せる案を優位**とする（projects_v2 webhook は **organization 限定** = 一次情報。個人 repo の盤面は polling しかできず S2-2 面も残る）。将来 = lathe UI の intent テーブル（DB 権限で fail-closed・S2-11 構造解消）が終着。
4. **③ issue は「人間の入力面＋読む面＋恒久記録」として残す**。二重台帳は「方向規律」で台帳＋キャッシュに降格する: 機械が GitHub から読むのは人間の入力（起票・承認・裁定）のみ／状態は読み戻さない／書き込みは全て proxy 経由の非権威投影＋台帳＋補償。S1-2（導出ラグ→二重実行）の根はこれで消える。
5. **④ 教材の一次配信は承認が起きる場所（issue comment・REST・post-check つき）へ**。Discussion は放送・アーカイブ面に格下げ（non-blocking・廃止可）。explains/ の repo 収載は正本として keep、ただし auto-PR を承認 evidence に直列させない（cr-github-defects §4-4 の直列結合を切る）。

---

## 1. 前提の確定 — GitHub に残る役割・出て行くもの

| | エンジン（DB 一次）へ出て行く | GitHub に残る |
|---|---|---|
| 実行状態 | run/stage 進行・claim 排他・dedup・retry 計数・再実行判定 | —（`run:*` label は純投影・読み戻さない） |
| task | 実行対象としての正本（key = issue 番号） | **起票面**（`gh issue create`・却下ゼロ・サーバー側直列採番 = ADR 0031 の実証資産） |
| 承認・裁定 | 効力判定と発火 | **入力面**（§3 の裁定）＋裁定 comment（時刻・帰属つき恒久記録） |
| 成果物 | posting 台帳（配信完了の正） | **着地面**: PR＋CI required check `gate`（ADR 0026 不変） |
| 読み物 | — | plan 全文・教材・escalation report・explains/（§5） |

事実（本日実測）: branch protection = required check `gate`・`strict:false`・enforce_admins 有効・force-push 禁止／auto-merge 許可／**ci.yml のトリガは `pull_request` のみ**（push:main で CI は走らない）。

---

## 2. 実測パラメータ（比較の物差し）

| 項目 | 値 | 出所 |
|---|---|---|
| CI 所要 | **median 51 秒・p90 65 秒・max 70 秒**（直近成功 30 run） | `gh run list` 実測 2026-07-08。与件「CI 1 分」と整合 |
| 着地件数/日 | 07-04: 5／07-05: 17／07-06: 5／**07-07: 60**／07-08: 13 | `gh pr list --state merged`（直近 100 件） |
| PR open→merge | median **0.9 分**・p90 32.8 分 | 同上 |
| rework 率 | **CHANGES 18 / LAND_REVIEW 36 = 50%** | meta-audit-agent-efficiency（実 run 集計） |
| rework 所要 | **15 分/件（与件として採用）**。時間の直接実測は本資料群に無し＝**未確認**（LAND_REWORK 平均 71 turn・$1.08 とは整合的） | 与件＋meta-audit |
| 直列化利用率 ρ | CI/着地間隔 = 1/72 ≈ **1.4%**（20 件/日・24h）・1/24 ≈ **4.2%**（60 件/日） | 上 2 行から算出 |
| 完全直列化の理論上限 | 60 件/時 = 1,440 件/日 | CI 1 分から自明 |

**含意**: 想定「1 日 20 着地」は既に実測 peak（60）の 1/3。そして CI が 1 分である限り、**着地の直列化はほぼ無料**（ρ≪1）。「CI がボトルネックだから束ねる」という問題設定自体が成立しない。律速は rework（15 分 × 率 50%）であり、これは **PR をどう束ねても消えない**——むしろ束ねると干渉する（§3 C 案）。

---

## 3. ① PR の単位 — 4 案の摩擦比較（20 着地/日・CI 1 分・rework 15 分×50%）

| 案 | 1 件あたり着地待ち | CI 計算量/日 | rework の干渉 | 履歴の可読性 | 判定 |
|---|---|---|---|---|---|
| **A. 1 task 1 PR・並列 auto-merge（現状）** | 1–2 分（実測 median 0.9 分） | 約 30 CI-min（PR 20＋rework 再 push 10） | 無し（worktree 並列・相互非阻害） | 1 issue = 1 PR = squash 1 commit。良 | **穴 1 つ**: strict=false＋push:main CI 無しのため**merge 後の合成状態が誰にも検査されない**。並行 5 本の wave で base が数分古い PR 同士の意味衝突が素通りする |
| **A'. A ＋ エンジン直列 arm・update-before-arm（strict=true 化）＝推奨** | +1 分/件（update→CI→merge）。wave k=15 でも尾 15 分 | 約 50 CI-min | 無し | 同上 | **merge queue と同等の合成状態保証を自前 1 部品で達成**。update は rebase でなく `merge origin/main`（non-FF 回避 = S2-4 照合）。エンジン死亡時は PR が待つだけ = fail-closed |
| B. GitHub merge queue | 待ち行列位置 × ~1.5 分 | A' 同等 | 無し | 同上 | **個人アカウント repo では利用不可**（org 所有 repo 限定 = 一次情報 §8-1）。org 移管すれば A' の update 機械を GitHub が代行するだけ＝**差分価値は「update 機械の外注」のみ**。新契約面 merge_group が M12 対象に増える |
| C. batch 統合 branch（n=5・窓 2h） | **平均 +60 分**（窓/2）。blocked-by 連鎖 1 段ごとに +窓 1 本 | 約 4–13 CI-min（bisect 込み） | **致命**: レビュー前 batch なら P(rework 混入)=1−0.5⁵≈**97%**（独立近似）→ ほぼ毎 batch 15 分停止＋他 4 task 巻き添え。レビュー後 batch でも RED 時 bisect ≈ +3 CI＋**統合 branch の書き換え（non-FF・S2-4 類の再輸入）** | 1 PR = 5 task でレビュー面が混線（2026-06-19 main 交錯事故と同型を review 面に再現）。explain 教材の接地単位も壊す | **棄却**。節約は CI −26 分/日 = CI 1 分では無価値。batch が効く条件は ρ→1（CI ≥ 30–70 分 or 数百件/日）で、本系はその 1/30 |
| D. trusted 変更の direct-to-main＋CI | −1〜2 分/件 の節約のみ | 20 CI-min | 変わらず | main に PR 非対応 commit が混じる | **棄却**。(i) branch protection の解除/bypass = **ADR 0026 の契機事故（ゲート迂回）の制度化**。(ii)「trusted」の判別は設計判断であり機械に安全に委ねられない（chip 禁止裁定 2026-06-26 と同型）。(iii) Q1: auto-merge は protection 前提＝残りの PR 経路も壊す。(iv) merge 権をエンジンのコード正しさに依存させる = M3 fail-closed の放棄 |

**推奨 = A'**（1 task 1 PR 維持＋proxy が arm を直列化＋update-before-arn＋strict=true）＋ **push:main CI 追加**（バックストップ。main RED はエンジンが p1 修理 task を自動起票）。merge method は squash に統一（main 履歴 = 1 task 1 commit、現状の実態追認）を併せて裁定に載せる。

補足（規模の上限）: A' の直列 arm が飽和するのは ~1,440 件/日。API rate limit（PAT 5,000 req/h）にも 20–60 件/日＋5 分 polling は 2 桁の余裕。**GitHub 側の制約で先に折れるのは throughput ではなく「読む人間」**（§5）。

---

## 4. ② 承認入力 — label / 盤面 webhook vs lathe UI（intent → signal）

### 遅延予算（結論: 遅延は決め手にならない）

承認遅延 = 人間段（教材を読む: O(数分〜数十分)）＋機械段。機械段の比較:

| 経路 | 機械段遅延 | 根拠 |
|---|---|---|
| polling（oneshot timer 5 分） | ≤ 5 分（設計値。現行実測 p95 52 分 = S3-1 は同期 dispatch が原因であり、エンジン再設計側で解消済みの前提） | 設計値 |
| repo webhook（`issues.labeled`） | 数秒〜（**SLO は文書に無し = 未確認**・§8-3） | 一次情報 §8-2 |
| lathe UI intent（DB 直書き） | ~0（＋socket activation で即パス起動可） | 同一ホスト DB |

人間段が数分以上ある限り、300 秒と数秒の差は承認全体の半分未満に埋没する。**決め手は (a) 承認 actor の機械検証可能性（S2-11 封じ）(b) PdM の操作性 (c) 契約面の広さ（S2-2/M12）**。

### 3 案比較

| 案 | actor 検証（S2-11） | 操作性 | 契約面・事故照合 |
|---|---|---|---|
| A. Projects **Ready 列** 継続（ADR 0035） | **手段未確認**（Projects v2 の列移動 actor を API で取れるかは未確認） | 盤面 drag = 既習・「Ready 待ち列 = 読む物付き needs-review だけ」の認知モデル資産。モバイル操作性は未確認 | **projects_v2 webhook は organization 限定**（一次情報 §8-2）＝個人 repo では polling しか無い。option id 失効（S2-2/Q4）の面が残る（名前解決＋contract test で緩和済みだが面は消えない） |
| B. **`gov:approve` label**（機械が読む承認入力を label に一本化・盤面は純投影へ降格）**= 当面の優位案** | timeline `labeled` イベントの actor ∈ 人間 allowlist で効力判定（**actor 網羅性は未確認 = M12 contract test 第 1 号**。両基盤設計と共通の前提）＋watchdog が allowlist 外を剥がす | issue 画面・モバイルで 1 タップ。盤面からも issue へ 1 遷移。`gov:*` 名前空間で label 汚染を抑制 | repo webhook（`issues.labeled`）が使える＝加速器を後付け可能（**ただし webhook は加速器であって荷重にしない**: 受け口 = 新常駐面 = S1-1 級の新設リスクなので、polling を常に床に敷く）。REST 完結（Q5 の GraphQL 死を回避）。**機械が読む面から Projects API を完全に排除できる = S2-2 クラス消滅・M12 対象縮小** |
| C. **lathe UI**（意図を DB intent テーブルに書く → engine signal） | **構造で fail-closed**: inner agent の DB role に intent INSERT 権を与えない（Postgres 権限）。GitHub actor 検証（未確認 API 依存）が不要になる＝S2-11 の唯一の構造解 | lathe の稼働＋認証＋UI 実装が前提。**lathe 開発は当面中止（code red 前提）**のため今は建てられない。裁定・承認の記録は proxy が issue comment へ投影（読む面・恒久記録の維持 = §5 の方向規律） | GitHub 契約面ゼロ。ADR 0031 §6 が「将来 lathe UI が盤面になる」扉を明示的に開けている（今は scope 外の宣言つき） |

**推奨（段階）**: 今 = **B**（`gov:approve` label・polling 床＋webhook 任意加速・actor contract test を M12 第 1 号で先行検証）。ADR 0035 §7 の「Ready 列だけは機械が読む」特例を廃止し、盤面は完全に投影へ戻す（ADR 0031 §4 の原型に復帰）。PdM が盤面 drag の操作感を優先するなら A 継続も可（その場合 S2-2 面と actor 検証未確認を受容する裁定として記録）。将来 = lathe 再開後に **C** へ移行（intent = 正・GitHub = 投影）。

---

## 5. ③ issue の役割 — task 正本がエンジンに移った後

### 残す価値（人間の読む面・入力面）

1. **起票面**: `gh issue create` = 参入コストゼロ・却下ゼロ・サーバー側直列採番（ADR 0031 の実証資産）。エンジンは新規 issue を「入力」として取り込み、**task key = issue 番号を維持**（TASK-N = #N の連続性・過去 300 件超の参照が生きる）。
2. **読む面**: plan 全文（body/comment）・裁定 comment（時刻・帰属つき）・escalation report・PR/commit への相互リンク。GitHub の render・検索・モバイル・通知は自前 UI で再現するとコストが大きく、**「読む面」需要は GitHub が最安**。
3. **恒久記録**: PdM 裁定が改竄困難な公開履歴として残る（審計面）。
4. **承認入力のアンカー**（§4 で B 案なら label の置き場所）。

### エンジンへ移すもの・二重台帳リスクの正味

二重台帳が事故になるのは「**両方に書けて、両方から状態を読む**」とき（ADR 0025 Backlog.md の同期事故・ADR 0031 が根治）。GitHub 側を読み戻す設計の構造脆弱 5 点は実測で帰納済み（cr-github-defects §4: 証拠着地ラグ = 再実行の窓・fail-open 書込・契約不安定・evidence と着地ゲートの直列結合・投稿検証層の不在）。**方向規律 3 行で「台帳 2 冊」を「台帳＋キャッシュ」に降格する**:

1. 機械が GitHub から**読む**のは人間の入力のみ（新規起票・承認 label・裁定 comment）。
2. **状態（実行中か・完了か・配信済みか）を GitHub から読み戻さない**。正は engine DB（claim・stage-ledger・posting 台帳）。→ S1-2（evidence 着地ラグ×毎 5 分パス→二重生成、`eca8247` 後も再発）の再発火条件そのものが消える。
3. GitHub への**書き込みは全て proxy 経由の非権威投影**: 台帳 intent（sha256 冪等）→ REST 投稿 → post-check → confirmed。失敗は台帳 failed＋watchdog 次パス補償（「非致命 continue」= S1-3 #229 の構造禁止）。issue close も投影の一部（close 失敗で系は誤読しない）。

**plan の置き場**: 本文は issue 上（人間が読み・裁定する場所）。ただし**承認 = その時点の plan の sha 固定 snapshot を engine が取り込む**（承認後の本文編集で発火内容が変わる曖昧さを排除。P1 transcript 死蔵の逆手 = 正本は常に issue に着地済み）。

**残余リスク（名指し）**: 投影の stale 化で「人間が」誤読する（issue は open に見えるが engine では done 等）。対処 = watchdog の台帳⇄gh 毎パス突合（M5/M9 と同一装置）＋投影 comment に generated-at を刻む。これは事故クラスとしては「読み物の鮮度」問題であり、S1 系（系の誤動作）には戻らない。

---

## 6. ④ 教材・Discussion 配信の位置づけ

事実: Explain Discussion 25 本中、破損 stub 2（#292/#295 = `@file` 未展開・S1-4）・8 秒差重複 1 組（#294/#295・S1-2c）。#288 の承認材料は壊れた 1 本のみだった。Discussion API は **GraphQL のみ**（REST 無し・一次情報 §8-4）で、gh の GraphQL 経路は既に 2 回死んでいる（Q5・Q6）。教材密度は形容詞注文で直らず 2 段化契約が要る（S3-7・#288）。

| 面 | 位置づけ（提案） | 根拠 |
|---|---|---|
| **承認材料としての教材** | **issue comment に一次配信**（proxy render・REST・post-check 5 項目・intent 冪等）。承認（§4 の label/Ready）と同じ画面で読める＝PdM の 1 面化（ADR 0035 の趣旨をより徹底） | 承認材料は「実在・非 stub・対象一致」を機械保証すべき対象（M9）。REST 完結で Q5/Q6/Q7 の GraphQL・`@file` 事故面を全部避ける |
| **Discussion** | **放送・アーカイブ面に格下げ**（non-blocking・遅延/重複しても承認に影響しない）。残すか廃止かは PdM 裁定。残す場合も proxy 経由・post-check・台帳冪等の同一装置に載せる | S1-2/S1-4 の再発条件は「配信完了の証拠を gh から導出」だった＝posting 台帳が正なら venue はどこでも安全。ただし契約面（GraphQL）を増やす価値があるかは効用次第 |
| **explains/ 正本** | **repo 収載 keep**（grep 可能・恒久・23 ファイル実績）。ただし **auto-PR を承認 evidence に直列させない**（アーカイブであって evidence でない。evidence は posting 台帳） | cr-github-defects §4-4: explains/ PR の merge 遅延・auto-merge 癖（Q1/Q2）が重複生成リスクに転化していた直列結合を切る |
| 教材の中身 | 2 段化＋密度の構造契約（予算・必須節・禁則・self_check = contracts データ）・正解位置は render 時乱択（F3） | #288・R3/R4（venue 非依存・両基盤設計と共通） |

---

## 7. S 系（GitHub 起因事故）照合表 — 推奨構成（A'＋B＋方向規律＋issue 一次配信）で再発するか

| 事故 | 推奨構成での帰結 |
|---|---|
| S1-1 silent death | GitHub の役割外（エンジン watchdog＋系外 heartbeat の領分）。②で webhook を「荷重」にすると受け口が新 S1-1 面になる → **polling を常に床**とする本設計で回避 |
| S1-2 二重 dispatch/生成（3 回実弾・guard 後も再発） | **構造で消える**: 再実行判定を gh 導出から DB claim へ（M1/M10）＋配信冪等は posting 台帳 intent_sha256（venue 非依存）。①の選択には依存しない。C 案（batch）だけは branch 書き換え窓を新設するため劣後 |
| S1-3 書込失敗の fail-open 恒久化（#229） | **構造で消える**: 全書込 = proxy 経由・台帳 failed 記録・watchdog 補償（M5）。§5 規律 3 で「label が真実を写す」前提自体を廃止。C 案 lathe UI なら承認経路の gh 書込がゼロになり、さらに面が減る |
| S1-4 破損 stub が承認材料化 | **構造で消える**: M9 post-check（実在・本文長・placeholder 不在・対象一致・必須節）＋一次配信を REST の issue comment へ（`@file` 系 Q7 の面ごと回避） |
| S2-1 stale 常駐 | GitHub の役割外（oneshot＋self-update の領分）。①A' の strict=true は「古い base のまま merge」を GitHub 側でも禁止する同型の防御 |
| S2-2 外部 id の silent 失効（Q4） | ②B 案なら**機械が読む面から Projects API を排除 = クラス消滅**。A 案（Ready 列継続）なら残存（名前解決＋contract test で緩和のみ） |
| S2-4 non-FF rework 停止 | ①A' の update は merge commit 方式（rebase 禁止）で回避。**C 案（batch）は bisect/eject で branch 書き換えを常態化 = 再輸入**なので棄却理由に算入 |
| S2-11 承認シグナル汚染 | ②B = credential 分離（M3）＋actor 検証（未確認 → M12 第 1 号で先行検証）＋watchdog 剥がし。②C = **DB 権限で構造解**（唯一の完全解。lathe 再開後） |
| S2-12 CI ザル（#279） | 全案共通の前提修理（M13）。**①D だけは M13 を無意味化する**（ゲートを通らない着地）ため単独でも棄却事由 |
| S3-1 dispatch 遅延（p95 52 分） | ② polling 床 5 分（エンジン側 R2 で設計値保証）。webhook は任意加速。承認全体は人間律速（§4） |
| S3-4 gh 仕様癖（Q1–Q3・A3） | ①A' は auto-merge＋protection を維持（Q1 前提を壊さない）。checks 出現前 watch（Q2）・branch 削除（Q3）の既知対処は proxy に移植。M12 contract test 化 |
| S3-6 優先度 label 不在 | `gov:p1/p2/p3` 新設（R8・両基盤設計と共通）。①の claim 順序に反映 |
| S3-7 教材密度 | ④ 2 段化の構造契約（venue 非依存） |

**新設リスクの正直な列挙**: (i) A' の直列 arm はエンジン単一障害点（ただし fail-closed: 止まると PR が待つだけ・main は壊れない）。(ii) 投影 stale による人間の誤読（§5 残余）。(iii) webhook を導入する場合の受け口常駐（→ 導入しない/加速器限定が既定）。(iv) B 案 label の効力判定が timeline API の未確認仕様に依存（→ 導入前 contract test を条件にする）。

---

## 8. 外部一次情報（本書が依拠する URL）

1. **merge queue は organization 所有 repo 限定**（public は org 所有なら全プラン・private は Enterprise Cloud）: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue ・ https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/merging-a-pull-request-with-a-merge-queue （挙動: 一時 branch で「base 最新＋先行 PR」を合成検査・失敗 PR は自動除去）。個人 repo 不可の追認: https://github.com/orgs/community/discussions/51483
2. **webhook の提供範囲**: `projects_v2_item` は **organization webhook のみ**・`issues`（labeled 含む）は repository webhook で利用可: https://docs.github.com/en/webhooks/webhook-events-and-payloads
3. **webhook 配送遅延の SLO は文書化されていない**（同上ページに遅延保証の記載なし）＝**未確認**として扱う。
4. **Discussions API は GraphQL のみ**（REST 提供の記載なし）: https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions
5. auto-merge が branch protection 前提である点は repo 内一次証拠（issue #94・Q1）で実証済み。

---

## 9. PdM 裁定が要る点

1. **① 合成状態保証の置き場**: A（現状＋push:main CI のみ）／**A'（strict=true＋エンジン直列 arm・推奨）**／B（org 移管＋merge queue。移管という一回性コストと引き換えに update 機械を外注）。
2. **merge method の squash 統一**（main 履歴 = 1 task 1 commit。実態追認）。
3. **② 承認入力**: Ready 列継続（操作性優先・S2-2 面と actor 未検証を受容）か **`gov:approve` label 化（推奨）**か。lathe UI intent への将来移行の予約（ADR 0031 §6 の扉）を今認めるか。
4. **④ Discussion の存廃**: アーカイブ面として残す（proxy 経由・non-blocking）か、issue comment 一次配信への完全一本化で廃止か。
5. **push:main CI の追加**と main RED 時の自動 p1 起票規約。
6. webhook 加速器の導入時期（既定 = 導入しない。導入するなら受け口の常駐監視を M2 に編入することが条件）。

## 10. 未確認事項（丸めずに残す）

- rework 15 分/件の**時間**実測は無し（与件採用。turn 数・費用の実測とは整合）。
- timeline `labeled` イベントの actor 網羅性（②B の効力判定前提・M12 contract test 第 1 号。両基盤設計と共通の未確認）。
- Projects v2 の列移動 actor を API で取得できるか（②A の actor 検証手段）。
- GitHub mobile での Projects 盤面の操作性（②の操作性比較の一部は体感情報で裏取り無し）。
- webhook 配送遅延の実測値（SLO 文書なし・本 repo での実測なし）。
- merge queue 可用性の記述は docs 2 ページ＋community discussion で確認したが、ページ内 callout の原文引用は fetch で取得できず（要旨一致は複数ソースで確認）。
- P(batch rework 混入) 97% は「task 間の rework 独立」近似（実測 rework 率 50% は run 単位の集計）。
