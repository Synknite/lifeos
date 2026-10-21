import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Sql } from 'postgres';
import { createDb } from './client.js';

/**
 * Migrations folder: `MIGRATIONS_DIR` if set, else `./migrations` beside the
 * bundled file (dist/migrations), else `../migrations` relative to src/.
 */
export function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(here, 'migrations');
  return existsSync(bundled) ? bundled : resolve(here, '../migrations');
}

/** Count of migration files shipped with this build, for readiness checks. */
export function expectedMigrationCount(dir = migrationsDir()): number {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).length;
}

export async function runMigrations(url: string, dir = migrationsDir()): Promise<void> {
  // A single connection; advisory locking keeps concurrent migrators safe.
  const { db, sql, close } = createDb({ url, max: 1 });
  try {
    await sql`select pg_advisory_lock(727274)`;
    await migrate(db, { migrationsFolder: dir });
  } finally {
    await sql`select pg_advisory_unlock(727274)`.catch(() => {});
    await close();
  }
}

/** Number of migrations recorded as applied in the database. */
export async function appliedMigrationCount(sql: Sql): Promise<number> {
  try {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}
