import { UnauthorizedError, type User } from '@lifeos/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

export const SESSION_COOKIE = 'lifeos_session';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
  interface FastifyInstance {
    requireUser: (req: FastifyRequest) => User;
    setSessionCookie: (reply: FastifyReply, token: string, expires: Date) => void;
    clearSessionCookie: (reply: FastifyReply) => void;
  }
}

/**
 * Cookie-session authentication plus CSRF defence. Cookies are SameSite=Lax,
 * and state-changing requests carrying a foreign Origin are rejected, which
 * together block cross-site form posts and fetches.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  const { config, services } = app.deps;
  const allowedOrigins = new Set([new URL(config.WEB_ORIGIN).origin]);

  app.decorateRequest('user', null);

  app.decorate('setSessionCookie', (reply: FastifyReply, token: string, expires: Date) => {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      expires,
    });
  });
  app.decorate('clearSessionCookie', (reply: FastifyReply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  });
  app.decorate('requireUser', (req: FastifyRequest) => {
    if (!req.user) throw new UnauthorizedError();
    return req.user;
  });

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (UNSAFE_METHODS.has(req.method) && origin && !allowedOrigins.has(origin)) {
      return reply.status(403).send({ error: { code: 'forbidden', message: 'Cross-origin request blocked' } });
    }

    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await services.auth.validateSession(token);
    if (!session) {
      app.clearSessionCookie(reply);
      return;
    }
    req.user = session.user;
    if (session.renewedUntil) app.setSessionCookie(reply, token, session.renewedUntil);
  });
});
