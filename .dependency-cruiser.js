/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      /**
       * I1-postgres-boundary:
       * lib/db.ts と lib/postgres.ts 以外が apps/web/lib/postgres を import するのを warn。
       * verdict route / analyst / lib/write 等が lib/postgres を直 import しているケースを捕捉。
       *
       * @/ エイリアスは options.tsConfig の paths で apps/web/* に解決する。
       *
       * scripts/ は architecture §5 の I1 機械強制対象外なので from.pathNot で除外。
       */
      name: 'I1-postgres-boundary',
      severity: 'warn',
      comment:
        'lib/db と ingest/db 以外が lib/postgres（queryOne/queryRows/getPool）を import している — I1 違反',
      from: {
        path: '^apps/web/(app|components|lib)/',
        pathNot: [
          '^apps/web/lib/db\\.',
          '^apps/web/lib/postgres\\.',
          // scripts/ は I1 機械強制対象外（architecture §5）
          '^apps/web/scripts/',
        ],
      },
      to: {
        path: '^apps/web/lib/postgres',
      },
    },
    {
      /**
       * I2-package-to-app:
       * packages/* が apps/web を import するのを warn。
       * 現状の既知違反: packages/mcp/src/server.ts:21, verify.ts:12-13
       *
       * .js 拡張子付き ESM 相対 import（例: ../../../apps/web/lib/mcp.js）は
       * enhancedResolveOptions.extensions で .ts にフォールバック解決される。
       */
      name: 'I2-package-to-app',
      severity: 'warn',
      comment:
        'packages/* が apps/web を import している — 依存方向違反 (I2)',
      from: {
        path: '^packages/',
      },
      to: {
        path: '^apps/web/',
      },
    },
    {
      /**
       * pure-core-no-io:
       * Pure core 層は PostgreSQL / Node I/O / Web DB adapter を import しない。
       *
       * TODO: packages/shared/src/harness.ts は既存の harness 実行支援として
       * node:fs と node:child_process を import しているため、I/O 分離後に例外を外す。
       */
      name: 'pure-core-no-io',
      severity: 'error',
      comment:
        'pure core が I/O（pg / fs / net / child_process / lib/postgres）を import している',
      from: {
        path: '(^apps/web/lib/db/rows\\.ts$|^packages/shared/src/|^packages/domain/src/)',
        pathNot: [
          '^packages/shared/src/harness\\.ts$',
        ],
      },
      to: {
        path:
          '(^node_modules/\\.pnpm/[^/]+/node_modules/pg/|^node_modules/pg/|^(node:)?(fs|net|child_process)$|^apps/web/lib/postgres|@/lib/postgres)',
      },
    },
    {
      /**
       * lib-db-internals:
       * apps/web/lib/db/* の内部モジュールは db.ts / read.ts facade 経由で利用する。
       * @/ エイリアスは options.tsConfig の paths で apps/web/* に解決する。
       */
      name: 'lib-db-internals',
      severity: 'error',
      comment:
        'lib/db の内部モジュールを deep import している — apps/web/lib/db または lib/read を経由する',
      from: {
        path: '^apps/web/(app|components|lib)/',
        pathNot: [
          '^apps/web/lib/db/',
          '^apps/web/lib/db\\.ts$',
          '^apps/web/lib/read\\.ts$',
        ],
      },
      to: {
        path: '^apps/web/lib/db/',
      },
    },
    {
      name: 'feature-internals-private',
      severity: 'error',
      comment:
        'components/<feature> の内部モジュールを別 feature から import している',
      from: {
        path: '^apps/web/components/([^/]+)/',
      },
      to: {
        path: '^apps/web/components/([^/]+)/',
        pathNot: '^apps/web/components/$1/',
      },
    },
    /**
     * I6-no-orphans:
     * 孤立モジュール（どこからも import されない・何も import しない）を warn。
     */
    {
      name: 'I6-no-orphans',
      severity: 'warn',
      comment: 'どこからも参照されていない孤立モジュール — デッドコード候補 (I6)',
      from: {
        orphan: true,
        pathNot: [
          // 設定ファイル類は orphan 判定から除外
          '\\.(config|setup|test|spec)\\.(js|ts|mjs|cjs)$',
          // e2e は独立実行なので除外
          'e2e/',
          // next.js 特有のエントリポイント
          'next\\.config',
          // 型定義ファイル
          '\\.d\\.ts$',
        ],
      },
      to: {},
    },
  ],

  options: {
    // node_modules をフォローしない（ただし解析の依存として記録はする）
    doNotFollow: {
      path: 'node_modules',
      dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg'],
    },

    // tsConfig は @/* -> apps/web/* の paths を resolver と TypeScript parser に渡すために使用する。
    // tsPreCompilationDeps: true で、未使用 import や type-only import も変換前の依存として捕捉する。
    // extraExtensionsToScan はディレクトリスキャン時に依存解析を壊すため使用しない。
    // packages/ の .ts ファイルは lint:deps スクリプトで直接パス指定する。
    tsConfig: {
      fileName: 'tsconfig.depcruise.json',
    },
    tsPreCompilationDeps: true,

    // ESM の .js 拡張子付き相対 import を解決できるようにする
    // (例: packages/mcp/src/server.ts が ../../../apps/web/lib/mcp.js を import)
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'],
    },

    // モジュール解決時のシステム
    moduleSystems: ['es6', 'cjs'],
  },
};
