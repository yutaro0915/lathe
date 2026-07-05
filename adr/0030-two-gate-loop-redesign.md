# ADR 0030: loop 体系の再編 — 2 ゲート原則（入口 intake・出口 PR+CI）と task への一元化

- status: accepted（2026-07-05 PdM 裁定。as-is 全体図レビューの壁打ちで各項を個別承認）
- date: 2026-07-05
- 関連: ADR 0025（task 基盤）／0026（単一着地ゲート・簡素化原則）／0027＋追記（intake＝判断ゼロの登記機械）／0028（無人着地）／0029（起票の唯一 UX）／[design/loops.md](../design/loops.md)／[design/plan-format.md](../design/plan-format.md)

## 背景（as-is レビューで確認した問題）

`.lathe/reports/dev-machinery-as-is-2026-07-05.html` を PdM がレビューし、以下を確認した。

1. **起票経路が 3 本ある**（intake／plan-loop の直接 `backlog task create`／前進 loop の手起票）。
   ADR 0027 の単一 writer 宣言と矛盾し、plan 通過も直列性も保証されない
2. **plan が二重に存在する**——plan-loop（issue 起点）と task loop 内 PLAN 段が重複
3. **1 run が長すぎる**——6 段を 1 本で完走。途中成果物がログしかなく、失敗の切り分けが
   困難で、比較実験ができない粒度
4. **ゲートが二重**——merge.mjs（receipt 検査＋backstop）と PR+CI の同居（移行残り）
5. **escalation がブラックボックス**——判断主体が 3 箇所（agent verdict／driver チェック／
   TRIAGE）に分散し、成果物は分類も調査結果も無い状態ダンプのみ
6. **設定のハードコード**——MAX_CYCLES 等が driver 内に散在
7. **hotfix が定型の成果物を残さない**——調査・計画の記録なしに着地し得る緊急路
8. **rubric 改訂に検証プロトコルが無い**——効果を予想と照合する比較実験の不在
9. **命名の混線**——「inner loop」が family 名と個別 loop 名を兼ねる

## 決定

### 0. 原則: ゲートは 2 つだけ

系の強制点は**入口 = intake**（task の唯一の発生点）と**出口 = PR + CI**（main の唯一の
入口、ADR 0026 §1）の 2 つ。その間にある作業単位は**すべて task** であり、loop の種類とは
task の型のことである。強制はこの 2 点の機械（Action / CI / branch protection）に集約し、
中間段に独自の強制機構（receipt 類）を作らない。

### 1. 起票の完全一本化（0027 §3／0029 §1 の完遂）

全経路（前進・感知・裁定・hotfix・plan-task の子出し）の終端は **issue 投函
（`task-request`）**に統一する。plan-loop の ISSUE_CREATE 段による直接
`backlog task create` は廃止（TASK-25 で PdM 温存とした (c) の裁定）。
機械担保として、**`backlog/tasks/` への新規 task ファイル追加を含む PR は intake 由来
以外を CI が拒否**する（task-id-unique check＝TASK-19 の拡張。status/notes 等の既存
task 編集は従来どおり可）。

### 2. plan の task 化 — plan-loop と PLAN 段の廃止

- intake は**却下ゼロのまま**、構造で振り分ける: 本文が plan-format の必須節
  （問題／方針／検証）を備え §5 の粒度規準内なら**実装 task**、それ以外は
  **plan-task** として登記する（差し戻し・却下はしない。判断ゼロは変えない）
- **plan-task** の終端は「plan の確定＋子 issue の投函」（intake へ還流）。
  実装・main への着地は終端に含まれない
- これにより issue 起点の独立 plan-loop と、task loop 内の PLAN 段は**両方廃止**。
  「すべての task は plan を持って生まれる」が構造で保証される

### 3. task loop の縮退 — ローカル段は IMPLEMENT → PR 作成のみ

- review = **PR 上**（TASK-16 で移行済みの方式を正式化。auto-merge の arm は
  reviewer PASS 後——単一アカウントでは required review にできないため駆動側の順序で
  担保し、逸脱は meta が検出する）
