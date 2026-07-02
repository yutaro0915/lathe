# ADR 0015: 依存関係つき並列 inner-loop — issue に依存を埋め込み、解決済みだけを並列実行

- status: accepted（2026-07-02、ユーザー指示: 「並列で実装できるように。issue に依存関係を埋め込んで、並列可能なものは並列で、依存が解決していない issue は実行されないように」）
- date: 2026-07-02
- 関連: ADR 0013（driver）/ ADR 0014（backend 抽象）/ #36（resume）

## 背景

inner-loop run は issue 単位で worktree・branch・manifest・receipt（sha キー）が分離済みで、**並列実行の隔離はすでに成立**している。欠けているのは (a) issue 間の依存を機械が読める形で持つこと（例: #33 は #29 の配線に依存＝実際に PLAN がエスカレーションした）、(b) 同時 land の直列化、(c) 実行可能な issue 群をまとめて撒く入口。

## 決定

### 1. 依存は issue body に機械可読の行で埋め込む
```
Depends-on: #29, #35
```
- 行頭 `Depends-on:`（大文字小文字非依存）＋ `#N` の列。**全依存 issue が CLOSED のとき実行可能**。
- 起票時に outer が書く（既存 issue にも随時追記）。GitHub ネイティブの依存機能に将来移行してもパーサだけ差し替えれば良い薄い規約。
- 任意の補助宣言 `Touches: scripts/inner-loop.mjs, apps/web/lib/`（触るパス目安）。宣言があれば dispatcher は**重なる issue を同時に走らせない**（無宣言は従来どおり＝衝突したら merge が escalate する既存安全網に任せる）。

### 2. dispatcher: `scripts/inner-queue.mjs [--max K] [--dry-run]`
- `gh issue list --label inner-loop --state open` を列挙（**label `inner-loop` が opt-in マーカー**＝ラベル無しは撒かない。人間/outer が付ける＝起動ゲートの置き換えではなく一括化）。
- 各 issue を判定: 依存が全 CLOSED か（未解決はスキップし理由を表示）／既に run 中でないか（worktree `inner-issue-N` の存在・manifest の進行）／Touches 重複が無いか。
- 実行可能なものを **最大 K 並列**（既定 2）で `node scripts/inner-loop.mjs <n>` として spawn。終了を待ち、空いたスロットに次を詰める（簡易ワーカープール）。各 run の stdout は `.lathe/runs/issue-<n>.log` へ。
- driver 本体は変更最小（並列の知識を持たせない）。

### 3. landing の直列化（merge.mjs にロック）
並列 run が同時に MERGE 段へ達すると main への git 操作が競合し得る。`merge.mjs` が landing 区間で **lock（`.git/lathe-merge.lock`、PID 記録・stale 回収は ingest の PID lock と同型）** を取り、待って順に land する。後着は rebase 済みでも main が動いた直後になるため、squash 3-way が吸収（衝突時は従来どおり escalate）。

### 4. quota への配慮
並列度 K は既定 2 で開始（codex/claude サブスク枠の消費速度と相談して調整）。K は flag。

## 却下した代替
- **ラベルでなく全 open issue を自動で撒く**: 起票＝即実行になり、人間の起動ゲート（ADR 0013 §3）が消える。却下（label 付与が起動ゲートの一括版）。
- **driver に並列管理を内蔵**: 状態機械に別関心が混ざる。却下（dispatcher を分離）。
- **依存をコメントに書く**: driver/dispatcher は body しか読まない実績（#25 の outer 判断も body 追記で解決した）。body 規約に統一。

## スコープ
- 本 ADR = 依存規約・dispatcher・merge lock・並列度制御。
- スコープ外: cross-issue の自動依存推定／GitHub ネイティブ依存 API への移行／cloud 並列（別検討中）。

## 実装スライス
1 issue（inner loop 実装可）: inner-queue.mjs＋Depends-on/Touches パーサ（純関数・単体テスト）＋merge.mjs の landing lock＋`.lathe/runs/issue-<n>.log`。受け入れ: dry-run で「実行可/依存待ち/重複回避」の判定表示・依存未解決 issue が起動されないテスト・2 並列の実走スモーク。

## 追補（2026-07-02）: 並列可否の判断の所在と防衛線

「並列できるか」の判断は 2 層に分離する:
- **宣言＝判断の実体**: outer loop が**起票時**に issue body へ書く（根拠: 論理依存＝成果物の利用関係、触るパスの見積もり）。
- **執行＝判断しない**: inner-queue は宣言を機械的に読むだけ（全依存 CLOSED か・Touches 重複か・run 中か）。merge gate と同じ「判断と執行の分離」。

宣言が誤っていた場合の防衛線（失敗モードは**破壊でなく停止**）:
1. **planner**: 未宣言の前提欠落を PLAN 段で検知しエスカレート（実績: #25 PLAN が未配線テストという未宣言依存を発見→#29）。
2. **git 3-way＋landing lock**: Touches 予測が外れて同一ファイルに触れても、衝突すれば merge.mjs が escalate。
3. **verify/backstop**: 意味的干渉の最終網。

既知の限界: Touches は起票時の予測（#32 で予測外の新ファイルが生まれた実例）。将来は lathe の実測 `changed_files`（全 run の触ったパスの観測データ）から Touches を接地する改善余地がある。
