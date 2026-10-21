import { commitCaptureSchema } from '@lifeos/core';
import {
  captureRequestSchema,
  capturePreviewSchema,
  createNoteSchema,
  noteSchema,
  searchHitSchema,
  searchQuerySchema,
  updateNoteSchema,
} from '@lifeos/domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const idParams = z.object({ id: z.uuid() });

export async function captureRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { capture } = app.deps.services;
  const tags = ['capture'];

  app.post(
    '/preview',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { tags, body: captureRequestSchema, response: { 200: capturePreviewSchema } },
    },
    async (req) => capture.preview(app.requireUser(req), req.body.text),
  );

  app.post('/', { schema: { tags, body: commitCaptureSchema } }, async (req, reply) =>
    reply.status(201).send(await capture.commit(app.requireUser(req), req.body)),
  );
}

export async function noteRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { notes, search } = app.deps.services;
  const tags = ['notes'];

  app.get(
    '/',
    {
      schema: {
        tags,
        querystring: z.object({ kind: z.enum(['note', 'journal']).optional() }),
        response: { 200: z.array(noteSchema) },
      },
    },
    async (req) => notes.list(app.requireUser(req).id, { kind: req.query.kind }),
  );

  app.get(
    '/search',
    { schema: { tags, querystring: searchQuerySchema, response: { 200: z.array(searchHitSchema) } } },
    async (req) => search.search(app.requireUser(req).id, req.query.q, req.query.limit),
  );

  app.post('/', { schema: { tags, body: createNoteSchema, response: { 201: noteSchema } } }, async (req, reply) =>
    reply.status(201).send(await notes.create(app.requireUser(req).id, req.body)),
  );

  app.get('/:id', { schema: { tags, params: idParams, response: { 200: noteSchema } } }, async (req) =>
    notes.get(app.requireUser(req).id, req.params.id),
  );

  app.patch(
    '/:id',
    { schema: { tags, params: idParams, body: updateNoteSchema, response: { 200: noteSchema } } },
    async (req) => notes.update(app.requireUser(req).id, req.params.id, req.body),
  );

  app.delete('/:id', { schema: { tags, params: idParams, response: { 204: z.null() } } }, async (req, reply) => {
    await notes.remove(app.requireUser(req).id, req.params.id);
    return reply.status(204).send(null);
  });
}

export async function metaRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { notifications, usage, briefings } = app.deps.services;

  app.get('/briefings/today', { schema: { tags: ['briefings'] } }, async (req) => ({
    briefing: await briefings.today(app.requireUser(req)),
  }));

  app.post(
    '/briefings/today',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { tags: ['briefings'] } },
    async (req) => ({ briefing: await briefings.generate(app.requireUser(req)) }),
  );

  /** Which AI backend is active, so the UI can show a demo-mode banner. */
  app.get('/meta', { schema: { tags: ['meta'] } }, async () => ({
    version: app.deps.config.SERVICE_VERSION,
    llm: app.deps.llm.info,
  }));

  app.get(
    '/usage',
    {
      schema: { tags: ['usage'], querystring: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }) },
    },
    async (req) => usage.summary(app.requireUser(req).id, req.query.days),
  );

  app.get(
    '/notifications',
    { schema: { tags: ['notifications'], querystring: z.object({ unread: z.coerce.boolean().default(false) }) } },
    async (req) => notifications.list(app.requireUser(req).id, { unreadOnly: req.query.unread }),
  );

  app.post(
    '/notifications/read',
    {
      schema: {
        tags: ['notifications'],
        body: z.object({ ids: z.union([z.array(z.uuid()).max(100), z.literal('all')]) }),
      },
    },
    async (req) => ({ updated: await notifications.markRead(app.requireUser(req).id, req.body.ids) }),
  );
}
