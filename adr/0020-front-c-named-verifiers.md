# ADR 0020: EDD 前線 C — verifier の独立化（named verifier / evidence 共有 / judge の要求クラス間接）

- status: accepted（2026-07-03 ユーザー承認・同日実装着地。受け入れ eval 通過: 前後比較 52/52 判定一致・7 verifier 各 1 回/run 実行・判定挙動不変。詳細は evals/verifier-evidence-sharing-v1.md の実行記録）
- date: 2026-07-03
- 入口文書: `/Users/cherie/LLMWiki/projects/edd-theory/handoff/lathe-rubric-system-decomposition.md`（§2 導入表・§3 verifier.json 形式・§4 前線 C・§5 確定事項。確定済み決定は再議論しない）
- **受け入れ条件 = [`evals/verifier-evidence-sharing-v1.md`](../evals/verifier-evidence-sharing-v1.md)**（前線 B で記述した未通過前提の問い。eval が前線を駆動する最初の例）
- 理論の正本: edd-theory `theory.md` §verifier の分離と evidence contract（LEDGER-0028）・§関係の管理（名前結合の原則、LEDGER-0032）
- 関連: [ADR 0011](./0011-rubric-schema-v2.md)（v2 schema）/ [ADR 0018](./0018-front-a-bindings.md)（bindings-lint）/ [ADR 0019](./0019-front-b-eval-first-class.md)（eval 形式）
- 実装規律: 監査役単独 writer・**判定挙動の変更なし**（同じ cmd の移設＝判定不変。run.mjs の改変はあるが GREEN/RED と発火は不変＝本 ADR がその授権）

## 対象（前線 C、1 前線 1 関心）

判定実装（cmd / judge のモデル束縛）を rubric.json から括り出し、**named verifier** として独立させる。目的は evidence の共有（1 run 1 実行）と多対多の判定・校正の rubric 版からの分離。発火の選定（scope 降格・影響集合）は前線 D＝触れない。

実測の根拠: `boundaries` の i1/i2 が同一 `pnpm lint:deps` を check ごとに 2 回実行（check 間重複の実例）。judge 型 = v2 の 2 rubric（tests-accompany-changes / ds-reuse-not-reimplement）＋ v1 の no-needless-backward-compat。

## 決定

### 1. `verifiers/` 新設と verifier.json 形式（handoff §3 準拠＋抽出機構）

`verifiers/<id>/verifier.json`。必須: `id`（ディレクトリ一致）/ `version` / `kind`（`cmd` | `judge-runner`）/ `run`（**1 run につき 1 回実行**）/ `produces`（名前つきチャンネル）/ `limits`（検査の限界の自己申告＝現 tolerance 散文の移住先）。任意: `details` / `fixtures`。

**lathe 追加（instance 詳細）**: チャンネルごとに `extract`——verifier の実行出力を stdin に受け、チャンネル値（最終行＝evalExpect 互換）を出す shell パイプ。これが「1 実行 → N 個の安価な抽出」の機構。

```jsonc
{ "id": "depcruise", "version": "1", "kind": "cmd",
  "run": "pnpm lint:deps 2>&1",
  "produces": {
    "I1-postgres": { "type": "count", "means": "生 SQL の I1 違反件数", "extract": "grep -c 'I1-postgres' || true" },
    "I2-package":  { "type": "count", "means": "package→app 依存の I2 違反件数", "extract": "grep -c 'I2-package' || true" }
  },
  "limits": "dependency-cruiser の静的解析が届く範囲のみ（動的 import・実行時結合は対象外）" }
```

### 2. 義務条件と「重い」の閾値（handoff §5 確定案 A の数字を置く）

named 化の義務 = 必要条件（チャンネルを少数の安定名で列挙できる）＋ **実行重複（check 間）/ judge 型 / 重い実行** の OR。「重い」の閾値: **単一 check の実行が 10 秒超**（根拠: Stop hook が回す `preflight --quick` の即時性の体感境界。初期 8 は確定済みなので、この数字は将来の分類にのみ効く）。安価な grep 約 34 check は inline 温存・任意 named 化と inline への降格は自由（確定どおり）。

### 3. run.mjs に verifier 実行層（判定挙動不変）

- check の `verify` が verifier を名指す場合: 当該 verifier の `run` を実行（**同一 run.mjs 呼び出し内で memoize＝2 回目以降は evidence 再利用**）→ チャンネルの `extract` に出力を渡す → 得た値を従来どおり `evalExpect` で判定。
- GREEN/RED ロジック・発火（scope/tier）・出力形式は不変。変わるのは実行の重複だけ。
- 選定 receipt・未実施明示は前線 D（本 ADR では従来出力を維持）。

### 4. rubric 側の名前結合（**handoff instance 例からの逸脱 1 点・要注意**）

```jsonc
"verify": { "kind": "cmd", "verifier": "depcruise", "channel": "I2-package", "metric": "count", "expect": "le:1", "tolerance": "…" }
```

