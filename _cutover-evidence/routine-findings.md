# Claude Code Routines — 仕様確認レポート

## 調査期間: 2026-07-08
## データソース: 公式ドキュメント（code.claude.com）+ GitHub Actions 仕様

## 1. 正式名称と所在

### 機能名称
**Routines** — Anthropic-managed cloud infrastructure で実行される自動化タスク

### 所在（複数面）
- **Web UI**: https://claude.ai/code/routines（Pro/Max/Team/Enterprise プラン必須）
- **Desktop App**: Routines セクション → New routine → Remote
- **CLI**: `/schedule` コマンド（Claude Code 内）
- **API**: `/fire` エンドポイント（experimental ベータ）

### 設定保存先
- Cloud account（claude.ai）に紐付け（ローカルファイルではなくクラウド）
- ユーザーのコンテキスト間で同期

---

## 2. トリガーと条件分岐

### トリガータイプ（複合可能）

#### A. Schedule Trigger
- **頻度**: 定期実行（最小 1 時間間隔）
  - プリセット: hourly / daily / weekdays / weekly
  - カスタム: cron 式対応
- **ワンタイム**: 特定タイムスタンプでの単発実行
- **タイムゾーン**: ユーザーのローカルタイムで自動変換（UTC に統一）
- **スタガー**: 実行時刻から数分のオフセット（同一ルーチンでは一貫）

#### B. GitHub Event Trigger
**サポートイベント**:
- `pull_request` (opened / closed / assigned / labeled / synchronize / etc)
- `release` (created / published / edited / deleted)

**フィルター機能** — すべて AND 条件:
| フィールド | マッチ内容 | 演算子 |
|-----------|---------|--------|
| Author | PR 作者の GitHub username | equals / contains / starts with / is one of / is not one of / matches regex |
| Title | PR タイトル | 同上 |
| Body | PR 説明文 | 同上 |
| Base branch | PR のターゲットブランチ | 同上 |
| Head branch | PR の作成元ブランチ | 同上 |
| **Labels** | PR のラベル | 同上 |
| Is draft | ドラフト状態 | true / false |
| Is merged | マージ済み | true / false |

**ラベル条件の例**:
```
labels: is one of ["needs-review", "bug-critical"]
→ これらのいずれかが付いた PR でトリガー
```

#### C. API Trigger
- **エンドポイント**: `POST /v1/claude_code/routines/{routine_id}/fire`
- **認証**: Bearer token（per-routine、ユニーク）
- **入力**: Optional `text` フィールド（freeform、JSON も literal string として受け取り）

### イベント・セッション対応
- 各マッチイベント = 独立した新セッション
- セッション再利用なし（GitHub trigger の場合）

---

## 3. 実行環境

### インフラ
- **所在**: Anthropic-managed cloud（ユーザーのマシン不依存）
- **生存性**: ユーザー PC off でも動作続行
- **Session 形式**: Autonomous cloud session（full Claude Code）

### 権限・制約
- **Permission mode**: なし（prompt 完全自動実行）
- **Permission prompts**: 実行中なし（事前設定時のみ）
- **Connectors**: 事前に指定したもののみ使用可
- **Skills**: Repository にコミットされたスキルは実行可

### 環境設定
- **Cloud environment**: Default or custom 選択
  - Network access: Trusted（default） / Custom / Full
  - Environment variables: Secret 化可（API key など）
  - Setup script: キャッシュされ再実行なし

---

## 4. 実行保証の意味論

### ルーチンレベル
- **保証形式**: 明記なし（ドキュメント上は「runs when trigger matches」）
- **重複排除**: GitHub webhook 対象に hourly cap（per-routine / per-account）
- **落ち: GitHub webhook event が cap 超過時は silently dropped**

### API トリガー
- **`/fire` 呼び出し**: 成功時は 200 + session ID 即座返却
- **ステータス値**: Green = infrastructure level のみ（task success ではない）
- **実行確認**: 返却 session URL を開いて transcript 確認必須

### ワンタイム実行
- **Daily cap 対象外**
- **Regular subscription usage のみ消費**
- **実行後は自動 disable**

---

## 5. 認証と権限

