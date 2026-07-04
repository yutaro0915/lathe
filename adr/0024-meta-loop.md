# ADR 0024: meta-loop — 感知・診断系の工学化（共有 driver × 監査プロファイル）

- status: accepted（2026-07-04 PdM 承認。components を 1 つずつ確認: result-classification=判断の中身の配管 / manifest=判断の記録＋自己適用 / fan-out=並列収集の契約 / profiles=何を監査するかの宣言）
- date: 2026-07-04
- 設計正本: [design/outer-loop-family.md](../design/outer-loop-family.md)（2026-07-04 PdM 壁打ちで確定した as-is 診断と to-be。本 ADR はその gap list 6 件の実装を授権する）
- **受け入れ条件 = [`evals/meta-detection-v1.md`](../evals/meta-detection-v1.md)**（ground truth = 実履歴 43 run 内の既知問題群）
- 関連: ADR 0013〜0016（inner-loop driver 一族＝機構の流用元）／ADR 0023（runs ingest＝manifest の載り先）／theory §結果分類・§関係の管理
- 役割分担: driver・profiles 形式は loop 基盤（inner loop で実装可）。skill・プロファイル内容の作成と検収は監査役。

## 対象

meta-audit（現状: 曖昧な委任状の skill ＋ ad-hoc な subagent 呼び出し）を、**driver で駆動される staged pipeline** に工学化する。判断（分類・診断）は消さない——**判断が流れる配管と記録を決定的にする**。

## 決定

### 1. driver `scripts/meta-loop.mjs`（inner-loop と同族・read-only）

状態機械: **SCOPE → GROUND → DIAGNOSE → REPORT**。各 stage は headless agent 実行＋`VERDICT: <TOKEN>` 契約（inner と同じ verdict-guard hook の保護下）。**MERGE 段は存在しない**（meta は書かない）。

| stage | verdict | やること | 契約の要点 |
|---|---|---|---|
| SCOPE | SCOPED \| ESCALATE | 起動理由（cadence / escalation クラスタ / PdM 指示）＋プロファイルから監査計画（対象×接地面×問い）を確定 | **問いは 1 run に 1 つ**（全バッテリー禁止）。計画は manifest に記録 |
| GROUND | GROUNDED \| ESCALATE | lathe MCP で段階開示（triage→背骨→生）。重い/並列は fan-out | 生 DB/SQL 禁止（MCP のみ）。fan-out は §4 の契約形式 |
| DIAGNOSE | DIAGNOSED \| ESCALATE | evidence を §結果分類 13 行へ写像。出所確認（blame・gate 再現）。任意で adversarial verify | **行 13（価値判断）と行 3/13 境界の不明は分類せず ESCALATE**（発明しない） |
| REPORT | REPORTED | finding（keep/improve/fix・優先度・観点・具体策・根拠座標・確信度）＋**判断記録** | 成果物は `.lathe/meta/<run>/report.md` と `findings.json` のみ |

### 2. 実行環境と read-only の機械強制

- **agent の cwd は使い捨て worktree**（main HEAD から作成・終了後に削除）。inner と同じ封じ込め方式: blanket Bash を許しつつ、迷い書き込みは worktree に閉じ、`git status` 照合で検出可能。**manifest と report は driver が main 側（`.lathe/runs/` / `.lathe/meta/`）へ書く**（agent は書かない——receipt を driver が刻む inner の方式と同型）。
- stage 権限（`stagePermissions` 同型）: 全 stage `permissionMode: dontAsk`・Write/Edit 不許可・Bash は GROUND/DIAGNOSE のみ blanket（MCP・git 読み・run.mjs 再現のため）。SCOPE/REPORT は Read/Grep/Glob＋narrow Bash。
- backend 既定は **claude**（lathe MCP 接地が必須のため。headless claude が repo の `.mcp.json` から lathe MCP を掴めることを実装時に検証——掴めない場合は GROUND のみ claude 対話相当へ escalate し、本 ADR に追記）。

### 3. 監査プロファイル `scripts/meta-profiles/<id>.json`

プロファイル＝関心の宣言（データ）。driver は共有機構。形式:

```jsonc
{ "id": "run-health", "version": "1",
  "target": "inner/plan loop の運行",
  "grounding": ["mcp:list_runs", "mcp:get_run", "mcp:list_sessions", "file:.lathe/runs/*.escalation.md"],
  "questions": ["escalation 率と再発パターン", "差し戻し cycle の分布", "invalid（判定不能）の頻度と帰属", "stage cost の逸脱"],
  "cadence": "10 run ごと、または escalation 3 連続時",
  "depth_budget": "suspect 上限 5・fan-out 上限 4" }
```

