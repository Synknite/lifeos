import { inject } from 'vitest';
import { createDb, type DbHandle } from '../src/client.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

/** Connect to the integration-test database started by global-setup. */
export function connectTestDb(): DbHandle {
  return createDb({ url: inject('databaseUrl'), max: 5 });
}

export function testRedisUrl(): string {
  return inject('redisUrl');
}

/** Wipe all application data between tests while keeping the schema. */
export async function resetDb(handle: DbHandle): Promise<void> {
  // users cascades to every user-owned table.
  await handle.sql`truncate table users, llm_calls restart identity cascade`;
}
