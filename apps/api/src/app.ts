import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { AppDeps } from './deps.js';
import { authPlugin } from './plugins/auth.js';
import { errorHandler } from './plugins/errors.js';
import { assistantRoutes } from './routes/assistant.js';
import { authRoutes } from './routes/auth.js';
import { captureRoutes, metaRoutes, noteRoutes } from './routes/features.js';
import { healthRoutes } from './routes/health.js';
import { projectRoutes } from './routes/projects.js';
import { taskRoutes } from './routes/tasks.js';

function createFastify(deps: AppDeps) {
  return Fastify({
    loggerInstance: deps.logger,
    trustProxy: true,
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
    // Health probes would otherwise dominate the logs.
    childLoggerFactory: (logger, bindings, opts, rawReq) =>
      rawReq.url === '/livez' || rawReq.url === '/readyz'
        ? logger.child(bindings, { ...opts, level: 'warn' })
        : logger.child(bindings, opts),
  }).withTypeProvider<ZodTypeProvider>();
}

export type App = ReturnType<typeof createFastify>;

export async function buildApp(deps: AppDeps): Promise<App> {
  const app = createFastify(deps);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.decorate('deps', deps);

  await app.register(swagger, {
    openapi: {
      info: { title: 'LifeOS API', version: deps.config.SERVICE_VERSION },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'lifeos_session' } } },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    redis: deps.redis,
    nameSpace: 'lifeos:rl:',
    allowList: (req) => req.url === '/livez' || req.url === '/readyz',
  });

  await app.register(healthRoutes);
  await app.register(
    async (api) => {
      await api.register(authPlugin);
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(taskRoutes, { prefix: '/tasks' });
      await api.register(projectRoutes, { prefix: '/projects' });
      await api.register(noteRoutes, { prefix: '/notes' });
      await api.register(captureRoutes, { prefix: '/capture' });
      await api.register(assistantRoutes, { prefix: '/assistant' });
      await api.register(metaRoutes);
      // OpenAPI 3 document generated from the same zod schemas that validate requests.
      api.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
    },
    { prefix: '/api' },
  );

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
