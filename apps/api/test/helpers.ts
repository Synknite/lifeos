import { apiConfigSchema, loadConfig } from '@lifeos/config';
import { connectTestDb, resetDb, testRedisUrl } from '@lifeos/db/testing';
import { MemoryScheduler } from '@lifeos/core';
import { createLlmRuntime, type LlmRuntime, type MockProvider } from '@lifeos/llm';
import { createLogger } from '@lifeos/observability';
import { Redis } from 'ioredis';
import { buildApp, type App } from '../src/app.js';
import { createServices, type AppDeps } from '../src/deps.js';

export const WEB_ORIGIN = 'http://localhost:5173';

export interface TestContext {
  app: App;
  deps: AppDeps;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/** Build the real Fastify app against the integration Postgres/Valkey. */
export interface TestAppOptions {
  /** Chat provider to use; defaults to the heuristic mock. */
  chat?: MockProvider;
}

export async function createTestApp(
  opts: TestAppOptions = {},
): Promise<TestContext & { jobs: MemoryScheduler; llm: LlmRuntime }> {
  const config = loadConfig(apiConfigSchema, {
    NODE_ENV: 'test',
    WEB_ORIGIN,
    LLM_PROVIDER: 'mock',
    EMBEDDING_PROVIDER: 'mock',
  });
  const db = connectTestDb();
  const redis = new Redis(testRedisUrl(), { maxRetriesPerRequest: 3 });
  const jobs = new MemoryScheduler();
  const base = await createLlmRuntime(config, {}, async () => false);
  const llm: LlmRuntime = opts.chat ? { ...base, chat: opts.chat } : base;
  const deps: AppDeps = {
    config,
    db,
    redis,
    logger: createLogger({ service: 'api-test', level: 'silent', version: 'test' }),
    llm,
    jobs,
    services: createServices(db, config, llm, jobs),
    lifecycle: { shuttingDown: false, abort: new AbortController() },
  };
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    deps,
    jobs,
    llm,
    reset: async () => {
      await resetDb(db);
      await redis.flushdb();
      jobs.clear();
    },
    close: async () => {
      await app.close();
      await db.close();
      await redis.quit();
    },
  };
}

let counter = 0;

/** Sign up a fresh user and return a cookie header for authenticated requests. */
export async function signUp(app: App, overrides: Record<string, string> = {}) {
  counter += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: {
      email: `user${counter}-${Date.now()}@example.com`,
      password: 'correct horse battery',
      displayName: `User ${counter}`,
      timezone: 'America/New_York',
      ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'lifeos_session');
  return { user: res.json<{ id: string; email: string }>(), cookie: `lifeos_session=${cookie!.value}` };
}
