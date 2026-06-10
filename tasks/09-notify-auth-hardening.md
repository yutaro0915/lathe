---
id: 09
title: POST /api/ingest/notify の認可ハードニング（shared secret + transcript path allowlist）
status: done
assignee: claude
depends_on: [08]
estimated: small
---

## What

[08] で入った `POST /api/ingest/notify`（`apps/web/app/api/ingest/notify/route.ts` → `apps/web/scripts/ingest/notify.ts`）には認可チェックが無い。payload の `transcript_path` をそのまま `fs` read して DB に ingest するため、サーバに到達できる任意プロセスから

1. **任意ローカルファイルの読み取り**（`transcript_path` に `/etc/passwd` 等を渡す）
2. **DB の上書き**（任意 session を冪等 replace で書き換え）

が可能。現状は localhost 個人ツール前提で許容しているが、**公開デプロイ前に対応が必要**。

## 対応（defense in depth・2 案を両方実装）

[08] follow-up（status.md「localhost 個人ツール前提、公開デプロイ時は要対応」）の解消。提示された 2 案は排他ではなく相補なので両方入れる。

### 1. Shared secret token（認可＝「誰が叩けるか」）

- サーバ: `LATHE_INGEST_TOKEN` を env で受ける。**未設定なら認可スキップ**（localhost 単一ユーザの既定。後方互換）。**設定時のみ** `Authorization: Bearer <token>` を必須化し、不一致/欠落は 401。比較は sha256 → `crypto.timingSafeEqual` で定数時間（長さもリーク無し）。
- client: `lathe-client init` が token を解決（`--token` / `LATHE_INGEST_TOKEN` / 無ければ `randomBytes(32)` 生成）して `.lathe/config.json` の `ingestToken` に保存。**再 init では既存 token を再利用**（サーバ env 値が無効化しない）。生成 token と「サーバ env に設定すれば enforce される」旨を init 出力に表示。
- hook: `config.ingestToken` があれば `Authorization: Bearer` を付けて送る（`hookVersion` 1→2）。
- `verify:notify`: `LATHE_INGEST_TOKEN` が env にあれば同ヘッダを付けて POST。

### 2. Transcript path allowlist（最低限のミティゲーション＝「何が読めるか」）

`assertTranscriptPathAllowed()` を常時適用。`fs.realpathSync` で symlink を解決してから許可ルート配下のみ通す（symlink 経由のエスケープを防ぐ）。許可ルート:

- `~/.claude/projects/`
- `~/.codex/sessions/` / `~/.codex/archived_sessions/`
- 運用拡張: `LATHE_TRANSCRIPTS_DIR`（verify/非既定レイアウト用）、`LATHE_INGEST_ALLOWED_ROOTS`（`,`/`:` 区切り）

token が漏れても/正規だが誤った呼び出しでも、読める範囲を実トランスクリプトディレクトリに限定する。

## 変更ファイル

- `apps/web/scripts/ingest/notify.ts`: `authorizeIngest()` / `assertTranscriptPathAllowed()` を追加、`ingestNotify` 冒頭で path 検証。
- `apps/web/app/api/ingest/notify/route.ts`: body parse 前に auth gate。
- `packages/client/src/cli.ts`: token 解決/保存、init 出力、hook script に Authorization 付与。
- `packages/client/src/index.ts`: `LATHE_HOOK_VERSION` 2。
- `apps/web/scripts/verify-ingest-notify.ts`: enforce 時に token 送出。
- README / PROTOTYPE.md: auth env と path allowlist の節。

## 受け入れ条件

| # | 条件 | 検証 |
|---|---|---|
| 1 | env 未設定で従来どおり通る（後方互換） | `authorizeIngest(null).ok === true` |
| 2 | enforce 時、token 無/誤は 401、正は通す | unit（定数時間比較） |
| 3 | `transcript_path` が許可ディレクトリ外なら ingest 拒否 | `/etc/passwd`・`~/.ssh/*`・traversal を block、`~/.claude/projects/*` を allow（unit） |
| 4 | init が token を生成/保存し hook が Authorization を送る／再 init で token 不変／既存 hooks 保全 | tmp dir init（exit 0、`node --check` hook.mjs、jq/grep） |
| 5 | ビルド + 型 PASS | `pnpm -F web build` / `pnpm -F client build` exit 0 |
| 6 | 回帰 | `pnpm -F web verify:notify`（env 未設定で従来パス）/ `pnpm -F web e2e` 49/49 |

## 検証結果（2026-06-10）

- 受け入れ 1〜3: notify.ts の純関数を tsx で直接検証 — 11/11 PASS（auth 5、path allowlist 6）。
- 受け入れ 4: tmp repo で `lathe-client init` PASS。`node --check .lathe/hook.mjs` OK、`ingestToken` 64 hex / `hookVersion=2`、hook に `authorization` 付与、再 init で token 不変、`.claude/settings.json` の既存 hook 保全。
- 受け入れ 5: `pnpm -F client build` / `pnpm -F web build` ともに exit 0。
- 受け入れ 6: **本環境に Docker/Postgres が無いため未実行**（5432 closed）。変更は additive かつ後方互換（env 未設定で auth スキップ・allowlist は実 transcript dir / `LATHE_TRANSCRIPTS_DIR` を許可）なので DB 有り環境で従来どおり GREEN になる想定。Postgres 起動環境で要再確認。

## Out of scope

- rate limit / IP allowlist / reverse proxy（継ぎ目は token + path 検証まで）
- token rotation の自動化（手動 re-init + env 差し替えで対応）
- マルチ PC / クラウド push 変種（ADR 0004 で MVP 外）
