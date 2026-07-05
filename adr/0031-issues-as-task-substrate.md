# ADR 0031: task 正本を GitHub Issues へ — 状態の導出・Backlog.md 廃止・盤面 = Projects

- status: accepted（2026-07-05 PdM 裁定。壁打ちで 3 点構成を承認）
- date: 2026-07-05
- 関連: ADR 0025（実質巻き戻し）／0026（単一着地ゲート・簡素化原則）／0027＋追記（intake）／0028（無人着地）／0029（起票の唯一 UX）／0030（2 ゲート原則）

## 背景

ADR 0026/0028 の単一着地ゲート＋branch protection 有効化（TASK-22）で、**帳簿の維持費構造が
変わった**。task の status 1 つを動かすにも PR+CI が必要になり、task 1 本のライフサイクルで
3 回以上の「帳簿 PR」が走る。さらに worktree ごとに backlog/ のコピーが存在するため、
どこで編集しても同期問題が残る（2026-07-05、main worktree 上の未コミット backlog 編集が
FF を黙って失敗させ、手元 main が 4 commit 遅れた事故）。

根本原因は置き場所ではなく、**git/GitHub が既に知っている事実を repo 内ファイルへ二重記録
していること**。ADR 0025 採用時は main 直コミットが可能で帳簿の維持費はゼロに見えた——
前提が変わった以上、決定を見直す。

## 決定

### 1. task の正本 = GitHub issue（TASK-N = issue #N）

task の実行単位・正本を GitHub issue そのものとする。**issue 番号がそのまま task ID**。
ADR 0027 が単一 registrar を置いた理由は採番の直列化だったが、issue 番号は GitHub が
最初からサーバー側で直列採番している。**2 ゲート原則（ADR 0030 §0）の「入口」は
issue 作成そのもの**が担う。

### 2. 状態は保存せず導出する

- **To Do** = open issue（`task` 系 label）／**In Progress** = その issue を参照する PR が
  open／**Done** = PR merge で issue close。status の書き込みという操作自体を廃止する
- 保存するのは**導出できないものだけ**: plan 本文 = issue body、裁定・申し送り =
  issue comment（時刻・帰属つき）、needs-plan／escalation／優先度 = label
- 依存関係は body の blocked-by 記法（`blocked-by #N`）を driver／engine が読む

### 3. Backlog.md と backlog/ の廃止

- Backlog.md CLI・MCP・`backlog/` ディレクトリを廃止する
- **intake Action の「issue → backlog task の写し」と採番は役割終了**（直列化は GitHub 採番、
  振り分けは label。ADR 0027 の登記機械・0029 §1 の「backlog task create は intake のみ」は
  本 ADR で置換）。却下ゼロ原則は不変（issue はそのまま task になる）
- task-id-unique CI check（TASK-19 成果物）は対象消滅につき削除

### 4. 盤面 = GitHub Projects v2（ビューであって帳簿ではない）

PdM の盤面は GitHub Projects v2。これは**同じ issue 群へのビュー**であり同期が存在しない
（無料・board/table/roadmap・close→Done の自動 workflow・`gh project` CLI）。盤面の
フィールド操作（列・優先度・milestone）は PdM の triage 空間であり、**機械は labels と
issue 状態のみを読む**（Projects フィールドを機械の入力にしない）。

### 5. ADR 0026 §4「repo の外に情報を置かない」の解釈

禁止の趣旨は**観測不能・履歴なしの置き場**（セッション記憶・ローカル memory）である。
GitHub の issue／PR／label は観測可能・履歴付き・ingest 可能な substrate であり、正本たりうる
（現に intake も PR 連携 G1 もそこにある）。

### 6. 観測面の宿題

issue イベント（作成・label・comment・close）の lathe ingest を実装課題として起票する
（G1 PR 連携の延長）。将来的に lathe UI が盤面になる選択肢はこれで開く（今は scope 外）。

## 却下した代替

- **MCP を自宅サーバーで常駐させ SSOT にする**: サーバー運用・障害対応・認証という新規負担。
  「機構は追加より削除」（0026 §0）に逆行
- **外部 SaaS（Linear／Trello／Notion 等）を GitHub と双方向同期**: 帳簿が再び 2 冊になり、
  今回消した同期問題を輸入する。無料枠制限も付く
- **現状維持＋運用規律**: worktree コピーがある限り事故は再発する

## 影響と移行

- ADR 0025 の実質巻き戻し（前提の変化 = 帳簿維持費の構造。0025 の「task に plan/AC を持たせる」
  思想は issue body 上でそのまま生きる）
- **TASK-29〜33 は着手禁止**。移行後に issue 上で再定義する（ADR 0030 の決定内容自体は不変。
  実装の substrate だけが変わる）
- 移行 task（task-request として投函）: open task の issue 化（intake 由来のものは元 issue の
  reopen で可）→ `backlog/` 削除 → intake Action の写し機能停止 → task-id-unique check 削除 →
  driver の backlog 結線除去（TASK-33 の縮退書き直しと統合可）
- loops.md／agent-workflow.md／runbook の追随（intake 行・起票手順・status 記述）は
  再定義後の文書 task に含める。as-is HTML の to-be 章は本 ADR 分の改稿を全面改稿時に併合
