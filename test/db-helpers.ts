import { DataSource } from 'typeorm';

// D8: per-test isolation. TRUNCATE … RESTART IDENTITY CASCADE so every spec
// starts at id=1 and FK chains don't trip on each other.
// Excludes the `migrations` table — migrations were applied once in globalSetup
// and never need to be re-run.
export async function truncateAll(ds: DataSource): Promise<void> {
  const tables = ds.entityMetadatas
    .map((m) => `"${m.tableName}"`)
    .filter((name) => name !== '"migrations"')
    .join(', ');
  if (!tables) return;
  // eslint-disable-next-line no-restricted-syntax -- raw DDL is the only way to TRUNCATE
  await ds.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}
