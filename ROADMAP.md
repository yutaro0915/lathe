---
title: Lathe — Roadmap (Phase 1 → 7)
status: in-progress
owner: yutaro0915
created: 2026-06-07
updated: 2026-06-11
---

# Lathe — Roadmap (Phase 1 → 7)

## TL;DR

- **目標**: 提案書 ([fukuoka-mitou-2026 proposal](../fukuoka-mitou-2026/work/proposal-ohno-draft-plain.md)) の全ビジョン（Phase 1-7）を完成させ、「**ハーネス開発を職人芸から定量工学へ引き上げる開発基盤**」を**ループとして動かす**。
- **アプローチ**: **dogfood-first**。当面はあなた自身がセルフホストで全 Phase を回し、その実運用フィードバックを元に Phase 7 を完成させる。**OSS 公開は Phase 7 動作後に段階的**に行う。
- **境界**: 提案書 [§3.0](../fukuoka-mitou-2026/work/proposal-ohno-draft-plain.md) に従い、**実装意図の作成 UI / コード編集環境 / PR ホスティングは Lathe の外**。入力は「既存ツール（Claude Code / Codex / Cursor / GitHub PR）が残した実行履歴」、出力は「ハーネス改善案・採否履歴・スコア推移」。
- **初期セキュリティ**: 単一ユーザー dogfood のため、認証・RBAC・SOC2・マルチテナント対応は**当面しない**。Phase 7 動作後の OSS 公開フェーズで段階的に追加する（notify endpoint の token 認可は #3 対応で導入済み）。
- **計画運用（2026-06-11 ユーザー決定）**: ① **rolling wave** — 全 Phase の完了定義・ADR ゲート・順序は本書で確定し、task ファイル詳細化は「現 Phase + 次 Phase」のみ。② **リスク階層監査** — 全 task に `audit: A|B|C` を宣言し Claude が常設監査（[design/audit-protocol.md](./design/audit-protocol.md)）。③ **期日はベストエフォート** — 順序と完了定義だけ固定し、日付は管理しない（各 Phase の「目安」は参考値）。

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

**現状（2026-06-11）**: tasks/01〜08 完了・main へ merge 済み。pnpm workspace 化（apps/web + packages/client,shared）、Postgres 移行（ADR 0004）、push 主・pull 補 ingest（`lathe-client init` + `POST /api/ingest/notify`、token 認可つき）。E2E 49/49 GREEN（→ [PROTOTYPE.md](./PROTOTYPE.md)）。

**Phase 1 完了の定義（dogfood で観測の不便がない状態。G8/G9 は 2026-06-11 ユーザー決定で完了ラインに追加）**:

- [x] Claude Code / Codex のローカル transcript 取り込み
- [x] Per-session ビュー（Transcript / Tools / Git / Skills / Subagents / Raw JSON / Stats）
- [x] Cross-session ビュー（`/overview`）
- [x] cost = 実トークン × 実モデル単価
- [x] サブエージェント run 単位ナビ
- [x] ハーネス信号観測（memory / hook / skill）
- [x] Transcript ⇄ Git 双方向リンク、step focus
- [x] 巨大セッション軽量化（hunk pagination + 時系列バケット）
- [x] **provider 抽象 + 型強化**（tasks/04）
- [x] **増分 ingest**（tasks/08 = Stop hook push + catch-up sweep。S1-4 成立）
- [x] **G8 探索 UI**（turn-first A-1。tasks/09 mockup → tasks/10 骨格 `a35cab9` → UI 標準 B 適用 `3f5dcf5`。S1-1 済）
- [x] **G9 コスト異常検知**（S1-3。前提の cost 検証 tasks/11 で **Opus 4.5+ の 3 倍過大計上を発見・修正** `493f3d8` → hybrid baseline 実装 tasks/12 `a281849`）
- [x] **G1 PR 連携**（tasks/13 `c8cae1b`。ADR 0006 = commit SHA 主 + branch 補。監査で block 3 件 → 修正 → 実データリンク成立を確認して merge。S1-5 済）

