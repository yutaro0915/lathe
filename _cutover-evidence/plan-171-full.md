issue #171 / stage: PLAN

以下の needs-plan issue から、実装 task として投函できる子 issue 群の plan を作成してください。

## source issue #171: 実行基盤の自宅サーバー集約 — driver・engine・応答 runner を home server の Claude Code に一元化
## 問題（将来トラック・PdM 構想 2026-07-07）
現在 driver（inner-loop）は PdM のローカルマシンで動く。engine（#128）も同様の想定。実行がローカル依存だとマシンが閉じている間は系が止まり、実行環境も分散する。

## 方針（骨子・plan-task で詰める）
- 自宅サーバーの Claude Code に実行を集約: driver・review engine・（必要なら）解説 loop runner・@claude 応答も同居可能
- 認証: サブスク（claude setup-token または server 上で claude login）・gh auth
- **本丸は観測面の接続**: transcript がサーバー側 ~/.claude に落ちるため、lathe ingest をサーバーで回すか手元へ同期するかの設計が必要（lathe DB の所在も含む）
- 発火: cron（needs-plan/実装 task の polling・review 待ち polling・needs-explain polling を同じ基盤に載せられる）

## 依存
#116（driver 復活）・#128（engine）・#117（escalation）の着地後。修理チェーンと独立に設計だけ先行してよい（needs-plan）。

## 裁定・申し送り（issue comments）
### yutaro0915 — 2026-07-07T04:10:00Z
**PdM 追加構想（2026-07-07・plan で必ず扱うこと）**:
1. **ローカル開発との統合**: サーバー集約後もローカルマシンで開発する需要は残る。両拠点で loop を回せる前提で、実行の取り合い（同一 task の二重着手）を防ぐ設計が要る——ADR 0031 の導出 status（参照 PR open = In Progress）が自然な排他になるか、明示 claim が要るかを詰める
2. **issue の実装 block 機能**: 特定 issue を driver/queue に拾わせない明示的な hold（label 例: `blocked` / `hold`）と、既定義の `blocked-by #N` 依存解決の両方。導出 status と同じく機械が読むのは label/参照のみ
3. **lathe 本丸のサーバー常駐＋ローカルからのテレメトリ送信**: lathe（web + Postgres）をサーバーで動かし、ローカルの transcript/実行記録は push ingest で送る。既存の push 主・pull 補 ingest（lathe-client init + notify・token 認可）がそのまま土台になる想定——サーバー側 ingest との統合方式を plan で確定

### yutaro0915 — 2026-07-07T08:14:21Z
解説教材を生成しました（explain-diff loop・直接要求）: https://github.com/yutaro0915/lathe/discussions/197

本丸である観測面（transcript / lathe ingest / DB の所在）を `design/observation-ingest.md` の (X)/(Y) と現行 ingest コード（`notify.ts` の allowlist・`discover-dirs.ts` の `os.homedir()` 走査）に接地し、集約後の ingest 所在 3 案（サーバ常駐 / 手元同期 / push 変種）を中立整理しています。正本: `explains/2026-07-07-issue171-home-server-consolidation.md`。

### yutaro0915 — 2026-07-07T13:24:00Z
**PdM 裁定（2026-07-07）**: 常駐先を確定 — **server『case』に orchestrator（inner loop driver 系）を常時常駐**させる。plan への追加要求:
- 常駐機構は case の init 系に合わせる（macOS launchd の plist は流用不可の想定 — OS/init 系・node/gh/claude の導入状態・認証手段（claude setup-token or login・gh auth）は**環境事実として plan が確認し、不明点は具体的な質問リストで escalation する**こと
- ローカル（Mac）併用時の排他は既記載の論点どおり（導出 status が自然排他になるか・明示 claim が要るか）
- lathe ingest 経路（transcript が case 側 ~/.claude に落ちる問題）は本 issue の既記載 3 点目を plan で確定

### yutaro0915 — 2026-07-07T13:26:57Z
**前提の全面更新（2026-07-07 夜・#201 再編後の世界に読み替え）— 本 comment が本文・旧 comment の記述を上書きする**

