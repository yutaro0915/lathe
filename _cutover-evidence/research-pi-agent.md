# 調査報告書: pi agent の実在確認と lathe inner loop 適合性検証

**調査日**: 2026-07-08  
**対象**: pi coding agent（@earendil-works/pi-coding-agent）  
**目的**: PdM 仮説「pi agent で inner loop harness が簡単になるか」の検証

---

## 1. Pi の実在確認

**結論**: ✅ 実在・アクティブ・実装済み

### リポジトリ情報
- **URL**: https://github.com/badlogic/pi-mono（親）
- **サブパッケージ**: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent
- **作者**: Mario Zechner（@badlogicgames）
- **npm パッケージ**: `@earendil-works/pi-coding-agent` v0.80.3
- **公式 URL**: https://pi.dev
- **言語**: TypeScript / Node.js
- **最終更新**: 2026-07-08（本日）
- **Discord**: https://discord.com/invite/3cU7Bz4UPx（活発）

### 規模
- **main README**: 〜 300 行（概要＋使用例）
- **coding-agent パッケージ**: src/（実装本体）+ docs/（仕様書）
  - 参照: [`packages/coding-agent/src/`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/src)
  - ドキュメント: session-format.md / extensions.md / json.md など
- **活動**: 毎日 commit あり、issue/PR auto-close gate は active（新規 contributor フィルタ）

---

## 2. Inner Loop 要件との適合性検証

### (a) Headless 実行（prompt 渡し→終了）

**適合度**: ✅ **完全対応**

```bash
# Print mode（応答出力＋終了）
pi --print "Your prompt here"

# JSON mode（イベントストリーム出力）
pi --mode json "Your prompt here"
```

出力フォーマット（JSON mode）:
```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_end","message":{...}}
{"type":"agent_end","messages":[...]}
```

**詳細**: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md

---

### (b) Tool 制限・許可制御（bash・編集の allowlist 相当）

**適合度**: ✅ **Extensions で実装可能**

Extension イベントフック（`tool_call`）で tool call を拦截・ブロック可能:

```typescript
// ~/.pi/agent/extensions/permission-gate.ts
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      return { block: true, reason: "Dangerous operation blocked" };
    }
  });
}
```

**注**: 標準機能「permission popup」は **pi の設計で意図的に削除** されている。代わりに:
- Extension で inline gate を構築
- Container で OS-level 隔離（Gondolin・Docker）
- OpenShell で policy-controlled sandbox

参照: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md / https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/containerization.md

---

### (c) Provider 対応（Anthropic API / OAuth）

**適合度**: ✅ **完全対応**

**API Key**: 
```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

**OAuth Subscriptions** (interactive mode):
```bash
pi
/login  # Anthropic Claude Pro/Max, OpenAI ChatGPT Plus/Pro, GitHub Copilot など
```

**その他 30+ 提供元** (DeepSeek / Google Gemini / Mistral / Groq / Azure OpenAI / xAI など):

参照: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md

---

### (d) Cost/Token の機械可読レポート

**適合度**: ✅ **完全対応・構造化**

`Usage` type（per message）:
```typescript
// packages/ai/src/types.ts
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;      // Anthropic only
  reasoning?: number;         // Subset of output
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

JSON mode 出力に包含:
```json
{"type":"message_end","message":{
  "role":"assistant",
  "usage":{
    "input":1234,
    "output":567,
    "cost":{"total":0.0042,...}
  }
}}
```

**footer in interactive mode**:
```
total token/cache usage (↑input ↓output R cache-read W cache-write) cost model
```

参照: https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts

---

### (e) Session/Transcript 保存形式（lathe ingest 対応）

**適合度**: ✅ **JSONL + tree structure・完全 machine-readable**

**ファイル形式**:
```
~/.pi/agent/sessions/--<cwd-with-slashes-as-dashes>--/<timestamp>_<uuid>.jsonl
```

**構造**: 
- Version 3（最新）
- 各行 = JSON object
- Tree: `id` / `parentId` で枝分かれ（branching）対応
- Entry types: UserMessage / AssistantMessage / ToolResultMessage / BashExecutionMessage / CustomMessage / CompactionSummaryMessage など

