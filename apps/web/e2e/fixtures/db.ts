// e2e/fixtures/db.ts — the scratch-Postgres primitives the e2e fixtures share.
//
// Extracted from e2e/helpers.ts (file-size gate, I4) so the seed*/cleanup*
// machinery lives in dedicated, sub-500-line fixture modules. helpers.ts and the
// per-domain fixture files both import DATABASE_URL / withDb / Client from here.
import { Client } from "pg";
export { Client };

export const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://lathe:lathe@localhost:55432/lathe";

export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