本文の「driver・engine・応答 runner を一元化」という枠は旧世界の部品構成。現在の実態:
- **常駐は 1 プロセスだけ**: `scripts/orchestrator.mjs`（launchd・5 分間隔・Mac 上で稼働中）。driver（inner-loop）・review engine・explain runner は**常駐ではなく orchestrator が毎パス spawn する仕事**
- したがって**移設対象は「orchestrator の常駐」1 点**＋その dispatch 先が動くための環境一式: repo clone・node/pnpm・gh 認証・claude 認証（サブスク）・**inner harness**（tracked .claude/ = #223 で純化済み・spawn の --settings pin = #224 が実装中）
- @claude 応答（Actions）は GitHub 側で稼働中 — case 移設の対象外
- 残る設計点（本文・既存 comment の有効部分）: ①case の init 系（systemd 想定）への常駐化 ②Mac との併用排他（導出 status で足りるか・orchestrator lock の単一化） ③**lathe ingest 経路**（transcript が case の ~/.claude に落ちる → lathe 本丸の常駐/送信の設計 = PdM 追加構想 3 点目） ④実装 block 機能（hold label）
- 環境事実（case の OS・導入済みツール・認証手段）は plan が確認し、不明は具体的質問で escalation

planner はこの comment を正として plan を生成すること。

### yutaro0915 — 2026-07-07T13:47:06Z
**PdM 裁定（2026-07-07・実機作業の実行方式）**: case 実機側の導入・構築は Mac から直接行わず、**SSH で case 上の Claude Code に task を渡し、case 側で gh repo・本 issue を読ませて実装まで完結させる**方式を採る。plan はこれを前提に分解すること:
- **Mac 側（repo 成果物・無人実装可）**: systemd unit・導入/検証 script・ingest 送信・handbook・および **SSH 越しの task 受け渡し機構**（例: `ssh case 'claude -p …'` の起動形・SETUP.md §6 と同型の最小権限指定）
- **case 側（case 上の claude が実行）**: 受け取った task による導入・構築・自己検証。case 側 claude の認証（サブスク）・gh 認証・repo clone の有無は**環境事実として質問可**（不明なら具体的質問リストで escalation）
- 到達性（ssh alias・鍵）も同様に環境事実扱い

本 issue はこの comment をもって PdM 承認済み — **Ready への移動は PdM の明示指示による監査役の代行**（この記録が承認の正本）。

### yutaro0915 — 2026-07-07T14:01:14Z
plan-task paused — PdM 判断が必要な選択肢に到達しました（escalation ではなく正常終端です。ADR 0030 追記 E）。

plan は完成しています。上に全成果物を出力済みです（子 issue 9 件の起票ブロック＝機械可読 3 行＋plan 本文、却下 3 件、PdM 裁定事項 D1–D3＋bootstrap 質問）。候補の処置漏れ・書式違反はなく、依存は後方参照のみ・トポロジカル順です。

残作業として、書式の自己照合結果のみ明示します（これで完了です）。

- 候補処置: 起票 9（plan#1〜#9）＋却下 3。silent drop なし。
- Blocked-by 検算（後方参照のみ）:
  - plan#1: none / plan#2: none
  - plan#3: plan#1
  - plan#4: plan#3, #224
  - plan#5: plan#3
  - plan#6: plan#4, #224
  - plan#7: plan#6
  - plan#8: plan#5
  - plan#9: plan#5, plan#6, plan#7
- 外部空間パス（`rubrics/`・`.claude/skills/`・`.claude/agents/`・`.claude/hooks/`・`design/test-failure-playbook.md`）の編集を含む子 issue は無し。
- 契約に触れる plan#1・plan#5・plan#2 は typedef／label 名／payload 不変を deliverable として明記済み。契約変更は ESCALATE と明記。

未解決の scope/phasing 判断（D1: ingest 所在、D2: 排他モデル、D3: 旧 body 依存の読み替え）と bootstrap 環境事実（ssh 到達性・claude/gh 認証）は、AGENTS.md の NEVER「工数・スコープ・フェーズ判断をユーザー指示なく行う」に該当するため、planner が独断で確定せず PdM 裁定に委ねます。これは escalation ではなく正常終端です。

## plan format（正本 design/plan-format.md。子 issue の plan 本文はこの規約に従うこと）

# Plan Format — PLAN 段の成果物規約（正本）

> status: adopted 2026-07-05（PdM 指示。契機: ADR 0025 manifest drift の事後監査——plan が型・インターフェース設計を要求せず、PdM が読んで判断できる形でもなかった）
> 適用: inner-loop PLAN 段の成果物すべて。PLAN prompt（`scripts/inner-loop-prompts.mjs`）がこの骨格を注入し、needs-approval の task は PdM がこの形式で読んで承認する。

## 原則

**plan は PdM の判断材料である。PdM が理解できない plan は通らない。**
plan は「何を・なぜ」まで。「どうやって」の詳細は implement の仕事（plan が implement を食わない）。

## スケール規則（過剰形式化の禁止）

