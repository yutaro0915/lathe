# dev-loop — Lathe 開発への agentic loop 導入設計（v1 ドラフト）

status: draft（レビュー待ち、実装未着手）
created: 2026-06-10
owner: claude
背景調査の正本: LLMWiki `wiki/queries/agentic-loop-for-lathe-2026-06-10.md`（一次出典付き）

## 1. 目的

Lathe の開発タスクのうち「受け入れ条件を機械検証できるもの」を、agent のループ実行（1 イテレーション 1 項目、検証 GREEN で commit、人間はブランチ承認）で消化する。人間の作業を「正本の整備」と「承認」に寄せる。

## 2. 背景（調査の要約）

- Ralph loop（ghuntley.com/ralph、2025-07-14）: `while :; do cat PROMPT.md | claude -p; done`。状態は context でなくファイルと git に置き、毎回ほぼ白紙の context で再開する。規律は one item per loop。
- 成立条件は mature な CI/CD ではなく **backpressure**（テスト・型・ビルドが不正な成果物を弾くこと）と **要件の正本**（specs / feature list）。greenfield はむしろ得意領域（CURSED 言語、Anthropic C compiler、claude.ai クローン等の実例）。
- 素のループの既知の失敗: 一度に全部やる / 未完了なのに完了宣言 / placeholder 実装 / 二重実装。対策はプロンプト規律と検証ゲート（Anthropic「Effective harnesses for long-running agents」2025-11-26）。
- 承認ゲートは上流（spec 承認）と下流（PR レビュー）の二極。本設計は両ゲート型を採る。

## 3. ループ形態 v1

```
[人間] 正本を承認（task file の受け入れ条件）
   │
   ▼
[loop driver] イテレーション i:
   1. fresh session で起動（claude -p、毎回 PROMPT を注入）
   2. 進捗ファイルと git log を読み、未完了項目の最優先 1 件を選ぶ
   3. 作業ブランチ上で実装（main / prototype に直接触らない）
   4. ゲート実行: pnpm -F web build && pnpm -F web e2e && pnpm -F web coverage
   5. GREEN → commit + 進捗ファイル更新 / RED → 修正 or 差し戻し記録
   6. 全項目完了 or 上限到達 → 停止
   │
   ▼
[人間] ブランチの diff / PR をレビューして merge 判断
```

### 3.1 正本（ループが読むもの）

- **task file**（`tasks/NN-*.md`、既存形式を踏襲）に「**受け入れ条件**」節を必須化する。各条件は機械検証コマンド（または E2E で観測可能な振る舞い）で書く。ループはこの節を完了判定の唯一の根拠にする。
- ループ用プロンプトは `loop/PROMPT.md`（毎イテレーション同一）。内容: 対象 task file の参照、one item per loop、実装前にコードベース検索（二重実装防止）、placeholder 禁止（no cheating）、ゲートコマンド、commit 規約。
- 進捗は `loop/PROGRESS.md`（イテレーションごとに「やったこと / 残り / 学び」を追記。使い捨て、ループ終了後はアーカイブ）。
- 将来: story 駆動に拡張する場合は `design/user-stories.md` → 受け入れ条件付き feature list（全件 fail 起点）の bootstrap を initializer タスクとして切る。v1 のスコープ外。

### 3.2 駆動部

候補 2 案。v1 では A を採る（挙動がログに残り、Lathe 自身で観測しやすい）。

- **A. 最小 loop スクリプト** `scripts/dev-loop.sh`: `for i in $(seq 1 $MAX); do cat loop/PROMPT.md | claude -p --output-format stream-json >> loop/logs/iter-$i.jsonl; done`。完了マーカー（PROGRESS.md 末尾の `ALL-GREEN-DONE`）を検知したら break。
- B. 公式 ralph-wiggum plugin（Stop hook 方式、`/ralph-loop "task" --max-iterations N`）。セッション内ループのため transcript が 1 本になり、context 劣化（170k 超で品質低下の報告）を受けやすい。A で不足が出たら比較検証する。

### 3.3 ゲート（backpressure）

既存資産をそのまま使う。追加実装なし。

