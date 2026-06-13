---
title: 監査プロトコル — Claude を常設監査として配置する
status: accepted
created: 2026-06-11
updated: 2026-06-12
---

# 監査プロトコル（audit protocol）

Phase 1〜7 の全実装期間、**Claude を常設監査（standing auditor）として配置する**（2026-06-11 ユーザー決定）。
実装主体は Codex（`/goal` loop、[dev-loop.md](./dev-loop.md) v2）。監査は **リスク階層化**で行う —
全 task を同じ深さで監査せず、task の触る界面のリスクで監査強度を決める。

参照実装: tasks/08 の監査（2026-06-10）。受け入れ条件 8 項の独立再検証 + サブエージェント
レビュー + 主文脈での裏取り + ff-merge + 記録、を 1 サイクルで実施した。
タスク類型別のワークフロー・loop 起動手順・エスカレーション基準は
[workflows.md](./workflows.md) を参照（本書は監査の深さと手順のみを定める）。

## 原則（全 tier 共通）

1. **監査は記憶でなく再実行**。受け入れ条件は監査時にその場で再実行する。Codex の status.md
   報告（「GREEN だった」）を判定根拠にしない（hub 規約: 網羅性・完成の主張は機械照合のみを根拠にする）。
2. **サブエージェントの指摘は裏取りしてから採用**。tasks/08 監査では初回指摘 5 件中 3 件が
   誤検出だった（tx 境界 / fail-open / seq 設計）。指摘は必ず実コードで反証を試みてから
   block 判断に使う。
3. **merge は監査者が行う**。GREEN 確認 → commit（規約 `[NN] <説明>`）→ main へ ff-merge → push。
4. **監査記録を必ず残す**: status.md の Last completed に「何を検証し、何を反証し、
   何を follow-up にしたか」を 1 エントリで記録。follow-up は GitHub issue 化（例: #3）。
5. **環境起因と回帰を区別する**。e2e/coverage の失敗は、まず DB 鮮度・live transcript・
   dev server と `.next` 共有などの既知の環境要因を疑い、diff が該当面を触っているかで
   回帰判定する（tasks/08 監査の 48/49 → 原因特定 → 49/49 が前例）。
6. **指摘の重大度は 3 段階**: 重大（merge block。修正されるまで merge しない）/
   中（merge 可、issue 化必須）/ 軽微（記録のみ）。block の降格はユーザー判断のみ。
7. **全実装に独立レビュー必須（2026-06-12 ユーザー決定）**: tier に関わらず、すべての実装は
   merge 前に独立レビューを必ず通す。実装者と同じ context（= main 自身の diff 流し読みのみ）で
   済ませない。レビュー指摘は原則どおり実コードで裏取りしてから採否（誤検出を block にしない）。
   chip 由来 PR も同じく、merge 前に独立レビューを 1 回かける。
   **レビューに使うモデル（2026-06-12 ユーザー訂正・厳守）**: **最新 Opus**（`claude-opus-4-8`、
   Agent tool `model: opus`）または **最新 Codex**（`gpt-5.5` 等を **reasoning effort xhigh 以上**、
   `codex --effort xhigh`）のみ。**Sonnet・軽量モデルをレビューに使わない**。レビューは品質の
   最終防壁であり、ここをケチらない。
8. **UI/視覚変更は実ブラウザ + スクショで検証（2026-06-12 ユーザー訂正・厳守）**: レイアウト・
   見た目・操作フローの変更は **e2e のアサーションだけで合格にしない**。実ブラウザで対象画面を
   開き、**スクリーンショットと computed geometry（要素の bounding box・グリッド列）を実測**して
   退行が無いことを確認する。**この UI 検証は main（Fable）が自分でやらない** — Codex または
   サブエージェントに行わせる（ユーザー: 「お前がテストするのをやめろ / UI テストは codex に」）。
   背景の事故: blank-fix の e2e が「finding 選択で grid left が一定」だけを見ていたため、
   **全選択で一様に左空白が出る状態でも「一定」で通り**、視覚退行を見逃した（2026-06-12 再発）。
   視覚アサーションは相対不変でなく**絶対位置**（例: グリッド左端 ≈ コンテナ左端、空白列なし）で書く。

## リスク tier の定義

task ファイルの frontmatter に `audit: A | B | C` を必ず書く。**tier は task 起草時に
Claude が宣言し、Codex 側から下げられない**。迷ったら上の tier。

### Tier A — フル監査

**対象**: 以下のいずれかに触れる task
- DB スキーマ変更・migration（schema.sql、列セマンティクス）
- 界面契約: HTTP API・hook payload・archive/finding format・package 間 interface・MCP tool surface
- セキュリティ面: 認可、外部入力の fs/DB 到達経路、redaction
- ingest 正しさ（正本 ⇄ DB の対応を変えるもの）
- Phase 3 sandbox の隔離境界

**監査内容**:
1. 受け入れ条件**全項目**をその場で独立再実行（exit code / 件数まで確認）
2. サブエージェントによる敵対的コードレビュー（観点: 正しさ / 界面整合 / セキュリティ /
   冪等・増分性 / 検証スクリプトの自己改変充足の有無）→ 重大指摘は主文脈で裏取り
3. docs（README / PROTOTYPE / design）と実装の一致確認
4. merge + 記録

### Tier B — 標準監査

**対象**: 確立済みの界面の内側での機能追加・拡張（新しい画面、既存 provider への項目追加、
viewer の新タブ等）

**監査内容**:
1. 機械ゲート再実行（`build` / `e2e` / `coverage` + task 固有の検証コマンド）
2. **独立レビュー必須**（原則 7）: sub-agent または Codex によるコードレビュー（重点 path）。
   主文脈の diff 流し読みだけで済ませない
3. merge + 記録

### Tier C — 軽量監査

**対象**: UI 磨き・文言・docs・界面を変えないリファクタ・スタイル

**監査内容**:
1. 機械ゲート再実行
2. **独立レビュー必須**（原則 7）: sub-agent または Codex による軽量レビュー（スコープ外変更・
   逸脱の有無）。複数 task をまとめて 1 レビューにしてよいが、レビュー自体は省略しない
3. merge + 記録。**複数 task をまとめて 1 監査にしてよい**

## 監査外で main に入った commit（out-of-band）

監査を通らず main に入った commit（例: 別セッション・chip 起動・手動 push）は、
**発見次第レトロ監査**する（`d0f5da0` が初例）。レトロ監査の強度は同じ tier 基準。
重大指摘が出た場合は hotfix task を起こす（revert はユーザー判断）。

## 監査と single-writer の関係

- Codex loop 稼働中（status.md `current_owner: codex*`）、Claude は当該ファイルを編集しない。
  監査は **loop 停止後**（受け入れ条件 GREEN 自己申告 or bound 到達）に開始する。
- 監査中の修正指示は、軽微なら Claude が直接 fix commit（記録必須）、重大なら task に
  差し戻して loop 再開、のどちらかを status.md に明記する。

## このプロトコル自体の改訂

監査で繰り返し同じ種類の見逃し / 誤検出が出たら、本書の tier 定義・観点リストを更新する
（それ自体が Lathe の主題 = ハーネス改善ループの dogfood）。