handoff §3 の instance 例は `{ "verifier": "depcruise", "metric": "I2-package", … }` とチャンネル名を `metric` に置くが、これは **v2 確定済みの `metric: count|measure`（ADR 0011）と衝突**する。名前結合の本質（意味の名前＝チャンネルに結合・inline cmd 併存）は不変のまま、フィールド名だけ `channel` を新設して回避する。**この衝突は edd-theory の ledger へ指摘として還流する**（handoff の規約: 確定の変更が必要な場合は実装せず指摘——ここでは確定の本質は変えず instance 表記のみの調整だが、指摘は出す）。
- `_schema.mjs` 追随: `kind: cmd` は `cmd` **または** `verifier`+`channel` のどちらかを必須に（negative test 追加）。
- 前線 A の bindings-lint に**チャンネル実在検証**を追加（A で予告済みの拡張）: `verifier` が指す id の実在・`channel` が `produces` に列挙されていること。`meta/bindings` は version 2 へ。

### 5. judge-runner（要求クラス間接＝handoff §3 確定案 a）

`verifiers/judge-runner/verifier.json`（kind: judge-runner）。**prompt / input_cmd は従来どおり rubric 側**。runner が持つのは:
- `bindings`: 要求クラス → provider / model。**v1 のクラスは `standard` のみ**とし、現行の judge 実行（codex）と同一束縛＝挙動不変。rubric の `class` 未指定は `standard`（v1 judge rubric は無改変で乗る）。クラス追加は実需時（固有名 pin は不採用＝確定）。
- `error_tolerance`: 誤り許容方針の書式（現行 judge prompt の「迷ったら通す」等の方針を runner 側書式に転記＝意味は不変）。
- `calibration`: クラスごとの校正手順（ground truth fixtures・周期・判定者＝監査役）。v1 は書式定義＋既存 judge の実態（fixtures 未整備なら「未整備」を明記）から始める。
- run.mjs の judge 実行はモデル束縛を runner から読む（現状ハードコードの移設）。モデル世代交代＝runner の版上げ＋再校正で rubric 不変（確定どおり）。

### 6. verifier 形式の機械検証（0011/0019 と同型の自己適用）

`rubrics/_verifier-schema.mjs`（必須要素・kind enum・produces 非空・type enum count|measure|verdict・judge-runner の追加必須）＋ in-memory 負テスト ＋ `meta/verifier-schema` rubric（gate 追加）。

### 7. 実装スライス（各スライスで gate GREEN を維持）

1. 形式＋検証器（verifiers/ 空でも GREEN）
2. 実行層＋ **depcruise**（実証済み重複の解消＝boundaries i1/i2 を名前結合へ）
3. preflight 系 5（typecheck / unit-tests / build / storybook / e2e-runner）＋ scratch-integration（tier 構成コマンドの形式化＝前線 D の下地）
4. judge-runner（クラス間接への移設）
5. **前後比較＝eval の負荷実行**: 同一変更集合で移行前後の `run.mjs`（tier=heavy 全量）を実行し、check ごとの verdict を突き合わせて記録。verifier 実行回数（1/run）を実行記録で確認。結果を eval `verifier-evidence-sharing-v1` の本文に記録

## 受け入れ条件

`evals/verifier-evidence-sharing-v1.md` の Y と inline_criteria（同一 verifier 1 回/run・前後で全 check 判定一致・run.mjs の判定挙動不変）。加えて負テスト: 壊した verifier.json（produces 空・不在 channel への結合・kind 不正）が検出されること。

## 却下した代替

- **全 48 check の一括 named 化**: 安価な grep 34 は inline 温存が確定。括り出しの価値（共有・校正分離）が無いものを動かすのは純コスト。
- **チャンネル名を handoff 例のまま `metric` に**: v2 確定の `metric: count|measure` と衝突（上記 §4、ledger へ指摘）。
- **judge のモデル固有名 pin**: 確定で不採用（クラス語彙の不足サインとして扱う）。
- **verifier 実行結果のディスクキャッシュ（run 跨ぎ）**: 鮮度管理（何で invalidate するか）という新しい関心を持ち込む。1 run 内 memoize で eval の要求は満たす。

## スコープ外

- 発火の選定層・選定 receipt・未実施（not-run）明示・5 値報告語彙（前線 D / 前線2 の ADR）
- Assurance の物理分離（別前線）／新クラス・新 verifier の追加（実需時）
- ledger 還流: `metric`/`channel` の名前衝突の指摘（本 ADR §4）

## 一次情報

- handoff: `/Users/cherie/LLMWiki/projects/edd-theory/handoff/lathe-rubric-system-decomposition.md` §2・§3・§4・§5
- theory: `/Users/cherie/LLMWiki/projects/edd-theory/theory.md` §verifier の分離と evidence contract・§関係の管理
- 実測: `rubrics/boundaries/rubric.json`（lint:deps の check 間重複）・judge 型 3 rubric