| ゲート | コマンド | 現状 |
|---|---|---|
| 型 + ビルド | `pnpm -F web build` | PASS |
| E2E | `pnpm -F web e2e` | 49/49 GREEN |
| coverage 照合 | `pnpm -F web coverage` | GREEN |

RED のまま commit しない。RED が同一項目で 3 イテレーション続いたらループを停止し、人間にエスカレーションする。

### 3.4 ブランチと承認

- 作業ブランチ: `loop/<NN>-<slug>`（task 単位）。ループは push しない（ローカル承認後に人間 or 指示で push）。
- 上流ゲート: task file の受け入れ条件を人間が承認してからループ開始。
- 下流ゲート: ループ終了後、人間が diff レビューして merge 判断。merge / reject / 修正指示のいずれか。

### 3.5 停止条件

1. 受け入れ条件すべて GREEN + 完了マーカー
2. max iterations 到達（v1 既定: 10）
3. 同一項目 RED 3 連続
4. ゲートコマンド自体が壊れた場合（即停止）

### 3.6 single-writer 整合

- ループ実行中は `status.md` の `current_owner` を `claude-loop` にし、終了時に `none` へ戻す。Codex がオーナーの間はループを起動しない。
- ループは `tasks/` `adr/` `design/` を編集しない（読み取りのみ）。編集対象はコードと `loop/` 配下に限定する。

### 3.7 dogfooding（Lathe 自身による観測）

ループの各イテレーションは通常の Claude Code セッションとして transcript を残すため、既存の ingest（hook + jsonl、ADR 0001）でそのまま Lathe Phase 1 に取り込める。ループ導入自体が「ハーネス変更の前後比較」の最初の実データになる。ループ運用で得た知見（プロンプト調整、ゲート追加）は Phase 2 の finding の手動先行例として記録する。

## 4. 適用範囲

- **向く**: 受け入れ条件が機械検証できる実装タスク（Postgres 移行、provider 追加、UI の E2E 検証可能な変更）。
- **向かない**: ADR 系の設計判断（#2 hook payload 設計など一次情報確認 + 人間判断が必要なもの）、受け入れ条件が主観評価のもの（UI の見た目品質）。従来どおり対話で進める。

## 5. 初回対象: tasks/07 Postgres 化

- ADR 0004（Postgres from Phase 1 + hybrid dev env）設計済み。受け入れ条件が立てやすい:
  1. `docker compose -f docker-compose.dev.yml up -d` で Postgres が起動する
  2. `pnpm ingest` が Postgres に書き込み、件数が SQLite 時と一致する（coverage 照合 GREEN）
  3. `pnpm -F web e2e` 49/49 GREEN（DB 差し替え後）
  4. `node:sqlite` への参照が apps/web から消える
- ループ開始前に人間がやること: tasks/07 ファイルの作成と受け入れ条件の承認、Docker 起動環境の確認。
- 補足: 元計画（SESSION-HANDOFF-2026-06-09）では Codex 担当想定だった。本ループは Claude で回すため、着手前に owner を明示して衝突を避ける。

## 6. 既知の失敗モードと対策

| 失敗モード（一次報告あり） | 対策 |
|---|---|
| 一度に全部やる | PROMPT に one item per loop を明記、diff 行数の上限目安 |
| 未完了なのに完了宣言 | 完了判定を受け入れ条件のコマンド結果のみに限定 |
| placeholder 実装 | no cheating 指示 + E2E が実挙動を検証 |
| 二重実装 | 実装前にコードベース検索を義務化 |
| context 劣化 | fresh session per iteration（案 A）で毎回リセット |
| 暴走・破壊 | ブランチ隔離 + RED 3 連続停止 + 人間承認まで merge しない |

## 7. 未決定（レビューで決める）

1. `claude -p` の権限モード（`--dangerously-skip-permissions` をブランチ隔離前提で許すか、`--permission-mode` + allowlist にするか）
2. max iterations の既定値（10 で妥当か）
3. ループログ（`loop/logs/*.jsonl`）を git 管理するか gitignore か
4. Codex でも同じループを回すか（driver の CLI 差し替えだけで成立するか）
5. tasks/07 の受け入れ条件の細目（上記 5 の 4 項で足りるか）