**Phase 1 完了（2026-06-11）**。e2e 67/67 / coverage GREEN / verify スクリプト 7 本 GREEN。

**振り返り（要点）**:
- **監査の価値が実証された**: tasks/13 は全ゲート GREEN 自己申告だったが、実データ照合で「紐付け 0 行」（検証スクリプトの合成 fixture による自己充足）を検出。fixture だけの GREEN は信用しない、が Phase 2 以降の検証設計の規範
- **cost 3 倍過大の発見**: 異常検知（G9）の前に cost 検証を挟む判断が正解だった。前提検証 → 機能実装の順序は維持
- **loop 運用の学び**は workflows.md / dev-loop.md に反映済み（/goal は CLI 引数、継続明示、prefix 永続承認、watcher、`.next` 規約、ゲートスクリプト変更は監査者検分）
- **実装配分の確立**: Claude は実装しない。UI = Opus、機械検証可能な実装 = Codex loop、probe = 並列サブエージェント

**Phase 1 で意図的にやらないこと**:

- **ハーネスの追跡・管理**（snapshot / 版数 / inventory / 編集・適用）: 完全にスコープ外（2026-06-11 決定、[ADR 0005](./adr/0005-harness-artifact-model.md) §4）。ハーネス**信号**の観測（memory / hook / skill イベント）は実装済みで残す。版数導入は Phase 2 開始ゲート。過去セッション分は git 履歴から後追い再構成できる。
- **Cursor 取り込み**: ユーザーが Claude / Codex 中心なら後回し。OSS 公開時に再評価。
- **検索強化（ベクトル検索等）**: Phase 2 の分析機能で十分代替できる可能性。
- **マルチユーザー対応**: dogfood 単一ユーザーのため不要。

**目安（参考）**: 2〜3 週間（G8 骨格 + G9 + G1 設計&実装）。

### Phase 2 — AI 分析（履歴の横断分析）

**目的**: ⑥ の自動化。**ハーネス改善エージェント**が Phase 1 の DB を横断して **finding（改善余地）** を抽出する。

**スコープ**:

- 1 セッション内の finding 抽出（リスク行動、未帰属差分、失敗ループ、過剰トークン消費、長すぎる turn など）
- 複数セッション横断の finding 抽出（同じハーネスでの同じ失敗パターン、コスト推移）
- 各 finding は **根拠リンク**（Phase 1 のイベント・差分・hunk への direct reference）を持つ
- **MCP ツール**: ハーネス改善エージェントが transcript を query できる Server を Lathe が公開（`mcp__lathe__*`）

**Phase 2 開始ゲートで確定する界面契約（後から変えると高くつく順）**:

1. **ハーネス版数（harness version）を一級概念としてデータモデルに導入** — モデルは [ADR 0005](./adr/0005-harness-artifact-model.md)（artifact 集合 + provider binding + hash 版数。意味論は扱わない浅いモデル。agent = runner × model × harness 版の導出タプルでエンティティ化しない）。G7（回帰検知、Phase 6）は「スコアがハーネス版数に紐付く」ことが前提。Phase 2 で入れ損なうと Phase 6 で migration になる
2. **finding データモデル + archive format v2 の踏襲度**（論点 #10。lathe-phase7 の v2 spec = Intent / Plan / DecisionTrace / format_version semver をどこまで採るか）
3. **G2**: finding の「有意義」の定義（dogfood で 1 件出る、の判定基準）
4. **G3**: finding 採否記録の最小スキーマ（棄却理由を Phase 4 judge の学習材料にする）
5. **MCP server の transport**（論点 #7: stdio / SSE / HTTP）
6. **analyst 選抜プロトコル**（複雑系対処 = probe-sense-respond）: 複数 candidate analyst（prompt / tool 構成違い）を並列 probe する。fitness は二段 — (a) **既知インシデント replay = 動作確認の smoke gate**: `memory/feedback_*.md` や lathe status.md 履歴など、人間認定済みの実ハーネス失敗（実際に harness 規則化されたもの）を seed 正解集合とし、教えずに過去 transcript から近い指摘を再発見できるかを見る。**ただし seed は数も質も限られる（N≈10〜20）ため最適化対象にしない（Goodhart 回避）** — 一部でも再発見できれば「動く」と判定して早期に dogfood 投入する。(b) **本命の fitness は運用中のユーザー採否ストリーム**で precision を継続測定。採否記録の蓄積により G2「有意義」の定義を結晶化させ、複雑系 → 煩雑系へ移行したら定義を文書化して Phase 4 judge の設計材料にする
7. **採否 UX 要件**: ユーザーの採否判定は「**1 クリック + 理由一言**」で完了すること。判定が重いとループ自体が止まる（G4 fixture 化と同種の、dogfood 成立の急所）

