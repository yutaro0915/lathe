# 調査: codex の cloud/リモート実行 × 自宅 mini-PC サーバー案（2026-07-02）

前提: ローカル駆動 driver（node が `claude -p` / `codex exec` を段ごとに spawn、サブスク認証、
transcript ローカル保存 → ローカル Postgres ingest）を A) cloud / B) mini-PC / C) 両立 のどれでスケールさせるか。
規律: disciplined-research（existence proof 先行・一次情報・未確認明示）。

---

## テーマ1: codex の cloud/リモート実行

### 1-1. `codex exec` のリモート認証 — サブスク認証は headless へ持ち出せるか

**結論: 持ち出せる（公式サポートの手段が 3 つ存在）。ただし公式は CI/CD には API key を推奨。**

公式ドキュメント（https://developers.openai.com/codex/auth ）が headless 向けに明記する手段:

1. **Device code auth**: `codex login --device-auth`。URL＋ワンタイムコードを別デバイスのブラウザで入力。
   事前に ChatGPT の security settings（個人）/ workspace permissions（Business 等）で
   「Allow device code login」を有効化する必要あり。
2. **auth.json コピー**: ブラウザのあるマシンで `codex login` → `~/.codex/auth.json` を scp で持ち出す。
   plaintext・可搬（`cli_auth_credentials_store = file | keyring | auto` で保存先制御）。
   公式注意書き: 「password と同様に扱え（commit しない・共有しない・chmod 600）」。
3. **SSH port forward**: `ssh -L 1455:localhost:1455` で OAuth callback をトンネルし通常ログイン。

- **Token 更新**: ChatGPT サインインの token は「使用中は自動 refresh」（公式）。
  「~8 日 idle で stale → 再ログイン要」という記述は二次情報（codex 派生 docs）で【未確認】。
  常駐 runner のように定期実行するなら自動 refresh が回り続けるため実務上問題になりにくい。
- **公式推奨**: 「programmatic な workflow（CI/CD 等）には API key 認証を推奨」（公式明記）。
  禁止ではなく推奨。単発 override は `CODEX_API_KEY=... codex exec`（exec のみ対応）。
- **規約上の扱い**: auth ドキュメントに「自分の複数マシン間コピー」を禁じる明文は無し。
  複数人での共有はアカウント共有として不可。OpenAI ToS のデバイス数上限の有無は【未確認】。
- **既知の穴**: workspace 管理者が device auth を無効にしていると headless ログイン不能
  （openai/codex issue #9253、open）。個人 Plus/Pro なら自分で有効化できる。

根拠:
- https://developers.openai.com/codex/auth （一次）
- https://github.com/openai/codex/issues/3820 / https://github.com/openai/codex/issues/9253
- https://developers.openai.com/codex/cli/reference

### 1-2. Codex cloud（公式クラウドタスク実行）

**結論: サブスク専用機能（むしろ API key では使えない）。外部からの trigger 面は
Web UI / GitHub @codex / IDE / CLI / Slack・Linear。汎用 HTTP API は確認できず【未確認】。**

- できること: OpenAI のクラウド環境で background task（コード読み書き・実行・PR 作成・
  並列 attempts（--attempts 1-4）・カスタム環境 setup）。
- trigger: chatgpt.com/codex（Web）/ GitHub issue・PR で `@codex` / IDE から delegation /
  CLI（`codex cloud exec`、`codex cloud list --json`・`codex cloud status/diff TASK_ID` で scripting 可）/
  Slack・Linear 連携（Plus/Pro/Business/Edu/Enterprise）。
- 認証: **ChatGPT サインイン必須**（Plus/Pro/Business/Edu/Enterprise）。API key モードでは
  cloud・GitHub 連携・Slack 連携が使えない（billing 2 トラックの区分）。
- 制約: **GitHub（cloud-hosted）repo 必須**。on-prem / 非 GitHub は SDK で自前構築せよ、が公式の案内。
- usage: ローカルメッセージと cloud task は同じ 5 時間窓の limit を共有。
- Codex SDK（`@openai/codex-sdk` TS / `openai-codex` Python beta）は「ローカルの Codex を
  プログラム制御」するもの。cloud task を叩く公開 HTTP API としては確認できず【未確認】。

根拠:
- https://developers.openai.com/codex/cloud （一次）
- https://developers.openai.com/codex/sdk （一次）
- https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan

### 1-3. GitHub Actions での codex — existence proof

**結論: 公式 action `openai/codex-action@v1` が存在（existence proof 成立）。
ただし認証は API key（OPENAI_API_KEY / AZURE_OPENAI_API_KEY）必須 = サブスクでは回せない。**

- 公式 action: install＋Responses API への secure proxy 構成まで面倒を見る。
  `prompt` / `codex-args` / `sandbox` / `safety-strategy`（default drop-sudo）等。
