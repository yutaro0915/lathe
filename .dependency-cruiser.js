/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      /**
       * I1-postgres-boundary:
       * lib/db.ts と lib/postgres.ts 以外が apps/web/lib/postgres を import するのを warn。
       * verdict route / analyst / lib/write 等が lib/postgres を直 import しているケースを捕捉。
       *
       * 注意: Next.js の @/ エイリアスは depcruise では実パスに解決されず
       * "resolved" が "@/lib/postgres" のまま残る。
       * そのため to.path は実パスと @/ エイリアスの両方をカバーする。
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
        // @/ alias が解決されていない場合（"@/lib/postgres"）と
        // 解決済みの実パス（"apps/web/lib/postgres"）の両方をカバー
        path: '(^apps/web/lib/postgres|@/lib/postgres)',
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

    // tsPreCompilationDeps: false で @/ エイリアスが resolved 値として取得できる。
    // tsConfig の tsc は next-env.d.ts がないと TS18003 エラーになるため使用しない。
    // extraExtensionsToScan はディレクトリスキャン時に依存解析を壊すため使用しない。
    // packages/ の .ts ファイルは lint:deps スクリプトで直接パス指定する。
    tsPreCompilationDeps: false,

    // ESM の .js 拡張子付き相対 import を解決できるようにする
    // (例: packages/mcp/src/server.ts が ../../../apps/web/lib/mcp.js を import)
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'],
    },

    // モジュール解決時のシステム
    moduleSystems: ['es6', 'cjs'],
  },
};
