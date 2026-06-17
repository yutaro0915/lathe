# Lathe Stacking Norms（PR/スタック分割の規範）

> **目的**: Graphite stacked PR で「大タスクを並走可能な小 PR に割る」ときの**分割基準**を定める。長 branch ブロック解消（workflows.md の Graphite 節）の運用面。
> **根拠**: Graphite 公式 docs/guides/blog の一次情報（2026-06-17 調査）。数値は Graphite 自社データ（trunk-based 偏りの注記あり）。
> **適用**: タスクを最初からスタック前提で設計するとき / 大きくなった branch を割るとき。Claude が task 分解時に使い、Codex loop は分割単位ごとに回す。

## いつ割るか（公式の分割シグナル）
- 1 つの変更が**無関係な複数の関心**を含む
- diff が**レビュー困難な大きさ**
- 部分ごとに**レビュー要件/ドメイン専門性が違う**（migration / backend / frontend 等）
- **増分でデプロイ/merge したい**

## 1 PR の基準
1. **単一責務（atomic）**: 1 PR = 1 目的（機能 *or* 修正 *or* リファクタのどれか 1 つ）。**リファクタは feature と分離**。
2. **自己完結**: 追加文脈なしで単独レビュー・merge できる。各 PR で build/test GREEN。
3. **サイズ目安**: **理想 ~50 行、200 行未満、10 ファイル未満**（Graphite 自社データ: 50 行は ~40% 速く merge・15% revert 減）。超える場合は割る。
   - ※この数値は Graphite 自社データ（trunk-based 利用者偏り注記あり）。厳密な普遍値ではなく目安。
4. **論理的グルーピング**: 関連変更はまとめ、無関係は分ける。

## スタックの順序（依存方向）
- **底（main に最も近い）= 基盤**（他が依存するもの: migration / 型 / shared util）。**上 = それに依存する層**（backend → API → UI → 配線）。
- レビューも **底→上**。下位が review 待ちでも上位を進められる（ブロック解消の本体）。
- 注: 公式は「依存方向＝底が基盤」「レビュー底→上」のみ明記。risk ベースの順序原則は公式に明記なし（我々の判断で「変わりにくい/安定を底」に寄せてよいが、第一原則は依存方向）。

## アンチパターン（やらない）
- **無関係な変更を 1 スタックに混ぜる**（依存が無いなら別スタックへ）。
- **多数の変更を 1 PR に束ねる** / **1 PR に複数タスク**。
- 純リファクタと挙動変更を同じ PR に混ぜる。

## 大きい branch を割る手法（gt）
- 分割点を決める → 必要なら `gt squash` で論理グルーピングを作る → `gt split`：
  - `--by-commit`（既存コミット境界、履歴保持）/ `--by-hunk`（hunk 単位）/ `--by-file <pathspec>`（ファイル抽出、非対話可）
- `gt submit` で各ブランチを一括 PR 化、`gt stack`/`gt log` で確認。`gt absorb`（staged 変更を適切な downstack commit へ自動振り分け）。

## lathe への当てはめ（設計時チェックリスト）
大タスクを最初からスタック設計する時:
1. 機能を高レベルで捉え **solution domain に分解**（Graphite の mental model）。
2. 各片を **単一責務**に絞る（migration / backend logic / API / UI / verify gate を別 PR に）。
3. **依存方向で底→上**を決める（例: migration → backend → submit 経路 → verify gate）。
4. 各片を **~50/200 行・10 ファイル未満**に収まる線で切る。
5. 各片が **単独 self-contained・build/test GREEN** か確認。
6. 無関係は別スタックへ。
7. レビュー要件/専門性が違う境界で切る。
- **engineering-norms（特に N1 反証ゲート・N6 scratch 隔離）は各 PR で守る**。各 PR を Codex loop で回し、底から順に audit→merge。

## 主要出典
graphite.com/guides/{break-up-large-pull-requests, best-practices-managing-pr-size, splitting-code-changes, how-to-split-a-pull-request-into-multiple-prs} / graphite.com/blog/{stacked-prs, the-ideal-pr-is-50-lines-long} / graphite.com/docs/{command-reference, best-practices-for-reviewing-stacks}
- 未確認: 「DB→backend→frontend の層別分割例」は検索要約レベル（一次ページは層別でなく単一責務/論理グルーピングを強調）。層別は目安として扱う。