**Phase 2 のスコープ境界（2026-06-11 確定）**:

- analyst の出力は**現象レベルの finding**（改善余地 + 根拠リンク）まで。ハーネスの語彙（どのファイルをどう変えるか）には踏み込ませない。どの種類の finding がハーネスで解決可能かは、事前の制約ではなく採否記録から学ぶ（[ADR 0005](./adr/0005-harness-artifact-model.md) §3 と整合）
- ハーネスは操作しない。ただし **session / finding への harness 版数スタンプは行う**（記録のみ。採用改善の before/after 比較 = G7 原型の成立条件）
- 採用 finding のハーネスへの適用は P2 では**ユーザーの手作業**（Lathe の外）。自動適用は Phase 5
- analyst をコードレビューツール化しない（設計境界: コード編集環境は Lathe の外）。コードのバグは「agent がそれを見逃した / 作った過程」という現象として扱う限りで finding になる

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

**Phase 3 開始ゲートで確定する事項**:

1. **G4: fixture の保持範囲**（プロンプトのみ vs repo 状態・ハーネス版数込み）— 「finding → fixture 化が軽い」かどうかが dogfood ループの成立を左右する急所
2. **sandbox 選定**（論点 #9。ADR 0004 で Workers 路線降格後は Docker ベースが第一候補。選定 ADR を起こす）
3. **G5: 並走結果の比較 UI**（Phase 1 の SessionViewer を 2 カラム再利用できるかが設計分岐。S4-3 judge 検証とも同根）

**完了の定義**:

- 自分の Claude Code CLAUDE.md の 1 行変更を例に、改善前 vs 改善後で同じ fixture を回せる
- 並走結果が Lathe DB に記録され、Phase 2 finding と紐付く

**目安**: 4〜6 週間（sandbox 選定 + 並走 runner + 結果記録）。

### Phase 4 — Evals / 自動採点機

**目的**: ⑦ の後半。**自動採点機 (judge)** が並走結果を rubric に沿って採点。改善案の合否を機械化する。

**スコープ**:

- **rubric** の設計（採点観点の集合、例: 「コードが動く」「テストが通る」「セキュリティ違反がない」「指示に従っている」）
- **G6: rubric テンプレ運用**（テンプレから数分で微調整できる UX。S4-1。重い rubric 作成はループを止める）
- LLM-as-judge による採点（Claude API で OK）。提案書 §3.x の信頼性向上策（多数決 / cross-model judging / 一次資料ベース採点）は最小構成の後に段階導入
- 採点結果の archive 記録（採点理由 → finding への逆リンク。S4-3 judge への不信に答える）
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

**Phase 5 開始ゲートで確定する事項**:

1. **ハーネス意味論の一般化**（[ADR 0005](./adr/0005-harness-artifact-model.md) §3 で意図的に未決とした部分）— loop の扱い / rubric・eval はハーネスの要素か / 操作 UX / basic harness の一般形を、Phase 2〜4 の CC/Codex 運用で集めた実例・provider 差の記録から一般化する。ADR 0005 の改訂または新 ADR として確定

**完了の定義**:

- Claude Code に対して `apply(CLAUDE.md 改訂案)` で改訂が PR 化される
- 同じ flow が Codex / Cursor に対しても動く skeleton

**目安**: 3〜4 週間。

### Phase 6 — 統合（ループの運用化）

**目的**: ⑧ の後半。Phase 1-5 を**1 つの運用ループとして接続**。改善履歴を成果物として永続化。

**スコープ**:

