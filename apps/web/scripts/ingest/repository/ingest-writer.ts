import type { Pool, PoolClient } from 'pg';
import type { Built } from '../built';
import { restoreSubagentParentLink } from './subagent-link';
import { insertBuiltRows, deleteSessionRows, seqForReplacement } from './session-writer';
import type { InsertBuiltOptions, InsertCounts } from './types';

export async function insertBuiltWithClient(
  client: PoolClient,
  built: Built[],
  options: InsertBuiltOptions = {},
): Promise<InsertCounts> {
  await client.query('BEGIN');
  try {
    const counts = await insertBuiltRows(client, built, options);
    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function insertBuilt(
  pool: Pool,
  built: Built[],
  options: InsertBuiltOptions = {},
): Promise<InsertCounts> {
  const client = await pool.connect();
  try {
    return await insertBuiltWithClient(client, built, options);
  } finally {
    client.release();
  }
}

export async function replaceBuiltSession(
  pool: Pool,
  built: Built,
  options: InsertBuiltOptions = {},
): Promise<InsertCounts> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    built.session.seq = await seqForReplacement(client, built.session.id, built.session.seq);
    await deleteSessionRows(client, built.session.id);
    const counts = await insertBuiltRows(client, [built], options);
    await restoreSubagentParentLink(client, built.session.id);
    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
