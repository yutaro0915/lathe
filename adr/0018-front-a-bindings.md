# ADR 0018: EDD 前線 A — 繋がりの可視化（grounded_in / bindings-lint / eval 第 1 号）

- status: accepted（2026-07-03 ユーザー承認・同日実装着地。導入時の lint 初走で未宣言 skill `implement` を 1 件検出＝検証器の初仕事）
- date: 2026-07-03
- 入口文書（本作業の唯一の入口）: `/Users/cherie/LLMWiki/projects/edd-theory/handoff/lathe-rubric-system-decomposition.md`（§2 導入表・§3 形式・§4 前線 A。確定済み決定は再議論しない）
- 理論の正本: edd-theory `theory.md` §関係の管理（LEDGER-0028/0032）・§skill の版と上位規範の変更
- 関連: [ADR 0011](./0011-rubric-schema-v2.md)（前線1。eval 第 1 号の移設元・`version` フィールドの出自）
- 実装規律: rubric/gate インフラ＝**監査役（Claude）単独 writer**・判定挙動の変更なし・inner loop に出さない（#57 の外部空間規律と整合）

## 対象（前線 A = 記録のみ、1 前線 1 関心）

skill ⇄ rubric ⇄ eval の**繋がりを artifact 内メタデータとして書き、lint で集計・検証可能にする**。判定挙動（run.mjs の選定・GREEN/RED ロジック）には触れない。

## 決定

### 1. skill frontmatter に `grounded_in`（出す側に書く）

`.claude/skills/*/SKILL.md`（5 skill）の frontmatter に追加:

```yaml
grounded_in:
  - rubric: meta/verify-commands-exist   # rubric id（ディレクトリ名 = v2 明示 id）
    verified: "3"                         # 検証済みの rubric version（v2 の version に結合）
```

- 結合先は **rubric id ＋版**（theory 名前結合の原則。実装の固有名＝cmd やファイルパスには結合しない）。
- 版は v2 の `version` フィールド（0011 で導入済み・改訂時に監査役が上げる）。content-hash 結合は不採用（表記変更で誤 staleness・意味的改訂の判断は監査役の仕事）。
- 根拠 rubric を持たない skill は `grounded_in: []` を**明示**する（未宣言と空を区別）。
- 対応の初期整備（実在照合の上で確定。例: verify → `meta/verify-commands-exist`、test-triage → `meta/triage-playbook-exists`、lathe-ui → ds 系 rubric）は実装時に監査役が行う。

### 2. bindings-lint 新設（lint は生成物を出す・手書き対応表は作らない）

`rubrics/bindings/lint.mjs`（集計スクリプト）＋ `rubrics/meta/bindings/rubric.json`（v2、gate への**追加**）。

**gate 判定（RED、expect eq:0）— 参照実在のみ**:
- grounded_in が指す rubric id が実在しない／`verified` の形式不正／frontmatter の構文エラー
- eval ファイルの `checks` が指す rubric id が実在しない

**生成一覧（`--report`、判定に使わない）**:
- skill → rubric 結合の全一覧
- **版見直し待ちキュー**: rubric.version > skill.verified の組（theory: 集約間の整合は結果整合＝lint が検出しキューに出す。**hard gate にしない**——無関係変更の merge を塞がないため）
- **宙に浮き**: どの skill / eval からも参照されない rubric の一覧（41 rubric の大半が該当して当然＝情報であり違反ではない）

見直し待ちキューの消化は outer の定常業務とし、meta-audit の検査項目に「bindings --report の stale 確認」を追加する。

### 3. `evals/` 新設＋第 1 号（ADR 0011 の合格条件の移設）

置き場は確定事項どおり **`evals/` 直下フラット**・前線は frontier メタデータ・命名は問いの内容ベース。第 1 号 `evals/rubric-schema-v1.md`:

```yaml
id: rubric-schema-v1
role: development        # Assurance 移行条件（版 pin・非公開ケース等）は未充足のため
frontier: 前線1
S: rubric 41 個が v2 形式で存在し、meta/rubric-schema が gate で常時実行されている
C: 任意の rubric.json（正常 v2 / 意図的に要素を欠いた fixture）を _schema.mjs に与える
Y: 正常 v2 が PASS し、欠落 fixture が VIOLATION として弾かれる（silent failure しない）
checks:
  - meta/rubric-schema
inline_criteria: []
trials: { n: 1, aggregate: all-pass }   # 決定的検査のため n=1
```

eval の**実行 runner は作らない**（前線 B の関心）。前線 A では eval は記録であり、bindings-lint が `checks` の参照実在だけを検証する。

### 4. 挙動不変の担保

- 既存 rubric の判定・run.mjs 本体・preflight は不変（`meta/bindings` は 0011 の `meta/rubric-schema` と同じ「gate の追加」パターン）。
- 導入 commit 内で全 skill の grounded_in を整備してから lint を有効化＝**初期状態 GREEN** で入れる。

## 受け入れ条件（handoff §4 前線 A の Development eval）

1. lint が**参照実在・版一致・宙に浮き**を機械判定できる（前二者は gate/report、宙に浮きは report）
2. **壊した fixture を検出できる**: `rubrics/bindings/fixtures/negative/`（不存在 rubric を指す grounded_in／不正 verified／不存在 check を指す eval）を負テストが検出（`_schema.test.mjs` と同型）
3. 実 repo で `node rubrics/run.mjs --changed <bindings 関連>` が GREEN、`--report` が 5 skill＋eval 第 1 号の結合一覧と stale キューを出力する

## 却下した代替

- **staleness を hard gate に**: theory の結果整合方針に反し、無関係変更の merge を塞ぐ → report＋キュー。
- **手書きの skill⇄rubric 対応表**: theory「手で維持する対応表は作らない」に反する → 出す側 frontmatter＋lint 生成。
- **rubric 側に利用 skill を書く**: 関係は出す側（根拠を負う skill）の artifact に書く。双方向に書くと二重正本。
- **grounded_in の対象を prompt 契約（inner-loop-prompts）まで拡大**: 前線 A は skill/eval/rubric の三者に限定。prompt 契約の繋がりは将来の関心。

## スコープ外（他前線・別作業）

- 形式化タグ `formalization`（§3 確定済みだが分類の関心＝別の小作業として監査役が別途）
- チャンネル実在 lint（前線 C で verifier 導入後に本 lint へ追加）
- eval 実行 runner・第 2 号以降（前線 B）／発火の選定層（前線 D）
- 理論への指摘が生じた場合は lathe 側で直さず edd-theory の `ledger.md` へ提案として還流する

## 一次情報

- handoff: `/Users/cherie/LLMWiki/projects/edd-theory/handoff/lathe-rubric-system-decomposition.md`
- theory: `/Users/cherie/LLMWiki/projects/edd-theory/theory.md` §関係の管理・§skill の版と上位規範の変更
- 移設元: [ADR 0011](./0011-rubric-schema-v2.md) 「本 ADR 自体の Development eval（合格条件）」節
