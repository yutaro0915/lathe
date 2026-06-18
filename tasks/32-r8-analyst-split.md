---
id: 32
title: r8-analyst-split — analyst-engine.ts(1769) を責務別モジュールへ分解（I4）。r5/r3 後
status: completed
workflow: loop
audit: A
estimated: large
bound: 30 turns
depends_on: [r3, r5]
assignee: codex
---
## What
design/convergence-plan.md r8。analyst-engine.ts(約1769行) を責務別に分解し各 ≤500行/関数≤80。**挙動を変えない**(pure extract)。

## 前提(r3/r5)
- stableJson/parseStoredAnalysis は @lathe/domain(r3)。重複させない。
- backfill は r5 で lib/write の backfillFindingAnalysisIfMissing に移動済み。**再実装/再homeしない**(それを呼ぶ)。

## 受け入れ条件(全 GREEN まで継続)
1. analyst-engine.ts を責務別ファイルへ分割: (a)検出 rules-v1(detectFailureLoops/UnattributedDiff/ExcessCost/RiskyActions, structuralAnalysis) (b)ACP 駆動(runAcpSession 等) (c)orchestration(runAnalyst/scheduling/enrich) (d)smoke(runAnalystSmoke 等)。純粋判定ロジックは @lathe/domain に置いてよいが、DB 読みを伴う部分は apps/web 側に残す(domain は純粋を保つ)。各ファイル ≤500行・関数 ≤80。
2. 既存 import(analyst.ts / ingest/notify.ts / verify-finding-depth.ts 等)は re-export shim で**不変**に保つ。
3. N1 反証: LATHE_ANALYST_ACP_COMMAND=/bin/false で llm-v1/hybrid が RED(ACP-only、**N2 no silent fallback**)。rules-v1 は ACP 無しで finding 生成(LLM 不要)。N3 missing-only 維持。
4. tsc GREEN / build GREEN / verify-finding-depth GREEN / verify(MCP all) GREEN(scratch, N6)。
5. oxlint max-lines: 分割後の全ファイル ≤500、analyst-engine を grandfather から除去(or ≤500 の薄い shim 化)。

## やらないこと
- backfill 再実装(r5 が home)・UI・verdict・lib/db 本体分割・detection の DB 読みを無理に domain へ(純粋性を壊す)。

## norms
engineering-norms N1–N8(N1 反証・N2 no fallback・N3 missing-only・N6 scratch)。全 GREEN + commit([r8])まで継続。push/merge しない。