| クラス | 例 | 要求 |
|---|---|---|
| **trivial** | 明確なバグ修正・数行・契約/構造に触れない | **軽量形**: 問題 / 修正方針 / 検証 の3行〜。承認不要（既存の「低リスク小変更は軽量 plan で可」を維持） |
| **standard** | 機能追加・複数ファイル・契約/構造に触れる | **完全形**（下記5セクション）＋ needs-approval なら PdM 承認 |

## 完全形の5セクション

1. **問題** — 何が起きているか・なぜ今やるか（2〜5行。座標付き）
2. **選択肢** — 検討した解決策（2つ以上）と却下理由、採用案を選んだ理由（各1〜2行。ミニ ADR）
3. **方針** — goal と概要**のみ**。構造に触るならモデル図・UML・インターフェース概形（ASCII 可）を必ず入れる。**ファイル別の詳細手順は書かない**
4. **契約** — 契約（型・schema・API 境界・artifact 形式）に触るなら、**typedef / schema そのものを deliverable としてここに書く**。implementer はこれを変更できない（変更が必要なら ESCALATE）
5. **検証** — AC との対応・回す gate/tier・「実 artifact の照合」が要る場合はその手順

## 設計原則（plan が示すべきもの・reviewer / PdM の却下基準）

- **深いモジュール**: インターフェースは狭く、ロジックは深く。**複数の関数を呼ぶだけの薄い糊層を新設しない**（契機: `appendManifestEntry` が path 関数と中身関数を別々に呼び、同一情報が2つの入口から入って片方だけ配線された事故）
- **同一情報の入口は1つ**: optional 引数（opt-in extra）で契約が切り替わる API を作らない。呼び忘れが型的・実行的に成立する設計は plan の段階で却下
- **契約は型で表現し、型は PLAN が決める**: implementer は宣言された型に合わせて書く。型を変えたくなったら実装せず ESCALATE（型 = 設計判断 = PLAN の管轄）

## 運用

- 違反 plan は PdM / reviewer が**このドキュメントを根拠に差し戻す**（散文根拠の明文化が本書の役割）
- この規約で再発が防げない場合の次段: rubric 化（機械 ratchet）を検討——ただし依存追加は慎重に（gate-effectiveness 監査で効きを測ってから）

## 出力契約

各 task は「人間が数分（理想 1 分）で完全に理解できる範囲」に閉じるまで分割してください（ADR 0030 §5。分離して意味が保てる最小単位まで。1 行単位まで刻む趣旨ではありません）。
検討した候補は必ず処置してください。処置は起票または却下の 2 種だけです。silent drop 禁止です。
- 起票: 候補ごとに 1 つの子 issue block を出力してください。複数 block 可です。
- 却下: `Rejected: <candidate> — <reason>` を 1 行で出力してください。

各子 issue block は以下の機械可読行 3 行で始めてください。
Title: <child issue title>
Blocked-by: #<n>, plan#<k>（依存が無い場合は "Blocked-by: none" と明記。この行自体を省略しない。同一 plan 内の k 番目 block への依存は plan#<k> と書く）
Touches: <path>, <path>

書式契約（子 issue 投函前に機械検証されます。違反は所見付きで差し戻され、修正されなければ escalation になります）:
- `Title:` 行は各 block の必須の先頭行です。`Title:` 行の無い出力は投函できません。
- 子 issue block は依存のトポロジカル順（依存される block が先）に並べてください。
- `plan#<k>` は後方参照のみ（自 block より前の block だけを指せます）。前方参照・自己参照・存在しない番号・重複参照は書式違反です。

各 block には、上記 plan format に従う plan 本文（子 issue の本文になる）を続けて書いてください。trivial クラスは軽量形（問題/修正方針/検証の 3 行〜）で可です。

子 issue の plan に次の外部空間パスの編集を含めないでください: `rubrics/`・`.claude/skills/`・`.claude/agents/`・`.claude/hooks/`・`design/test-failure-playbook.md`。 外部空間の変更が必要だと判断した場合は、その旨を選択肢として明記し VERDICT: ASK_PDM で終えてください（監査役の管轄です）。

PdM 判断が必要な選択肢（価値判断・scope 裁定・工数トレードオフ）に到達した場合は、選択肢と推奨を明記して VERDICT: ASK_PDM で終えてください（escalation ではなく正常終端です。ADR 0030 追記 E）。
調査の結果、目標不成立・前提矛盾が判明した場合は ESCALATE してください。

最終行に必ず次の形式で verdict を出力してください（他の形式は不可）:
VERDICT: <TOKEN>
<TOKEN> は次のいずれか: PLAN_READY | ASK_PDM | ESCALATE