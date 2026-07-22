
---

# §7 未決の裁定点と、あなた（外部分析者）への問い

## 7.1 未決の裁定点

最上位: **D-0 製品戦略** — lathe は「駆動を所有する製品」（loop 実行そのものが観測・改善対象 = 自系で閉じる）になるか、「駆動を外部化し統治と観測に徹する製品」になるか。この選択だけが他の全軸（保証の所有権・依存・観測・可逆性）の重み付けを決める。以下の決定木・裁定分解は §5 末尾（決定木）と §6 末尾（Step 0 実測リスト）に収載。

主要な下位裁定: エンジン選定（Temporal self-host / DBOS / Postgres queue＋自前薄層)・観測劣化の受容可否（実測照合済み: cloud 実行の劣化観測では本書 §2 レベルの診断は再現不能)・権能分離の実現手段（agent に書き込み credential を持たせない構造をどう作るか)・GitHub 上の承認面の形（label / 盤面 / 専用 UI)・基盤の置き場（製品 repo 内か独立 repo か）。

## 7.2 外部分析者への問い

1. **根因診断への反証**: 「事故の主因は、分散した状態を非トランザクショナルな他人のサイト上に置き、短命プロセス群で高速ループを回したこと」という診断（§4・§6）に、見落としや別解釈はあるか。26 incident の分布（§2）を別の単一原因でより良く説明できるか。
2. **D-0 の判断軸**: 「駆動を所有する」vs「駆動を外部化する」の二択の重み付けで、本書の戦略 5 軸（保証の所有権・依存の非対称性・観測の主権・製品戦略・可逆性）に欠けている軸はあるか。
3. **エンジン選定の適正規模**: 個人＋agent 群・数十 task/日という規模に対し、Temporal self-host / DBOS / Postgres queue＋自前薄層はそれぞれ overkill / underkill か。判定の基準は何であるべきか。
4. **GitHub 再設計案の盲点**: 「1 task 1 PR は維持・状態機械は追い出す・承認は label または専用 UI・issue は人間の読み物」という再設計（§4・§5）の見落としは何か。
5. **体制固有のリスク**: 「設計・実装・レビュー・運用を LLM agent が担い、人間は承認のみ」という体制に固有のリスクで、本資料が未対処のものは何か。特に: 自己申告の連鎖（agent が agent の報告を検証せず中継する — 本運用で 3 回実際に起きた)・bus factor 1・統治違反（承認なしの行動 — 9 件実績）の構造的抑止。
6. **段階移行計画の危険点**: Step 0（仕様の実測 spike・1〜2 日）→ PoC（実 task 1 件の無人一巡を 4 点機械検収）→ 段階展開、という計画（§6 末尾）の危険点はどこか。特に新旧システムの併存窓（旧排他と新排他が互いを見えない期間）の扱い。
7. **資料自体の品質**: この分析を行う上で、本資料に不足している情報は何か（それは今後の観測設計の欠陥リストとして使う)。

---

# 付録 A: 用語集（本文で使う内部用語）

| 用語 | 意味 |
|---|---|
| PdM | 人間のオーナー 1 名。承認・裁定・vision のみ担当 |
| 監査役 | outer 側の主 agent（本書の編纂者)。監視・issue 化・rubric 管理・escalation 対応を担う |
| inner / outer | inner = task を実装する自動ループ側。outer = それを監督する人間＋監査役側 |
| task / issue | GitHub issue がそのまま task（1 task = 1 issue)。状態は保存せず GitHub から毎回導出する原則だった |
| driver | 1 つの task を plan→審査→実装→着地まで進める実行プロセス（自作 node スクリプト群) |
| orchestrator | 5 分ごとに全 issue を分類し driver を起動する常駐プロセス |
| stage | driver 内の段（TASK_PLAN / PLAN_REVIEW / IMPLEMENT / LAND_REVIEW 等) |
| verdict | 各 stage の agent 出力末尾の機械判定トークン（PLAN_READY / PASS / RED / CHANGES / IMPL_DONE 等) |
| plan 契約 | plan が必ず持つ 6 セクション構造（問題/選択肢/方針/契約/検証/見積り)。見積り過小は差し戻し |
| rubric | コード規範の台帳（48 本)。決定的検査（grep 等）と agent-judge（LLM が違反数を数える）の 2 種 |
| agent-judge | rubric のうち機械式で書けない規範を LLM に判定させる検査器 |
| escalation | agent が自力で進められない時に人間の裁定キューへ差し戻す仕組み。文脈不足/環境起因/意思決定の三分岐（triage） |
| needs-review | 人間の承認が必要な task に付く label。教材生成→承認待ちのレールに乗る |
| 盤面 / Ready 列 | GitHub Projects のかんばん。人間が task を Ready 列に動かす = 承認、という規約 |
| 教材 / explain | 承認判断のために自動生成される解説文書（GitHub Discussion に投稿) |
| worktree | git worktree。実装は必ず隔離 worktree で行い main は単一 writer とする規律 |
| 検収 4 点基準 | 基盤切替の完了条件: 実 dispatch 1 件で ①子プロセスの生存 ②agent 応答 ③成果物の期限内出現 ④成功記録、の機械照合 |
| 版固定 / harness-release | 走行中の loop を loop 自身に改修させず、改修は版として一括実装・切替する規約（ADR 0036) |
| silent death | 子プロセスが痕跡ゼロで死に、システムが異常を報じない事故クラス |
| dispatch | orchestrator が task に対して実行プロセスを起動すること |
| manifest | 各 run の段別記録ファイル（所要・費用・判定・出力)。本書の実測の一次資料 |
| lathe | この開発基盤が属する製品。agent 開発の観測・改善・評価のプラットフォーム（transcript ingest・コスト分析・UI） |
| routines | Claude Code のクラウド自動実行機能。schedule / GitHub イベント（label 条件つき）/ API で発火し、ベンダー管理のクラウドで agent session を実行する |
| durable execution | workflow の状態・タイマー・再試行・生存監視をエンジンが永続的に保証する実行モデル（Temporal・DBOS 等) |
