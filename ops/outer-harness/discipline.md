# outer 行動規律（起票・scope・記録の正本）

正本はこのファイル（repo 内・機械検証可能な場所のみを正とする）。
**セッション外 memory は全廃**（2026-07-08 PdM 裁定「メモリなんていう不確実なものに頼ることはない。
機械的に検証できるようにすること」）。旧 `~/.claude/.../memory/` は tombstone 化済み・参照禁止。

## 起票（issue 作成）

- **loop 外の起票は、その起票について PdM の明示承認を得てからのみ行う**（2026-07-07 確定・違反 2 回の教訓）。
  以下は承認ではない: 包括委譲／ADR に記録済みであること／会話の含意／願望の表明。
- 起票したい内容は平文で提示し、承認を**待つ**（提示と起票を同一 turn でやらない）。
- **loop 内の機械起票**（承認済み plan の FILE_CHILDREN・escalation の issue 化・orchestrator 投函）は
  親の承認で正当化済み・個別承認不要（2026-07-07 #201 裁定）。
- 機械強制: `ops/outer-harness/hooks/issue-create-guard.mjs`（配線は untracked `settings.local.json`）。

## scope 変更

- **plan が確定した issue には scope を追加しない。必ず新 issue にする**（2026-07-08 PdM 裁定。
  plan と body の乖離が review・実装の接地を壊すため）。
- plan 未確定（needs-review の Ready 待ち等）の issue への本文追記は可。ただし教材が既に生成済みの
  場合は教材と body が乖離することを PdM 報告に明記する。
- 既存 issue への「設計要求」コメント追記も起票と同格の承認制（2026-07-07 裁定）。

## 記録の置き場

- 運用知識・規律・経緯の正本は **repo のみ**: `design/loops.md`（loop 台帳）・`design/agent-workflow.md`・
  `adr/`・`design/runbooks/`・本ファイル。
- PdM 裁定は当該 issue / Discussion の comment に転記する（対話ログを正本にしない）。
- 完成・網羅の宣言は必ずその場の機械照合を根拠にする（grep・件数照合・実測。記憶・印象は不可）。
