---
updated: 2026-06-12T20:00+0900
current_owner: none
current_stage: Phase 2 close 待ち（M3 機構実証済み） → 次は UI rebase
---

## Current

- **Phase 2 実装完了 + UX 改修ラウンド + issue 消化まで完了（2026-06-12、HEAD `a616f3c`）**。M3 機構は実証済み（finding #110 に accept verdict が durable 層に記録）。**Phase 2 close はユーザー GO 待ち**（ROADMAP 更新・振り返り・hub 記録を締める）
- **issue 消化完了**: chip 経由で #6/#8/#10/#11、PR #17 で #9 を全 merge（各々 独立レビュー + ローカル実データ監査）。chat は撤去（#7 解消）。残 open issue は #16（getPool 潜在・保留）/ #4（認証・サービス化時）のみ
- **決定（2026-06-12）**: 全実装に sub-agent/codex の独立レビュー必須（audit-protocol 原則 7）/ 委譲配分 = UI:Opus / 重い:Codex / 他:Sonnet / chat はコード撤去（再開時ゼロから、論点 #16）/ **UI rebase を chip+P2 後に実施（論点 #18）**
- dev server: tmux `lathe-dev`（port 3000）。agent: none（全 loop / worktree 撤収済み）

## 次の一手

1. **Phase 2 close**（ユーザー GO で）— ROADMAP の Phase 2「完了の定義」3 点に照合、status/log/hot/memory 記録、wiki/concepts へ学び extract
2. **UI rebase**（論点 #18）— SessionViewer 肥大分割 / layout3・grid-column 結合の整理 / UX backlog #17（PR の project グルーピング・上部スペース・rail フィルタ過密・Annotations・error 意味論）回収
3. **Phase 3 入口ゲート** — G4 fixture スコープ / sandbox 選定 ADR

## Last completed
- 2026-06-14 [22] agent core モジュール（packages/agent、6 層）完成 + Tier A 監査(Codex xhigh) + merge（`a4e5d92`）— provider 非依存(claude-cli/anthropic-api/codex-exec が同一 LanguageModel)/ MCP host 中立(公式 SDK、Claude Code ハードコードなし、実 stdio で 5 tools)/ tool registry(local+MCP 同型)/ loop(final・maxSteps 停止)/ runAgent(非対話)・streamAgent(対話)が同一 core / analyst-lite・chat-lite サンプル。監査で MCP error surface 不一致 1 件検出→修正(isError 検査して throw、local と同 surface)。fake provider で決定的、web 不変。**ADR 0009 = agent を core、analyst/chat を consumer に**。disciplined-research で実在 7 実装の共通 6 層を一次情報確認した上で設計 (codex high impl + codex xhigh audit + claude orchestrate)

