# ADR 0006: PR 連携 — 紐付けキー = commit SHA 主 + branch 補、認証 = gh token 流用（暫定）

- Status: accepted
- Date: 2026-06-11
- 決定者: yutaro0915（選択肢提示: Claude。調査: prior art 15 実装 + GitHub API 一次情報）

## Decision

1. **紐付けキー: commit SHA 主 + branch 補**
   - session の commit イベントから SHA を抽出し `session_commits(session_id, sha)` に保存。
     PR 側は `pr_commits(pr_id, sha)`。紐付けは SHA join
   - SHA が取れない session は `git_branch` ⇄ PR `headRefName` で補完
   - 時間窓ヒューリスティックは**使わない**（prior art 採用ゼロ、誤紐付けの温床）
   - 根拠: lathe と同型の実装（git-ai / DX）はいずれも commit SHA 解決。branch 名主キーの
     実装は 15 実装中ゼロ。GitHub に公式逆引き API（`GET /commits/{sha}/pulls`）が存在
   - 遡及 backfill 可（transcript 正本が手元にあるため。LinearB が existence proof）
2. **`projects` テーブルを同一 migration で新設**（論点 #6 の処理）
   - ADR 0002 のモデル（canonical = 正規化 git remote URL、display_name 分離）。
     PR は repo 単位の資源であり G1 が必然的に要求する
3. **認証: 当面 `gh auth token` 流用**（2026-06-11 ユーザー決定）
   - 導入ゼロコストを優先。scope が `repo`（全 repo 書込相当）と広い点は既知のトレードオフ
   - **サービス化（他者提供 / デプロイ）時に fine-grained PAT / GitHub App へ移行する（要対応、
     issue 化して追跡）**。コードは token 取得を 1 箇所に抽象化し、env `GITHUB_TOKEN` 優先 →
     `gh auth token` fallback の順で解決する（移行点を 1 箇所に閉じる）
4. **取り込み経路**: 初回 backfill = GraphQL（100 PR/query、merged・差分統計・reviews を nest）。
   定常増分 = REST `issues?since=` + ETag 条件付き polling（304 は rate limit 非消費）。
   webhook は使わない（ローカル個人ツールに不適）。catch-up sweep にも PR 同期を含める

## Consequences

- スキーマ追加: `projects` / `pull_requests` / `pr_commits` / `session_commits`、
  `sessions` は projects 参照へ移行（Tier A 監査対象）
- commit イベントからの SHA 抽出を provider 解析に追加（ingest 正しさ = Tier A）
- 認証抽象を挟むため、PAT/App 移行はコード 1 箇所 + env 変更で済む