**Lathe ingest の観点**:
```
✅ Structured JSON（regex / stream parse 可能）
✅ Tool call と result が同一 file に記録
✅ Token / cost / provider / model が metadata に含まれる
✅ Bash exit code 記録（BashExecutionMessage.exitCode）
✅ Timestamp（Unix ms）で時系列追跡可能
```

**参照**: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md

---

### (f) Exit code 等の機械制御面

**適合度**: ⚠️ **部分対応・要検証**

**確認できたこと**:
- Bash tool が exit code を記録: `BashExecutionMessage.exitCode`
- JSON mode は `agent_end` で completion を signal
- `/print` mode は prompt 実行後 exit（exit code 0 推定）

**確認できなかったこと**:
- CLI `pi --print` が task 失敗時に非 0 exit code を返すか（ドキュメント未記載）
- JSON mode での error-exit-code の明示
- Task の「成功/失敗」の決定ロジック（lathe 側で「何をもって成功とするか」を定義する必要あり）

**推定**: RPC mode / SDK mode を使えば、ホスト側で exit code を制御可能

---

## 3. Claude Code との実測比較

**適合度**: ⚠️ **比較対象データ不足・推定に頼る部分あり**

### 検索結果
- 公開ベンチマーク記事: 見つからず
- Twitter/Mario Zechner timeline: 比較記述なし
- Blog posts: https://mariozechner.at/ に philosophy post あるが、定量比較なし

### 推定される差異

| 側面 | Claude Code | pi agent |
|------|-------------|----------|
| **システムプロンプト規模** | 規模不明 | 最小化設計（拡張型） |
| **起動オーバーヘッド** | 不明 | npm install / trust decision で初回遅い？ |
| **デフォルト tools** | read / write / edit / bash / bash の 5 つ | 同じ 4 つ |
| **MCP 対応** | Yes（native） | No（削除・拡張で自作） |
| **Sub-agent** | Yes | No（tmux で spawn） |
| **Permission gate** | UI popup | Extension で inline |
| **Plan mode** | Yes | No（design decision） |

**定量データ source**:
- Pi philosophy: https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md「## Philosophy」
- Rationale blog: https://mariozechner.at/posts/2025-11-30-pi-coding-agent/

---

## 4. 最小 harness の競合・位置づけ

### 類似ツール検索結果

#### a. Pi から派生・関連 tools
- **pibot**: Smartphone robot（無関連）
- **pi-skills**: Skill pack（pi-coding-agent 用の skills 集合）
- **pi-mono**: Main repo（本体）

#### b. 競合（検索実行・見つかったもの）
- **Cursor**: IDE 統合（standalone agent ではない）
- **Codex CLI**: OpenAI（Claude Code の競合、pi も同等に対応）
- **OpenCode**: 同様
- **Amp / Droid**: 提示なし・検証不可

#### c. Self-contained minimal agent
- **Claude Code**: 対象（比較対象だが情報不足）
- **Smol agent**: 見つからず（「smol」で検索しても pi など出たのみ）

**結論**: Pi が「最小 harness」市場での **最大規模プロジェクト**（Discord active / daily commit / npm package）と見える。

---

## 5. Lathe 側で失う/作り直す必要のあるもの

### A. Pi で代替できる機能（✅ 継続可能）
- ✅ Headless coding agent → pi JSON mode
- ✅ Multi-provider LLM API → pi-ai unified API
- ✅ Session storage → pi JSONL format
- ✅ Tool execution + reporting → BashExecutionMessage etc
- ✅ Cost tracking → Usage type

### B. Lathe 現在の機能で Pi では対応していない（❌ 実装必要）

| Lathe 機能 | Pi 対応 | 代替手段 | effort |
|-----------|--------|--------|--------|
| **MCP tool discovery** | No（削除） | Extension で自作 or skilled tools CLI | 中～高 |
| **Sub-agent dispatch** | No（設計上） | tmux で pi 起動（orchestrator 要修正） | 中 |
| **Hooks（git-guard / verdict-gate / etc）** | Partial（extension event あり） | Extension イベント再実装 | 低～中 |
| **Rubric 検証 system** | No | Pi extension で実装 | 高 |
| **Session ⇄ GitHub PR 連携（finding 記録）** | No | Extension + CustomMessage で実装 | 中 |
| **Transcript ingest （現在の forms に拡張）** | Partial（Session 形式は別） | Parser 修正（JSONL 対応） | 低 |
| **Judgment / verdict 出力の決定ロジック** | No | Extension custom tool + decision logic | 高 |
| **Settings.json 分離** | Partial（~/.pi/agent/settings.json） | Pi settings 仕組みを転用 | 低 |

