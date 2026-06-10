---
title: Lathe — Roadmap (Phase 1 → 7)
status: drafting
owner: yutaro0915
created: 2026-06-07
updated: 2026-06-07
---

# Lathe — Roadmap (Phase 1 → 7)

## TL;DR

- **目標**: 提案書 ([fukuoka-mitou-2026 proposal](../fukuoka-mitou-2026/work/proposal-ohno-draft-plain.md)) の全ビジョン（Phase 1-7）を完成させ、「**ハーネス開発を職人芸から定量工学へ引き上げる開発基盤**」を**ループとして動かす**。
- **アプローチ**: **dogfood-first**。当面はあなた自身がセルフホストで全 Phase を回し、その実運用フィードバックを元に Phase 7 を完成させる。**OSS 公開は Phase 7 動作後に段階的**に行う。
- **境界**: 提案書 [§3.0](../fukuoka-mitou-2026/work/proposal-ohno-draft-plain.md) に従い、**実装意図の作成 UI / コード編集環境 / PR ホスティングは Lathe の外**。入力は「既存ツール（Claude Code / Codex / Cursor / GitHub PR）が残した実行履歴」、出力は「ハーネス改善案・採否履歴・スコア推移」。
- **初期セキュリティ**: 単一ユーザー dogfood のため、認証・RBAC・SOC2・マルチテナント対応は**当面しない**。Phase 7 動作後の OSS 公開フェーズで段階的に追加する。

## なぜ今ロードマップを書くか

[PROTOTYPE.md](./PROTOTYPE.md) は Phase 1（観測）の引き継ぎ書、[REFACTOR-PLAN.md](./REFACTOR-PLAN.md) は Phase 1 のリファクタ計画。どちらも Phase 1 内に閉じている。**Phase 2 以降の方向性が文書化されていないため、観測機能の作り込み深さやアーキテクチャの選定が宙に浮く**。本書はその橋渡し。

## ビジョンの再確認

### 提案書が描くループ（[§3.3](../fukuoka-mitou-2026/work/proposal-ohno-draft-plain.md)）

```
[ A. 開発タスク処理ライン — Lathe の外 ]
  ① 意図の提示 (人間, 既存ツール)
  ② PR を起こす (人間, GitHub)
  ③ 実装 (実装エージェント, Claude Code / Codex / Cursor)
  ④ PR を返す (実装エージェント, GitHub)

[ B. ハーネス改善ループ — Lathe の内 ]
  ⑤ 実行履歴の集約 (Lathe)              ← Phase 1 = 観測
  ⑥ 履歴の横断分析 (ハーネス改善エージェント) ← Phase 2 = AI 分析
  ⑦ 改善案の検証 (検証用入出力セット + 自動採点機) ← Phase 3-4 = 実験 + Evals
  ⑧ 採用改善の蓄積 (Lathe)               ← Phase 5-6 = Agent 接続 + 統合
```

**起点は issue ではなく PR**（[§3.3](../fukuoka-mitou-2026/work/proposal-ohno-draft-plain.md)）。雑な実装コードも意図の一部として扱うため。

### ターゲットの段階

- **Phase 1-7 開発期間**: **あなた1人 dogfood**。`pnpm dev` 起動で単一ユーザー、認証なし、ローカル SQLite。
- **OSS 公開後（Phase 7+）**: 提案書 [§2.3](../fukuoka-mitou-2026/work/proposal-ohno-draft-plain.md) の三対象（チーム / 個人 / 研究者）。

## 設計境界（変えない）

| 担う（Lathe の内） | 担わない（Lathe の外） |
|---|---|
| 実行履歴の集約・永続化 | 実装意図の作成 UI（モック・スケッチエディタ等） |
| ハーネス自体の編集・改善・採否管理 | コード編集環境 / IDE 相当 |
| 改善前後の隔離検証 + 並走比較 | PR ホスティング機能（GitHub に任せる）|
| 改善ノウハウの構造化された成果物化 | 実装エージェントそのもの |