- 改善履歴の永続化（dec 採否、scoring 推移、**G7: 回帰アラート** — Phase 2 で導入したハーネス版数に紐付く。S6-3）
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
  - 当面: Node.js child process / シンプルな queue（BullMQ 等不要、Postgres テーブルベースの素朴な queue で足りる）
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

## マイルストーン（順序ベース。期日はベストエフォート — 2026-06-11 決定）

| M | 内容 | 完了の判定 | 状態 |
|---|---|---|---|
| **M1** | Phase 1 リファクタ + monorepo + Postgres + 増分 ingest（tasks/01〜08） | `pnpm -F web e2e` GREEN / Stop hook で自動反映 | **済（2026-06-10）** |
| **M2** | Phase 1 完了 = G8 探索 UI + G9 コスト異常 + G1 PR 連携 | dogfood の自分の PR の意図 → 実装 → review → merge が 1 セッションとして見える。S1-1〜S1-5 全て閉じる | **済（2026-06-11）** |
| **M3** | **Phase 2 analyst の最小プロトタイプ** + MCP server 公開 | Claude API で自分のセッションを読み、finding が 1 件出る。finding クリックで Phase 1 のイベントへジャンプできる | — |
| **M4** | **Phase 3 sandbox + Phase 4 judge** の最小構成 | 自分の CLAUDE.md の 1 行変更で改善前後を並走、勝敗が出る | — |
| **M5** | **Phase 5-6 統合** = ループの最短経路が動く | 観測 → 分析 → 改善案 → 実験 → 採点 → 採用 → 履歴記録 が 1 クリック範囲で回る | — |
| **M6** | **Phase 7** spec 公開 + OSS 段階公開 | JSON Schema 公開 + README / quickstart 整備 | — |

## 計画運用 — rolling wave と監査

**rolling wave（2026-06-11 決定）**: 本書で確定するのは「全 Phase の完了定義・開始ゲート・順序」。
task ファイル（`tasks/NN-*.md`、受け入れ条件つき）への詳細化は **現 Phase + 次 Phase のみ**行う。
遠い Phase の task 分割は前 Phase の設計結果で陳腐化するため、書かない。

**Phase 開始ゲート（design sprint）**: 各 Phase 着手時に Claude が
① その Phase の「開始ゲートで確定する事項」（各 Phase 節に列挙済み）を design 文書 + ADR に確定
（必要な判断はユーザーに選択肢つきで諮る）→ ② task ファイル群へ分割（`audit: A|B|C` 宣言つき）→
③ ユーザーが受け入れ条件を承認 → Codex `/goal` loop 起動（[design/dev-loop.md](./design/dev-loop.md) v2）。

**Phase 終了ゲート**: 完了定義チェックリスト全項目を機械検証 → Claude が Phase 監査
（界面契約の整合・docs 同期・既知の罠の棚卸し）→ 本書の該当 Phase を「済」に更新 + 短い振り返りを追記。

**監査**: 全 task はリスク階層化された監査（Tier A/B/C）を通って main に入る。
詳細・tier 判定基準・out-of-band commit の扱いは [design/audit-protocol.md](./design/audit-protocol.md)。

**実装ワークフロー**: タスク類型 5 種（loop / design / exploration / polish / hotfix）、
loop 起動手順（tmux + `/goal`）、エスカレーション基準、bound 既定値、rubric 管理は
[design/workflows.md](./design/workflows.md) が正本（2026-06-11 確定）。

### 直近の実行計画（M2 = Phase 1 完了まで）