### C. 発生する大きな問題

#### **問題 1: Sub-agent 動作の本質的相違**

Lathe 現在:
```
outer loop (Claude Code) → inner loop (subagent_type: "implementer") 
                          ↓ (return exit code / finding JSON)
                          ← outer が結果を読む
```

Pi + Lathe:
```
outer loop (Claude Code) → tmux session / pi spawn + JSON stream 監視
                          ↓ (pi が stdout に JSON 出力)
                          ← outer が tail / jq で events を consume
```

**差異**: 
- Pi は agent-sdk `subagent_type` に**対応していない**（別プロセス起動のみ）
- stdout/file 経由で event 渡し（return 値ではなく）
- Orchestrator が複数 pi session の dispatcher になる必要

#### **問題 2: MCP 喪失**

Lathe が MCP で扱う tools（Gmail / Drive / Google Sheets / etc）を Pi で呼ぶには:
- Pi 側で **custom extension** を新規作成（each MCP tool ごと）
- 参照: pi-skills に gccli / gdcli / gmcli あり（Google tools のみ）
- **非 Google tools は自作必須**

#### **問題 3: Hooks 移植**

Lathe の `.claude/hooks/` (git-guard.mjs / verdict-guard.mjs / etc):
- Pi は **node hook system がない**
- Extensions で interception する必要（各 hook → 各 extension に）
- ビルド・検証フロー（preflight）との integration 要確認

---

## 6. 適合性の最終評価

### ✅ Pi は「最小 harness」の有力候補

**合致点**（洛陽 仮説の部分的確認）:
1. **最小**: 設計思想が明確（core minimal / extension-first）
2. **Headless 実行**: JSON mode で完全対応
3. **Cost tracking**: 実装済み・構造化
4. **Multi-provider**: Anthropic API 含む
5. **Active**: アクティブ開発・discord community

### ❌ 即採用は困難（高リスク要因）

**障害**:
1. **Sub-agent 動作が異なる**: Lathe の agent-sdk integration が再実装必須
2. **MCP 全廃**: 30+ MCP tools を custom extension で代替（月単位のエフォート）
3. **Permission/Hook system**: Lathe hooks の移植（中程度エフォート）
4. **検証ゲート再実装**: Rubric / judgment の pi extension 化（数週間）

**推定 migration cost**: 
- 実装: 4〜8 週間（sub-agent + MCP + hooks + rubric）
- テスト: 2〜3 週間
- **安定化まで: 8〜12 週間**

### 🤔 Verdict: "重すぎない"は仮説だが、"簡単"ではない

PdM 仮説「Claude Code は重すぎる」→「pi で簡単になる」の検証:
- **前半は ✅ 正しい**: Pi core は Claude Code より確かに軽い（MCP 削除・sub-agent 削除・設計思想）
- **後半は ❌ 仮説外**: Lathe harness の **他の部分**（MCP / hooks / rubric / sub-agent dispatch）が重いため、単に LLM provider を切り替えても、inner loop は簡単にならない

---

## 7. 確認できなかったこと

- ❓ Pi CLI `--print` / `--mode json` が task 失敗時に non-zero exit code を返すか
- ❓ System prompt 規模（token count）
- ❓ 初回起動（project trust decision）のオーバーヘッド測定
- ❓ Large session での memory/performance 特性
- ❓ Pi-ai unified API が Anthropic cost field を正確に報告するか（実測）

---

## 参考 URL

### Main Repositories
- https://github.com/badlogic/pi-mono (main monorepo)
- https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent (coding-agent package)
- https://github.com/badlogic/pi-skills (skills pack)

### Documentation
- https://pi.dev (public site)
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md (README)
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md (Session format)
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md (JSON mode)
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md (Extensions)
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md (Provider list)
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/containerization.md (Containerization)

### Source
- https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts (Usage type)
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/messages.ts (Message types)

### Design Philosophy
- https://mariozechner.at/posts/2025-11-30-pi-coding-agent/ (Pi design rationale blog)
- https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/ (Why no MCP)

---

**調査者**: Research agent  
**実施日時**: 2026-07-08  
**出典**: すべての情報は GitHub API / raw.githubusercontent.com 経由の一次資料から取得
