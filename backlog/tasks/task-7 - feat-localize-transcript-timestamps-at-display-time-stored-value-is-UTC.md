---
id: TASK-7
title: 'feat: localize transcript timestamps at display time (stored value is UTC)'
status: To Do
assignee: []
created_date: '2026-07-04 13:16'
updated_date: '2026-07-04 21:15'
labels:
  - migrated
milestone: m-18
dependencies: []
references:
  - gh#19
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub issue #19 から移送（ADR 0025）。詳細・議論は元 issue（closed・リンク保持）を参照。
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
【PdM 判断待ち・2026-07-05 夜間 PLAN:ESCALATE】設計判断が必要につき自律実装から除外。
根拠: 保存値は transcript_events.ts が UTC の HH:MM:SS（時刻のみ・日付なし。ingest の hhmmss() が生成、apps/web/scripts/ingest/shared.ts L147）。正しいローカライズには date（オフセット/DST 決定）と日跨ぎ処理（例 22:00 UTC→JST 翌 07:00）が要るが event 単位の date は未保存（session.startedAt に session 単位のみ）。
要判断: (1) 保存契約を変え event ごとに datetime を保存するか / session 日付で近似するか（データモデル判断）、(2) 対象 TZ（ブラウザ TZ / 固定 JST）。
付随: 元 issue #19 が inner 環境で取得不可（gh/WebFetch 拒否）で AC 不明。移行タスクの body が「issue #19 参照」のみで自己完結していない（別途 body 補完が要る）。
<!-- SECTION:NOTES:END -->
