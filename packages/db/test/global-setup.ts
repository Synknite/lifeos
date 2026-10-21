import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/migrate.js';
import './helpers.js';

let pg: StartedPostgreSqlContainer | undefined;
let valkey: StartedTestContainer | undefined;

/**
 * Start real Postgres (with pgvector) and Valkey once for the integration
 * project, apply migrations, and hand connection URLs to tests via `inject()`.
 * Set TEST_DATABASE_URL / TEST_REDIS_URL to reuse already-running services.
 */
export async function setup(project: TestProject): Promise<void> {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  let redisUrl = process.env.TEST_REDIS_URL;

  const [pgStarted, valkeyStarted] = await Promise.all([
    databaseUrl ? undefined : new PostgreSqlContainer('pgvector/pgvector:pg17').withDatabase('lifeos_test').start(),
    redisUrl
      ? undefined
      : new GenericContainer('valkey/valkey:8-alpine')
          .withExposedPorts(6379)
          .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
          .start(),
  ]);
  pg = pgStarted;
  valkey = valkeyStarted;
  databaseUrl ??= pg!.getConnectionUri();
  redisUrl ??= `redis://${valkey!.getHost()}:${valkey!.getMappedPort(6379)}`;

  await runMigrations(databaseUrl);
  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redisUrl);
}

export async function teardown(): Promise<void> {
  await Promise.all([pg?.stop(), valkey?.stop()]);
}
