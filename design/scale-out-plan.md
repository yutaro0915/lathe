---
title: inner loop のスケールアウト方針 — cloud vs 自宅 mini-PC vs 両立
status: proposal（2026-07-02 調査完了・ユーザー裁可待ち）
created: 2026-07-02
---

# inner loop のスケールアウト方針

前提（動かさない要件）: **サブスク認証を温存**（API 二重払いをしない）／**観測ローカル**（transcripts → ingest → lathe DB の循環が閉じること。meta-audit の生命線）。
一次調査: [research/2026-07-02-cloud-claude-auth.md](research/2026-07-02-cloud-claude-auth.md)（Claude 側）・[research/2026-07-02-codex-minipc.md](research/2026-07-02-codex-minipc.md)（codex＋mini-PC）。

## 比較（要点）

| 観点 | A: cloud（GH Actions 等） | B: 自宅 mini-PC | C: 両立 |
|---|---|---|---|
| Claude サブスク | token は置ける（`claude setup-token`・1 年有効）が **CI 自動化は ToS グレー**＋**対話と quota 共食い** | **公式手段で成立**（本人の別マシン＝用途どおり） | B に同じ |
| codex サブスク | **公式 codex-action は API key 必須**（サブスク不可・要望 issue #92 open）。Codex cloud は**サブスク専用**だが汎用 API 未確認 | **成立**（device-auth / auth.json 可搬・自動 refresh） | B に同じ |
| 観測（transcripts→lathe） | runner から push 還流の追加配管が必要。**Codex cloud はローカルに落ちず未解決** | **無改修で閉じる**（driver・CLI・DB・transcripts が同居） | B が主なら閉じる |
| コスト | API 従量なら $50-150/月（見積） | mac mini M4 ¥94,800〜・電気 月 ¥100-800／N100 箱 ¥23,000-40,000 | B＋α |
| 並列 | runner 数だけ | マシン性能内で K 並列（ADR 0015 の inner-queue がそのまま動く） | ＋Codex cloud バースト |
| Mac を閉じられる | ✓ | ✓（常時稼働機に移る） | ✓ |

## 推奨: **B を primary、C を限定併用**

1. **mini-PC（推奨は mac mini M4）** に driver＋両 CLI＋Postgres を移す。両 CLI ともサブスク認証が公式手段で維持でき、観測ループが無改修で閉じ、ランニングは月数百円。macOS なら現環境と同型（Keychain・検証済みの挙動）で移行が最も滑らか。N100/Linux は半額だが credential 管理と環境差の検証が増える。
2. **併用型 1**: Codex cloud を「並列バースト」に限定利用（同一サブスク枠・`codex cloud exec --json` で駆動可）。ただし transcript がローカルに落ちない＝**観測に穴**が開くため、ログ取得可否（未確認）を確かめるまで常用しない。
3. **併用型 2**: GitHub Actions は **LLM を使わない決定的ゲート専用**（rubric の cmd 層・unit 等。API key 不要）。issue #20（CI で gate が回らない）の解と一体で、branch protection の required check 化＝ゲートの repo スコープ化にも繋がる。

## 段階

- **Phase B0（今・ハード購入前に完了可能）**: #36 resume・#37 codex 修正・#38 inner-queue。**この 3 つは mini-PC 上でそのまま動く**＝先行投資が無駄にならない。
- **Phase B1（mini-PC 導入時）**: セットアップ = 専用ユーザー・Tailscale SSH・fine-grained PAT・launchd 常駐・`claude setup-token`（1 年）・`codex login --device-auth`・Postgres 移設（pg_dump/restore）・lathe ingest 起動。MacBook からは `ssh mini "node scripts/inner-queue.mjs --max 2"`（または issue label だけ付けて mini 側の常駐が拾う）。
- **Phase C（任意・後）**: 型 2 の CI ゲート（#20/#4 が前提）→ 型 1 の Codex cloud バースト（ログ還流の確認後）。

## 未確認（導入前に潰す 2 点）
- Codex cloud の実行ログ/transcript を取得する手段の有無（観測穴の解消可否）。
- Anthropic / OpenAI の同時デバイス数・マシン数の規約上限。

## 却下
- **全面 cloud**: サブスク温存と観測ローカルの両方に反する（codex-action は API key 必須・Claude は quota 共食い＋ToS グレー・Codex cloud は観測が閉じない）。
