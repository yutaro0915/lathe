# Lathe — Phase 1 prototype（引き継ぎドキュメント）

**このファイルだけ読めば次の担当者（人間 / Codex / 別 agent）が再開できる**ことを目標にする。

**現在の状態（2026-06-07）**: Phase 1（観測 = トランスクリプト / Git 差分 / 統計ビューア）プロトタイプ**動作・E2E 42/42 GREEN・coverage GREEN**。
- **公開済み** → https://github.com/yutaro0915/lathe （**public**、default branch `main` に全コードあり）
- 取り込みは **Claude Code + Codex** 両対応。cost は実モデル単価（Claude + GPT/Codex）で算出
- npm は**未公開**（`package.json` `private:true` のまま。公開はユーザー判断で後日）
- `main` と `prototype/harness-loop-ui` は同一コミット（`prototype` ブランチは不要なら削除可）
- **UI（2026-06-07）**: グローバル上部ナビ（セッション / Git差分 / 統計）を廃止。Git に続き統計も `Stats` タブとして in-page 化（全 7 タブ）。`/diff` `/stats` は redirect で残置
- Phase 2 以降（AI 分析 / ハーネス評価 / 実験基盤 / Evals / agent 接続 / 統合）は**未着手**

## これは何か

ハーネスエンジニアリング基盤 Lathe の **機能1（観測 = トランスクリプト / Git 差分ビューア）** の動くプロトタイプ。
**このマシンの実際の Claude Code セッション**（`~/.claude/projects/`）を取り込み、
Next.js + SQLite の Web UI で観測する。提案書の白い実装イメージ `phase-1-*.png` を正本にしている。

> 正本・参照: `../fukuoka-mitou-2026/work/phase-implementation-image-addendum.md`、
> 画像 `../fukuoka-mitou-2026/submit/images/phase-1-session-viewer.png` /
> `phase-1-git-diff-attribution.png`

## 起動 / 検証（Node 24 前提）

```
pnpm install
pnpm ingest        # ~/.claude/projects/<project-dir>/*.jsonl を取り込み data/lathe.db を生成（既定は最新の Claude プロジェクト）
pnpm dev           # next dev（既定 http://localhost:3000、`.claude/launch.json` 経由なら :3210）

pnpm build         # 本番ビルド（型チェック込み）
pnpm coverage      # 正本(JSONL) ⇄ DB の機械照合（GREEN を確認）
pnpm e2e           # Playwright E2E（42 ケース。build+start を内部で回すので dev は止めてから）
```

注意:
- **DB は再生成物**（`data/lathe.db` は gitignore）。clone 後は必ず `pnpm ingest`。
- **dev 稼働中に `pnpm build` / `pnpm e2e` を走らせない**（同じ `.next` を壊す）。E2E/ビルド前に dev を止める。
- `pnpm ingest` 後に dev が起動済みなら**再起動**する（`node:sqlite` 接続が起動時の DB を掴むため）。
- env: `LATHE_TRANSCRIPTS_DIR`（**既定は最も最近活動した Claude プロジェクト dir を自動選択**＝ハードコードなし、誰の環境でも動く）/ `LATHE_CODEX_PROJECT`（Codex を cwd basename で絞り込み、既定は上記 dir から導出）/ `LATHE_NO_CODEX=1`（Codex 無効化）。

## 画面（route）

