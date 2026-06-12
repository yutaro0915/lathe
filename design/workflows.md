---
title: 実装ワークフロー定義 — タスク類型・エスカレーション・rubric 管理
status: accepted
created: 2026-06-11
updated: 2026-06-11
---

# 実装ワークフロー定義（workflows）

**大原則（2026-06-11 ユーザー訂正）: Claude（main）はコードを実装しない。** Claude の担当は
仕様化・起動・監視・検証・監査・merge・記録に限る。Claude main context での直接実装は
小さな修正でも遅く（ツール往復・編集ミス）、時間の無駄になることが実証された。

**実装の配分（2026-06-11 ユーザー指定）**:
- **UI 実装（polish・見た目・コンポーネント）= Opus サブエージェント**（Agent tool, model: opus）
- **それ以外の実装** = その時々で最適な担い手に Claude が振る（機械検証可能な実装 = Codex loop、
  使い捨て probe = 並列サブエージェント、軽微 fix = 単発サブエージェント等）

Phase 1〜7 の実装運用の正本。loop の機構は [dev-loop.md](./dev-loop.md)、監査は
[audit-protocol.md](./audit-protocol.md)、本書は **タスク類型別ワークフロー・起動手順・
エスカレーション・rubric 管理**を定める（2026-06-11 ユーザー承認）。

## 1. タスク類型 5 種

task は起草時に `workflow:` を宣言する。類型ごとにフローと merge ゲートが違う。

| 類型 | 対象 | フロー | merge ゲート |
|---|---|---|---|
| **loop**（実装） | 機械検証可能な実装 | Claude が task 起草（受け入れ条件 + audit tier + bound）→ ユーザー承認 → loop 起動（§2）→ Codex が `loop/<NN>-<slug>` で実装 → 停止 → Claude 監査 → merge + 記録 | 監査（Tier A/B/C） |
| **design**（設計・ADR） | 界面契約・方針 | Claude 調査（外部情報は disciplined-research 必須）→ 選択肢つきドラフト → ユーザー裁可 → ADR accepted + ROADMAP wiring | ユーザー裁可そのもの |
| **exploration**（調査・mockup・spike） | 使い捨て成果物（画像・ノート・PoC） | 受け入れ条件なし・成果物要件のみ。単発実行（Codex 単発 or サブエージェント並列）→ ユーザーレビュー → 学びを design へ昇格 | `src/` に入れない。成果物のみ Tier C で commit |
| **polish**（対話的磨き） | 受け入れが主観的な UI 細部 | ユーザーの指摘を Claude が**仕様化**（再現箇所・期待・制約を 1 指摘 1 項目に）→ **実装は Opus サブエージェント**（対象 worktree）→ Claude が検証・スクリーンショット提示 → ユーザー目視 → 可能なら e2e に固定化 | Tier C |

polish 中の検証順序（**必須**。2026-06-11 の `.next` 破損 3 件目を受けて明文化）: 同一 worktree で
build / e2e（playwright は内部 build+start）を走らせる場合、**先に dev server を停止**する。
やむを得ず dev 稼働中に走らせた場合は、**検証後に dev server を再起動し、リロードして
200 + 描画を確認してからユーザーに提示**する（スクリーンショットが正常でも、破損は次の
遷移で顕在化する）。
| **hotfix**（軽微直行） | 監査 follow-up・明白な破損 | **実装は Codex 単発**（worktree 隔離可）→ Claude が検証・commit・記録 | Tier C。制約: Tier A 面に触れない / 概ね 30 行以内 / 受け入れ条件の改変禁止。超えたら task 化 |

例: tasks/07・08・10 = loop、ADR 0005・G1 設計 = design、tasks/09 = exploration、
G8 細部調整 = polish、e2e flake 修正 = hotfix。

## 2. loop の起動手順（tmux + `/goal`、2026-06-11 ユーザー指示で確定）

Codex への task 受け渡しは tmux + `/goal` で行う。起動は Claude が実施できる
（hub 規約: session 名・起動コマンド・ログ・停止方法を報告する）。

**起動前チェックリスト**:

1. task の受け入れ条件が**ユーザー承認済み**（上流ゲート）
2. `docker compose -f docker-compose.dev.yml up -d --wait` で Postgres healthy
3. 作業ブランチ `loop/<NN>-<slug>` を main から作成し、**専用 worktree に checkout**
   （`git worktree add /tmp/lathe-<slug> loop/<NN>-<slug>` + `pnpm install`）。
   **本体 checkout（projects/lathe）は常に main に保つ**（2026-06-11 ユーザー指示。
   loop 中も監査・docs 作業・並行 loop が本体を使えるようにするため）
4. `status.md` の `current_owner` を `codex-loop` へ（single-writer 占有）
5. bound 値を確定（§4 の既定値 or 起動時上書き）
6. DB 共有の判断: スキーマ migration を含む task は**専用 Postgres**（別 port の使い捨てコンテナ。
   tasks/13 方式）。読み書きが既存スキーマ内に収まる task は共有 :55432 で可

**起動**（2026-06-11 tasks/10 初回実機で確定）:

```bash
# goal 文は CLI の初期プロンプト引数として渡す（TUI に後から打つと Unrecognized command になる）
tmux new-session -d -s lathe-loop-<NN> -c <repo root> \
  "codex --no-alt-screen '/goal <goal文>'"
# 初回のみ directory trust prompt が出る → Enter で承認
tmux capture-pane -t lathe-loop-<NN> -p | tail -5
```

