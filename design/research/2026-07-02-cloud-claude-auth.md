# Claude Code Cloud Runner 調査報告書

調査日: 2026-07-02
対象: GitHub Actions/cloud での Claude Code 実行
焦点: サブスク token（Pro/Max）を CI で使用できるか

---

## 1. 公式 GitHub Actions（anthropics/claude-code-action@v1）

公式 docs: https://code.claude.com/docs/en/github-actions
GitHub repo: https://github.com/anthropics/claude-code-action

### 何ができるか
- PR/Issue コメント内の `@claude` メンション自動検出
- 自動トリガー（スケジュール・push・issue 割り当て）で headless 実行
- issue/PR レビュー、バグ修正、機能実装を自動実行
- skills・plugin マーケットプレイス統合

### 自前 workflow（`claude -p` 直叩き）との違い
| 項目 | GitHub Action | `claude -p` 直叩き |
|------|-------|-----------|
| wrapper | あり | なし |
| plumbing | 自動 | 手動 |
| セットアップ | 自動化 | 手動 |
| 柔軟性 | 中程度 | 高い |

---

## 2. 認証（最重要）

参考: https://code.claude.com/docs/en/authentication

### 利用可能な認証方法（優先順）
1. AWS Bedrock（OIDC WIF）
2. Google Vertex AI（Workload Identity Federation）
3. ANTHROPIC_AUTH_TOKEN（raw bearer token）
4. ANTHROPIC_API_KEY（pay-per-token）
5. apiKeyHelper
6. CLAUDE_CODE_OAUTH_TOKEN（Pro/Max subscription）
7. /login（interactive、CI では不可）

### サブスク token（Pro/Max）を CI で使用できるか？

**技術的には可能だが、規約とリスクあり。**

#### 技術実現可能性：
- `claude setup-token` で長期有効な OAuth token 生成可能
- `CLAUDE_CODE_OAUTH_TOKEN` env var で CI runner に渡し可能
- CI で headless 実行時に認証可能

出典:
- https://code.claude.com/docs/en/authentication
- https://medium.com/@nimeshka/how-to-run-the-claude-code-cli-completely-headless-without-paying-for-api-keys-e04a72559f0f

#### 規約リスク：
Anthropic Consumer ToS に記載：
「OAuth authentication is intended exclusively for Claude Code and claude.ai, and using OAuth tokens obtained through Free, Pro, or Max accounts in any other product, tool, or service violates Anthropic's Consumer Terms of Service.」

CI/cloud での大規模自動化が「他のサービス」に該当するか、Anthropic の解釈次第。

出典: 
- https://medium.com/@lalatenduswain/claude-code-on-claude-max-plan-understanding-oauth-token-vs-api-key-authentication-in-2026-96a6213d2cde

#### 最大の実運用問題：Quota 競合
- OAuth token の quota は **個人の Pro/Max 枠から直接消費**
- local interactive session と **5h/7d quota を共有**
- CI が重い場合、人間の interactive session が rate limit に当たる可能性が高い

出典:
- https://medium.com/@lalatenduswain/claude-code-on-claude-max-plan-understanding-oauth-token-vs-api-key-authentication-in-2026-96a6213d2cde
  > "The OAuth token is tied to an individual's subscription and its usage draws from that subscription's rate limits. Heavy automated workflows may exhaust the quota that the engineer needs for interactive work during the same window."

---

## 3. CI での headless 実行の制約

参考: https://code.claude.com/docs/en/headless

### 読み込まれるもの
- `.claude/agents`（named agents）→ read-only
- `.claude/settings.json`（hooks, permissions）→ read-only
- CLAUDE.md（project guidelines）→ read-only
- hooks（PreToolUse, PostToolUse, Stop）→ **実行される**（重要）

### CLI オプション対応
- `--output-format json|stream-json` → ✅
- `--permission-mode dontAsk` → ✅
- `--bare-mode` → ✅（推奨、reproducibility のため）
- `--max-turns <n>` → ✅
- `--model <model-id>` → ✅

### 既知制限
- GitHub App が必要（読み込み権限・webhook のため）
- runner の node_modules stray symlink が巻き込まれる可能性
- Docker runner では filesystem isolation が完全でない可能性

---

## 4. レート・同時実行

参考:
- https://platform.claude.com/docs/en/api/rate-limits
- https://blog.laozhang.ai/en/posts/claude-code-rate-limit-reached
- https://blog.laozhang.ai/en/posts/claude-code-api-key-vs-subscription-billing

