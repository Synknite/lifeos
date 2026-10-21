import { createProjectSchema, projectSchema, updateProjectSchema } from '@lifeos/domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const idParams = z.object({ id: z.uuid() });

export async function projectRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { projects } = app.deps.services;
  const tags = ['projects'];

  app.get('/', { schema: { tags, response: { 200: z.array(projectSchema) } } }, async (req) =>
    projects.list(app.requireUser(req).id),
  );

  app.post('/', { schema: { tags, body: createProjectSchema, response: { 201: projectSchema } } }, async (req, reply) =>
    reply.status(201).send(await projects.create(app.requireUser(req).id, req.body)),
  );

  app.patch(
    '/:id',
    { schema: { tags, params: idParams, body: updateProjectSchema, response: { 200: projectSchema } } },
    async (req) => projects.update(app.requireUser(req).id, req.params.id, req.body),
  );

  app.delete('/:id', { schema: { tags, params: idParams, response: { 204: z.null() } } }, async (req, reply) => {
    await projects.remove(app.requireUser(req).id, req.params.id);
    return reply.status(204).send(null);
  });
}
