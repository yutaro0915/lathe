#!/usr/bin/env bash
# scripts/intake-register.sh <ISSUE_NUM>
#
# issue 番号を 1 つ受け取り、backlog task として登記して issue を close する。
# push 主 + pull 補（sweep）の両経路から同一コードパスを通る。
#
# べき等性ガード: origin/main に当該 issue 参照（intake: issue #NUM <-）が
# あれば既登記 → skip する（二重登記防止）。
set -euo pipefail

NUM="$1"

# 最新の origin/main を取得し、clean な状態に戻す
# （sweep ループで複数回呼ばれる場合も毎回 fresh な base から開始する）
git fetch -q origin main
git checkout main 2>/dev/null || git checkout -f main
git reset --hard origin/main

# べき等性ガード: origin/main に当該 issue 参照があれば登記済み → skip
# 「intake: issue #NUM <-」形式で検索（#1 が #10 にマッチしないよう空白で区切る）
if git grep -q "intake: issue #${NUM} " origin/main -- 'backlog/tasks/' 2>/dev/null; then
  echo "::notice::issue #${NUM} already registered on origin/main — skip"
  exit 0
fi

# issue 詳細を gh から取得（payload 非依存・schedule/labeled の両トリガで同一情報源）
ISSUE_JSON="$(gh issue view "$NUM" --json title,body,author,labels)"
TITLE="$(echo "$ISSUE_JSON" | jq -r '.title')"
BODY="$(echo "$ISSUE_JSON" | jq -r '.body // "（本文なし）"')"
AUTHOR="$(echo "$ISSUE_JSON" | jq -r '.author.login')"
LABELS="$(echo "$ISSUE_JSON" | jq -r '[.labels[].name] | join(" ")')"

# priority 判定
PRIO=medium
case " $LABELS " in
  *" p0-urgent "*|*" p1-high "*) PRIO=high ;;
  *" p3-low "*) PRIO=low ;;
esac

# task 作成
DESC="$(printf '%s\n\n---\nintake: issue #%s <- @%s' "$BODY" "$NUM" "$AUTHOR")"
OUT="$(npx -y backlog.md task create "$TITLE" -d "$DESC" --priority "$PRIO" --plain)"
echo "$OUT"
# 「Task TASK-N - …」の行頭アンカーで採番結果だけを取る
# （タイトル内の TASK-nn 言及を誤抽出しないよう行頭固定、#84 対策）
TASK_ID="$(echo "$OUT" | sed -n 's/^Task \(TASK-[0-9][0-9.]*\) .*/\1/p' | head -1)"
test -n "$TASK_ID"

# land: git 設定
git config user.name "lathe-intake"
git config user.email "intake-bot@users.noreply.github.com"
git add backlog/

# backlog/ 以外への書き込みを機械検査（-z = quotePath 安全）
if git diff --cached --name-only -z | tr '\0' '\n' | grep -v -e '^backlog/' -e '^$' | grep -q .; then
  echo "::error::non-backlog paths staged — registrar refuses to write outside backlog/" >&2
  exit 1
fi

# 採番の衝突検査: origin/main に同 ID が既に居たら失敗させる
# （label 再付与で再走すれば新しい base から採番し直す）
N="${TASK_ID#TASK-}"
if git ls-tree --name-only origin/main backlog/tasks/ | grep -qE "^backlog/tasks/task-$N "; then
  echo "::error::duplicate task id $TASK_ID already on origin/main — re-trigger the label to retry" >&2
  exit 1
fi

BR="intake/issue-$NUM"
git checkout -B "$BR"
git commit -m "intake: $TASK_ID <- issue #$NUM"
git push -u origin "$BR"
gh pr create --title "intake: $TASK_ID ← issue #$NUM" \
  --body "登記機械による自動 PR（ADR 0027・判断なし）。issue #$NUM を $TASK_ID として backlog に写す。backlog/ 以外に触れないことは workflow が機械検査済み。"

# checks 存在判定 merge（merge.mjs の checksNotRegistered() と同型の判定）
# GITHUB_TOKEN 構成では ci.yml が起動しないため checks は常に不在 = 即 merge 経路。
# checks が存在する将来の構成（task-22 等で branch protection 有効化時）は
# watch 経路が自然に機能する（追加変更不要）。
CHECKS_OUT="$(gh pr checks "$BR" 2>&1 || true)"
if echo "$CHECKS_OUT" | grep -qi 'no checks reported'; then
  # checks 不在 → 即 merge（deadlock しない）
  gh pr merge "$BR" --squash --delete-branch
else
  # checks 存在 → GREEN まで待ってから merge
  gh pr checks "$BR" --watch
  gh pr merge "$BR" --squash --delete-branch
fi

# issue close
gh issue comment "$NUM" --body "登記完了: $TASK_ID として backlog に登録しました（intake action・判断なし。priority 等の triage は盤面で）。"
gh issue close "$NUM" --reason completed
