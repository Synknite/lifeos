import { appliedMigrationCount, expectedMigrationCount, pingDb } from '@lifeos/db';
import type { FastifyInstance } from 'fastify';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { z } from 'zod';

const checkSchema = z.object({ status: z.enum(['ok', 'fail']), detail: z.string().optional() });

/**
 * Kubernetes-style probes:
 * - /livez: the process is responsive (event loop not wedged). Never checks
 *   dependencies, so a database outage doesn't trigger a restart storm.
 * - /readyz: dependencies reachable, schema migrated, not shutting down.
 */
export async function healthRoutes(app: FastifyInstance) {
  const { db, redis, lifecycle } = app.deps;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  app.addHook('onClose', () => loop.disable());
  const expectedMigrations = expectedMigrationCount();

  app.get(
    '/livez',
    { schema: { hide: true, response: { 200: z.object({ status: z.literal('ok') }), 503: checkSchema } } },
    async (_req, reply) => {
      const p99ms = loop.percentile(99) / 1e6;
      loop.reset();
      if (p99ms > 2_000) return reply.status(503).send({ status: 'fail', detail: `event loop p99 ${p99ms}ms` });
      return { status: 'ok' as const };
    },
  );

  app.get(
    '/readyz',
    {
      schema: {
        hide: true,
        response: {
          200: z.object({ status: z.enum(['ok', 'fail']), checks: z.record(z.string(), checkSchema) }),
          503: z.object({ status: z.enum(['ok', 'fail']), checks: z.record(z.string(), checkSchema) }),
        },
      },
    },
    async (_req, reply) => {
      const checks: Record<string, z.infer<typeof checkSchema>> = {};
      const run = async (name: string, fn: () => Promise<string | void>) => {
        try {
          const detail = await withTimeout(fn(), 2_000);
          checks[name] = detail ? { status: 'ok', detail } : { status: 'ok' };
        } catch (err) {
          checks[name] = { status: 'fail', detail: (err as Error).message };
        }
      };
      await Promise.all([
        run('lifecycle', async () => {
          if (lifecycle.shuttingDown) throw new Error('shutting down');
        }),
        run('postgres', () => pingDb(db.sql)),
        run('redis', async () => {
          await redis.ping();
        }),
        run('migrations', async () => {
          const applied = await appliedMigrationCount(db.sql);
          if (applied < expectedMigrations) throw new Error(`applied ${applied}/${expectedMigrations}`);
          return `${applied}/${expectedMigrations}`;
        }),
      ]);
      const ok = Object.values(checks).every((c) => c.status === 'ok');
      return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'fail', checks });
    },
  );
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref()),
  ]);
}