- 2026-06-12 chip 6 実装の Opus 再レビュー（先行 Sonnet レビューのやり直し、ユーザー訂正「レビューに Sonnet 使うな・最新 Opus/Codex xhigh+」を受け）— **全 6 件「健全」、hotfix・新規 issue 不要**。#6 verify:cost（判定路無改変・偽 RED 経路封鎖）/ #9 e2e port（3 経路一貫・全フォールバック安全側）/ chat 撤去（MCP `analyst: String(input.analyst ?? '')` は schema 必須化で R4 退行なし＝先行 Sonnet の退行疑いは誤検出）/ #10 relink（捏造防止がクエリ構造に内蔵・実 DB で linked 126/孤立 0/自己参照 0、先行の ORDER BY/child-first 2 指摘は重大度引き下げ）/ #8 perf（N+1→バッチが per-key 順序まで同値・回帰 0）/ #11 scratch（共有 DB 不汚染・#16 は当該呼び出し順では非顕在）。レビュー = 最新 Opus 固定を audit-protocol 原則 7 に明記 (claude/opus review)
- 2026-06-12 UX 改修ラウンド + issue 消化（chip 並列）— 実 dogfood フィードバック起点の連続改修を全 merge: findings master-detail + narrative evidence / IA 再編（グローバルバー・Findings 軸昇格・session 内限定）/ evidence の turn グループ化 + rail 同期 / Overview v2（rail 撤去・ドリルダウン・要注意パネル）/ triage（埋め込み transcript・sticky verdict・jump 整理）/ コピー中立化（COST OUTLIERS 根拠併記）/ 左空白 bug 修正（grid-column phantom 列）。**issue は chip でクラウド消化 → PR → 独立レビュー + ローカル実データ監査 → merge**: #6 verify:cost live（PR12）/ #10 subagent relink（PR13、Tier A 捏造 0 確認）/ #11 verify scratch（PR14、共有 DB 不変実証）/ #8 perf nav（PR15）/ #9 e2e port env（PR17）。chat は撤去（`69f4b90`、#7 解消、DB テーブルは保持）。follow-up: #16 getPool 潜在 (codex chips + sub-agent review + claude audit)
- 2026-06-12 [19] サブエージェント session 親子リンク + migration 完走 + Tier A 監査 + merge（`11ed7f8`）— codex spawn_agent の agent_id を実在 child session にだけリンク（捏造 0: 孤立 FK/自己参照/dangling すべて 0、実ペア 019e67d2→019e69f2 確認）。`sessions.parent_session_id`/`spawned_by_seq` 追加（冪等 ALTER）、Subagents タブ実数表示 + 不能時「not captured」正直化、rail に SUB バッジ+トグル、二重計上なし (codex + sub-agent review + claude audit)
- 2026-06-12 [18] agent チャット view 完走 + Tier A 監査 + merge（`6552d06`）— /chat 専用画面 / CLI provider（claude -p stream-json、stdin prompt）/ 道具制限 = lathe MCP 5 tools のみ。**監査 block → 16 分で修復**: R1 実 provider 不通（`--allowedTools` variadic が positional prompt を飲み込む → stdin 渡しへ）/ R2 flags 多層化（`--strict-mcp-config` + `--tools ""` + `--disallowedTools` + cwd 隔離）/ R3 launch config 網羅 assert / R4 finding 出所をサーバ側で `chat:<provider>` 強制 + §6.5 self-observation 接続 / R5 injection 区切り + サイズ上限。実 smoke GREEN（tools_observed=1）を監査側で独立再現 (codex+claude)
- 2026-06-12 [16] analyst probes 完走 + Tier B 監査 + merge（`538d074`）— 3 系統（rules/llm/hybrid）+ 実 5 incident smoke replay（recall 5/5, 4/5, 5/5 を監査再実行で同値再現）(codex+claude)
- 2026-06-12 [17] findings 採否 UI / [15] MCP stdio server / [14] Phase 2 データモデル — いずれも監査 + merge 済み（経緯は log.md）(codex+claude)
- 2026-06-11 [11] cost 検証 完走 + 監査 + merge（Tier A）— **過大疑いを実証**: 旧実装は Claude family 名 substring で旧 Opus 単価（$15/$75）に解決し、Opus 4.5 以降の値下げ（$5/$25）未反映 = 約 3 倍過大（claude-opus-4-8 合計 $10,341→$3,477）。per-model 単価表 + 最長 prefix 解決へ修正、`verify:cost` 新設、`docs/cost-semantics.md` に意味論 + 公式照合（Anthropic/OpenAI 一次 URL）。監査: ゲート独立再実行 GREEN（verify:cost / e2e 56/56 / coverage）、単価値は監査者知識とも一致、**循環検証の残り（単価解決の直接アサーション欠如）は issue #5**。修正後 cost で G9 式を再シミュレーション → flag 28 件 / 8.9% でほぼ不変、**承認済みパラメータ変更不要**。ff-merge + push（`493f3d8`）(claude+codex)
- 2026-06-11 [10] 監査 + merge（Tier B、初の loop 監査）— Claude がゲートを独立再実行: build PASS / e2e **56/56** / coverage GREEN。diff 照合: 変更は期待 6 ファイルのみ（スコープ外なし）、新規 E2E 7 件は **DB から期待値を独立算出して UI と突き合わせる independent oracle 構造**で空打ちなし、skip/only なし、既存テストは意図保存（Collapse→Expand/Collapse 往復に更新）、追加コードに TODO/HACK/ts-ignore なし。`main` へ ff-merge + push（`a35cab9`）。loop 運用observed: 承認は「コマンド prefix 永続許可」を 4 種（e2e/playwright/coverage/ingest）に付与して自動化、/goal は CLI 初期プロンプト引数が正、assessor セッション（独立 grader）生成を確認 (claude)
- 2026-06-11 [10] A-1 turn-first explorer — `SessionViewer` の既存 turn/collapse/filter と `DiffViewer` の attribution リンクを再利用し、初期表示を turn-first に変更。turn 行に `steps / edits / bash / errors / cost / tokens / duration / files` rollup と機械抽出 summary、error turn class/属性、展開 step の時間バー、files chip から Git active file への導線を追加。Diff 側は既存 `linkedEvents` から file header の touched steps を表示し、click で transcript の該当 step へ戻る。type filter は highlight/hide 2 モード化。新 E2E 7 件を追加し、既存 E2E は turn 展開操作を足して意図維持。検証: `pnpm -F web exec tsc --noEmit` PASS、`pnpm -F web build` PASS、`pnpm -F web coverage` GREEN、`pnpm -F web e2e` 56/56 GREEN (codex)
- 2026-06-11 [09] G8 mockup close — 並行セッション成果物（mockups/g8 PNG 10 枚 + NOTES.md、g8-explorer-ui.md §7 決定化、tasks/09・10）を Claude が回収・照合して commit。受け入れ条件 6 項照合 PASS（10 ファイル存在 / 案バッジ / 実データ baseline / 配色維持 / NOTES 変更点 / コード変更 0）。ユーザーレビューは 2026-06-10 実施済み: **A-1 turn-first のみ採用、A-2/A-3 不採用、ファイル軸は軽い導線、細部は作りながら詰める**。M2 順 1 完了 (claude)
- 2026-06-11 全体実装計画の確定 — ユーザー決定 4 点（rolling wave / Phase 1 完了ライン = G8+G9+G1 / リスク階層監査 / 期日ベストエフォート）を受け、ROADMAP.md を改訂: Phase 1 完了定義更新（tasks/01-08 済、残 = G8/G9/G1）、Phase 2/3/4/6 に開始ゲート確定事項と G 採番を紐付け（**ハーネス版数を Phase 2 で一級概念化** が最重要の先取り）、マイルストーン順序化、論点台帳 13 件に整理（済 5 / 残 8 を Phase ゲートへ割付）、「直近の実行計画（M2）」6 手順を明記。`design/audit-protocol.md` 新設（Tier A/B/C、裏取り原則、out-of-band retro 監査、tasks/08 を参照実装に）(claude)
- 2026-06-11 d0f5da0 事後監査（out-of-band commit、audit-protocol 初適用）— **PASS-with-notes、重大指摘なし**。Bearer token は timingSafeEqual 比較、transcript は realpath 後 allowlist + `.jsonl` 制限で symlink/`..` エスケープ遮断、fail-open 維持（token 未設定時はヘッダ送らず・失敗は silent）、schema.sql は DDL 不変（コメントのみ）、verify:notify が拒否 4 ケース + DB 不変を実検査 (claude)
- 2026-06-11 issues #2/#3 — `apps/web/db/schema.sql` の列セマンティクスコメントを PostgreSQL 方言のまま復元。notify endpoint は JSON parse / transcript 読み取り前に Bearer token を検証し、`realpath` 後の transcript allowlist + `.jsonl` 制限を追加。hook 生成は token を Authorization header へ載せ、`.lathe/.gitignore` で config/token を git へ載せない。`verify:notify` は token なし / wrong token / allowlist 外 `.jsonl` / symlink escape の拒否と DB 不変、正規 notify の冪等 replace を確認。サブエージェントレビューの指摘を反映済み。`pnpm -F @lathe/client build` PASS、`pnpm -F web build` PASS、`LATHE_TRANSCRIPTS_DIR=/Users/cherie/.claude/projects/-Users-cherie-LLMWiki pnpm -F web coverage` GREEN、`pnpm -F web e2e` 49/49 GREEN、`pnpm -F web verify:notify -- --url http://localhost:3210` PASS (codex)
- 2026-06-10 [08] review + merge — Claude が task 8 をレビュー（重大指摘なし。tx 境界 / fail-open / seq=MIN-1 はサブエージェント初回指摘を実コードで反証）。受け入れ条件 1〜8 を再検証: verify:notify PASS（冪等 counts 不変）、init の既存 hooks 保全 jq PASS、fail-open exit 0、ingest+coverage GREEN、両 build PASS。e2e 48/49 の 1 fail はデータ依存（/diff の既定セッション=changed file 1 件の live セッションで「別ファイル選択」が不成立）で task 8 の回帰ではない。`main` へ ff-merge + push（`f83ead2`）。follow-up: notify endpoint は認可なし（localhost 個人ツール前提、公開デプロイ時は要対応）→ issue #3（https://github.com/yutaro0915/lathe/issues/3）に記録、対応は後日 (claude)
- 2026-06-10 [08] lathe-client + notify endpoint — `packages/client` に `lathe-client init` CLI と fail-open `.lathe/hook.mjs` 生成を追加し、Claude `.claude/settings.json` merge / Codex `.codex/hooks.json` + TOML snippet 生成に対応。本体は `POST /api/ingest/notify` から provider 解析を再利用して該当 session の関連行だけ削除→再挿入する増分 ingest を実装。`pnpm -F web ingest` PASS、`pnpm -F web verify:notify -- --url http://localhost:3210` PASS、`pnpm -F web coverage` GREEN、`pnpm -F client build` PASS、`pnpm -F web build` PASS、`pnpm -F web e2e` 49/49 GREEN (codex)
- 2026-06-10 [07] Postgres migration — `node:sqlite` / local DB file 依存を Postgres + `pg` に移行。`docker compose -f docker-compose.dev.yml up -d --wait` PASS、`pnpm -F web ingest` PASS、`pnpm -F web coverage` GREEN、`pnpm -F web build` PASS、`pnpm -F web e2e` 49/49 GREEN、`rg -l "node:sqlite" apps/ packages/` 0 件、`rg -l "lathe\\.db" apps/ packages/` 0 件 (codex)
- 2026-06-09 [06] scaffold packages and wiring smoke — `@lathe/shared` / `@lathe/client` skeleton を追加し、`format.ts` を `@lathe/shared` 経由に移動。`pnpm -F web build` PASS、`pnpm -F web coverage` GREEN、`pnpm -F web e2e` 49/49 GREEN (codex)
- 2026-06-09 [05] monorepo block move — app 本体を `apps/web/` へ block move し、root pnpm workspace 化。`pnpm -F web ingest` PASS、`pnpm -F web build` PASS、`pnpm -F web coverage` GREEN、`pnpm -F web e2e` 49/49 GREEN (codex)
- 2026-06-09 ADR 0004 — DB = Postgres（Phase 1 から）+ hybrid dev env（依存だけ Docker・アプリは host）+ dev/prod compose 分離。ROADMAP の DB/deploy 方針を改訂 (claude)
- 2026-06-07 17:06 [04] provider abstraction — `scripts/ingest.ts` を provider loop へ縮小し、Claude/Codex provider、Built 型、DB insert、shared helpers に分解。`pnpm ingest` PASS、`pnpm coverage` GREEN、`pnpm build` PASS、`pnpm e2e` 49/49 GREEN (codex)
- 2026-06-07 16:56 [02] extract format utils — shared format helpers を `lib/format.ts` に集約し、components の重複定義を削除。差異は短時間 duration の秒表示と Overview の 0 aggregate 表示を保つ形で統合。`pnpm build` PASS、`pnpm e2e` 49/49 GREEN (codex)
- 2026-06-07 16:51 [03] extract UI mappings — runner/event display mapping を `lib/runner-display.ts` / `lib/event-display.ts` に集約。`TYPE_LABEL` は同一内容のため `EVENT_LABEL` に統一。`pnpm build` PASS、`pnpm e2e` 49/49 GREEN (codex)
- 2026-06-07 16:46 [01] remove dead code — SessionSidebar / seed script を削除し、PROTOTYPE.md の stale 参照も更新。`pnpm build` PASS、`pnpm e2e` 49/49 GREEN (codex)
- 2026-06-07 14:30 [00] handoff — REFACTOR-PLAN.md + tasks/01〜04 + status.md を起こした (claude)

