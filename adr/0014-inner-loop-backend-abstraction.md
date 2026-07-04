# ADR 0014: inner loop の backend 抽象 — 段を codex exec でも回す（Claude token を outer/fable に温存）

- status: accepted（2026-07-02、ユーザー指示: 「codex も inner loop で使えるようにしたい。claude code は fable の利用になるべく多くのトークンを割きたい」）
- date: 2026-07-02
- 関連: ADR 0013（inner loop driver）/ `design/phase2-finding-model.md` §6.4（CLI provider 抽象 `claude -p` / `codex exec` の先行判断）/ hub `references/claude-codex-collaboration`・`strength-map`
- 接地: `codex exec --help` 実測（codex-cli 0.142.1、2026-07-02）

## 背景

inner loop の各段は現在 `claude -p --agent <name>` 固定。Claude サブスクの token は outer（fable＝監督・meta-audit・エスカレーション判断）に集中させたいので、**grunt（inner の各段）を codex（gpt-5.x・別サブスク）へ逃がせる**ようにする。lathe は最初から runner 非依存（claude-code + codex 両対応の ingest / session_class / cost 単価）なので、観測系は無改修で吸収できる。

## 決定

### 1. 段の起動を backend adapter で抽象化（`scripts/inner-loop.mjs`）
`runStage` を backend 分岐にする。**verdict 規約・receipt（driver 刻印）・manifest・escalation・merge.mjs ゲートは backend 非依存のまま**（プロセスレベルの契約なので変更しない）。

| 関心 | claude backend（現行） | codex backend（新設） |
|---|---|---|
| 起動 | `claude -p <prompt> --agent <name> --output-format json` | `codex exec <prompt> --json -o <lastmsg-file> -C <cwd>` |
| 役割注入 | `.claude/agents/<name>.md`（--agent） | **同じ agent .md の本文（frontmatter 除去）を prompt 先頭に inline**（役割の単一情報源を共有） |
| 権限 | `--permission-mode`＋`--allowedTools` | `-s read-only`（PLAN/REVIEW）／`-s workspace-write`（IMPLEMENT/VERIFY/TRIAGE、`-C`=worktree）。workspace-write では `sandbox_workspace_write.network_access=true` を明示。`--dangerously-bypass-*` は使用禁止 |
| model | agent frontmatter | `-m`（既定=ユーザー config。段別 override 可） |
| verdict | envelope `result` 末尾 | `-o` ファイル末尾（同じ `VERDICT: <TOKEN>` 規約） |
| session id | envelope `session_id` | `--json` の JSONL イベントから捕捉（rollout id。実イベント名は実装時に 1 発スモークで確定） |
| transcript/ingest | `~/.claude/projects` → ingest 済み | `~/.codex/sessions` → **ingest 済み**（S1 で全 rollout 対応済み）。`--ephemeral` は使わない |

### 2. 配分の既定と override
- **既定 = inner の大半を codex、VERIFY は Claude fallback**（ユーザー意図: Claude token を fable/outer に温存。ただし 2026-07-02 時点で Codex VERIFY は sandbox 書込 / localhost EPERM の実測があるため、検証段は安全側に倒す）。  
  **【事実注記 2026-07-05】** codex サブスク解約により、`selectBackend` の既定を全段 `'claude'` に変更（TASK-20）。`--backend codex` 明示 override は温存（将来の再契約に備えた互換）。設計論拠（Claude token の outer 温存・adapter 分離）は不変。
- driver フラグで override: `--backend claude`（全段）／段別 `--backend-plan claude` 等。難所 issue だけ planner を claude/opus に切り替える運用を許す。
- manifest に `backend` を記録（run ごとの配分が meta-audit で見える）。

### 3. ゲート完全性の維持
- codex には PreToolUse hook（git-guard）が無いが、**workspace-write sandbox が書き込みを worktree に閉じ込め**、main への着地は従来どおり driver が `merge.mjs`（receipt 照合＋backstop）で行う。ゲートは backend に依存しない。
- receipt は driver 刻印（ADR 0013 改）なので変更なし。

## 却下した代替
- **codex 用の別 driver を書く**: 状態機械・manifest・escalation の二重化。却下（adapter 1 枚で足りる）。
- **役割 prompt を codex 用に別管理**: agent .md と乖離する。却下（同一 .md を inline）。
- **`--dangerously-bypass-approvals-and-sandbox`**: 不要（sandbox 段階指定で足りる）。禁止。

## 実装順
**#32（段プロンプトの役割契約・P0）を先に land**（両 backend に効く前提整備。codex は agent .md を inline するので契約の明文化が一層効く）→ 本 ADR の実装 issue を inner loop で。実装時スモーク: `codex exec "say OK" --json -o /tmp/x` で JSONL の session id イベント名と `-o` の形を確定してから adapter を書く。

## スコープ外
段の並列化・codex `resume` の差し戻し周回への利用（将来最適化）・outer の backend 変更（fable のまま）。
