import { Pool } from 'pg';
import { closePool, DEFAULT_DATABASE_URL } from '../../lib/postgres';

export interface ScratchDatabase {
  schema: string;
  databaseUrl: string;
  originalDatabaseUrl: string;
  createPool(): Pool;
}

let scratchCounter = 0;

export function currentDatabaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

export function scratchDatabaseUrl(baseDatabaseUrl: string, schema: string, includePublic = true): string {
  const url = new URL(baseDatabaseUrl);
  const searchPath = includePublic ? `${schema},public` : schema;
  url.searchParams.set('options', `-c search_path=${searchPath}`);
  return url.toString();
}

function scratchSchemaName(prefix: string): string {
  return `${prefix}_${process.pid}_${Date.now()}_${scratchCounter++}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function withScratchDatabase<T>(
  prefix: string,
  fn: (scratch: ScratchDatabase) => Promise<T>,
  options: { includePublic?: boolean } = {},
): Promise<T> {
  const originalDatabaseUrl = currentDatabaseUrl();
  const schema = scratchSchemaName(prefix);
  const admin = new Pool({ connectionString: originalDatabaseUrl });
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);

  const previousDatabaseUrl = process.env.DATABASE_URL;
  const databaseUrl = scratchDatabaseUrl(originalDatabaseUrl, schema, options.includePublic ?? true);
  await closePool();
  process.env.DATABASE_URL = databaseUrl;

  try {
    return await fn({
      schema,
      databaseUrl,
      originalDatabaseUrl,
      createPool: () => new Pool({ connectionString: databaseUrl }),
    });
  } finally {
    await closePool();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}
