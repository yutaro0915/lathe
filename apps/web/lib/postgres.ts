import { Pool, types } from 'pg';

const JSON_OID = 114;
const INT8_OID = 20;
const JSONB_OID = 3802;

types.setTypeParser(INT8_OID, (value) => Number(value));
types.setTypeParser(JSON_OID, (value) => value);
types.setTypeParser(JSONB_OID, (value) => value);

export const DEFAULT_DATABASE_URL = 'postgres://lathe:lathe@localhost:55432/lathe';

export function getDatabaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

declare global {
  // eslint-disable-next-line no-var
  var __lathePgPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __lathePgPoolUrl: string | undefined;
}

export function getPool(): Pool {
  const url = getDatabaseUrl();
  if (!globalThis.__lathePgPool || globalThis.__lathePgPoolUrl !== url) {
    if (globalThis.__lathePgPool) {
      void globalThis.__lathePgPool.end().catch(() => {});
    }
    const pool = new Pool({ connectionString: url });
    pool.on('error', (error) => {
      console.error(`[lathe-postgres] idle client error: ${(error as Error).stack ?? String(error)}`);
    });
    globalThis.__lathePgPool = pool;
    globalThis.__lathePgPoolUrl = url;
  }
  return globalThis.__lathePgPool;
}

export async function queryRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

export async function queryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await queryRows<T>(sql, params);
  return rows[0];
}

export async function closePool(): Promise<void> {
  if (globalThis.__lathePgPool) {
    const pool = globalThis.__lathePgPool;
    globalThis.__lathePgPool = undefined;
    globalThis.__lathePgPoolUrl = undefined;
    await pool.end();
  }
}