**この境界は Phase 7 完成まで守る**。境界が膨らみ始めたら Phase 設計を見直す。

## Phase 別スコープ

各 Phase は「**dogfood で 1 ループ回せる最小**」を完了の定義にする。**スコープを膨らませない**。

### Phase 1 — 観測（実行履歴の集約）

**現状**: 基本動作・E2E 49/49 GREEN・public 公開済み（→ [PROTOTYPE.md](./PROTOTYPE.md)）。

**Phase 1 完了の定義（dogfood で観測の不便がない状態）**:

- [x] Claude Code / Codex のローカル transcript 取り込み
- [x] Per-session ビュー（Transcript / Tools / Git / Skills / Subagents / Raw JSON / Stats）
- [x] Cross-session ビュー（`/overview`）
- [x] cost = 実トークン × 実モデル単価
- [x] サブエージェント run 単位ナビ
- [x] ハーネス信号観測（memory / hook / skill）
- [x] Transcript ⇄ Git 双方向リンク、step focus
- [x] 巨大セッション軽量化（hunk pagination + 時系列バケット）
- [ ] **provider 抽象 + 型強化**（Codex 進行中、→ [REFACTOR-PLAN.md](./REFACTOR-PLAN.md) tasks/04）
- [ ] **増分 ingest / watch**（リアルタイム更新 — dogfood で必須）
- [ ] **PR 連携**（GitHub API で PR 履歴を実行記録に取り込み — 提案書の「起点は PR」を満たす）

**Phase 1 で意図的にやらないこと**:

- **Cursor 取り込み**: ユーザーが Claude / Codex 中心なら後回し。OSS 公開時に再評価。
- **検索強化（ベクトル検索等）**: Phase 2 の分析機能で十分代替できる可能性。
- **マルチユーザー対応**: dogfood 単一ユーザーのため不要。

**目安**: 1〜2 週間（リファクタ + 増分 ingest + PR 連携）。

### Phase 2 — AI 分析（履歴の横断分析）

**目的**: ⑥ の自動化。**ハーネス改善エージェント**が Phase 1 の DB を横断して **finding（改善余地）** を抽出する。

**スコープ**:

- 1 セッション内の finding 抽出（リスク行動、未帰属差分、失敗ループ、過剰トークン消費、長すぎる turn など）
- 複数セッション横断の finding 抽出（同じハーネスでの同じ失敗パターン、コスト推移）
- 各 finding は **根拠リンク**（Phase 1 のイベント・差分・hunk への direct reference）を持つ
- **MCP ツール**: ハーネス改善エージェントが transcript を query できる Server を Lathe が公開（`mcp__lathe__*`）

**完了の定義**:

- dogfood の自分のセッションを analyst が読み、finding が 1 件でも有意義に出る
- finding をクリックして Phase 1 のイベント・差分にジャンプできる
- finding は archive に追加され、後の Phase 3 で fixture として再利用できる

**目安**: 3〜4 週間（finding データモデル + analyst の最小プロトタイプ）。

### Phase 3 — 対照実験基盤（改善案の検証）

**目的**: ⑦ の前半。**検証用入出力セット (fixture)** に対し、改善前後のハーネスを並走実行できる隔離環境。

**スコープ**:

- fixture の格納（提案書の「検証用入出力セット」= 固定された入力 + 期待結果のセット）
- **Sandbox** の選定 — Docker / git-isolated / Cloudflare Sandbox SDK のどれか
  - 推奨検討対象: [Cloudflare Sandbox SDK](https://github.com/cloudflare/sandbox-sdk)（オーバーヘッド軽い、Lathe 全体が Workers に乗ると Phase 6 で楽）
  - 代替: ローカル Docker Compose（自前で全部）
- 改善前後の harness を並走実行（同じ fixture を 2 バージョンに食わせる）
- 並走結果を archive に記録（後の Phase 4 で採点する）

**完了の定義**:

- 自分の Claude Code CLAUDE.md の 1 行変更を例に、改善前 vs 改善後で同じ fixture を回せる
- 並走結果が Lathe DB に記録され、Phase 2 finding と紐付く

**目安**: 4〜6 週間（sandbox 選定 + 並走 runner + 結果記録）。

### Phase 4 — Evals / 自動採点機

**目的**: ⑦ の後半。**自動採点機 (judge)** が並走結果を rubric に沿って採点。改善案の合否を機械化する。

**スコープ**:

- **rubric** の設計（採点観点の集合、例: 「コードが動く」「テストが通る」「セキュリティ違反がない」「指示に従っている」）
- LLM-as-judge による採点（Claude API で OK）
- 採点結果の archive 記録
- 既存 evals fw との互換性検討（Inspect AI 等、提案書では Phase 7 のスコープ）

**完了の定義**:

- 同一 fixture × 改善前後 × rubric で機械的に勝敗が出る
- 採点理由が finding と紐付く

**目安**: 2〜3 週間（rubric + judge + 結果集約）。

### Phase 5 — Agent 接続（実装エージェント観測の汎用化）

**目的**: ⑧ の前半。提案書 [§2.2](../fukuoka-mitou-2026/work/proposal-ohno-draft-plain.md) の「**コーディングエージェント自体は作らない**」原則を守りつつ、既存 agent サービスとの統合を汎用化する。

**スコープ**:

- Plugin 経由で各 provider の transcript と PR 履歴を抽象化（Phase 1 の provider 抽象を発展）
- **Claude Code / Codex / Cursor / Devin / Aider** 等を同じ interface で扱う
- 各 plugin は `discover()` + `build()` + `apply(改善案)` の 3 メソッドを持つ
- 「ハーネス改善 → 自動適用 → 検証」が agent 横断で動く

**完了の定義**:

- Claude Code に対して `apply(CLAUDE.md 改訂案)` で改訂が PR 化される
- 同じ flow が Codex / Cursor に対しても動く skeleton

**目安**: 3〜4 週間。

### Phase 6 — 統合（ループの運用化）

**目的**: ⑧ の後半。Phase 1-5 を**1 つの運用ループとして接続**。改善履歴を成果物として永続化。

**スコープ**:

- 改善履歴の永続化（dec 採否、scoring 推移、回帰アラート）
- ダッシュボード（複数 project / 複数 harness 版 / 複数 agent の横断ビュー）
- 採否管理 UI（人間が最終承認するワークフロー）
- 週次レポート、改善履歴の検索

**完了の定義**:

- 自分の Claude Code / Codex で観測 → 分析 → 改善案 → 実験 → 採点 → 採用 → 履歴記録 が**人間の 1 クリック範囲で回る**
- 改善履歴を時系列で見ると、ハーネス品質の推移が読める

**目安**: 3〜4 週間。

### Phase 7 — Spec 公開 + OSS 配布

**目的**: dogfood で動作証明できた状態から、**段階的に OSS として公開**する。

**スコープ**:

- 実行記録の **JSON Schema 仕様公開**（提案書 [§2.2 軸 δ](../fukuoka-mitou-2026/work/proposal-ohno-draft-plain.md)、phase7 essence の archive format v2 系譜）
- Inspect AI 互換 exporter（OSS 評価生態系との接続）
- README / Quickstart / Architecture 図 / Contributor Guide
- 初期 OSS 公開時の現実的なセキュリティライン（後述）
- 段階的なマルチユーザー / SSO / RBAC 機能追加（任意、需要次第）

**目安**: 4〜6 週間（dogfood 完成後）。

## アーキテクチャの方向性

### Phase 1-6（dogfood 期）

- **Frontend**: Next.js 15（現状維持）
- **DB**: **Postgres**（[ADR 0004](./adr/0004-postgres-from-phase-1-and-hybrid-dev-env.md)。旧案「SQLite を Phase 6 まで維持」は撤回。現コードは `node:sqlite`、実装時に `pg` へ差し替え）
- **Dev 環境**: 依存（Postgres 等）だけ Docker Compose、アプリ + worker は host で `pnpm dev`（[ADR 0004](./adr/0004-postgres-from-phase-1-and-hybrid-dev-env.md)）。SQLite 期は Docker 不要
- **Ingest**: `tsx scripts/ingest.ts` + provider plugins（[REFACTOR-PLAN.md](./REFACTOR-PLAN.md) tasks/04 後）
- **Background workers**:
  - Phase 2 analyst worker（finding 抽出）
  - Phase 3 sandbox runner（fixture 並走実行）
  - Phase 4 judge worker（採点）
  - 当面: Node.js child process / シンプルな queue（BullMQ 等不要、SQLite ベースで足りる）
- **Auth**: なし（dogfood 単一ユーザー）
- **観測 API**: MCP server として Phase 2 で公開（外部 agent からも query 可）

### Phase 7+（OSS 公開期）

- DB は既に Postgres（[ADR 0004](./adr/0004-postgres-from-phase-1-and-hybrid-dev-env.md)、Phase 1 から）。Phase 7 は本番運用向けチューニング（接続プール / バックアップ / index 設計）に集中
- 認証層: 最小限の API key / OAuth、本格的な RBAC は需要次第
- Deploy: **Docker Compose + Postgres**（セルフホスト）を主経路に（[ADR 0004](./adr/0004-postgres-from-phase-1-and-hybrid-dev-env.md)）。Cloudflare Workers + D1 路線は降格（必要が出たら再検討）
- Phase 3 sandbox は **Docker ベース**が第一候補（[ADR 0004](./adr/0004-postgres-from-phase-1-and-hybrid-dev-env.md) で Workers 路線を降格したため、Cloudflare Sandbox SDK の Workers 同居メリットは薄れた）

### 「初期は高セキュリティしない」の具体

- 認証なしの dev server（`pnpm dev` localhost:3210）
- API key 不要、token 不要
- secrets は OS keychain / `.env`（gitignore 済み）
- これでも:
  - **transcripts に含まれる機密**は ingest 時に明示的に redact（既存の token redaction を維持・拡張）
  - **public repo に push する artifacts は手動レビュー必須**（既存の `cherie` スクラブ規約）

## 直近 3〜6 ヶ月のマイルストーン

| M | 期間 | 内容 | 完了の判定 |
|---|---|---|---|
| **M1** | 1-2 週間（今） | Phase 1 リファクタ完成（Codex） + 増分 ingest skeleton | `pnpm e2e` GREEN / 新セッション追加でブラウザ自動更新 |
| **M2** | 〜1 ヶ月 | PR 連携（GitHub API で PR 履歴も実行記録に取り込み） | dogfood の自分の PR の意図 → 実装 → review → merge が 1 セッションとして見える |
| **M3** | 1-2 ヶ月 | **Phase 2 analyst の最小プロトタイプ** + MCP server 公開 | Claude API で自分のセッションを読み、finding が 1 件出る |
| **M4** | 2-4 ヶ月 | **Phase 3 sandbox + Phase 4 judge** の最小構成 | 自分の CLAUDE.md の 1 行変更で改善前後を並走、勝敗が出る |
| **M5** | 4-6 ヶ月 | **Phase 5-6 統合** = ループの最短経路が動く | 観測 → 分析 → 改善案 → 実験 → 採点 → 採用 → 履歴記録 が 1 クリック範囲で回る |
| **M6** | 6 ヶ月〜 | **Phase 7** spec 公開 + OSS 段階公開 | JSON Schema 公開 + README / quickstart 整備 |

## 決定済み（ADR 索引）

| ADR | 件名 | 日付 |
|---|---|---|
| [0001](./adr/0001-ingest-via-hook-and-server-side-jsonl.md) | Ingest pipeline = Stop hook trigger + server-side jsonl reading（Langfuse 流） | 2026-06-07 |
| [0002](./adr/0002-project-identity-model.md) | Project = repo、identity vs display_name 分離、canonical = 正規化 git remote URL | 2026-06-07 |
| [0003](./adr/0003-monorepo-with-pnpm-workspaces.md) | Repository structure = single GitHub repo, internal pnpm workspaces + Turborepo | 2026-06-07 |
| [0004](./adr/0004-postgres-from-phase-1-and-hybrid-dev-env.md) | DB = Postgres（Phase 1 から）+ hybrid dev env（依存だけ Docker・アプリは host）+ dev/prod compose 分離 | 2026-06-09 |

## 次に詰める論点（順序つき）

ADR 0001-0003 で観測パイプラインの骨格は決まった。次は実装に落とすための詳細を順に詰める。

| 順 | 論点 | 主担当 | 関連 ADR |
|---|---|---|---|
| **1** | **monorepo 移行のタイミング**（今すぐ / Phase 1 リファクタ完了後 / Phase 2 直前） | 議論 | [0003](./adr/0003-monorepo-with-pnpm-workspaces.md) |
| **2** | **hook が送る payload の中身**（`session_id` / `transcript_path` / `project_id` / `cwd` / `git_branch` / その他） | 議論 → 別 ADR | [0001](./adr/0001-ingest-via-hook-and-server-side-jsonl.md), [0002](./adr/0002-project-identity-model.md) |
| **3** | **`lathe-client init` の UX**（`.claude/settings.json` への hook 追加、本体 URL の保存、identity 解決の対話フロー、init 失敗時の挙動） | 議論 → 別 ADR | [0001](./adr/0001-ingest-via-hook-and-server-side-jsonl.md), [0002](./adr/0002-project-identity-model.md) |
| **4** | **サーバ停止中の取りこぼし対策**（catch-up sweep の仕様、どこまで遡るか、重複回避） | 議論 → 別 ADR | [0001](./adr/0001-ingest-via-hook-and-server-side-jsonl.md) |
| **5** | **HTTP API 設計**（`POST /api/ingest/notify` 等の endpoint 仕様、認証は当面なし） | 議論 → 別 ADR | [0001](./adr/0001-ingest-via-hook-and-server-side-jsonl.md) |
| **6** | **DB スキーマ変更**（`sessions.project` の意味変更、`projects` テーブル新設） | 設計 → 別 ADR | [0002](./adr/0002-project-identity-model.md) |
| **7** | **MCP server**（Phase 2 で外部 agent からも query 可能にする、stdio / SSE / HTTP のどれか） | 議論 → 別 ADR | (Phase 2) |
| **8** | **PR 連携の認証**（GitHub Personal Access Token / GitHub App） | 議論 → 別 ADR | (Phase 1 完成) |
| **9** | **Phase 3 の sandbox**（Cloudflare Sandbox SDK / Docker Compose / Modal Labs） | 議論 → 別 ADR | (Phase 3) |
| **10** | **archive format v2 の踏襲度**（lathe-phase7 の v2 spec をそのまま採用するか、Phase 1 の現スキーマを発展させるか） | 議論 → 別 ADR | (Phase 2 finding データモデル設計時) |
| **11** | **npm package 名問題**（`lathe` は埋まり気味 → `@yutaro0915/lathe` 等） | 議論 → 別 ADR | [0003](./adr/0003-monorepo-with-pnpm-workspaces.md) |

## このロードマップとの整合性チェック

- **新機能を追加するとき**: 提案書の境界（[§3.0](../fukuoka-mitou-2026/work/proposal-ohno-draft-plain.md)）から外れていないか確認。実装意図 UI / コード編集環境 / PR ホスティングを Lathe 内に作らない。
- **Phase を飛び越したくなったとき**: dogfood で 1 ループ回せる最小に立ち返る。先の Phase に手を出さない（[AGENTS.md](./AGENTS.md) Scope）。
- **アーキテクチャ重大変更**: ADR を起こし、本書を更新。

## 出口

- **Phase 6 動作時**: 本書を「Roadmap (実績版)」に更新し、各 Phase の振り返りをまとめる。
- **Phase 7 OSS 公開時**: 本書を README に統合 or 公開用の概念図に置き換える。
