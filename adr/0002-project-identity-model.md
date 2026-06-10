---
id: 0002
title: Project = repo, identity vs display_name 分離、canonical = 正規化 git remote URL
status: accepted
date: 2026-06-07
deciders: [yutaro0915, claude]
supersedes: null
---

## Context

Phase 1 の `sessions.project` カラムは「変更したファイルパスから推測」(`lib/db.ts` の `deriveProjectKey`)している。dogfood 環境では全部 `"LLMWiki"` に潰れて、Overview のプロジェクト集計が歪む。

[ADR 0001](./0001-ingest-via-hook-and-server-side-jsonl.md) で hook トリガー方式に決めたので、**hook 側がプロジェクト identity を明示的に運べる**ようになる。この機会に identity モデルを整理する。

Langfuse の調査:

- Langfuse のデータモデル: **Org → Project → Trace → Observation**
- 公式 best practice: 全部 1 つの Langfuse Project に入れて、`tags=["repo:foo"]` や `metadata.repo="foo"` で repo を区別。Project を分けるのは RBAC / billing / retention が違う時のみ。
- 出典: [FAQ managing-different-environments](https://langfuse.com/faq/all/managing-different-environments), [discussion #13025](https://github.com/orgs/langfuse/discussions/13025)
- **Langfuse の "Project" は tenant の意味**(API key / RBAC / 課金単位)。Lathe では tenant 階層は dogfood 段階では不要。

エッジケース(repo identity の候補ごと):

| 候補 | エッジケース |
|---|---|
| git remote URL | remote 未設定 / 複数 remote / URL 形式違い(SSH/HTTPS/.git) / fork / monorepo subdir / submodule / repo rename / mirror |
| cwd 絶対パス | PC を超えると別物 / ディレクトリ rename で identity 喪失 |
| cwd basename | `~/code/web/api` と `~/code/test/api` 衝突 |
| package.json `name` | package.json がない repo / scope 違い |
| ユーザー手動命名 | 同じ repo を別 PC で init すると揺れる |
| `.lathe/project-id`(commit) | ファイルを commit する必要 |
| git root commit hash | 人間が読めない / 新規 init 直後は commit 無し |

## Options

- **A. cwd basename を identity に**: 単純だが衝突しまくる。
- **B. git remote URL を canonical key として 1 個だけ**: 正規化必要、remote 無し時に fallback が要る。
- **C. identity と display_name を分離 + identity 解決の優先順位を定める**: immutable な identity を持ちつつ、display は人間に優しい形に。
- **D. ユーザーが完全に手動で命名**: 揺れる、init UX が増える。

## Decision

**C を採用する**。具体的に:

1. **Project = repo の意味づけ**(Langfuse の Project とは別物。Lathe の Project は tenant 階層ではなく repo の単位)。
2. **DB は 1 個、`project_id` で repo を区別**。新しい階層(Org 等)は dogfood 段階では作らない。
3. **identity と display_name を分離**:
   - `project_id` は immutable な canonical key
   - `display_name` は人間が読む名前(変更可)
4. **identity 解決の優先順位**(`lathe-client init` 時):
   1. `.lathe/project-id` があれば(commit 済み project の clone 先)それを使う
   2. 無ければ **正規化した git remote URL**(`host/owner/repo` 形式、SSH/HTTPS/.git 差異を吸収)を identity にする。本体 DB に既存があれば match、無ければ新規作成。
   3. git remote URL も無ければ、**`lathe init --name <foo>` で手動命名を強制**(警告だけだと続行できるので止める)。
5. **display_name の推定**(auto-fill):
   - `package.json` の `name` → git remote の `owner/repo` → cwd basename
   - ユーザーが `lathe init --name <foo>` で override 可能
6. **fork は別 identity** とする。fork 元と fork 先は別の改善対象であり、ハーネスも独立に進化するため(例: cursor は vscode の fork だが同一 identity にはしない)。
7. **migration コマンド**(将来):
   - `lathe project rename <old-id> <new-id>` — repo rename / org 移転に対応
   - `lathe project alias <id-a> <id-b>` — 後付けで紐付け(fork 同士を後で同一視したくなった時)
   - 発生頻度が低いので**後付け実装**で良い

## Consequences

- **Phase 1 の `deriveProjectKey`(変更ファイルパスからの推測)は廃止**(または lathe-client init してない project の fallback としてのみ残す)。
- **DB スキーマ変更**: `sessions.project` カラムの意味が「正規化 identity」に変わる。`projects` テーブルを新設して `id`(immutable canonical) + `display_name` + `git_remote` + `cwd_hint` + `created_at` を持たせる方向(具体スキーマは別 ADR or design で詰める)。
- **hook が `project_id` を送る**: [ADR 0001](./0001-ingest-via-hook-and-server-side-jsonl.md) の hook payload に `project_id` を含める。
- **git remote URL の正規化ロジックが必要**: SSH(`git@github.com:user/repo.git`)/ HTTPS(`https://github.com/user/repo.git` or `.git` なし)を `github.com/user/repo` に揃える。
- **複数 PC 対応**(将来): 同じ repo を別 PC で init しても、git remote URL ベースなら同じ identity に解決される(`.lathe/project-id` を commit するならさらに確実)。
- **Org 階層は将来必要になったら追加**(Phase 7 OSS 公開時に複数ユーザー dogfood する段階で再評価)。
