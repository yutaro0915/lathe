# ADR 0005: ハーネスのモデル = artifact 集合 + provider binding（統一 IR 不採用・完全分離不採用）

- Status: accepted
- Date: 2026-06-11
- 決定者: yutaro0915（提案: Claude）

## Context

Phase 2 以降、Lathe はハーネスを一級概念として扱う（版数・改善・採否・回帰検知）。
その表現として 2 案が検討された:

- **A. provider 非依存の統一ハーネス（意味論レベルの IR + provider 適応ロジック）**:
  どの基盤にも合わせたハーネスを提供できるが、hook の event 体系・skill 形式・設定スキーマは
  provider ごとに意味論が違い、N=2（Claude Code / Codex）で双方向変換層を作るのは過剰抽象。
  変換は必ず lossy になる。
- **B. provider ごとに完全分離（CC ハーネスは CC で、Codex ハーネスは Codex で管理）**:
  シンプルだが実態に合わない。現実の repo（LLMWiki hub、lathe 自身）は AGENTS.md を正本に
  CLAUDE.md を薄い redirect とし、**1 つのファイルを両 agent が読む**。完全分離だと共有
  ファイルへの 1 改善が二重 finding / 二重採否記録になり、共有 artifact の変更が両 provider の
  ハーネス版数を変えるという回帰検知（G7）に不可欠な因果が表現できない。

## Decision

### 1. ハーネス = repo 内の artifact 集合 + provider binding + hash 版数

```
harness(repo) = {
  AGENTS.md             → [claude-code, codex]   # 共有
  CLAUDE.md             → [claude-code]
  .claude/settings.json → [claude-code]
  .codex/config.toml    → [codex]
  skills/<name>/        → 実態に応じて
}
harness_version(provider) = その provider が読む artifact subset の content hash
```

- 意味論（hook の中身、skill の構造）は理解しない**意図的に浅いモデル**。ファイル・binding・
  ハッシュのみ扱う。
- provider 適応ロジックは **discovery（どのファイルをどの provider が読むか）だけ**に縮退する。
  この知識は Phase 1 のハーネス信号観測（nested CLAUDE.md/AGENTS.md 読み込み・hook 発火・
  skill 読み込みのイベント化）として実装済み。
- 共有 artifact の変更は、それを読む全 provider のハーネス版数を自然に変える。
  provider 固有 artifact への改善は自然にその provider だけを対象にする。

### 2. agent = runner × model × harness 版の導出タプル（エンティティ化しない）

- 提案書 §0 の「エージェント＝モデル＋ハーネス」に、観測実態として runner（provider CLI）を
  加えた 3 座標: **runner / model / harness_version**。
- agent は CRUD を持つ管理対象テーブルにしない。session・実験 run が座標
  （runner / runner_version / model / harness_version）を**記録**し、agent はその
  GROUP BY ビュー（grouping key）として導出する。
- 理由: agent にライフサイクルを持たせると、model 更新のたびに agent が分裂し、命名・管理の
  負担だけが残る。管理対象は harness（版つき artifact 集合）に一本化する。
- Phase 3 実験 config はこのタプルを明示的に固定する（runner と model を固定し、harness 版だけ
  変えて並走）。G7 の回帰タイムラインは harness 版を主軸にし、runner / model の変化は
  confound marker（注釈）として同じ時間軸に重ねる — モデル交代由来のスコア変動をハーネスに
  誤帰属させない。

### 3. ハーネス意味論は意図的に未決とし、CC/Codex 運用から Phase 5 ゲートで一般化

- loop をどう扱うか / rubric・eval はハーネスの要素か / 操作（編集・適用）の UX /
  basic harness の一般形 — これらは**今決めない**。
- N=2（CC / Codex）の dogfood 運用（Phase 2〜4）で実例とヒントを集め、**Phase 5 開始ゲート**で
  一般化する（具体例が揃う前の統一は「間違った抽象」になり、重複より高くつく）。
- 運用中に気づいた provider 差・一般化のヒントは status.md / design ノートに都度記録する。

### 4. Phase 1 ではハーネスの追跡・管理を完全にスコープ外とする（2026-06-11 ユーザー決定）

- Phase 1 に**残す**もの: ハーネス信号の観測（transcript 上のイベント。実装済み）。
- Phase 1 で**作らない**もの: ハーネス snapshot / 版数 / inventory（追跡）、編集・適用（管理）。
  版数の導入は Phase 2 開始ゲート（ROADMAP「Phase 2 開始ゲートで確定する界面契約」1 番）。
- 後追い可能性: ハーネス artifact は git 管理下のファイルであり、session は branch / commit を
  記録している。Phase 2 で版数導入後、過去セッションの harness 版は git 履歴から再構成できる。

## Consequences

- Phase 2 データモデル設計は、本 ADR の浅いモデル（artifact / binding / hash）を前提に
  finding・採否・スコアを設計する。意味論の理解を前提にしない。
- 統一 IR を作らないため、「どの基盤にも合わせたハーネスを提供する」汎用化は Phase 5 まで
  約束しない。Phase 5 ゲートでの一般化は本 ADR の改訂（または新 ADR）として行う。
- binding の判定（どのファイルをどの provider が読むか）が誤ると版数が誤る。判定根拠は
  Phase 1 の観測イベント（実測）を優先し、静的な規約（ファイル名パターン）は補助とする。
