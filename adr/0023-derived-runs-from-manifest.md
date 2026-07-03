# ADR 0023: run manifest を project-scoped derived runs として取り込む

- status: provisional
- date: 2026-07-03
- 関連: ADR 0013 / ADR 0014 / ADR 0016 / `docs/cost-semantics.md`

## 背景

inner-loop driver は `.lathe/runs/*.json` に段ごとの `session_id`、verdict、backend 起動情報を記録する。

これは段と transcript session を結ぶ正本だが、DB に取り込まれていない限り、SQL だけで「issue / plan の run がどの stage を通り、どの session と cost を持つか」を列挙できない。

一方で manifest は driver が直接書くローカル artifact であり、DB を正本にすると file と DB の二重書き込みになる。

## 決定

`.lathe/runs/*.json` を正本とし、DB の `runs` / `run_stages` は純粋派生テーブルにする。

`runs` は `(project_id, run_key)` を主キーにする。
`run_key` は manifest basename から `.json` を除いた値で、`issue-25`、`issue-25.attempt1`、`plan-43` のような値をそのまま保持する。

`project_id` は ingest 実行時に発見した repo root に対して `resolveProjectIdentity(repoRoot, basename(repoRoot))` で解決する。
これにより、複数 project に同名の `issue-23.json` が存在しても衝突しない。

`run_stages` は `(project_id, run_key, stage_index)` を主キーにする。
`session_id` は nullable な論理座標として保存し、`sessions` への FK は張らない。
derived island 内部の `run_stages -> runs` だけは `ON DELETE CASCADE` を許容する。

manifest の `backend_cost_usd` / `backend_cost_source` は backend launch envelope の値として保存する。
legacy `cost_usd` は `legacy_backend_cost_usd` としてのみ保存し、`backend_cost_usd` へ混ぜない。

`result_text` 全文は v1 では保存しない。

## 同期方針

incremental ingest は current project の `.lathe/runs` を走査し、manifest ごとに `runs` を upsert する。
対応する `run_stages` は一度削除してから stage order 通りに再挿入する。
これにより同一 manifest の再取り込みで stage が重複しない。

current project の `.lathe/runs` に存在しなくなった manifest row は削除する。
これにより `DROP TABLE run_stages, runs` 後も manifest から再構成でき、file 正本と DB 派生の関係を保てる。

`has_escalation` は同名 `*.escalation.md` の存在、または stage verdict `ESCALATE` から派生する。

## 撤回条件

- driver が manifest を正本として維持できなくなり、DB だけが完全な run 状態を持つ設計へ移行する場合。
- `.lathe/runs` の形式が複数 backend で分岐し、単一の派生 parser で安全に扱えなくなった場合。
- run stage と session の参照整合性を DB FK で強制する必要が生じ、nullable / missing session を許容する現行契約が破綻した場合。
