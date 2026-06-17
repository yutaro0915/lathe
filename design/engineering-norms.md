# Lathe Engineering Norms（コード規範）— 手戻り削減の機構

> **目的**: 監査が毎回捕まえてきた「ゲートは GREEN でも中身が骨抜き」系の手戻りを、**事前ルール化**して減らす。
> **適用**: すべての Codex /goal loop は本ファイルを**必読**（goal 文に「engineering-norms.md を守れ」を明記）。
> 監査（audit-protocol Tier A/B/C）は本ルールの**遵守を検査軸**にする。違反は要修正。
> 由来: 2026-06-14〜17 の tasks/22-25 監査で繰り返し検出した実害パターン（ADR 0009 / 各 audit ログ）。

## N1. ゲートは「反証可能」でなければならない（最重要）
- すべての品質ゲート（verify:*）は、**検査対象の性質が壊れた/欠けたときに必ず RED になる**こと（falsification）。
  - 例: 「analyst は ACP 経由」を主張するなら、**ACP を強制失敗（`LATHE_ANALYST_ACP_COMMAND=/bin/false`）させると gate が RED** になる反証チェックを同梱する。
  - 例: 「generic を弾く」なら、generic を注入して RED になることを gate 内で確認。
- **fallback / stub / 別経路で通ってしまうゲートは無効**。「GREEN」は「正しい経路を実際に通って GREEN」でなければならない。
- 監査は「gate を意図的に壊して RED を確認」する反証実行を行う。反証で RED にならない gate は要修正。

## N2. 指定経路の失敗をサイレント fallback で隠さない
- 設計上の経路（例: LLM 候補は ACP 経由）が失敗したとき、**旧経路/直接経路へ黙って fallback しない**。明示的に失敗 or スキップする。
- 「動かす」ために旧経路を生かすと、移行が骨抜きになりゲートが守れない（tasks/25 R1 の実害）。
- 例外（LLM 不要な経路）は許容（例: rules-v1 の直接 submit）。ただし「LLM/agent を要する経路」は指定経路のみ。

## N3. 上位情報源を下位生成物で上書きしない（provenance 保持）
- agent / LLM が生成した richer なデータ（例: ACP agent の深掘り analysis）を、ルールベースの backfill / normalize で**上書きしない**。
- backfill・補完は **欠落しているものだけ**を埋める（missing-only）。`overwrite: true` で source を潰さない（tasks/25 R2 の実害）。

## N4. ゲートを通すために緩めない（anti-Goodhart / anti-gaming）
- gate を GREEN にするために、判定を緩める・検査を削る・条件を分割して骨抜きにする、をしない。
- 正しい分割は可: 「**決定的 gate（fake fixture で安定）+ 反証チェック + 別建ての live 存在証明**」のように、**保証を保ったまま**安定化する（tasks/25 の split は反証を残したので可）。
- known-incident の手書き期待インサイトは**ハードな最適化対象にしない**（ROADMAP の Goodhart 回避）。recall/depth は hard、per-incident の文面一致は情報ログ寄り。

## N5. generic / テンプレ / fixture 流用を成果物にしない
- 分析・finding の本文は **finding 固有の機序**まで踏み込む。複数 finding で同じ fixture 系の cause を使い回さない。
- env/runtime/setup vs product/harness の区別など、判断に効く内容を持たせる。generic は gate で弾く（N1）。

## N6. 検証は scratch 隔離、共有 DB を汚さない
- verify / ingest / e2e / coverage は **専用 scratch schema or scratch DB** で実行し、終了後に drop。
- 共有 `lathe` DB に対し **DROP / DELETE / TRUNCATE をしない**。検証前後で findings/evidence の count/md5 が不変であることを確認できる形にする。

## N7. provider 非依存・界面の堅さ
- 特定 provider（Claude Code 等）前提のハードコードを core/共有層に置かない（ADR 0009）。incident 知識・期待値は**データ化**（コード直書きしない）。
- 外部入力（MCP tool 引数 / LLM payload / JSON-RPC）は**型ガード/正規化**する。floating promise（`void p` で例外を握り潰す）を残さない（例外は session エラーへ構造化）。

## N8. 完成宣言はその場の機械照合のみ
- 「完成 / 網羅 / 検証済み」は記憶・印象でなく、**その場でゲートを実行した GREEN**を根拠にする（hub ALWAYS、[[memory/feedback_coverage_harness]]）。
- dev server と同じ worktree で build/e2e を走らせない（`.next` 破損、hook で防御済み）。

## 監査との接続
- 監査者（Codex xhigh / audit-protocol Tier A）は本 N1-N8 を検査軸にし、特に **N1（反証で gate を壊して RED 確認）** と **N2/N3（骨抜き検出）** を実走で確かめる。
- loop は commit 前に本ルールへの自己照合を行う。違反は loop 内で直す（監査往復を減らす）。
