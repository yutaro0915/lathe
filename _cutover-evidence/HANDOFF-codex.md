# Codex 引き継ぎ — code red 後の lathe（2026-07-09）

読む順: 本書（全体像・5 分）→ 深掘りは `_cutover-evidence/briefing-for-external-analysis.md`（自己完結・外部分析向け・936 行）。以下の主張の一次証拠は同ディレクトリの各資料。

## 1. いま何が起きたか

lathe は「ハーネスエンジニアリングのプラットフォーム」（agent 開発の観測・改善・評価）。**製品コード（`apps/web`・観測 UI・ingest）は健在で今後も育てる。凍結したのは開発基盤（自律開発ループ）の方**。

3 日間、GitHub issue=task で「plan→機械審査→実装→着地 review→PR+CI」を無人で回す自律ループを運用 → **incident 26 件**（プロセス管理 10・統治 9・環境差 4・prompt 依存 4・情報配管 4・API 癖 3）→ **code red 宣言・全面停止・基盤の作り直し**。

根因（PdM 仮説・実測が支持）: 個別バグではなく「**タスクの切り方・PR の使い方・状態の保ち方**」の設計自体。人間の非同期協働用の GitHub を、分単位で回る機械の状態機械の基板として誤用した。1 人日 10〜20 着地という velocity が、GitHub の伝播速度と routines の想定を超えた。統一的に言えば「**分散ワークフローエンジンを他人のサイトの上に手作りしていた**」。欠けていた部品の名 = durable execution。

## 2. 凍結済みの状態（cutover 2026-07-09）

- 実行系停止: case の systemd timer 無効・service 停止・プロセス 0／Mac launchd 無し／`claude-discussions.yml` を `.disabled` 化（唯一のエージェント発火 workflow）。`ci.yml` は検査専用で残置
- GitHub 凍結: **open issue 0・open PR 0**（旧 11 issue は `legacy` label + close、mid-flight PR 2 本は merge せず close）
- worktree: dev ループの 13 worktree/branch 撤去。commit を持つ 2 本は `legacy/*` tag で凍結（削除でなく凍結）
- **ソース削除（2026-07-09・107 ファイル・16,501 行・git にステージ済み・未 commit）**: 旧ループの統治文書・harness・実装を `git rm`。内訳 = `design/` の dev ループ md（loops/agent-workflow/plan-format/experiment-loop/outer-loop-family/test-failure-playbook/rubric-schema-v2/loop-domain-architecture/runbooks）・`adr/0013-0017,0023-0038`・`ops/`（outer-harness/launchd/systemd/install）・`.claude/agents`（全 7）・`.claude/skills`（dev 系 7・lathe-ui は製品として残置）・`scripts/`（orchestrator/inner-loop/dispatch-runner/review-engine/meta-loop/inner-queue/case-dispatch 系）。復元は git 履歴から可能
- 証拠: `_cutover-evidence/` に 36 ファイル退避（揮発対策・untracked。**削除された設計判断の内容はここと git 履歴にのみ残る**）
- **削除せず保留**: `rubrics/`（正しさは持ち出せる資産。**一つずつ点検して新基盤へ移送する対象**・別作業）／`.claude/hooks/`（file-size/git-guard/ui-skill-guard は製品開発にも効くため温存）／`AGENTS.md`・`CLAUDE.md`・`README.md`（旧ループ記述で埋まっている・**削除でなく書き直し**待ち）／ADR `0005`・`0009`（foundational として保守的に残置）
- **未処理（PdM 指示で保留）**: credential 一切放置・Cloudflare トンネル稼働のまま・Projects 盤面の item 残置・製品由来の旧 branch 48 本は範囲外
- **git 状態の注意**: 上記 107 削除は**ステージ済み・未 commit**。Codex が別 clone で作業する場合、commit するまでこの削除は見えない

## 3. 決まったこと — 新基盤の 5 原則（憲法・血で買った）

| # | 原則 |
|---|---|
| 1 | 人間境界で loop を細分化しない（issue/PR/承認/comment を細かく挟まない。agent 内部の反復は小さくてよい。人間の理解単位を system clock にしない） |
| 2 | 人間は loop 内制御をしない（分割・探索・再試行・局所判断は agent と engine。人間は prototype 後の意図形成・完了条件承認・事後監査） |
| 3 | 可読性ではなく監査可能性を設計単位にする（読める issue を多数作っても全体は読めない。意図・判断・成果物・検証結果を後から追える構造を優先） |
| 4 | prototype は実装の縮小版ではなく意図形成のための実測（code を流さず、成立/失敗した前提・不変条件・完了条件・検証方法へ変換） |
| 5 | 安全境界は構造で作る（prompt/規範/hook でなく、排他・権能分離・schema・post-check・履歴・heartbeat で構造的に防ぐ） |

**改正条項**: この 5 原則を変更するには、また試行と失敗を必要とする（観測なき規範化の禁止を、この表自身に適用する）。

保留の 6 番目候補（未採択）: 「走る系に手を入れない — 変更は複製に、昇格は版で」（ADR 0036 系譜・#201 の破滅で実証済みだが 5 原則表には未収載）。

## 4. 未決の裁定（PdM 専権・Codex は材料整備と設計案まで）

- **D-0（最上位）**: lathe は「駆動を所有する製品」か「駆動を外部化し統治と観測に徹する製品」か。技術比較でなく製品戦略。他の全軸の重みを決める
- エンジン: durable execution を **Temporal self-host / DBOS / Postgres queue＋自前薄層** のどれで得るか（`fast-loop-foundation-v1.md`）。routines は「遅い自動化」前提で高速ループに不適合と結論（参考列）
- コード構造: 「layer より feature」— 並行 task の衝突は共有核（core/prompts）の奪い合いが主因。feature 縦割り＋不可侵 kernel で blast radius を構造的に閉じる仮説（**未検証・実験候補**）
- 運転モデル案: 昼=壁打ち＋prototype（merge 不可・構造隔離）／夕=plan 一括承認／夜=直列バッチ実装（統治フル・checkpoint 検収・失敗即停止）／朝=検収レポート。直列化で並行事故クラスが消え、Temporal 級の必要性も下がる公算
- GitHub 再設計: 速い面（状態機械・排他・監視＝エンジン所有）と遅い面（起票・承認 UI・読み物・PR+CI 着地＝GitHub）の分離。機械は GitHub から状態を読み戻さない

**新ループの名称・構造は現時点でスコープ外**（未着手）。

## 5. 生き残った協働規律（基盤に依らず有効）

single-writer / worktree 隔離 / 構造 > プロンプト / 完了は機械照合で宣言（記憶でなく） / 状態は正本から導出・二重台帳禁止 / 証拠は repo（memory に頼らない）/ 起票は PdM の明示承認（会話の含意は承認でない）/ plan 確定後の issue に scope 追加しない。

## 6. 深掘り資料（すべて `_cutover-evidence/`）

- `briefing-for-external-analysis.md` — 自己完結の全体ブリーフィング（外部 AI 分析用・§1 現状〜§7 問い＋用語集）
- `code-red-charter-material.md` — incident 26 件全台帳・keep/drop/rebuild 分類・M1〜M13 要件
- `foundation-decision-material.md` — routines vs 自作の敵対比較・決定木
- `fast-loop-foundation-v1.md` — Temporal/DBOS/velocity/GitHub 再設計
- `meta-audit-agent-efficiency.md` — agent の非効率実測（探索 37%・再読 3 回/session・Stop hook 二重課金）
- `research-pi-agent.md` / `routines-*.md` / `self-built-*.md` / `fl-*.md` — 各設計・調査の原本