- verify(tier=test) = **CI**。TRIAGE 段は廃止（§4 の escalation 一元化に吸収）
- **merge.mjs は解体**する。receipt 検査・backstop（CI と完全重複）・landing lock
  （GitHub が直列化を担う）を削除し、残る push / `gh pr create` / auto-merge arm は
  driver が直接実行する（TASK-21 の receipt 物理削除と連続）
- heavy 検証（e2e・judge）はローカル宿題のまま維持（機能は落とさない。CI 昇格は
  TASK-22／#69 系で再訪）

### 4. escalation の一元化と調査書

escalate するか否かの規則は**駆動側の関門（段の verdict 判定点と CI 結果）だけ**が持つ。
agent は成否と**定型調査書**（何を試したか／何が失敗したか／仮説／切り分けの次の一手）を
返すのみ。escalation.md は現行の状態ダンプに調査書を加えた形とし、lathe に ingest して
裁定 loop の一次資料にする。

### 5. task の粒度規準

task は「**人間が数分（理想 1 分）で完全に理解できる範囲**」に閉じる。
plan-format.md の scale rules に分割規準として明文化し、plan-task はこの規準まで
分割してから子 issue を出す。粒度の細かさは §6 の比較実験・失敗切り分け・レビュー精度の
前提条件である（1 行単位まで刻む趣旨ではない——分離して意味が保てる最小単位）。

### 6. rubric 改訂 = 比較実験

rubric／skill 改訂の受け入れ条件を「**同一 task 集合で改訂前後を走らせ、事前に宣言した
予想差分が観測されること**」とする（evals/ の思想の延長）。予想と結果の照合を改訂 PR に
記録する。

### 7. hotfix の同形化

harness-hotfix も **issue → intake → task → PR+CI の同形**とする。通常 task との違いは
優先 label と PdM の同期承認のみ。調査・計画・実装が通常 task と同じ形で記録される
（「よくわからないものが緊急路から着地する」穴を塞ぐ）。loops.md の緊急路定義を改訂する。

### 8. 設定の集約

driver の運用パラメータ（サイクル上限・リトライ等）はハードコードをやめ、単一の設定
ファイルに集約する。

### 9. 命名整理

「inner loop」を family 名と個別名に兼用しない。個別 loop 名 = **task loop／plan-task／
感知（meta）**とし、loops.md を改訂する。

## 却下した代替

- **LangGraph 等の既製 agent ハーネスへの乗り換え**: 現在の痛点（verdict parse・worktree
  規律・gate 連携）はドメイン固有でフレームワークは解決しない。§3 の縮退で driver から
  receipt／merge／起票コードが消えた後に、残った状態機械を見て再評価する
- **必須フィールド未達の issue を却下**: 却下ゼロ原則（0027 追記／0029)を維持。plan 無しは
  却下ではなく plan-task への振り分けで吸収する
- **provider 非依存化の前倒し**: 意図的 deferral を維持（2026-07-02 PdM 判断、
  agent-workflow.md 末尾）。問題が出てから

## 実装（依存順・task-request として投函）

1. **intake 拡張と起票一本化**——構造振り分け（実装 task／plan-task）＋ plan-loop の
   ISSUE_CREATE 廃止＋ backlog/tasks/ 新規追加の CI 機械拒否（§1, §2 前半）
2. **merge.mjs 解体**——driver 直呼びへ（§3。TASK-21 と連続）
3. **task loop 縮退**——PLAN／TRIAGE 段削除・plan-task 型の導入（§2 後半, §3）
4. **escalation 調査書と ingest**（§4）
5. **設定集約・粒度規準の明文化・loops.md 改訂**（hotfix 同形化・命名、§5, §7–9）

影響を受ける文書: design/loops.md／plan-format.md／agent-workflow.md／
outer-loop-family.md。as-is HTML は本再編の着地後に全面改稿する。
