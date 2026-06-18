import { Pool, types } from 'pg';

const JSON_OID = 114;
const JSONB_OID = 3802;

types.setTypeParser(JSON_OID, (value) => value);
types.setTypeParser(JSONB_OID, (value) => value);

export const DEFAULT_DATABASE_URL = 'postgres://lathe:lathe@localhost:55432/lathe';

export function getDatabaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

declare global {
  // eslint-disable-next-line no-var
  var __lathePgPool: Pool | undefined;
}

export function getPool(): Pool {
  if (!globalThis.__lathePgPool) {
    const pool = new Pool({ connectionString: getDatabaseUrl() });
    pool.on('error', (error) => {
      console.error(`[lathe-mcp-postgres] idle client error: ${(error as Error).stack ?? String(error)}`);
    });
    globalThis.__lathePgPool = pool;
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
  if (!globalThis.__lathePgPool) return;
  const pool = globalThis.__lathePgPool;
  globalThis.__lathePgPool = undefined;
  await pool.end();
}