## Open questions / blockers

- G8 A-1 骨格は完了。見た目の細部（色・密度・chip 並び）は task 10 の out of scope として未調整。
- G9（コスト異常検知）は未着手。baseline 定義（project 別中央値 / percentile / 絶対閾値）はユーザー判断待ち。表示面の界面は g8-explorer-ui.md §6 に定義済み
- （解決済み 2026-06-11）schema.sql のコメント劣化は issue #2 で対応。
- （解決済み 2026-06-11）notify endpoint の認可欠如は issue #3 で対応。残る運用注意: server と observed repo の `lathe-client init` で同じ `LATHE_NOTIFY_TOKEN` を使う。
- （解決済み 2026-06-09 調査）Codex CLI にも Stop hook があり transcript path を stdin で渡す。Codex=scan の前提は棄却（`design/observation-ingest.md`）
- スコープ判断（ユーザー veto 可）: turbo+changesets は YAGNI で後回し（ADR 0003 から sequencing 変更）

## Feedback for Claude

- tasks/01 の grep done criteria は `REFACTOR-PLAN.md` / `tasks/*.md` 自身にも削除対象名が出るため、refactor 指示ファイルを除外して検証した。実装・通常ドキュメント側の `SessionSidebar` / `db/seed` / `"seed": "tsx ..."` は 0 件。