| 順 | 項目 | 担当 | 前提 |
|---|---|---|---|
| 1 | tasks/09 G8 mockup シミュレーション → ユーザーレビュー | Codex → ユーザー | **済**（2026-06-10 レビュー済み。決定 = g8-explorer-ui.md §7: A-1 のみ採用） |
| 2 | tasks/10 turn-first explorer 骨格（audit: B） | Codex loop → Claude 監査 | **済**（2026-06-11 監査 PASS、`a35cab9` merge。e2e 56/56） |
| 3 | G9 設計（baseline 定義をユーザーに諮る → 小設計文書）→ task 化（audit: B） | Claude → Codex loop | G8 の Stats 界面確定後 |
| 4 | G1 設計文書 + ADR（PR ⇄ session 紐付けキー、GitHub 認証 = 論点 #8）→ task 化（audit: A、スキーマ・外部 API 界面に触れるため） | Claude（設計）→ ユーザー承認 → Codex loop | — |
| 5 | Phase 1 終了ゲート（完了定義チェック + Phase 監査 + 本書更新） | Claude | 1〜4 完了 |
| 6 | Phase 2 開始ゲート（design sprint: ハーネス版数 / finding model / archive v2 踏襲度 / G2 / G3 / MCP transport / analyst 選抜 / 採否 UX） | Claude + ユーザー | 5 完了（下記注記参照） |

注記: 順 6 の**設計ドラフトは順 1〜4 と並行開始可**。設計（Claude、新規 design 文書のみ）と実装（Codex loop、src/）は lane が分かれ single-writer に抵触しない。ただし ADR の最終確定と Phase 2 実装 task の起動は順 5（Phase 1 終了ゲート）の後。

## ユーザーの作業（役割定義、2026-06-11）

書く仕事はゼロ、選ぶ仕事が全部。以下の 3 種類に限定される。

- **定常（task ごと、数分）**: task ファイルの受け入れ条件を承認し、Codex loop を起動する。実装中・コードレビュー・merge は無関与（監査 = Claude が代行、[design/audit-protocol.md](./design/audit-protocol.md)）。監査が重大 block を出した時のみ裁定（revert か hotfix か等）
- **節目（Phase ゲートごと、30〜60 分）**: 選択肢つきで諮られる **UX / データの境界 / 設計方針**を選ぶ。残りの主な判断: G8 mockup レビュー、G9 baseline、G1 紐付けキー ADR、finding モデルと MCP tool surface、G4 fixture 保持範囲、rubric テンプレ、ハーネス意味論の一般化 ADR、OSS 公開判断
- **運用（P2 以降、週 5〜10 分）**: finding の**採否判定（オラクル）**。「採用 / 棄却 + 理由一言」。これが G2 の教師信号・analyst 選抜の fitness・Phase 4 judge の校正材料になる。**代替不能な作業はこれだけ**。P3 以降は同種の作業として「fixture 化を自分で試して軽さを判定」「judge の採点理由の月 1 spot check」が加わる

## 決定済み（ADR 索引）

| ADR | 件名 | 日付 |
|---|---|---|
| [0001](./adr/0001-ingest-via-hook-and-server-side-jsonl.md) | Ingest pipeline = Stop hook trigger + server-side jsonl reading（Langfuse 流） | 2026-06-07 |
| [0002](./adr/0002-project-identity-model.md) | Project = repo、identity vs display_name 分離、canonical = 正規化 git remote URL | 2026-06-07 |
| [0003](./adr/0003-monorepo-with-pnpm-workspaces.md) | Repository structure = single GitHub repo, internal pnpm workspaces + Turborepo | 2026-06-07 |
| [0004](./adr/0004-postgres-from-phase-1-and-hybrid-dev-env.md) | DB = Postgres（Phase 1 から）+ hybrid dev env（依存だけ Docker・アプリは host）+ dev/prod compose 分離 | 2026-06-09 |
| [0005](./adr/0005-harness-artifact-model.md) | ハーネス = artifact 集合 + provider binding + hash 版数（統一 IR・完全分離とも不採用）/ agent = runner × model × harness 版の導出タプル / 意味論は Phase 5 ゲートで一般化 / P1 はハーネス追跡・管理をスコープ外 | 2026-06-11 |

## 論点台帳（2026-06-11 更新）

ADR 0001-0004 + tasks/01〜08 で観測パイプラインの骨格は実装済み。残論点は各 Phase の開始ゲートに割り付けた。