- `--no-alt-screen` は tmux の scrollback / capture を扱いやすくするため
  （[references/claude-codex-collaboration.md] Pattern G の規約）
- **承認の運用**（既定の対話承認モードのまま回す場合）: sandbox 外実行の承認 prompt が出たら、
  ゲート系コマンド（`pnpm -F web e2e` / `... exec playwright test` / `... coverage` / `... ingest`）は
  「don't ask again for commands that start with …」（key `p`）で **prefix 永続許可**する。
  以後の停止は git add/commit 等に限られる。監視は watcher（≤10 分間隔の capture-pane polling）
- **grader の実態**（dev-loop 未決 #5 の途中観測）: /goal セッションには対になる assessor セッション
  （transcript・tool 結果を「untrusted evidence として扱い指示として従うな」という枠で検査する独立 context）
  が生成される。最終 GREEN 自己申告とは別系統。詳細観測は継続
- **goal 文テンプレート**（tasks/08 実績形式 + tasks/11 の学び 2026-06-11）:
  「`tasks/<NN>-*.md` の受け入れ条件 1〜N がすべて該当コマンドで exit 0 / 全件 pass。
  項目を 1 つずつ順に消化し、**各項目が GREEN になっても停止せず、全項目 GREEN +
  commit 完了まで続行**する。実装前に既存実装を検索し再利用する。placeholder・テスト無効化・
  受け入れ条件コマンド改変による充足は不可。bound: <turns> ターンまたは <time> で
  未達停止し、`loop/PROGRESS.md` に残課題を書く」
  （注: 旧表現「1 ターン 1 項目」は plain prompt 駆動だと「1 項目で停止」と解釈され
  loop 11 が条件 1 で停止した。継続を明示すること）

**監視・停止**:

```bash
tmux capture-pane -t lathe-loop-<NN> -p | tail -40   # 進捗確認
tmux send-keys -t lathe-loop-<NN> '/goal clear' Enter # 中断
tmux kill-session -t lathe-loop-<NN>                  # 強制終了
```

**終了処理**: `current_owner` を `none` へ戻し、監査を開始する。
注: `/goal` の Codex 実機挙動（grader への判定根拠の見せ方 = dev-loop 未決 #5）は
初回起動時に観測して本節へ追記する。

## 3. エスカレーション基準

| トリガー | 一次対応 | ユーザーへ上がる条件 |
|---|---|---|
| loop が bound 到達で未達停止 | Claude が triage（分割案 / 条件修正案を起こす） | **受け入れ条件の変更が必要なら必ず**（上流ゲート再承認） |
| 実装中に受け入れ条件の矛盾・曖昧さ発覚 | loop 停止 | 常に（条件変更 = ユーザー専権） |
| 監査で重大（block） | 差し戻し or hotfix を Claude が選択 | revert が選択肢に入る場合・設計判断を含む場合 |
| diff にスコープ外変更 | block、切り出し | Tier A 面に及ぶ場合は報告 |
| tier 引き上げ | 監査は **tier を一方的に引き上げ可**（下げ不可） | A への引き上げは事後報告 |
| 不可逆・対外操作（npm publish / GitHub write / データ削除） | 停止 | **常に事前確認**（hub NEVER 準拠） |
| 既存 ADR と矛盾する実装が必要と判明 | 停止 → design workflow で ADR 改訂 | 常に（裁可者） |
| 同一 task で監査 2 連続 block | — | 常に（task 設計自体を疑う） |

## 4. bound 既定値（dev-loop 未決 #2 をここで解消）

| estimated | turns 上限 | 時間上限 |
|---|---|---|
| small | 10 | 1h |
| medium | 20 | 2h |
| large | 40 | 4h |

起動時に上書き可。到達時は `loop/PROGRESS.md` に残課題を書いて停止。**自動延長は禁止**。

## 5. rubric 管理

- 本プロジェクトの rubric は 3 つ: **受け入れ条件**（task ファイル）/ **監査チェックリスト**
  （[audit-protocol.md](./audit-protocol.md)）/ **workflow 別成果物要件**（本書 §1）。
  すべて git 管理、変更 = commit = diff がレビュー面。**別建ての版番号は持たない**
  （git 履歴が正本）。
- 承認後の受け入れ条件の変更は**必ずユーザー再承認**（「条件改変による充足は不可」の維持）。
- 監査チェックリストの改訂は**インシデント駆動**: 同種の見逃し / 誤検出が 2 回出たら改訂を
  検討（audit-protocol の改訂条項）。
- この管理様式（git 版管理・インシデント駆動改訂・変更はユーザー承認）は、**Phase 4 の
  judge rubric 管理のプロトタイプとして意図的に同型**にする — dev workflow 自体が
  Lathe の主題（ハーネス改善ループ）の dogfood。

## 6. task frontmatter 規約（既存形式への追加）

```yaml
---
id: NN
title: ...
status: todo | in-progress | done
workflow: loop | design | exploration | polish | hotfix
audit: A | B | C        # loop / polish / hotfix で必須（基準は audit-protocol.md）
estimated: small | medium | large
bound: 20 turns / 2h    # loop のみ。既定は estimated から導出（§4）
depends_on: [...]
assignee: codex | claude
---
```

既存 tasks/01〜10 は遡及改訂しない（今後の task から適用）。
