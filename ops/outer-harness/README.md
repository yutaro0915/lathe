# outer harness — 監査役（repo root 対話セッション）専用層

tracked `.claude/` は **inner 専用**（driver worktree に行き渡る世界・#206）。
outer 固有のものはここに正本を置き、`install.sh` で repo root へ untracked 展開する。

- **統治 hook**: issue-create-guard（loop 外の起票に PdM 確認を強制・ADR 0034 系）
  — 配線は `settings.local.json`（untracked・repo root のみ）。inner worktree には物理的に存在しない
- **監査系 agent/skill**: meta-auditor／meta-audit／result-classification — 監査役しか使わない

導入: `bash ops/outer-harness/install.sh`（冪等）。
検証: repo root で `gh issue create` を試みると確認プロンプトが出る／driver worktree では出ない
（機械検証は #206 の子 D が担う）。

規律の正本: [discipline.md](./discipline.md)（起票・scope 変更・記録の置き場。memory 全廃 2026-07-08）。
