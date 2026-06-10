# dev-loop — Lathe 開発への goal loop 導入設計（v2 ドラフト）

status: draft（レビュー待ち、実装未着手）
created: 2026-06-10（v2: 駆動部を `/goal` native primitive へ全面変更）
owner: claude
背景調査の正本: LLMWiki `wiki/queries/agentic-loop-for-lathe-2026-06-10.md`（Ralph 系譜）+ `wiki/concepts/loop-engineering.md` / `wiki/sources/x-rlancemartin-designing-loops-fable-5.md`（2026-06 の loop engineering 潮流）

## 1. 目的

Lathe の開発タスクのうち「受け入れ条件を機械検証できるもの」を、goal loop（人間は goal と承認だけ、agent が verification を満たすまで自己修正）で消化する。人間の作業を「正本の整備」と「承認」に寄せる。

## 2. 背景（調査の要約）

- **2026-06 の loop engineering 潮流**（Osmani 2026-06-07 / Lance Martin (Anthropic) 2026-06-09）: 「agent を prompt するな、agent を prompt する loop を設計せよ」。loop は harness の上位概念ではなく、**harness を時間軸上で回す反復制御領域**（停止条件・oracle・state・rollback・handoff を持つ closed loop）。実装 primitive は Claude Code **`/goal`** と Managed Agents の Outcomes。
- `/goal` の機構（Lance Martin 一次）: goal = **measurable end state**、判定は **independent grader model**（自己申告でない）、not-met verdict が次ターンを起動、bound は条件文中の turn/time 節、met で自動クリア。verifier を独立 context に分離する方が self-critique より成績が良い、が実証されている。
- 系譜としての Ralph loop（ghuntley.com/ralph、2025-07）: bash 再投入 + specs + backpressure。one item per loop、状態は git とファイルへ、という規律は現在も有効。駆動部だけが bash → native primitive に置き換わった。
- 成立条件は mature な CI/CD ではなく **deterministic oracle（backpressure）と要件の正本**。greenfield はむしろ得意領域（CURSED 言語、Anthropic C compiler 等）。
- 素のループ（unbounded・自己申告完了）の既知の失敗: 一度に全部やる / 未完了なのに完了宣言 / placeholder 実装 / 二重実装 / 誤状態の増幅。product 水準では bounded 条件（最大回数・停止条件が自己申告でない・oracle・rollback・handoff）が必須（loop-engineering concept の bounded 条件）。

## 3. ループ形態 v2（`/goal` 駆動・両ゲート型 closed loop）

```
[人間] 正本を承認（task file の受け入れ条件 = goal の素材）
   │
   ▼
[Claude Code セッション] 作業ブランチ上で /goal を設定:
   goal = 受け入れ条件（機械検証コマンドの GREEN）+ bound 節（turn/time 上限）
   1. agent が未完了項目の最優先 1 件を実装（one item per turn の規律）
   2. ゲート実行: pnpm -F web build && pnpm -F web e2e && pnpm -F web coverage
   3. independent grader が goal 充足を毎ターン判定
   4. not-met → feedback 付きで次ターン（自己修正）/ met → 自動クリア・停止
   5. GREEN 単位で commit（状態は git と進捗ファイルへ）
   │
   ▼
[人間] ブランチの diff / PR をレビューして merge 判断
```

### 3.1 正本（loop が読むもの）

- **task file**（`tasks/NN-*.md`、既存形式を踏襲）に「**受け入れ条件**」節を必須化する。各条件は機械検証コマンド（または E2E で観測可能な振る舞い）で書く。`/goal` の goal 文はこの節から組み立て、grader の判定根拠をコマンド結果に固定する。
- 進捗は `loop/PROGRESS.md`（ターンの大きな区切りで「やったこと / 残り / 学び」を追記）。session を跨ぐ outer loop（memory）として機能させ、中断・再開時はここと git log から再開する。
- 将来: story 駆動に拡張する場合は `design/user-stories.md` → 受け入れ条件付き feature list（全件 fail 起点）の bootstrap を initializer タスクとして切る。v2 のスコープ外。

### 3.2 駆動部: Claude Code `/goal`（native primitive）

loop スクリプトは**使わない**（ユーザー決定 2026-06-10）。理由込みの整理:

