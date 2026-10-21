import { apiConfigSchema, loadConfig } from '@lifeos/config';
import { BullScheduler } from '@lifeos/core';
import { createDb } from '@lifeos/db';
import { createLogger } from '@lifeos/observability';
import { shutdownTelemetry } from '@lifeos/observability/telemetry';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { createLlm, createServices, type AppDeps } from './deps.js';

const config = loadConfig(apiConfigSchema);
const logger = createLogger({
  service: 'lifeos-api',
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
  pretty: config.NODE_ENV === 'development',
});

const db = createDb({ url: config.DATABASE_URL, max: config.DATABASE_POOL_MAX });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
redis.on('error', (err) => logger.warn({ err }, 'redis error'));

// BullMQ needs its own connection with no per-command retry limit.
const jobs = new BullScheduler(new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }));
const llm = await createLlm(config, db, redis, logger);
logger.info({ llm: llm.info }, llm.info.demoMode ? 'no LLM configured: running in demo mode' : 'llm ready');

const deps: AppDeps = {
  config,
  db,
  redis,
  logger,
  llm,
  jobs,
  services: createServices(db, config, llm, jobs),
  lifecycle: { shuttingDown: false, abort: new AbortController() },
};

const app = await buildApp(deps);
await app.listen({ host: config.HOST, port: config.PORT });

/**
 * Graceful shutdown: fail readiness first so the load balancer stops routing
 * to us, let in-flight requests finish (bounded by SHUTDOWN_GRACE_MS), then
 * release connections. Kubernetes sends SIGTERM after the preStop hook.
 */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  deps.lifecycle.shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const force = setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, config.SHUTDOWN_GRACE_MS);
  force.unref();

  try {
    // In-flight chat streams get the grace period to finish; then abort them.
    const abortTimer = setTimeout(() => deps.lifecycle.abort.abort(), Math.max(0, config.SHUTDOWN_GRACE_MS - 3_000));
    abortTimer.unref();
    await app.close();
    await Promise.allSettled([jobs.close(), db.close(), redis.quit(), shutdownTelemetry()]);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