- サブスク認証での利用は issue #92（open の feature request）＝現状非対応が一次確認できる。
- auth.json を CI に持ち込み refresh させ続ける community 手法は存在するが二次情報【未確認】。
- 対照: Claude Code の公式 GitHub Action は `CLAUDE_CODE_OAUTH_TOKEN`（サブスク由来 token）を
  受け付ける構成が流通（Marketplace に OAuth 対応 action）。公式 action の最新のサブスク token
  対応状況は【未確認】。

根拠:
- https://github.com/openai/codex-action / https://developers.openai.com/codex/github-action （一次）
- https://github.com/openai/codex-action/issues/92
- https://developers.openai.com/codex/noninteractive

---

## テーマ2: 自宅 mini-PC サーバー案 vs cloud

### 2-1. サブスク認証の可搬性（最重要）

**結論: 両 CLI とも headless 常時稼働機でサブスク認証を維持できる。existence proof も複数
（headless VPS で Claude Code / codex を動かす公開ガイド・gist が多数）。**

- **Claude Code**: `claude setup-token`（ブラウザのあるマシンで実行）→ **1 年有効の OAuth token
  （sk-ant-oat01-…）** → サーバー側で `CLAUDE_CODE_OAUTH_TOKEN` に設定。Pro/Max/Team/Enterprise の
  サブスク枠で消費（API 課金にならない）。公式ドキュメントに記載の正規手段。
  - 保存場所: macOS = Keychain（暗号化）/ Linux = `~/.claude/.credentials.json`（0600 の平文）。
  - 注意: setup-token は自動 refresh なし＝**年 1 回再発行**。env var が credentials file を
    暗黙に上書きする優先順位（Bedrock/Vertex → ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY →
    apiKeyHelper → CLAUDE_CODE_OAUTH_TOKEN → subscription OAuth）に注意（issue #16238）。
  - 規約: Anthropic の OAuth token は Claude Code / claude.ai 専用（他プロダクト流用は Consumer
    ToS 違反）。公式バイナリをサーバーで走らせること自体の禁止規定は確認できず（この解釈は
    二次情報を含む【一部未確認】）。
- **codex**: テーマ 1-1 の通り device auth / auth.json コピーで維持可能。定期実行があれば
  自動 refresh で回る。
- **mac mini の位置づけ**: 「本人の別マシン」としてもっとも自然。macOS なので Claude Code は
  Keychain 保存が既定で、Linux 平文ファイルより保全が一段良い。device auth も自分の個人
  アカウントなら自己完結。再ログイン頻度: codex = 稼働継続なら実質不要（idle 長期放置のみ注意）、
  Claude Code = setup-token なら年 1 回。

根拠:
- https://code.claude.com/docs/en/authentication （一次）
- https://developers.openai.com/codex/auth （一次）
- existence proof: https://gist.github.com/coenjacobs/d37adc34149d8c30034cd1f20a89cce9 /
  https://codeongrass.com/blog/how-to-run-claude-code-on-a-remote-server/ （二次・動作報告）

### 2-2. 構成

**結論: 全部品が既製・標準技術で成立。lathe の「観測ローカル」前提と唯一整合する構成。**

- 常駐: macOS = launchd（mac mini）/ Linux = systemd。driver（node）は issue 起票を
  ポーリング（`gh` CLI / webhook 受け）で起動する形が素直。
- リモート起動・運用: Tailscale SSH（公開ポートゼロで自宅機へ到達、無料枠で十分）。
  tmux を実行基盤に（本 hub の既存規律と同じ）。
- gh push 権限: fine-grained PAT（対象 repo 限定・contents:write + pull-requests:write のみ）
  または GitHub App。broad な classic PAT を置かない。
- Postgres 同居: driver と同一機。transcript → ingest → 観測 DB が全部ローカルで閉じる
  （lathe の ingest 設計そのまま。cloud 案ではここが崩れる: Codex cloud の実行 transcript は
  手元の `~/.codex/sessions` に落ちない）。
- 【未確認】: Codex cloud のタスクログを後からローカル ingest 可能な形で全量取得できるか
  （`codex cloud diff/status` はあるが transcript 相当の完全ログ取得は未確認）。

### 2-3. コスト

**結論: ハード 2.3 万〜10 万円の一括＋電気代 月 100〜800 円程度。サブスク枠内で回す限り
限界コストはほぼゼロ。API 従量はエージェント負荷に比例して変動（サブスクの温存と正反対）。**

