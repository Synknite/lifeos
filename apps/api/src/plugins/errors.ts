import { DomainError } from '@lifeos/core';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** One error envelope for every failure, and no stack traces leaking to clients. */
export function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  if (hasZodFastifySchemaValidationErrors(err)) {
    return reply.status(400).send({
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      },
    } satisfies ErrorBody);
  }
  if (err instanceof ZodError) {
    return reply.status(400).send({
      error: { code: 'validation_error', message: 'Invalid input', details: err.issues },
    } satisfies ErrorBody);
  }
  if (err instanceof DomainError) {
    return reply.status(err.status).send({ error: { code: err.code, message: err.message } } satisfies ErrorBody);
  }
  const status = err.statusCode ?? 500;
  if (status >= 500) {
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong' } } satisfies ErrorBody);
  }
  return reply
    .status(status)
    .send({ error: { code: err.code?.toLowerCase() ?? 'error', message: err.message } } satisfies ErrorBody);
}