初期 2 本: **run-health**（上例）と **gate-effectiveness**（rubric/verifier/eval の効き・judge 校正・bindings --report の stale/宙に浮き棚卸し。cadence=rubric 改訂後＋週次）。cost 監査は run-health に畳む。プロファイルの検証は driver 起動時の必須フィールド検査（専用 schema gate は本数が増えたら＝ratchet）。

### 4. fan-out 契約（GROUND 段）

sub-agent への委譲を口頭運用から形式化する。**渡す**: `{対象(run_key|session_id), 問い, 接地面, 深さ上限}`／**返す**: `{問題の要旨, 根拠座標(run_key+stage | session_id+seq), 仮説, 確信度(high|med|low)}`。逸脱形式の返答は GROUND agent が破棄して再依頼（1 回まで）。inner の「ネスト subagent 禁止」（X1）は**回避目的のネスト**の禁止であり、meta の fan-out は同一 read-only 権限での並列探索＝目的が異なることを明記。

### 5. manifest（dogfooding の入口）

driver が `.lathe/runs/meta-<profile>-<通番>.json` に stage/verdict/session_id/cost を記録（inner と同形式）。**companion issue**: runs ingest（ADR 0023）の loop_kind 判定に `meta-*` プレフィックスを追加（apps/web 変更＝inner loop へ起票）。これで **meta 自身の run が lathe に載り、run-health プロファイルが meta-loop 自体も監査対象にできる**（自己適用）。

### 6. `skills/result-classification`（新設・監査役が作成）

theory §結果分類 13 行の判別手順を DIAGNOSE 段の skill にする。内容: 13 行の表＋判別手順（証拠→行の順で当てる）＋行 3/13 境界規則＋**「機械判定しない・判断を必ず記録する」条項**。grounded_in は `[]`（根拠は外部 theory＝lathe rubric に正本が無いことを明示）。外部空間なので作成・改訂は監査役のみ（#57）。

### 7. 癒着の分離（設計正本 §3.3 の授権）

- 効果測定は meta の仕事から**除外**（Assurance eval の関心。別 ADR）
- meta の出口は finding まで。**submit_finding / issue 起票 / rubric 更新は行わない**——findings.json を ACT 系（監査役・改善起票 loop）が読んで実行する。lathe の findings 採否フロー（submit_finding）への接続は採否 UX 決定後の別判断（設計正本 §6 の未決）

## 受け入れ条件

`evals/meta-detection-v1.md`——実履歴 43 run に対する run-health 初運用で、既知問題 5 系統中 4 以上を検出・当時の実裁定と一致する分類・判断記録と座標の完備・read-only 遵守・manifest 生成。

## 実装順序

1. 本 ADR 承認 → 監査役: `skills/result-classification`・プロファイル 2 本を作成（外部空間）
2. inner loop へ起票: (a) driver `scripts/meta-loop.mjs`＋テスト、(b) ingest の meta プレフィックス追随（小粒）
3. **初運用 = eval の負荷実行**: run-health を実 43 run に当て、eval の criteria を照合して通過記録
4. gate-effectiveness の初運用 → プロファイルの手直し（実データからの改善）
5. その後の別 ADR: Assurance 運用（移行 7 条件の具体化）／findings 採否 UX／ACT 系の工学化（感知の実証後）

## 却下した代替

- **関心別に agent を即分割**: harness 面が N 倍・安定した切れ目が未知の段階での分割は premature（集約境界は「同時に変わるべき範囲」で切る）。プロファイルの成長が実需を示した時に昇格。
- **委任状を広いまま staged 化だけする**: SCOPE 段が「1 run 1 問い」を強制しなければ、モデル任せの scope 選定が残る（as-is 問題 (a) が未解決）。
- **meta に書き込み権限（rubric 修正・起票まで）を持たせる**: 感知と ACT の混同は診断の独立性を壊す（reviewer と implementer を分けたのと同じ理由）。ACT の工学化は感知の実証後。
- **合成 fixture での eval**: 実履歴に既知問題と当時の正解裁定が揃っており、合成より安く・厳密で・現実的。

## スコープ外

- Assurance 運用の設計（効果測定の行き先）／findings 採否 UX／submit_finding 接続
- ACT 系 3 loop の工学化／プロファイル専用の schema gate（本数増加時の ratchet）
- 製品化（vision 骨子 = task:vision-kokkuchi で別途。本 ADR の機構はその仕様前駆）