### API Key（pay-per-token）
- Tier 1: 500k input tokens/min, 80k output tokens/min（2026年値）
- Tier 2-4: ポートフォリオ・使用パターンで昇格

### OAuth Token（Pro/Max）
- 公開値なし（Anthropic が公開していない）
- 2 層制限:
  - 5h window（倍に増加、2026年更新）
  - 7d cap（総額制限）
- Max plan: Pro の約 5倍（非公開値）

### 並行実行
- 同一ユーザー/token での複数 runner → **同じ quota から消費**
- API key は tier ごとに limit が独立

### 現実的運用
- CI で `claude -p` を並列 spawn する場合、**API Key の使用が quota 競合が少ない**
- OAuth token の CI 使用 → 個人の interactive quota と奪い合う

---

## 5. コスト構造の比較

### モデル単価（2026年）
| Model | Input | Output |
|-------|-------|--------|
| claude-3-5-sonnet-6 | $3/1M | $15/1M |
| claude-opus-4.6 | $18/1M | $54/1M |
| claude-haiku-4.5 | $0.8/1M | $4/1M |

### API Key vs OAuth

#### API Key（従量課金）
- CI で月 10M input + 5M output → $30 + $75 = $105/月
- quota 独立、cost 予測可能

#### OAuth（Pro）
- 月額 $20（固定）
- rate limit 中程度、quota 競合
- 軽い CI ならコスト効率よい

#### OAuth（Max）
- 月額 $100-200（地域による）
- rate limit Pro の 5倍
- 同じ quota 競合問題は残る

### 判断基準
- **軽い CI**（月 1M tokens 以下）→ OAuth Pro $20
- **中程度**（月 3-10M tokens）→ API Key（$50-150）で quota 独立
- **重い CI**（月 50M+ tokens）→ Max または複数 API key で tier 上げ

---

## 未確認事項

1. Anthropic の明示的な ToS 解釈
   → OAuth token の CI 使用が実際に違反と見なされるか
   → サポートに問い合わせ推奨

2. Enterprise/Team plan での quota 扱い
   → ドキュメント未確認
   → Team/Enterprise 検討時に確認

3. Named agent の cloud runner での読み込み機序
   → `claude -p --agent <name>` が runner で動作することは明示ドキュメントにないが、
   → 技術的には可能と推定

---

## 結論

### サブスク温存のまま cloud 実行は可能か？

**A. 技術的に可能だが、実運用では推奨しない。**

1. **技術実現可能**: `claude setup-token` で token を生成 → `CLAUDE_CODE_OAUTH_TOKEN` で runner に渡し可能
2. **規約リスク**: ToS に「Claude Code・claude.ai のみ」とあり、大規模自動化での解釈余地あり → Anthropic に事前確認推奨
3. **Quota 競合**: 重大。CI が重い場合、個人の interactive session が rate limit に当たる可能性が高い

### 推奨構成

| 用途 | 認証 | 理由 |
|------|------|------|
| ローカル開発 | OAuth token（Pro/Max） | interactive + light automation 両対応 |
| **CI 本体** | **API Key** | quota 独立、rate limit 透明、cost 予測可能 |
| CI + local 並走激しい場合 | Team/Enterprise plan | 複数 user の quota を分離、explicit SLA |

**最小構成（Lathe workflow driver の場合）**:
1. GitHub Secrets に `ANTHROPIC_API_KEY`（org 単位）を登録
2. 月額 $50-150 の従量課金で運用
3. サブスク（Pro）は local interactive session のままにして quota を分離

---

## 参考 URL（一次情報・出典）

**公式 docs**:
- https://code.claude.com/docs/en/github-actions
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/headless
- https://github.com/anthropics/claude-code-action
- https://platform.claude.com/docs/en/api/rate-limits

**コミュニティ情報・実装例**:
- https://medium.com/@lalatenduswain/claude-code-on-claude-max-plan-understanding-oauth-token-vs-api-key-authentication-in-2026-96a6213d2cde
- https://medium.com/@nimeshka/how-to-run-the-claude-code-cli-completely-headless-without-paying-for-api-keys-e04a72559f0f
- https://blog.laozhang.ai/en/posts/claude-code-rate-limit-reached
- https://blog.laozhang.ai/en/posts/claude-code-api-key-vs-subscription-billing
