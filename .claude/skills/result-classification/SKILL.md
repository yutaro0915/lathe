---
name: result-classification
description: run の結果・系の観察を「何の誤りか」に類別し、直す対象（code/skill/rubric/verifier/eval/harness/開発前線/開発体制/価値判断）と戻り先ループを決める判別手順。meta-loop の DIAGNOSE 段が従う。機械判定はしない——taxonomy を参照して判断を必ず記録する。正本は edd-theory §結果分類。
grounded_in: []
---

# result-classification — 結果を「何の誤りか」に類別する（判別手順）

meta-loop の DIAGNOSE 段がこれに従う。**判断を消さず、判断を構造化して記録する**——13 行の taxonomy を参照して分類し、選んだ行と根拠を必ず残す。**自動分類器ではない**（機械判定しない。特に行 13 と行 3/13 境界は還元不能な人間判断）。

正本は edd-theory `theory.md` §結果分類（本 skill はその判別手順を lathe の DIAGNOSE 段に置く。theory が改訂されたら ledger 経由で追随）。grounded_in が `[]` なのは、根拠が lathe の rubric でなく外部 theory にあることの明示。

## 入力
- run の結果（manifest の stage/verdict/result_text・escalation）、または系の運用観察（ループ混線・gate の効き等）。GROUND 段が集めた evidence 束（根拠座標つき）。

## 判別表（13 行）

| # | run の結果・観察 | 何が誤っているか | 次の操作 | 変更対象 | 戻り先 |
|---|---|---|---|---|---|
| 1 | 既存 rubric に違反、証拠契約で skill の変換手続きからの**逸脱**が確認できる | production code | コードを修正 | code | inner |
| 2 | 既存 rubric に違反、skill の手続きに**忠実**だった | skill の変換規則・適用範囲 | skill を修正 | skill | outer |
| 3 | 拒絶理由はあるが rubric が無い（所有者が**有限の試行で言語化・証拠定義できる**） | rubric の欠落 | rubric 候補化（採否規則で判定） | rubric | outer |
| 4 | 正しい成果物が却下、rubric の**意味・適用条件**が誤り | rubric | rubric の意味・適用条件を修正 | rubric | outer |
| 5 | 正しい成果物が却下、判定実装が誤り（false RED） | verifier | 判定器を修正・校正 | verifier | outer |
| 6 | 問いの設定が誤り（宣言が実現不能・矛盾・過小指定） | eval | eval を修正 | eval | outer |
| 7 | 宣言条件・適用条件・証拠が未実現（宣言自体は実現可能） | harness | harness を修正（判定対象外、run やり直し） | harness | — |
| 8 | 同条件の複数 run で結果が揺れる（valid だが非再現） | 受容主張の試行・集約規則、対象系の非決定性 | 集約規則を定義／非決定性を隔離 | eval | outer |
| 9 | 複数 rubric が同時に満たせない（競合） | rubric 間の優先関係が未決 | 真の競合なら優先規則を決めて rubric へ | rubric | outer |
| 10 | 同じ問いへの code 修正が収束しない（能力差分が大きすぎる） | 開発前線の選択 | 前線をより小さい能力差分へ再選択 | 開発前線 | outer |
| 11 | run でなく**系の運用の観察**から異常（ループ混線・gate の自己参照・改訂圧の不在・担当の空白） | 開発体制 | 運用規律・セッション構造・担当割当を変更 | 開発体制 | outer |
| 12 | 全 rubric 通過なのに受容主張が過大と事後判明（本番事故・想定外条件での失敗） | 受容主張の論証（rubric 集合の十分性） | 主張の条件 C を狭める／rubric 集合を拡充 | eval | outer |
| 13 | 正しさ自体が未決定（拒絶理由を有限の試行で言語化できない） | 価値判断 | outer loop で人間が決める | 価値判断 | outer |

## 判別手順（証拠 → 行 の順で当てる）
1. **証拠から入る**（行から埋めない）: GROUND の evidence 束を読み、「何が観察されたか」を確定する。
2. **rubric 違反か / 却下の誤りか / 未実現か / 系の観察か** で大別 → 該当行を絞る。
3. **行 3 / 13 の境界規則**（最重要）: 「受容できないと感じる＝暗黙の rubric がある」は常には成り立たない。**所有者が拒絶理由を有限の試行で言語化し、証拠と判定方法を定義できるなら行 3（rubric 化）**、できないなら**行 13（人間判断に残す）**。迷う品質次元は行 13 へ。
4. **行 12 の注記**: 「rubric が足りなかった」の万能行にしない。必ず「どの論証（なぜこの rubric 集合で主張を支えられると考えたか）が誤っていたか」を記録する。
5. **確信が持てない・行 13 に触れる場合は分類せず ESCALATE**（発明しない）。DIAGNOSE 段の verdict は ESCALATE を持つ。

## 出力（必ずこの形・判断を記録する）
- finding ごと: `分類=行<N>（<変更対象>） ／ 根拠座標=<run_key+stage | session_id+seq> ／ なぜこの行か=<1〜2 文> ／ 確信度=<high|med|low>`。
- **「なぜこの行か」を省略しない**——これが LEDGER-gap（判断が記録されず #31→#60 で同型誤検出を 2 回踏んだ）の解消点。
- 行 1（code）は inner へ（起票 loop 経由）。行 2〜13 は outer の ACT 系へ。行 13 は人間へ。

## 不変の前提
- **read-only**。分類と記録まで。rubric/skill/eval の更新・起票・裁定は ACT 系（別ループ）の仕事。
- taxonomy の正本は theory §結果分類。ここに 13 行の**手順**を置き、行の意味の改訂は theory へ ledger 還流する。
- 機械判定しない設計（迷ったら通す/ESCALATE）は意図的——判断を消すのでなく、構造化して記録するため。
