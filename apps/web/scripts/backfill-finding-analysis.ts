import { closePool } from '../lib/postgres';
import { backfillFindingAnalysis } from './analyst-engine';

function parseIds(value: string | undefined): number[] {
  if (!value) throw new Error('usage: tsx scripts/backfill-finding-analysis.ts <id>[,<id>...]');
  const ids = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) throw new Error('no valid finding ids supplied');
  return [...new Set(ids)];
}

async function main(): Promise<void> {
  const ids = parseIds(process.argv[2]);
  const result = await backfillFindingAnalysis(ids);
  console.log(`[backfill-finding-analysis] ids=${ids.join(',')} considered=${result.considered} updated=${result.updated} skipped=${result.skipped}`);
}

main()
  .catch((error) => {
    console.error(`[backfill-finding-analysis] failed: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