| # | 論点 | 状態 | 処理先 |
|---|---|---|---|
| 1 | monorepo 移行のタイミング | **済** | tasks/05-06（apps/web + packages/、[0003](./adr/0003-monorepo-with-pnpm-workspaces.md)） |
| 2 | hook が送る payload の中身 | **済** | tasks/08 設計論点として 2026-06-10 承認（`{agent, session_id, transcript_path, cwd, project_id?, event}`、本文は運ばない） |
| 3 | `lathe-client init` の UX | **済** | tasks/08 実装（settings.json 非破壊 merge / Codex hooks.json + TOML / `.lathe/config.json`） |
| 4 | サーバ停止中の取りこぼし対策 | **済** | catch-up sweep = 全量 `pnpm -F web ingest` を維持（ADR 0001 Consequences） |
| 5 | HTTP API 設計（notify、認証） | **済** | tasks/08 + #3 対応（`LATHE_NOTIFY_TOKEN` Bearer、timingSafeEqual、transcript path allowlist） |
| 6 | DB スキーマ（`projects` テーブル新設、`sessions.project` 意味変更） | 残 | **G1 設計（直近実行計画 順 4）で要否ごと判定**。PR エンティティ追加と同時にやるのが migration 1 回で済む |
| 7 | MCP server transport（stdio / SSE / HTTP） | 残 | Phase 2 開始ゲート |
| 8 | PR 連携の認証（PAT / GitHub App） | 残 | **G1 設計に統合**（直近実行計画 順 4） |
| 9 | Phase 3 sandbox（Docker / その他） | 残 | Phase 3 開始ゲート（ADR 0004 以降は Docker 第一候補） |
| 10 | archive format v2 の踏襲度 | 残 | Phase 2 開始ゲート（ハーネス版数・finding model と同時） |
| 11 | npm package 名（`lathe` は埋まり気味） | 残 | Phase 7（npm 公開時。それまで `private:true`） |
| 12 | G9 baseline 定義（project 別中央値 / percentile / 絶対閾値） | 残 | G9 設計（直近実行計画 順 3）でユーザーに選択肢つきで諮る |
| 13 | dev-loop 運用の未決（権限モード / bound 節既定値 / Codex 側 `/goal` 相当 / grader 根拠固定） | 残 | loop 実運用の中で順次確定（[design/dev-loop.md](./design/dev-loop.md)） |
| 14 | ハーネス意味論の一般化（loop の扱い / rubric・eval の位置づけ / 操作 UX / basic harness 一般形） | 残 | **Phase 5 開始ゲート**（[ADR 0005](./adr/0005-harness-artifact-model.md) §3。CC/Codex 運用の実例から一般化。それまで意図的に未決） |
| 15 | IA 原則（2026-06-12 ユーザー決定）: 全画面は常設グローバルバー配下、バー・タブ以外で移動できる画面を作らない。横断軸（Findings 等）と session 軸を混ぜない（session 内タブは当該 session 紐付きのみ） | **済**（原則決定） | グローバルバー再編タスクで実装。design/ui-design-language.md に固定 |
| 16 | chat の設計（どこからでも呼び出せる / 過去会話をどこでも参照 / 今見ている画面の要素を選択してコンテキスト化 = 画面でなく全画面に被さるレイヤー） | 残・**意図的保留** | ユーザー判断（2026-06-12）「今手をつけるべきじゃない。重すぎる」。実装済みの /chat 画面はナビから外して休眠。バグは issue #7（同じく保留）。再開時に専用設計タスクを起こす |

## このロードマップとの整合性チェック

- **新機能を追加するとき**: 提案書の境界（[§3.0](../fukuoka-mitou-2026/work/proposal-ohno-draft-plain.md)）から外れていないか確認。実装意図 UI / コード編集環境 / PR ホスティングを Lathe 内に作らない。
- **Phase を飛び越したくなったとき**: dogfood で 1 ループ回せる最小に立ち返る。先の Phase に手を出さない（[AGENTS.md](./AGENTS.md) Scope）。
- **アーキテクチャ重大変更**: ADR を起こし、本書を更新。

## 出口

- **Phase 6 動作時**: 本書を「Roadmap (実績版)」に更新し、各 Phase の振り返りをまとめる。
- **Phase 7 OSS 公開時**: 本書を README に統合 or 公開用の概念図に置き換える。
