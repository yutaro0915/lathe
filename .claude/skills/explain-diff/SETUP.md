# explain-diff セットアップ（人間向け・agent は読まない）

この skill を新しい repo で使うための 1 回きりの準備。所要 5 分。前提: `gh` CLI 認証済み。

## 1. Discussions を有効化

Settings → General → Features → **Discussions** にチェック。CLI なら:

```sh
gh api -X PATCH repos/<owner>/<repo> -f has_discussions=true
```

## 2. Discussion カテゴリ「Explain」を作成（UI 操作・API なし）

Discussions タブ → カテゴリ一覧の編集（鉛筆アイコン）→ **New category**:

- **Category name**: `Explain`
- **Discussion Format**: **Announcement** を選ぶ
  - 理由: 教材は「配信物」。新規投稿を maintainer（あなたと agent）に限定しつつ、
    comment / reply は誰でも可——「教材の投稿 = 運用側のみ／質問スレッド = 自由」になる。
    public repo で第三者がカテゴリに投稿してくる事故も防ぐ
  - Q&A は不適（先頭投稿が「回答待ちの質問」という逆向きの意味論になる）

カテゴリが無い間、skill は General に投稿する（動作はする）。

## 3. `explain` label を作成

```sh
gh label create explain \
  --description "解説 loop の入口: 理解対象への参照を投函すると教材が返る" \
  --color 0e8a16
```

## 4. `explains/` の扱いを決める（任意）

教材の正本は repo 内 `explains/YYYY-MM-DD-<slug>.md` に置かれる。
git 管理するか `.gitignore` に入れるかは repo ごとの判断
（ignore しても Discussion 投稿が耐久コピーになるので情報は失われない）。

## 5. 使い方

- issue に `explain` label を付けて理解対象への参照（PR 番号／plan／ADR／概念）を書く、
  またはセッションに直接「〇〇を解説して」と依頼する
- 教材が `explains/` に保存され、Explain カテゴリの Discussion として投稿される
- 追加の質問は Discussion のスレッドにそのまま書く

## 6. 独立 runner として回す場合（任意・最小権限のハード強制）

```sh
claude -p "issue #<N> に対して .claude/skills/explain-diff/SKILL.md の解説 loop を実行して" \
  --allowedTools "Read" "Grep" "Glob" "Write(explains/**)" "Edit(explains/**)" \
    "Bash(gh:*)" "Bash(git log:*)" "Bash(git diff:*)" "Bash(git show:*)" "Bash(git ls-files:*)"
```

FS 書き込みは `explains/` のみ、他は読み取りと gh／git 読み系だけになる
（SKILL.md frontmatter の `allowed-tools` と同内容。skill 実行に必要十分）。

形式・禁則・検収の正本は同ディレクトリの [SKILL.md](./SKILL.md)。
