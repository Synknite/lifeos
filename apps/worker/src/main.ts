import { workerConfigSchema, loadConfig } from '@lifeos/config';
import {
  BullScheduler,
  DbUsageSink,
  QUEUES,
  RedisTokenBudget,
  type BriefingJob,
  type EmbedJob,
  type MaintenanceJob,
  type ReminderJob,
} from '@lifeos/core';
import { appliedMigrationCount, createDb, expectedMigrationCount, pingDb } from '@lifeos/db';
import { createLlmRuntime } from '@lifeos/llm';
import { appMetrics, createLogger } from '@lifeos/observability';
import { shutdownTelemetry } from '@lifeos/observability/telemetry';
import { Worker, type Job, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import { createServer } from 'node:http';
import { createSmtpMailer } from './mailer.js';
import { createProcessors } from './processors.js';

const config = loadConfig(workerConfigSchema);
const logger = createLogger({
  service: 'lifeos-worker',
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
  pretty: config.NODE_ENV === 'development',
});

const db = createDb({ url: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
// BullMQ workers block on Redis; they require maxRetriesPerRequest: null.
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
for (const r of [connection, redis]) r.on('error', (err) => logger.warn({ err }, 'redis error'));

const jobs = new BullScheduler(connection);
const llm = await createLlmRuntime(config, {
  sink: new DbUsageSink(db.db),
  budget: new RedisTokenBudget(redis, config.LLM_DAILY_TOKEN_BUDGET),
  onSinkError: (err) => logger.warn({ err }, 'failed to record llm usage'),
});
const processors = createProcessors({
  db: db.db,
  llm,
  jobs,
  mailer: createSmtpMailer(config.SMTP_URL, config.MAIL_FROM),
  logger,
  appUrl: config.APP_URL,
});
logger.info({ llm: llm.info }, 'worker starting');

/** Wrap a handler with logging and outcome metrics. */
function instrumented<T>(queue: string, fn: (job: Job<T>) => Promise<unknown>): Processor<T> {
  return async (job) => {
    const started = performance.now();
    try {
      const result = await fn(job);
      appMetrics.jobsProcessed.add(1, { queue, outcome: 'ok' });
      logger.info({ queue, jobId: job.id, ms: Math.round(performance.now() - started), result }, 'job done');
      return result;
    } catch (err) {
      appMetrics.jobsProcessed.add(1, { queue, outcome: 'error' });
      logger.warn({ queue, jobId: job.id, attempt: job.attemptsMade + 1, err }, 'job failed');
      throw err;
    }
  };
}

const workerOpts = { connection, prefix: 'lifeos', concurrency: config.WORKER_CONCURRENCY };
const workers = [
  new Worker(
    QUEUES.embed,
    instrumented<EmbedJob>(QUEUES.embed, (j) => processors.embedNote(j.data)),
    {
      ...workerOpts,
      // Respect embedding-provider rate limits.
      limiter: { max: 20, duration: 1_000 },
    },
  ),
  new Worker(
    QUEUES.reminders,
    instrumented<ReminderJob>(QUEUES.reminders, (j) =>
      processors.sendReminder(j.data, { number: j.attemptsMade + 1, max: j.opts.attempts ?? 1 }),
    ),
    workerOpts,
  ),
  new Worker(
    QUEUES.briefings,
    instrumented<BriefingJob>(QUEUES.briefings, (j) => processors.dailyBriefing(j.data)),
    {
      ...workerOpts,
      concurrency: 2,
      limiter: { max: 10, duration: 1_000 },
    },
  ),
  new Worker(
    QUEUES.maintenance,
    instrumented<MaintenanceJob>(QUEUES.maintenance, (j) => processors.maintenance(j.data)),
    {
      ...workerOpts,
      concurrency: 1,
    },
  ),
];
for (const w of workers) w.on('error', (err) => logger.error({ err, queue: w.name }, 'worker error'));

// Repeatable maintenance. upsertJobScheduler is idempotent across replicas.
await jobs.maintenance.upsertJobScheduler(
  'reminder-sweep',
  { every: 60_000 },
  { name: 'sweep', data: { kind: 'reminder-sweep' } },
);
await jobs.maintenance.upsertJobScheduler(
  'schedule-briefings',
  { every: 5 * 60_000 },
  {
    name: 'briefings',
    data: { kind: 'schedule-briefings' },
  },
);
await jobs.maintenance.upsertJobScheduler(
  'purge-sessions',
  { pattern: '17 3 * * *' },
  {
    name: 'purge',
    data: { kind: 'purge-sessions' },
  },
);

// --- health endpoints for Kubernetes probes --------------------------------
let shuttingDown = false;
const expectedMigrations = expectedMigrationCount();
const health = createServer((req, res) => {
  const reply = (status: number, body: object) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  if (req.url === '/livez') return reply(200, { status: 'ok' });
  if (req.url === '/readyz') {
    void (async () => {
      try {
        if (shuttingDown) throw new Error('shutting down');
        await Promise.all([pingDb(db.sql), redis.ping()]);
        if ((await appliedMigrationCount(db.sql)) < expectedMigrations) throw new Error('migrations pending');
        if (workers.some((w) => !w.isRunning())) throw new Error('worker not running');
        reply(200, { status: 'ok' });
      } catch (err) {
        reply(503, { status: 'fail', detail: (err as Error).message });
      }
    })();
    return;
  }
  reply(404, { status: 'not found' });
});
health.listen(config.HEALTH_PORT, () => logger.info({ port: config.HEALTH_PORT }, 'worker ready'));

/**
 * Graceful shutdown: stop taking new jobs, let active ones finish (BullMQ
 * close waits for them), then release connections. A job that outlives the
 * grace period is retried elsewhere once its lock expires.
 */
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 25_000);
  force.unref();
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([jobs.close(), db.close(), redis.quit(), connection.quit(), shutdownTelemetry()]);
  health.close();
  logger.info('shutdown complete');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
