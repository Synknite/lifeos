import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseStream<E extends { type: string }> {
  send: (event: E) => void;
  close: () => void;
  /** Aborts when the server is shutting down. */
  signal: AbortSignal;
}

/**
 * Server-Sent Events over a hijacked Fastify reply.
 *
 * - `x-accel-buffering: no` stops nginx/ingress from buffering the stream.
 * - A comment heartbeat every 15s keeps idle proxies from closing it.
 * - If the browser disconnects mid-run we stop writing but let the run
 *   finish, so its results are persisted and appear on reload.
 */
export function openSse<E extends { type: string }>(
  req: FastifyRequest,
  reply: FastifyReply,
  shutdown: AbortSignal,
): SseStream<E> {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': req.id,
  });
  res.flushHeaders();

  const write = (chunk: string) => {
    if (!res.writableEnded && !res.destroyed) res.write(chunk);
  };
  const heartbeat = setInterval(() => write(': ping\n\n'), 15_000);
  heartbeat.unref();
  res.on('close', () => clearInterval(heartbeat));

  return {
    send: (event) => write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
    close: () => {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
    signal: shutdown,
  };
}