| 観点 | `/goal`（採用） | bash 再投入 / ralph-wiggum plugin（不採用） |
|---|---|---|
| 完了判定 | independent grader model（自己申告でない） | 完了マーカー = agent 自己申告、または無限 |
| feedback | grader の not-met feedback が次ターンに入る | 毎回白紙、失敗理由はファイル経由でしか伝わらない |
| bound | goal 条件文中の turn/time 節 | max iterations を外部スクリプトで管理 |
| 観測 | 1 session の transcript に loop 全体が残り、Lathe の既存 ingest でそのまま取り込める | iteration ごとに別 transcript、結合処理が要る |

- goal 文のひな型: 「`tasks/NN` の受け入れ条件 1〜k がすべて該当コマンドで GREEN になること。1 ターンに着手する項目は 1 つ。実装前に既存実装を検索すること。placeholder・テスト無効化による充足は不可。N ターンまたは X 時間を超えたら未達のまま停止し、PROGRESS.md に残課題を書くこと」
- 長大タスクは task を分割し、`/goal` を受け入れ条件のまとまり単位で複数回設定する（context 劣化への対処。1 goal を巨大化させない）。

### 3.3 ゲート（backpressure）

既存資産をそのまま使う。追加実装なし。

| ゲート | コマンド | 現状 |
|---|---|---|
| 型 + ビルド | `pnpm -F web build` | PASS |
| E2E | `pnpm -F web e2e` | 49/49 GREEN |
| coverage 照合 | `pnpm -F web coverage` | GREEN |

RED のまま commit しない。同一項目の RED が続く場合の扱いは goal 文の bound 節で打ち切り、人間にエスカレーションする。

### 3.4 ブランチと承認

- 作業ブランチ: `loop/<NN>-<slug>`（task 単位）。loop 中は push しない（ローカル承認後に人間 or 指示で push）。
- 上流ゲート: task file の受け入れ条件を人間が承認してから `/goal` 設定。
- 下流ゲート: loop 終了後、人間が diff レビューして merge 判断。merge / reject / 修正指示のいずれか。

### 3.5 停止条件（goal 文に内蔵）

1. 受け入れ条件すべて GREEN（grader が met と判定 → 自動クリア）
2. bound 節到達（turn / time 上限、v2 既定はレビューで決める）
3. ゲートコマンド自体が壊れた場合（修復を 1 項目として扱い、直せなければ未達停止）
4. 人間の介入（`/goal clear` / interrupt）はいつでも可

### 3.6 single-writer 整合

- ループ実行中は `status.md` の `current_owner` を `claude-loop` にし、終了時に `none` へ戻す。Codex がオーナーの間はループを起動しない。
- ループは `tasks/` `adr/` `design/` を編集しない（読み取りのみ）。編集対象はコードと `loop/` 配下に限定する。

### 3.7 dogfooding（Lathe 自身による観測）

`/goal` 駆動なら loop 全体が 1 つの Claude Code セッション transcript に残り、既存の ingest（hook + jsonl、ADR 0001）で**そのまま** Lathe Phase 1 に取り込める（bash 再投入案で必要だった iteration 別ログの結合が不要になる）。loop 導入自体が「ハーネス変更の前後比較」の最初の実データになる。loop 運用で得た知見（goal 文の調整、ゲート追加）は Phase 2 の finding の手動先行例として記録する。

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
| 一度に全部やる | goal 文に one item per turn を明記、diff 行数の上限目安 |
| 未完了なのに完了宣言 | 完了判定を independent grader + 受け入れ条件のコマンド結果に限定（自己申告を判定根拠にしない） |
| placeholder 実装・テスト無効化による充足 | goal 文に no cheating 節 + E2E が実挙動を検証 |
| 二重実装 | 実装前にコードベース検索を goal 文で義務化 |
| context 劣化（長大 goal） | task 分割し goal を受け入れ条件のまとまり単位で複数回設定 |
| 誤状態の増幅（state carry-over） | 状態は git + PROGRESS.md に限定し、commit 単位で audit 可能にする |
| 暴走・破壊 | ブランチ隔離 + bound 節 + 人間承認まで merge しない |

## 7. 未決定（レビューで決める）

1. loop 実行時の権限モード（auto mode / allowlist。ブランチ隔離前提でどこまで許すか）
2. bound 節の既定値（turn 上限・時間上限をいくつにするか）
3. Codex 側に同等の goal loop primitive があるか（一次情報未確認）。無ければ Codex タスクは従来の tasks/NN handoff のまま二本立てにするか
4. tasks/07 の受け入れ条件の細目（§5 の 4 項で足りるか）
5. grader の判定根拠の固定方法（ゲートコマンドの実行結果をどう grader に見せるか。実機で `/goal` の挙動確認が先）
