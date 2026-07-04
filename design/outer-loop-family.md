# outer loop family — 整理（as-is 診断と to-be 設計）

- date: 2026-07-04（PdM との壁打ちで確定した骨子。実装は本書を仕様前駆として各 ADR で授権する）
- 位置づけ: [design/agent-workflow.md](./agent-workflow.md)（開発フロー正本）の outer loop 側を分解・詳細化する。inner loop（ADR 0013〜0016）と対をなす
- 関連: theory（edd-theory）§結果分類・§関係の管理／ADR 0017（tool-loop）／ADR 0023（runs 一級化）
- 将来との関係: 本設計は lathe 製品再定義（vision 骨子＝別タスク task:vision-kokkuchi）の下で**製品機能の仕様前駆**になる見込み。ここでは開発運用の設計として書く

## 1. 全体図（to-be）

outer loop は単一のループではなく、目的別の family である。**判断（人間・モデル）は消さず、判断が流れる配管を決定的に作る**。

```
outer loop family
├─ 感知・診断系
│   └─ meta-loop: 観測 → 類別 → 診断 → 方針（finding）まで。read-only
├─ ACT 系（書き込み権限を持つ）
│   ├─ artifact 更新 loop: rubric/eval/skill/harness を整合機械の下で更新（監査役単独 writer・#57 境界）
│   ├─ 改善起票 loop: finding（code 由来）→ issue → inner（PdM 規律 = pdm-issue-filing）
│   └─ 裁定 loop: inner の escalation → §結果分類で routing → 更新/起票/PdM へ
├─ 前進系（機能を生む）
│   ├─ 入口チャネル: PdM 対話 ／ vibe 注釈 ／ ROADMAP・phase 分解
│   └─ plan-loop: needs-plan → 承認ゲート → 実装 issue 群（実装済み・#43 で実証）
└─ 検証系（持続）
    └─ Assurance 運用: 獲得能力の保存を eval の回帰検出で担保（meta から分離した「効果測定」の行き先）
```

- **meta は family の一員にすぎない**。目的＝開発システム（rubric/eval/skill/harness と loop 運行）が効いているかの検証と問題の診断。**finding を出すまでが仕事**で、実装・更新・起票は ACT 系が担う。
- ACT 系の整合は EDD 基盤（前線 A〜D）が機械で守る: bindings-lint（結線破壊の検知）・schema gate・exemptions の構造化・selection golden。**EDD 基盤とは「更新 loop が安全に書くための装備」である**。
- 前進系は machinery 完成済み（承認ゲート #59・plan-loop・複数 issue 起票 #50）。vibe 注釈は入口チャネルの一つ（注釈＝明示指示の standing authorization は hub 正本）。
- 未工学化で残るのは **meta-loop** と **Assurance 運用** の 2 つ。

## 2. meta の as-is 診断（なぜ「モデル任せ」に感じるか）

| 実際にやってきたこと | 本来の分類 | 問題 |
|---|---|---|
| cost / loop 非効率の掘削（meta-audit R1） | 感知・診断 ✓ | 本業。ただし「何を見るか」の選定が run ごとにモデルの気分 |
| gate の穴の検出（R2 X2: unit-tests scope 欠落） | 感知・診断 ✓ | 本業 |
| 前回 fix の効果測定（R2: nested subagent 3→0 等） | Assurance 的検証 | 別の関心が癒着。「能力の保存確認」は eval の役割 |
| bindings stale queue の消化（skill に追記された定常業務） | 定期の衛生検査 | cadence が違う（rubric 改訂ごと）。sweep 型監査に癒着 |
| escalation 裁定・rubric 直接修正・issue 起票 | **meta の仕事ではない**（outer セッションが実施） | 会話上 meta と混同されがち。書き込みは全て meta の外 |

構造問題は 3 つ:
1. **委任状が無限**（「問題点を探る。狭めない」）→ scope 選定がモデル任せになる根因
2. **cadence の違う関心の同居**（stale=改訂ごと / cost=週次 / gate の効き=N run ごと）
3. **meta 自身に manifest・eval・gate が無い**——inner の run は receipt/manifest で説明可能なのに、meta の run は透明性ゼロ（判断が記録されず、#31→#60 の同型誤検出を 2 回踏んだ）

## 3. meta-loop の to-be（共有 driver × 監査プロファイル）

分割の原則は EDD の集約境界（意味でなく**同時に変わるべき範囲**で切る）。機構は 1 つ、関心はデータ。rubric が要求クラスだけを宣言し judge-runner が束縛を持つのと同じ**名前結合**。

### 3.1 stages（driver: `scripts/meta-loop.mjs`、inner-loop と同族・read-only）

