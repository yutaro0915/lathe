# experiment-loop — 手順書

> 正本（ADR 0030 §6・§7）。rubric / skill 改訂の比較実験を、**監査役（outer loop）が**
> 手動で回す手順書。machine driver は含まない（B 案採用・plan §2）。

## 目的

rubric / skill の改訂案について、改訂前後で同一 task 集合の gate を走らせ、
**事前に宣言した予想差分（S / C / Y）** と観測を照合し、採否判断を記録する。

効果が未実証のまま改訂を landing させることを防ぐ（ADR 0030 背景 §8）。

---

## 三つの入力

| 入力 | 内容 |
|---|---|
| **改訂案** | `rubrics/` 配下の改訂候補（branch または一時ファイル）|
| **事前宣言の予想差分（S / C / Y）** | `evals/experiments/<id>.md` の `predicted_diff` セクション。実験開始**前**に記入する |
| **対象 task 集合** | `evals/experiments/<id>.md` の `task_set`。gate を実行する issue 番号リスト |

---

## 段（手順）

### 1. 実験票を作成する

`evals/experiments/_template.md` を複製して `evals/experiments/<id>.md` を作り、
以下のフィールドを実験開始**前**に記入する。

- `id` / `revision` / `task_set`
- `predicted_diff.S` / `predicted_diff.C` / `predicted_diff.Y`

`results` / `verdict` / `landing_ref` はこの時点では空欄（`~`）のまま。

### 2. baseline を走らせる

現行の rubric（改訂前）のまま、`task_set` の各 task に対して gate を実行する。

```
node rubrics/run.mjs <rubric_id> --changed <paths>
```

`results.baseline.outcome` と `results.baseline.note` に実測を記入する。

### 3. candidate を走らせる

改訂案の rubric を適用した状態で、同じ `task_set` に対して gate を実行する。
（改訂案が branch にある場合は branch を checkout してから実行し、終了後に元の branch に戻す。
改訂案が一時ファイルにある場合は、baseline の rubric ファイルを一時退避 → 候補に差し替え → 実行 → 復元。）

`results.candidate.outcome` と `results.candidate.note` に実測を記入する。

### 4. 予想と観測を照合する

`predicted_diff` の S / C / Y と、baseline / candidate の実測を突き合わせる。
全予想が観測と一致した場合 → `verdict: ADOPT`
不一致が 1 件以上ある場合 → `verdict: REJECT`

`evals/experiments/<id>.md` の `verdict` を更新する。

### 5. 採否判断を記録する

- **ADOPT の場合**: `landing_ref` に採用 PR 番号を書く。改訂の main への着地は、
  別途 PR を作成し CI ゲート（ADR 0030 §0）を通すこと。実験票を commit して
  rubric 管理 loop のゲート経由で landing させる。
- **REJECT の場合**: `landing_ref` は空欄のまま。実験票に reject 理由を `note` に補記し、
  rubric 管理 loop へ差し戻す（改訂案の再設計）。

---

## 採否規則（まとめ）

| 条件 | verdict |
|---|---|
| 全 S / C / Y 予想が baseline / candidate 実測と一致 | **ADOPT** |
| 1 件以上の S / C / Y 予想が観測と不一致 | **REJECT** |
| gate 実行エラー（環境障害等） | REJECT（エラーを note に記録し再実験） |

---

## landing 経路

```
実験票作成（evals/experiments/<id>.md）
  → baseline gate 実行
  → candidate gate 実行
  → 予想照合 → verdict 記録
     ├─ ADOPT → 実験票 commit → 改訂 rubric を別途 PR 化 → CI → merge
     └─ REJECT → rubric 管理 loop へ差し戻し（改訂案の再設計）
```

---

## meta/rubric 管理との境界

| 実験 loop の責任範囲 | 境界の外（rubric 管理 loop の責任）|
|---|---|
| 同一 task 集合で改訂前後を比較する | 改訂案の設計・起草・レビュー |
| 予想と観測の照合・採否判断の記録 | 採用後の rubric を main へ landing させる |
| `evals/experiments/<id>.md` への記録 | `rubrics/` への実際の変更のコミット |

実験 loop は「効果の検証」のみを行う。rubric の設計判断・landing・バージョン管理は
rubric 管理 loop（`rubrics/` 統治文書 loop）の責任。
