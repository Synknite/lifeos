import { decideSchema, sendMessageSchema, type ChatEvent } from '@lifeos/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { openSse } from '../sse.js';

const idParams = z.object({ id: z.uuid() });

// Chat is the expensive endpoint; cap it per user on top of the global limit.
const chatRateLimit = {
  rateLimit: {
    max: 20,
    timeWindow: '1 minute',
    keyGenerator: (req: { user?: { id: string } | null; ip: string }) => req.user?.id ?? req.ip,
  },
};

export async function assistantRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { agent } = app.deps.services;
  const { lifecycle } = app.deps;
  const tags = ['assistant'];

  /** Send a message; responds with an SSE stream of ChatEvents. */
  app.post('/chat', { config: chatRateLimit, schema: { tags, body: sendMessageSchema } }, async (req, reply) => {
    const user = app.requireUser(req);
    const sse = openSse<ChatEvent>(req, reply, lifecycle.abort.signal);
    try {
      await agent.send(user, req.body, sse.send, sse.signal);
    } catch (err) {
      req.log.error({ err }, 'chat failed');
      sse.send({ type: 'error', code: errCode(err), message: errMessage(err) });
    } finally {
      sse.close();
    }
  });

  /** Approve or decline proposed actions, then stream the resumed run. */
  app.post(
    '/runs/:id/decisions',
    { config: chatRateLimit, schema: { tags, params: idParams, body: decideSchema } },
    async (req, reply) => {
      const user = app.requireUser(req);
      const sse = openSse<ChatEvent>(req, reply, lifecycle.abort.signal);
      try {
        await agent.decide(user, req.params.id, req.body, sse.send, sse.signal);
      } catch (err) {
        req.log.warn({ err }, 'decision failed');
        sse.send({ type: 'error', code: errCode(err), message: errMessage(err) });
      } finally {
        sse.close();
      }
    },
  );

  app.get('/conversations', { schema: { tags } }, async (req) => agent.listConversations(app.requireUser(req).id));

  app.get('/conversations/:id', { schema: { tags, params: idParams } }, async (req) =>
    agent.getConversation(app.requireUser(req).id, req.params.id),
  );

  app.delete('/conversations/:id', { schema: { tags, params: idParams } }, async (req, reply) => {
    await agent.deleteConversation(app.requireUser(req).id, req.params.id);
    return reply.status(204).send();
  });
}

function errCode(err: unknown): string {
  return (err as { code?: string })?.code ?? 'internal';
}

function errMessage(err: unknown): string {
  // Domain errors (409 conflict, 404) carry user-safe messages.
  return err instanceof Error && 'status' in err ? err.message : 'Something went wrong. Please try again.';
}