| stage | 入力 | やること | 出力 | 契約 |
|---|---|---|---|---|
| **SCOPE** | 起動理由（escalation / 定期 cadence / PdM 指示）＋プロファイル | 監査計画の確定（対象 × 分析型 × 接地面） | 監査計画 | 全バッテリー禁止。問いは 1 run 1 つ |
| **GROUND** | 監査計画 | lathe 接地で evidence 収集。段階開示（triage→背骨→生）。重い/並列は fan-out | evidence 束（座標つき） | fan-out 契約（下記）。read-only |
| **DIAGNOSE** | evidence 束 | theory §結果分類 13 行への写像。出所確認（blame/再現）。任意で adversarial verify | 分類済み finding 候補＋確信度 | 行 13（価値判断）は分類せず人間へ。発明しない |
| **REPORT** | finding 候補 | finding 提出＋**判断の記録**（なぜその行・その対象か） | finding（keep/improve/fix＋優先度＋観点＋具体策＋根拠座標）＋判断記録 | read-only を最後まで維持。ACT は family の別員 |

- stage 権限は inner の `stagePermissions` と同じ機構で機械強制する（Write は `.lathe/meta/` と判断記録先のみ、等）。
- **fan-out 契約**: sub-agent へ渡す形式（対象・問い・接地面・降りてよい深さ）／返す形式（問題・根拠座標・仮説・確信度）を定義し、口頭運用をやめる。
- **manifest**: `.lathe/runs/meta-*.json`（`loop_kind='meta'`）に stage/verdict/cost を記録 → 既存 ingest（ADR 0023）で lathe に載る＝**meta 自身が lathe の観測対象になる（dogfooding の入口）**。

### 3.2 監査プロファイル（初期 2 本）

| プロファイル | 対象 | 接地面 | 問いの型 | cadence |
|---|---|---|---|---|
| **gate-effectiveness** | rubric / verifier / eval の効き | receipts・run.mjs 結果・bindings --report・judge 判定履歴 | false GREEN/RED は無いか・judge は校正されているか・stale/宙に浮きの棚卸し | rubric 改訂後＋定期 |
| **run-health** | inner/plan loop の運行 | runs/run_stages・escalations・sessions（cost/turn） | escalation 率・差し戻し cycle・invalid 率・stage cost の逸脱は無いか | N run ごと＋escalation クラスタ時 |

- cost 監査は run-health に畳む（最初から分けない）。プロファイルが固有の機構を要求し始めたら、その時に別 agent へ昇格（分割の判断を実需に遅延）。

### 3.3 癒着の行き先（分離の明文化）

- **効果測定 → Assurance eval 化**: 「直った」の持続確認は eval の役割変化（theory §Development→Assurance、移行 7 条件）で保存する。meta はやらない。
- **stale queue → gate-effectiveness の定常項目**（cadence 独立）。
- **裁定・更新・起票 → ACT 系**: meta の出口は finding まで、を契約に明記。

## 4. gap list（存在せず、作るもの）

| # | 作るもの | 中身 | 備考 |
|---|---|---|---|
| 1 | `skills/result-classification` | theory §結果分類 13 行の判別手順 skill。機械判定はしない・判断を記録する | grounded_in で結線。行 3/13 境界規則を含む |
| 2 | fan-out 契約 | GROUND 段の sub-agent I/O 形式の定義 | 今は口頭運用 |
| 3 | meta manifest | `loop_kind='meta'` の run 記録＋ingest 追随 | ADR 0023 の器に乗る |
| 4 | meta の Development eval | 例: 既知の埋め込み問題（合成した gate の穴・非効率）を検出できるか、を S/C/Y で | eval が meta-loop 実装の前線を駆動する（B の型） |
| 5 | driver `scripts/meta-loop.mjs` | SCOPE→GROUND→DIAGNOSE→REPORT・stage 権限・プロファイル読み込み | inner-loop.mjs の機構を流用 |
| 6 | finding 品質 gate | meta の finding に対する gate | 既存 `findings/no-generic` が種（scope 拡張 or 同型新設） |

## 5. 実装順序（各段で ADR）

1. **meta-loop ADR**（stages・権限・プロファイル・manifest・eval を授権）→ 実装は worktree 委譲・監査役着地
2. 初回実運用: run-health プロファイルをこの 2 日の runs（43 run）に当てる＝**dogfooding 開始点**
3. Assurance 運用の ADR（移行 7 条件の lathe 具体化・最初の昇格候補の選定）
4. ACT 系の工学化は**まだやらない**——感知側で分類の質と記録の規律が実証されてから（書き込み権限を持つ側を先に自動化しない）

## 6. 未決（PdM と詰める）

- SCOPE の能動 cadence の具体値（N run ごとの N・定期の周期）
- finding の採否 UX（lathe の findings 採否フローに載せるか・当面 issue/comment か）
- meta-loop と製品再定義（vision 骨子）の合流点——本書の機構がそのまま製品機能になる場合の画面・API の要件
