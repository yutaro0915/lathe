# ADR 0021: EDD 前線 D — 発火の選定層（scope 降格・影響集合・選定 receipt・golden test）

- status: accepted（2026-07-03 ユーザー承認。ホップ=辺 1 回・推移閉包既定の具体例説明（barrel 経由 2 段波及と meta/typecheck 不発火の実例）の上で裁可。実装は Agent(isolation:worktree) へ委譲し監査役が diff レビュー・着地）
- date: 2026-07-03
- 入口文書: `/Users/cherie/LLMWiki/projects/edd-theory/handoff/lathe-rubric-system-decomposition.md`（§1 診断・§2 導入表・§4 前線 D・§5 残決定）
- **受け入れ条件 = [`evals/rubric-selection-v1.md`](../evals/rubric-selection-v1.md)**
- 理論の正本: edd-theory `theory.md` §適用の選定（LEDGER-0028）・§run validity の報告語彙（5 値、LEDGER-0034——本 ADR は not-run を採用、warn/invalid は前線2）
- 関連: [ADR 0020](./0020-front-c-named-verifiers.md)（A〜C のオントロジーの矢印が D の前提）
- 実装規律: 監査役単独 writer。**本 ADR は run.mjs の判定挙動変更（発火の拡大）の授権そのもの**——4 前線で唯一

## 対象（前線 D、1 前線 1 関心）

scope の二役（意味上の適用範囲 ⋀ 発火条件）を解消する。scope は**意味上の適用範囲へ降格**し、発火は選定層が run ごとに計算する:

> 発火(rubric) = invariant ∨（scope ∩ 影響集合 ≠ ∅）∨ 明示指定
> 影響集合 = 変更集合 ∪ 依存グラフ上の逆依存閉包 ∪ 宣言エッジの誘発分

## 決定

### 1. 選定層 `rubrics/select.mjs`（run.mjs の前段・純関数＋CLI）

- 依存グラフ: `depcruise --output-type json`（既存 dependency-cruiser 設定・apps/web + packages）から module → 依存 のグラフを構築し、**逆依存を BFS** で辿って変更ファイルの下流（利用側）を影響集合に加える。グラフは 1 run 1 回構築（変更が apps/web / packages に触れない場合は構築自体を省略＝Stop hook --quick の即時性を守る）。
- 選定ロジックは純関数 `selectRubrics({changed, graph, rubrics, edges})` として export（golden test の対象）。
- run.mjs の `--changed` は選定層を通る形に変わる（従来の直接 prefix 照合は選定規則の一部として残る）。明示指定モード（id 列挙）は不変。

### 2. 発火の単調拡大（安全性の設計不変条件）

新選定の発火集合は**常に旧規則（scope ∩ 変更集合）の上位集合**。dep 閉包・宣言エッジ・invariant は発火を**増やす**方向にしか働かない＝「gate が今より緩む」変化はゼロ。この性質自体を golden test で固定する。

### 3. ホップ数の既定（handoff §5 の残決定に数字を置く）

**逆依存の推移閉包を既定・tier 非依存**とする。理由: (a) 1 ホップは packages/domain → packages/mcp → apps/web の 2 段波及を取りこぼす（§1 診断の再発）、(b) 本 repo のグラフ規模（数百 module）で閉包計算は数 ms＝絞る経済的理由が無い、(c) tier は従来どおり check の実行深度（cmd<test<heavy）だけを絞る——選定（どの rubric か）と深度（どこまで検証するか）の直交を保つ。ホップ制限は実測でグラフが肥大した時に再訪。

### 4. 宣言エッジの書式（handoff §5 の残決定）

依存グラフに映らない結合（CSS token → styling 系等）は rubric.json の任意フィールドで**受け側が宣言**する:

```jsonc
"edges": [ { "from": "apps/web/app/globals.css", "reason": "design token の変更は styling 検査を誘発（import グラフに映らない）" } ]
```

`from` 配下の変更は当該 rubric を発火させ、receipt に `declared-edge` として記録する。**v1 で実エッジは張らない**（現 rubric の scope は広い prefix で実質カバー済み。書式と機構＋golden の合成ケースのみ導入し、実需の初出時に張る）。取りこぼしの最終保証は従来どおり `preflight --full`（全量）＝**選定は経済装置であって正しさの最終保証ではない**（theory 明文）。

### 5. invariant rubric（理論の式の第 1 項）

任意フィールド `"invariant": true` = 変更集合と無関係に常時発火。機構として導入し、**v1 で適用する rubric はゼロ**（現行は全て scope で足りている。常時走らせたい rubric が現れた時に付与）。

### 6. 選定 receipt（未実施の明示＝偽 GREEN の防止）

`--changed` 実行の出力に選定 receipt を追加する:

- **発火した rubric**: 発火規則つき（`direct-scope` / `dep-closure(経路の起点→終点)` / `declared-edge` / `invariant`）
- **発火しなかった rubric**: **not-run 一覧として全列挙**（silent skip の廃止。tier で絞られた check の SKIP 表示は従来どおり＝これも not-run 語彙の一部）
- `--receipt <path>` で JSON 出力（inner loop の run 記録・#43 の runs ingest に将来接続）

報告語彙は前線2 と共通の 5 値（pass / fail / warn / invalid / not-run、LEDGER-0034）のうち **not-run のみ**を本 ADR で導入。warn / invalid の意味論は前線2 の ADR。

### 7. golden test（選定の誤り＝harness の誤り）

`rubrics/select.golden.test.mjs`: (a) 合成グラフでの規則別ケース（direct / 閉包 / エッジ / invariant / 上位集合性）、(b) **実グラフでの波及ケース**（packages/domain のみの変更 → apps/web scope の rubric が発火＝eval の中核 criterion）。golden の期待集合は明示リスト＝選定変更は golden 更新を強制（無言の選定変化を塞ぐ）。

### 8. `preflight --full` の役割の再定義（記録のみ）

--full（全量・tier=heavy）は「過小発火の補償」から「**最終保証層**」へ役割を明文化（merge gate は従来どおり --full）。コードは不変・注釈と本 ADR で記録。

## 受け入れ条件

`evals/rubric-selection-v1.md`（golden 全 pass・packages→apps 波及の検出・receipt の全説明・上位集合性）。着地時に選定 golden の gate rubric を eval の checks に追記して記録する。

## 却下した代替

- **1 ホップ既定**: 2 段波及（domain→mcp→apps）を取りこぼす＝§1 診断の再発。閉包が安価な規模で絞る理由が無い。
- **tier でホップを変える**: 選定と深度の直交が壊れ、tier ごとに発火集合が変わる（説明可能性が落ちる）。
- **エッジをグラフ側（別ファイルの対応表）に置く**: 前線 A の原則（手で維持する対応表を作らない・出す側の artifact 内メタデータ）に反する。受け側 rubric が自分の誘発条件を宣言する。
- **選定で全量 gate を置き換える**: theory 明文で否定（選定は経済装置。依存グラフに映らない結合は必ず残る）。

## スコープ外

- warn / invalid の意味論・soft gate（前線2 の ADR）
- 選定 receipt の DB ingest（#43 runs 一級化と接続——将来）
- Assurance の物理分離／実宣言エッジの追加（実需時）

## 一次情報

- handoff: `/Users/cherie/LLMWiki/projects/edd-theory/handoff/lathe-rubric-system-decomposition.md` §1・§2・§4・§5
- theory: `/Users/cherie/LLMWiki/projects/edd-theory/theory.md` §適用の選定・§run validity
