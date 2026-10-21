import { loginSchema, signupSchema, updateProfileSchema, userSchema } from '@lifeos/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SESSION_COOKIE } from '../plugins/auth.js';

// Brute-force protection on credential endpoints (per IP, shared via Redis).
const credentialRateLimit = { rateLimit: { max: 10, timeWindow: '15 minutes' } };

export async function authRoutes(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { auth } = app.deps.services;
  const tags = ['auth'];

  app.post(
    '/signup',
    { config: credentialRateLimit, schema: { tags, body: signupSchema, response: { 201: userSchema } } },
    async (req, reply) => {
      const user = await auth.signup(req.body);
      const session = await auth.createSession(user.id, { userAgent: req.headers['user-agent'], ip: req.ip });
      app.setSessionCookie(reply, session.token, session.expiresAt);
      return reply.status(201).send(user);
    },
  );

  app.post(
    '/login',
    { config: credentialRateLimit, schema: { tags, body: loginSchema, response: { 200: userSchema } } },
    async (req, reply) => {
      const user = await auth.verifyCredentials(req.body.email, req.body.password);
      const session = await auth.createSession(user.id, { userAgent: req.headers['user-agent'], ip: req.ip });
      app.setSessionCookie(reply, session.token, session.expiresAt);
      return user;
    },
  );

  app.post('/logout', { schema: { tags, response: { 204: z.null() } } }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await auth.revokeSession(token);
    app.clearSessionCookie(reply);
    return reply.status(204).send(null);
  });

  app.get('/me', { schema: { tags, response: { 200: userSchema } } }, async (req) => app.requireUser(req));

  app.patch('/me', { schema: { tags, body: updateProfileSchema, response: { 200: userSchema } } }, async (req) =>
    auth.updateProfile(app.requireUser(req).id, req.body),
  );
}