| route | 画面 | 内容 |
|-------|------|------|
| `/` | セッションビューア | 上部 sessbar（セッション名 + model/branch/commit/日付 + duration/turns/tools/edits/tokens/**cost**）。左: セッション一覧 + 検索 + Event type フィルタ + Model / Errors 絞り込み + 並び替え。中央: タブ内容（既定 Transcript = 実行タイムライン）。右: 選択イベント詳細。下: 時間リボン。**左上のプロジェクトセレクタでセッション一覧と Stats をプロジェクトに絞り込む**（各プロジェクトの sessions/cost 付き）。**統計も `Stats` タブとして in-page**（下記）。グローバルな上部ナビは廃止し、画面遷移は全てタブ。 |
| `/diff` | （レガシー）| 旧 Git 差分専用ページ。現在は `/?session=<id>&tab=git` へ **redirect**（変更のある最新セッションを既定に）。古いリンク互換のため残置。 |
| `/stats` | （レガシー）| 旧 統計専用ページ。現在は `/?tab=stats` へ **redirect**。統計は `Stats` タブ（in-page）へ統合済み。古いリンク互換のため残置。 |

タブ（Transcript / Tools / Git / Skills / Subagents / Raw JSON / Stats）は**すべて in-page**で中央＋右だけ切り替わる（**左のセッション一覧サイドバーは常に維持**）。Git タブは `DiffViewer` を、Stats タブは `StatsView` を `embedded`（`grid-column:2/4` = main+aside 幅）で中央に埋め込む。Git タブは [変更ファイルツリー｜差分（Unified/Split・追加緑/削除赤）｜Linked Events + 帰属信頼度]、Stats タブは**現在のスコープ**（左上プロジェクトセレクタ + 検索/モデル/エラーフィルタで絞った visible session 集合）の**4グラフ**（コスト&トークン推移 / モデル別コスト / イベント構成 / 最大セッション）を依存ゼロの SVG で表示する。**Stats タブのときだけ上部 sessbar がそのスコープの totals（Statistics）に切り替わる**。プロジェクト別の比較は左上のプロジェクトセレクタ（各プロジェクトの sessions/cost 付き）が担い、Stats タブに横断テーブルは置かない。`?tab=` で初期タブ復元、セッション切替時も現在のタブを保持。
（旧構造では Git / 統計が別ページ `/diff` `/stats` へ遷移してサイドバーが差し替わり、上部にグローバルナビ（セッション / Git差分 / 統計）があった。2026-06-06 に Git を、2026-06-07 に統計を in-page タブへ統一し、グローバルナビを廃止。`/diff` `/stats` は redirect で残置。）

## できること（すべて動作・E2E 済み）

- セッション切替（一覧クリック / `?session=`、両画面共有）、検索、Model / Errors 絞り込み、並び替え
- タブ切替（中身が変わる / 画面遷移）、`?tab=` で初期タブ復元
- タイムラインのイベント選択 → 右に**所要時間 / Exit / Tokens / Tool calls** のチップ + **出力（stdout/stderr）/ Result / Thinking 全文**（折返し・copy）
- **Cost 表示**: sessbar の `cost` スタット + セッション一覧の cost チップ。実トークン × モデル単価から ingest 時に算出（下記「データモデル / 取り込み」）。`ccusage` と同方式だが依存ゼロ・オフライン
- **サブエージェント展開**（Transcript）: ランチャー行の「N steps」を展開すると内部のツール・スキルがインデント表示。ランチャー行の「⌥ open →」で Subagents タブの当該 run 詳細へジャンプ
- **Subagents タブ = run 単位ナビ**: 同型 agent（general-purpose 等）を名前で 1 リストに潰さず、**1 ランチャー = 1 run** として扱う。上部に Overview + run ごとのサブタブ。Overview は各 run を時系列カード（agent 種別 / **実行モデル** / 実行時刻 / 結果要約 / ステップ glyph / steps・tools・duration・tokens・**cost**）で並べ、クリックで当該 run のタブへ。run タブは Model / Cost を含む stat 群 + 内部実行ステップを全件ツリー表示し、各ステップ選択で右詳細が連動。Prev/Next で run 間移動。**モデルとコストは子 transcript（`subagents/agent-*.jsonl`）の per-message model + usage から算出**し launcher の `meta` に格納
- **thinking 閲覧**: 本文のある extended-thinking を `thinking` イベントとして表示（紫 ✲、フィルタチップ、詳細に全文）
- Event type フィルタ（thinking 含む）、Pin / Add Note（localStorage 永続）、Copy（クリップボード）
- **時間リボン**（下部）: 各セグメント幅 = 次ステップまでの実経過時間。**ホバー**でカーソル位置の正確な時刻（秒まで）・step・イベント・所要時間を読み取り、**クリック**でその step を選択＋本体リストを該当行へスクロール（細い 2px セグメントでも掴める）。**ズーム連動の時刻軸**（目盛りがスクロールに追従して増える＝拡大時も時刻が読める）+ 選択 step の playhead
- **Annotations**（右下）: run 中の節目（error / commit / test）を**種別タグ + step番号 + 内容**で一覧。クリックでその step へジャンプ（説明文付きで何かが分かる）
- **ハーネス信号**: skill だけでなく **memory**（nested CLAUDE.md/AGENTS.md 読み込み、❏ cyan）と **hook**（PreToolUse/PostToolUse/Stop 発火、↪ rose）をイベント化。トランスクリプト + フィルタ + `/stats` の Usage に「Memory loaded / Hooks fired」。⚠️ ルート CLAUDE.md は JSONL 非永続のため観測不可（nested のみ）
- **Codex 対応**: Claude Code と並んで Codex セッション（`runner='codex'`、gpt-5.x モデル）を同じビューア/一覧/統計に統合（取り込み詳細は「データモデル / 取り込み」。**cost は実 GPT 価格で算出**、thinking は reasoning summary を抽出、file_read はシェルから検出＋パス抽出、skill は SKILL.md 読み込みから検出）
- **統計**（`/stats`）: **プロジェクト別集計** + **ファイル別集計（追跡）** + **使われ方観測**（Models / Sub-agent types / Skills / Memory / Hooks 件数）。**左にセッション一覧サイドバー（`SessionSidebar`）を保ち、他画面と同じシェル**（別画面化しない）。プロジェクトは各セッションが変更したファイルパスから導出（`sessions.project` は全 "LLMWiki" なので使えない）→ `deriveProjectKey` が `projects/<slug>` / `wiki` / `memory` / `(external)` 等に分類、セッションは**最多変更ディレクトリ = primary project** に集約。**By file** は変更の多いファイル → 展開で**それを触ったセッション一覧**（ファイル単位で「どこで作業したか」を追跡）。`lib/db.ts` の `getStats()`
- 差分: ファイル選択 / フォルダ折りたたみ / Unified⇄Split / Hunk 前後 / Linked Event 選択 / Raw JSON
- **Changed Files ツリー**: 単一子フォルダのチェーンを 1 行に圧縮（VS Code compact folders）＝深いパスでも「実ファイル数 ≒ 行数」。フォルダ（青フォルダアイコン + 太字 + 末尾 `/`）とファイル（色付き A/M/D/R 状態チップ + ファイル名）を明確に区別
- **Transcript ⇄ Git 双方向リンク**（attribution = hunk⇄event を両向きに辿る）: トランスクリプトの編集イベント詳細の「⎇ Diff →」で、その編集が生んだ差分（該当ファイル + hunk）に Git タブでフォーカス（`SessionViewer.gitFocusEvent` → `DiffViewer.focusEventId`）。逆に Git の Linked Event の「↩ step N」で、その hunk を生んだトランスクリプトのステップ（時点）へ戻る（`DiffViewer.onJumpToEvent` → Transcript タブ + 該当 event 選択）。「この時どう変更したか」と「この差分はどの時のものか」を相互参照できる

## データモデル / 取り込み

`db/schema.sql`（SQLite, `node:sqlite`）:
`sessions / transcript_events(parent_id で sub-agent 子ステップ) / changed_files / diff_hunks /
attributions / event_files / annotations`。型は `lib/types.ts`、read 層は `lib/db.ts`（`getSessionBundle` / `getStats` / per-session イベント数の `getSessionEventCounts`）。

`scripts/ingest.ts`（`pnpm ingest`）が実 JSONL を取り込む:
- 1 transcript = 1 session（最近の全セッション、上限は実質撤廃）。
- イベント: user/assistant テキスト・**thinking（本文ありのみ）**・tool_use（Bash/Edit/Write/Read/Skill/MCP/…）。
- **所要時間** = tool_use → tool_result のタイムスタンプ差。サブエージェントは結果の `<usage>` から duration / tokens / tool_uses を抽出。
- **差分と帰属**は実ツール呼び出しから復元（`Edit` の old→new / `Write` の content を hunk 化し、その tool_use イベントに high 帰属）。
- **サブエージェント**: `<session>/subagents/agent-<id>.jsonl` を `meta.json.toolUseId` で親に紐付け、子イベント（`parent_id`）として取り込む。
- `error_count` = 非ゼロ終了のツール呼び出し + error イベント数（**セッションの成否判定ではない**。バッジは `N errors`、0 なら非表示）。
- **Cost = 実トークン × モデル単価**（`lib/cost.ts` + バンドル価格表 `db/pricing.json`）。transcript に cost フィールドは無いが per-message usage はあるので、ccusage と同じく **input / output / cache_creation / cache_read の4分類を単価別に合算**して ingest 時に `cost_usd` 確定。価格表は LiteLLM `model_prices_and_context_window.json`（MIT）の **Claude tier（opus/sonnet/haiku）+ OpenAI tier（gpt-5.x、`openai` キー）**をピン留め（依存ゼロ・オフライン）。モデル文字列→tier は Claude が部分一致 / OpenAI が最長プレフィックス一致、未知モデル（`codex-auto-review` 等）は null（"—" 表示で捏造しない）。
  - ⚠️ **cache_read は cost に含むが tokens 表示には含めない**（cache_read は最安単価だが最大バケット。tokens 列は「実作業量」指標として cache_read を除外、cost は課金対象として全4分類を計上）→ cost は tokens の数字に対し大きく見えることがある（正常）。
  - ⚠️ **session 合計 cost はメイン transcript のみ**（session tokens と同じ範囲。サブエージェント分は未加算）。ただし**各サブエージェントの個別 cost は子 transcript から算出済みで Subagents タブに表示**（model 別、4分類で正確）。session 合計に子コストを合算するのは将来拡張（合算すると headline cost と tokens の意味が変わるため現状は分離表示）。

`scripts/coverage_check.ts`（`pnpm coverage`）= 正本(JSONL) ⇄ DB の機械照合。MISSING/DROPPED が無ければ GREEN。
直近3分以内に更新中の transcript は「live」として除外し明示（並行書き込み対策）。

## ファイル構成

```
app/
  layout.tsx            # 共通シェル（上部バー = ブランド + パンくずのみ。グローバルナビは廃止）
  page.tsx              # / : サーバラッパー → components/SessionViewer（getSessionBundle + getStats を渡す）
  diff/page.tsx         # /diff : `/?session=&tab=git` への redirect（レガシー互換）
  stats/page.tsx        # /stats : `/?tab=stats` への redirect（レガシー互換）
  globals.css           # 白(light)デザインシステム
components/
  SessionViewer.tsx     # セッションビューア（client、全インタラクション）。Git タブで DiffViewer を、Stats タブで StatsView を embedded 描画
  DiffViewer.tsx        # Git 差分・帰属（client、`embedded` で SessionViewer の Git タブに埋め込み）
  StatsView.tsx         # Stats タブ（client）: 現在のスコープの4グラフ（コスト/トークン推移・モデル別・イベント構成・最大セッション）を依存ゼロ SVG で描画
  SessionSidebar.tsx    # 共有の左サイドバー（セッション一覧。/stats 等が同じシェルを保つため）
  TimeRibbon.tsx        # 共有の時間リボン
db/
  schema.sql            # スキーマ（正本）
  pricing.json          # バンドル価格表（LiteLLM Claude tier, MIT。cost 算出用）
  seed.ts               # 合成デモデータ（pnpm seed、オフライン用フォールバック）
lib/
  types.ts  db.ts       # 型 / read 層（db.ts に getStats = クロスセッション集計）
  cost.ts               # トークン×単価で USD を算出（ingest が使用、依存ゼロ）
scripts/
  ingest.ts             # Claude + Codex 取り込み + harness 信号(memory/hook) + cost 算出（pnpm ingest）
  coverage_check.ts     # 網羅性照合（pnpm coverage）
e2e/app.spec.ts         # Playwright E2E（42 ケース）
playwright.config.ts
```

## 既知の制約 / 申し送り

- **公開済み（2026-06-07）**: `github.com/yutaro0915/lathe`（**public**）、`main` に全コード push 済み。`main` ⇔ `prototype/harness-loop-ui` 同一。npm は未公開（`package.json` `private:true`。公開時に外す + 利用可能な名前確保 + 必要なら `npx` 用 `bin` 追加）。⚠️ **履歴の古いコミットに macOS ユーザー名 `cherie` が残る**（機密ではない。気になれば履歴書き換え＋force-push）。
- **thinking は大半が redacted**（Claude Code が署名のみに）。本文のある分だけ表示。
- **`node:sqlite` を使用**（`AGENTS.md` は `better-sqlite3` 想定だが Node 24 で prebuilt 不在のため）。接続部のみで差し替え可。
- **commit SHA など transcript に無い値は出さない**（捏造しない）。Cost は transcript の実トークン × 既知モデル単価から導出（[[#データモデル / 取り込み]] 参照）。未知モデルや 0 トークンは "—"。
- 取り込み対象は **Claude Code + Codex**（Cursor は未対応）。**Codex**: `~/.codex/sessions/**/rollout-*.jsonl`（+ archived）から cwd が同 repo のセッションを `runner='codex'` で取り込み。message / `exec_command`→bash・commit・test・file_read・skill / `apply_patch`→file_edit・write / `update_plan`→todo / `spawn_agent`→subagent。**cost は実 GPT 価格で算出**（`db/pricing.json` の `openai` tier、gpt-5.5/5.4 等。`codex-auto-review` 等の不明モデルのみ "—"）。**thinking は reasoning summary を抽出**（raw 推論は暗号化なのでスキップ）。**file_read は read ツールが無いため `cat`/`sed` 等のシェルから検出 + ファイルパスを抽出**（cwd で絶対化、Claude の read と同格・追跡可能）。**skill は専用ツールが無いため `~/.codex/skills/<name>/SKILL.md` の読み込みから検出して `skill` イベント化**（Claude の Skill ツールと同格、Skills タブ/フィルタ/`/stats` に出る。`codexSkillName()`）。token は最後の `token_count` の累計（cached input は cache-read 単価で課金）。`LATHE_NO_CODEX=1` で無効化。
- スコープは Phase 1（観測）まで。Phase 2 以降（AI 分析 / ハーネス評価 / 改善ワークベンチ / エージェント実行 / 統合）は未着手。

## 次の一歩（再開時の候補）

- **npm 公開の仕上げ**（やるなら）: `private:true` を外す / 利用可能な npm 名（`lathe` は埋まり気味 → `@yutaro0915/lathe` 等）/ `npx lathe` 用 CLI 化（Next ビルドの同梱）/ 履歴の `cherie` スクラブ。
- Phase 2: AI 分析（finding 抽出、MCP ツール経由の根拠リンク）。`README.md` の機能2に対応。
- ハーネス *評価*（どの memory/hook/skill が効いたか。**観測は実装済み**、評価は Phase 2）。
- Cursor トランスクリプト形式への対応（Claude/Codex は対応済み）。実トランスクリプトの増分取り込み / 監視。
- session 合計 cost への子サブエージェント cost 合算（現状は分離表示）。
