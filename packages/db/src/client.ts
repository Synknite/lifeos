import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  url: string;
  max?: number;
  /** Prepared statements break behind transaction-mode poolers (PgBouncer). */
  prepare?: boolean;
}

export function createDb({ url, max = 10, prepare = true }: CreateDbOptions): DbHandle {
  const sql = postgres(url, {
    max,
    prepare,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: 'lifeos' },
  });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

/** Cheap connectivity probe used by readiness checks. */
export async function pingDb(sql: postgres.Sql): Promise<void> {
  await sql`select 1`;
}
