# ADR 0027: task intake の単一受付と登記 loop — 起票の直列化

- status: proposed（設計は 2026-07-05 PdM 発案・壁打ちで方向承認。accepted 化は本 PR review で）
- date: 2026-07-05
- 関連: ADR 0025（task 基盤・Issues の外部窓口降格）／ADR 0026（単一着地ゲート・信頼境界は remote・loops 台帳）／[design/loops.md](../design/loops.md)

## 背景

backlog task の発行が**複数 writer × ローカル採番（max+1）**である。outer セッションが並走した 2026-07-05、ID 衝突が実際に起きた（TASK-12 を両セッションが同時期に採番）。さらに ADR 0026 で起票も PR 経由になると、**並行 PR が同一 ID を掴む衝突が構造化**する（各 branch が自分の max+1 を信じる）。起票元も分散している——outer の前進 loop・plan-loop の ISSUE_CREATE・meta の ACT 系が、それぞれ直接 `backlog task create` を呼ぶ。

## 決定

### 1. 受付 = GitHub Issues（内外統一の唯一の受付窓口）

task の発行依頼はすべて **GitHub Issue** として投げる。issue 番号は**サーバー採番＝到着順・ローカルで改竄不能**であり、ADR 0026「単一マシンに信頼境界は作れない・信頼境界は remote に置く」と同じ思想に載る。依頼の provenance（誰が・いつ・なぜ）は issue スレッドに残る。

**ADR 0025 との関係（降格の取り消しではなく役割の精密化）**: Issues は引き続き**実行単位ではない**。0025 が定めた「外部レポート窓口」を「内外問わずの**申請書受付**」へ広げるだけで、実行正本は backlog のまま。

### 2. 登記 = intake loop（新 loop・backlog の唯一の writer）

受付 queue を**到着順に**消化し、起票規律（[[pdm-issue-filing]] = 意味・効能の PdM 事前共有）を検査して、**backlog task を発行する（または却下を記録する）**単一の loop。

- **唯一の終端**: 「task 起票（issue close＋task 参照）」または「却下の記録（issue close＋理由）」
- **backlog task の新規発行はこの loop のみ**が行う。単一 writer なので ID は構造的に直列・起票 PR の衝突は消滅する
- 多重起動は merge-lock と同型の PID lock で防止（単一マシンの現状には十分。remote 化は将来）

### 3. 既存の起票元をすべて受付経路へ統一

outer 前進 loop・plan-loop（ISSUE_CREATE）・meta ACT 系は「issue を投げる」に変更。直接 `backlog task create` を呼ぶのは intake loop だけになる。

### 4. loops.md への行追加

| loop | 誰が | 起動条件 | やること | 唯一の終端 | 終端でないもの |
|---|---|---|---|---|---|
| **intake（登記）** | intake driver（単一 writer） | 受付 issue の到着 | 到着順に検査・採番・起票 | **task 起票 or 却下の記録** | 実装・実行単位としての issue 復活 |

（loop の追加は PdM 承認事項＝本 ADR がその承認）

## 却下した代替

- **outer 間の領域/時間分担**: 人間規律頼み。規律は破られることが実証済み（ADR 0026 契機）。
- **ID への session prefix / namespace**: 多 writer を温存する弥縫。ID は分離できても backlog への並行書き込み・PR 衝突は残る。
- **repo 内 inbox ディレクトリ（file-based queue）**: 投函自体が branch/PR 経由になり結局 race。サーバー採番の利点もない。

## 実装順序

1. TASK-15/16（PR+CI 移行）の着地を待つ
2. intake driver の実装 task を起票（inner loop で実装。受付 issue の template / label 設計を含む）
3. plan-loop / meta ACT 系の起票先切替（別 task・小粒）
4. 移行完了までの暫定運用: 新規起票は**単一の outer セッションに限定**する（並行起票の自粛）
