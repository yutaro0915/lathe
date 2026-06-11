---
title: G1 — PR 連携（session ⇄ PR 紐付け）設計ドラフト
status: accepted（2026-06-11 ユーザー決定: commit SHA 主 + branch 補 / 認証は gh token 流用・サービス化時に移行 = issue #4 → ADR 0006 / tasks/13）
created: 2026-06-11
updated: 2026-06-11
---

# G1 PR 連携 設計ドラフト

S1-5「PR 起点の閲覧」を閉じ、提案書の「起点は PR」を成立させる。
M2 完了判定: 「dogfood の自分の PR の意図 → 実装 → review → merge が 1 セッションとして見える」。

## 調査結果（2026-06-11、一次情報。詳細は本セッション調査ログ）

**prior art（15 実装網羅）の要点**:
- cloud agent（Copilot coding agent / Codex cloud / Devin / Cursor / Claude Code web）は
  platform DB で session→PR を**生成時記録** — ローカル観測の lathe には適用不可
- **lathe と同型**（ローカル hook 観測 → commit 時に SHA へ紐付け）は **git-ai / DX** の 2 実装
- **branch 名 match を主キーにする実装は確認できず**（branch prefix は補助情報どまり）
- 遡及 backfill を明言する existence proof は **LinearB**（trailer/author の後解析）のみ
- commit trailer に session URL を埋める方式（Copilot `Agent-Logs-Url` / Amp `Amp-Thread`）は
  「ローカル DB が消えても git 履歴に紐付けが残る」補完。将来 lathe-client 拡張の候補

**GitHub API（公式 docs 確認済み）**:
- commit→PR 逆引きの公式 endpoint あり: `GET /repos/{o}/{r}/commits/{sha}/pulls`（branch 名でも可、
  複数 PR が返り得る）。GraphQL `Commit.associatedPullRequests` も同等
- 初回 backfill = **GraphQL**（pullRequests に merged/差分統計/reviews を nest、100 PR/1 query）。
  定常増分 = **REST `issues?since=` + ETag 条件付き**（304 は rate limit 非消費 = 実質無料 polling）
- webhook はローカル個人ツール不適（`gh webhook forward` は dev 専用）→ polling 一択
- 認証: fine-grained PAT（Pull requests:read + Issues:read、期限 1〜366 日）が least privilege。
  `gh auth token` 流用は導入ゼロコストだが scope `repo`（全 repo 書込相当）と広い

**手元データ**: 全 341 sessions に `git_branch` 記録済み。commit イベント 265 件
（SHA は イベント本文からの抽出処理を追加すれば取れる見込み — 実装時に検証）。

## 設計（判断待ち 2 点を除き確定）

### 紐付けモデル（推奨: commit SHA 主 + branch 補）

```
session --(commit イベントから SHA 抽出)--> session_commits(session_id, sha)
pull_requests(project_id, number, ...) --(pr_commits: pr_id, sha)--> SHA 集合
紐付け = SHA join。SHA が取れない session は head branch 名（git_branch ⇄ headRefName）で補完。
時間窓ヒューリスティックは使わない（prior art に採用例なし、誤紐付けの温床）。
```

- 双方向: PR ページから sessions / session から PR chip
- **遡及可**: transcript は保存済みなので、過去 session も SHA/branch 再解決で backfill できる
  （LinearB 型。lathe の強み = 正本が手元にある）

### スキーマ（論点 #6 をここで同時処理 — migration 1 回で済ませる）

- `projects` テーブル新設（ADR 0002 のモデル: canonical = 正規化 git remote URL、display_name 分離）。
  PR は repo 単位の資源なので G1 が必然的に要求する
- `pull_requests` / `pr_commits` / `session_commits` 追加。`sessions.project` は projects への
  参照に移行（互換 view か段階移行かは実装時判断）

### 取り込み

- `lathe-client init` 済み repo（`.lathe/config.json` に gitRemote あり）を対象に、
  初回 GraphQL backfill → 定常は notify hook と同周期 or 定期 polling（ETag）
- catch-up sweep に PR 同期を含める（サーバ停止中の取りこぼし回収、ADR 0001 と同型）

### UI（最小）

- session ヘッダ / 一覧行に PR chip（`#123 merged`）→ click で PR パネル（意図 = PR description、
  実装 = linked sessions、review = timeline、merge 状態）
- PR 起点ビュー: PR 一覧 → PR を開くと関連 session 列が見える（M2 判定の画面）

### 受け入れ条件の骨子（task 化時に確定、audit: A — スキーマ + 外部 API 界面）

- 実 repo（lathe 自身）で backfill → 本 task の PR が session と紐付く E2E
- SHA 抽出の単体検証（commit イベント本文 → SHA）
- 冪等性（再 backfill で重複しない）/ rate limit 安全（ETag 動作）/ 既存 e2e GREEN / coverage GREEN

## ユーザー判断待ち（2 点）

1. **紐付けキー**: 推奨 = commit SHA 主 + branch 補（git-ai/DX 同型 + 公式逆引き API）。
   代替: branch 主（実装は軽いが prior art ゼロ・rename/再利用に弱い）
2. **認証**: 推奨 = fine-grained PAT（最小権限）。代替: `gh auth token` 流用（ゼロ設定・広権限）

判断後、本ドラフトを ADR 0006 として確定し task 化する。