- mac mini M4（16GB）: **¥94,800〜**。実測 idle 3〜7W・負荷 40〜65W。
  日本の電気料金 ~31 円/kWh で idle 常時稼働 **月 100〜200 円**、高負荷連続でも **月 ~800 円** 程度。
  - https://support.apple.com/en-us/103253 （一次: Apple 公式の消費電力表）
  - https://www.jeffgeerling.com/blog/2024/m4-mac-minis-efficiency-incredible/ （実測 idle 3-4W）
  - https://macclaw.jp/articles/mac-mini-power-heat/ （日本の電気代実測ベース）
- N100 小型 Linux 箱（16GB/500GB）: 実売 **2.3〜4 万円**（TRIGKEY G4/G5、Beelink S12 Pro 等。
  2026 年はメモリ高騰で変動【価格は時点依存】）。idle 6〜10W、月 ~100〜130 円の報告。
  - https://kakaku.com/pc/stick-pc/itemlist.aspx?pdf_Spec102=51
- cloud 側: Codex cloud はサブスク内（5 時間窓を local と共有）。GitHub Actions で codex を
  回す場合は API key 従量が必須（1-3）。従量の絶対額は使用量依存のため本調査では定量化せず
  【未確認】。方向性のみ: 段 spawn 型 driver の常用を API 従量へ移すと、既払いのサブスクと
  二重払いになる。

### 2-4. リスク

**結論: 「repo 書込権 + LLM 認証が常時稼働機に同居」は事実だが、緩和策は標準的で保守負担は小さい。**

- 認証材の所在: `~/.codex/auth.json`（平文）/ `CLAUDE_CODE_OAUTH_TOKEN`（env）/ gh token。
  漏れれば サブスク悪用＋repo push が可能。緩和: 専用 OS ユーザー・chmod 600・FileVault/LUKS・
  Tailscale のみ（公開 SSH なし）・gh は fine-grained 最小権限・token 類を launchd plist や
  systemd unit の EnvironmentFile に集約し 600。
- prompt injection → push: driver が外部入力（issue 本文）を agent に渡す構造上、
  sandbox（codex の workspace-write / Claude Code の permission 設定）と FF-only・PR 経由
  merge（既存の lathe merge gate）を維持することが対策になる。
- 保守: macOS 自動アップデート再起動（launchd で自動復帰させる）/ Claude token 年 1 回更新 /
  codex は長期 idle 放置のみ再ログイン。停電・回線断は「止まるだけ」（cloud CI ゲートを
  併設していれば致命でない）。
- 規約リスク: 自分のマシン間での認証持ち出しは明示禁止の条文を確認できず（1-1・2-1）。
  ただし device 数・自動化の程度に関する OpenAI/Anthropic の将来的な運用変更は【未確認】。

### 2-5. 両立プラン（C 案）の型

**型 1: mini-PC = primary runner ＋ Codex cloud = 並列バースト（推奨候補）**
- mini-PC に driver＋CLI＋Postgres。通常の inner loop は全部ここ（サブスク温存・観測ローカル）。
- 混みあう時だけ `codex cloud exec` / `@codex`（サブスク内・同じ 5 時間窓）で並列タスクを
  cloud に逃がし、成果は PR で受けて mini-PC 側で通常フローに合流。
- 弱点: cloud 実行分の transcript がローカル観測に入らない（2-2 の未確認事項）。

**型 2: mini-PC = primary ＋ GitHub Actions = 決定的ゲート専用**
- LLM 不要の preflight / rubric gate（tsc・unit・e2e）だけを GH Actions に置き、merge の
  独立検証面にする。LLM は Actions で使わない（= API key 不要、サブスク二重払いなし）。
- LLM 判定を CI に置きたくなった箇所だけ、限定的に API key 従量（codex-action）または
  Claude 側 OAuth token 対応 action を検討。

**型 3: 全面 cloud 移行（A 案）**
- codex を GH Actions で常用 = API key 従量が必須（公式 action がサブスク非対応、1-3）。
  Codex cloud 常用 = GitHub repo 内で閉じ、driver の段制御・ローカル transcript・ローカル
  Postgres ingest という現行アーキテクチャを作り替えることになる。本件の前提と最も相性が悪い。

---

## 私見（サブスク前提・観測ローカルの本件での A/B/C）

**B（mini-PC）を primary にした C（型 1＋型 2 の併用）が素直です。**
A（cloud 全面）はサブスク前提と衝突します（公式 codex-action は API key 必須、Codex cloud は
transcript がローカルに残らず観測 DB の前提が崩れる）。B は両 CLI とも公式手段（device auth /
setup-token）でサブスク認証を維持でき、電気代は月数百円、driver・Postgres・transcript が
一箇所で閉じます。cloud は「サブスク内の Codex cloud を並列バースト」「LLM 不要の決定的 CI
ゲート」に限定して足すのが、二重払いなしで並列性と独立検証を得る最短路と考えます。
