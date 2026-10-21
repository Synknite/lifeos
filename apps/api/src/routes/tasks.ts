import { createTaskSchema, listTasksQuerySchema, taskSchema, updateTaskSchema } from '@lifeos/domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const idParams = z.object({ id: z.uuid() });

export async function taskRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { tasks } = app.deps.services;
  const tags = ['tasks'];

  app.get(
    '/',
    { schema: { tags, querystring: listTasksQuerySchema, response: { 200: z.array(taskSchema) } } },
    async (req) => {
      const user = app.requireUser(req);
      return tasks.list(user.id, user.timezone, req.query);
    },
  );

  app.post('/', { schema: { tags, body: createTaskSchema, response: { 201: taskSchema } } }, async (req, reply) =>
    reply.status(201).send(await tasks.create(app.requireUser(req).id, req.body)),
  );

  app.get('/:id', { schema: { tags, params: idParams, response: { 200: taskSchema } } }, async (req) =>
    tasks.get(app.requireUser(req).id, req.params.id),
  );

  app.patch(
    '/:id',
    { schema: { tags, params: idParams, body: updateTaskSchema, response: { 200: taskSchema } } },
    async (req) => tasks.update(app.requireUser(req).id, req.params.id, req.body),
  );

  app.post('/:id/complete', { schema: { tags, params: idParams, response: { 200: taskSchema } } }, async (req) =>
    tasks.complete(app.requireUser(req).id, req.params.id),
  );

  app.delete('/:id', { schema: { tags, params: idParams, response: { 204: z.null() } } }, async (req, reply) => {
    await tasks.remove(app.requireUser(req).id, req.params.id);
    return reply.status(204).send(null);
  });
}
