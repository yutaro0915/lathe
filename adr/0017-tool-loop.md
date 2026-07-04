# ADR 0017: tool-loop — 開発支援ツールは goal 丸投げ＋検収で作る（`tools/` carve-out）

- status: accepted（2026-07-03、ユーザー裁可: 「開発中に必要になったものはどんどん作らせる。要件だけ固めたら agent に丸投げし、提出物をチェックする」＋ tools/ のゲート外 carve-out に yes）
- date: 2026-07-03
- 関連: ADR 0016（loop family。本 ADR は第 3 の loop 種）/ [[workflow-merge-gate]]

## 背景

開発の過程で「開発を支援する小さなツール」が繰り返し必要になる（例: WBS ビューア・run watcher——どちらも outer が手書きで都度作っていた実績）。これらは (a) 動けばよい・(b) 壊れても本体に波及しない・(c) 要求者＝検収者、という性質を持ち、receipt ゲート（review/verify 必須）の重さが割に合わない。一方で lathe 本体と loop 基盤の品質保証は緩めない。

## 決定

### 1. tool-loop（loop family 第 3 号）
- **入力**: 要件だけ固めた goal（仕様の細部・実装選択は agent に委ねる）。
- **実行**: agent に丸投げ（worktree 隔離の単発 run。途中の review/verify 段は無し）。
- **ゲート**: **提出物の検収**（要求者＝人間 or outer が動かして確認）が唯一のゲート。
- **失敗時**: 作り直し依頼 or 破棄（使い捨て可）。

### 2. `tools/` carve-out
- 置き場は **`tools/`（新設）**。ここは receipt ゲートの対象外。
- **着地**: 検収合格後、outer が main に直接 commit（git-guard はコードパス block を `apps/web`/`packages` に限定しており `tools/` は通る。branch からの取り込みは patch 適用で行い、raw merge は使わない）。
- **本体は不変**: `apps/web`・`packages`・`scripts/`（loop 基盤）は従来どおり full gate。**tool が本体機能へ昇格する時は通常フロー（needs-plan → impl-loop）に乗せ直す**。

### 3. 品質の下限
- tool は自己完結（node ESM・依存追加なし・repo 状態を変更しない read-only 動作を基本）。
- 破壊的操作（削除・DB 書込・git 変更）を行う tool は carve-out 対象外＝通常フローへ。

## 却下した代替
- **tool も full gate**: 検収者が要求者本人である使い捨て支援物に二重の審査は過剰。摩擦で「作らない」に倒れるのが最大の損失。
- **ゲートも検収も無し**: 破壊的 tool の混入リスク。§3 の下限と検収で担保。

## 初弾
1. `tools/wbs.mjs` — gh issues＋`.lathe/runs` から WBS 盤面を生成。 **【廃止 2026-07-04・ADR 0025】** タスク基盤を Backlog.md へ移行。盤面は `backlog board`/`browser`＋lathe `list_runs` に分解され不要に（tool-loop 機構と §2 carve-out は存続＝wbs は初弾インスタンスが役目を終えただけ）。
2. `tools/watch-run.mjs` — run の PID 監視→終了時に manifest/escalation/main を dump（outer が毎回手書きしていた watcher の定型化）。存続。