### ユーザー認証
- **主体**: claude.ai account（個人）
- **GitHub 連携**: `/web-setup` で OAuth またはデバイスフロー
  - 仕様: GitHub App installation token（reading only）
  - リポジトリクローン: Default branch から開始

### トークン・スコープ
- **Branch push 権限**: デフォルト `claude/` prefix のみ
  - Override: 「Allow unrestricted branch pushes」を per-repo 設定
- **Force push**: 禁止（ドキュメント非言及だが仕様で `claude/` prefix 限定）

### Connector 権限
- **MCP connector**: 指定したものすべて use-without-prompts
- **Local MCP servers**: 非対応（`.mcp.json` で repository-scope に declare なら included）

---

## 6. Skills との関係

### スキル実行形式
- **GitHub Actions**: `prompt: "/skill-name"` で指定
- **Routines**: Repository に committed した skill は自動 included
- **CLI**: `/schedule` で skill を部分的に指定可（予 conversational）

### スキルの可用性
- **Local skills** (`.claude/skills/`): Routines では **未対応**（cloned repo には含まれない）
- **Plugin skills**: Routine 作成時に plugin marketplace を指定して include 可
- **同名競合**: Plugin skill > local skill

---

## 7. 制約

### Rate & Capacity
| 項目 | 値 |
|-----|---|
| Schedule 最小間隔 | 1 時間 |
| Daily routine runs | Per-account cap（表示 at claude.ai/code/routines） |
| GitHub webhook hourly | Per-routine + per-account cap |
| Session タイムアウト | 不明記 |
| Max concurrent | 不明記 |

### 料金・消費
- **Subscription draw**: regular interactive session 同等
- **One-off runs**: daily cap 非対象、subscription usage のみ
- **GitHub Actions**: GitHub minutes 別途消費

### 有効期限
- **API token**: 無期限（rotate / revoke 可）
- **GitHub webhook**: 不明記（90 日推奨が GitHub 標準、但し Routines 公式仕様なし）
- **Schedule**: 一度 disabl

e されたら再 enable 要

### 対応リポジトリ
- **Private**: Support（GitHub OAuth or App で認可）
- **External**: Yes（複数 repo 指定可）

---

## 8. GitHub Actions との関係性

### Claude Code GitHub Actions
- **実行基盤**: GitHub Actions runner（standard Ubuntu latest）
- **claude-code-action@v1**: Full Claude Code runtime 内包
- **トリガー**: GitHub event（issue_comment / pull_request 等）
- **条件**: GitHub Actions native `if:` + claude-code-action 自体のフィルタなし
  - Label filter は Actions workflow level で実装（Routines の GitHub trigger フィルタとは異なる）

### 2 つの仕組みの選択肢
1. **Routines の GitHub trigger** → Label filter native サポート、自動新セッション
2. **GitHub Actions workflow** → `if:` で条件制御、claude-code-action@v1 で実行

---

## 9. 未確認項目

❓ **At-least-once vs At-most-once**: 不明記  
❓ **Missed run catch-up**: Desktop tasks の「7 日以内で 1 回」ルールが Routines に適用されるか不明  
❓ **Session re-use**: GitHub trigger で同一 event 重複時の dedup 戦略  
❓ **Max concurrent routines**: 並列実行上限  

---

## 適合所見 — GitHub issue ラベルで自動開発ループを実装できるか

✅ **基本的に可能。2 つの実装パターン**:

1. **Routines GitHub trigger（推奨）**
   - Label フィルタで PR ラベル条件を指定
   - `needs-plan`/`in-review`/`needs-impl` など label 状態で自動トリガー
   - **制約**: Release / PR event のみ（Issue label では未対応）

2. **GitHub Actions workflow（代替）**
   - `if:` で GitHub Actions ネイティブ条件制御
   - Issue label ぐるみで対応可（Issue event trigger 対応）
   - **制約**: PC off でも動く guaranty なし（Actions runner は GitHub infrastructure）

**Lathe auto-development loop への推奨**:  
Issue ラベルを承認入力（plan/impl/review 段階）としたい場合は、Routines GitHub trigger では PR ベースのみで Issue label トリガーは直接不可。代案は Issue comment に `@claude` + label を組み合わせるか、外部 webhook で orchestrate する設計。

