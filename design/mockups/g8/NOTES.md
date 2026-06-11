# G8 Explorer UI Mockups

基準画像は実アプリを Postgres + 実データ入りで起動して撮影したものです。シミュレーションは基準 PNG に最小限の UI オーバーレイを合成し、配色・文字サイズ・余白密度を現アプリに寄せています。

## 01a A-1 turn-first collapsed
- Transcript の初期視界を turn 要約行だけに変更。
- 各 turn に steps / edits / error / cost / duration の chip を付与。
- エラー turn は淡い赤背景で行単位に強調。
- 3 列構成、左フィルタ、右詳細、TimeRibbon は維持。

## 01b A-1 expanded
- 1 つの turn を展開し、既存 step 行に近い見た目で表示。
- step 行右端に session 全体内の位置と duration を示す小さな時間バーを追加。
- child / sub-agent はインデントで現行ネストを維持。
- turn-first のまま、掘った箇所だけ step 密度に戻る見え方。

## 02 A-2 outline pane
- 左ペインを session 一覧から選択 session の turn / step アウトラインへ変更。
- 最上部に Sessions へ戻る導線を追加。
- 右 aside の詳細を中央ペインに統合し、選択 step 詳細を主役化。
- session 横断一覧は同時表示しない前提の見え方。

## 03 A-3 Tree / Timeline toggle
- sessbar 近くに Tree / Timeline トグルを追加。
- Timeline 側は turn / step を横バー waterfall として表示。
- 色は現行 event 種の色に寄せ、error のみ赤で強調。
- TimeRibbon は下部 minimap として残す前提。

## 04a File axis
- A-1 展開 turn の直下に Files touched サブ行を追加。
- ファイル status、追加削除数、diff への導線 chip を置く。
- 同一画像内に Git タブ側の file → touched steps 履歴の小プレビューを追加。
- diff 連動は既存の step ⇄ hunk リンクの延長として見せている。

## 04b G9 anomaly surface
- Overview と session 一覧行に anomaly chip の置き場所を追加。
- sessbar 相当の場所に「最も高い turn」「エラー turn」へのジャンプ chip を追加。
- 閾値や具体的な数値は未設計のため書いていない。
- 表示面だけを確認するための配置案。

## 迷った点
- 案 4a は 1 枚にまとめる指定に合わせ、Transcript 上に Git タブ preview inset を置いた。
- 02 は右 aside を完全廃止するより、中央詳細へ統合する案として表現した。
- 03 は Tree 側が 01 と重複するため、Timeline 側だけを描いた。
