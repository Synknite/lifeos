import { context, trace } from '@opentelemetry/api';
import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

/**
 * Paths that must never reach log storage. Journal/note bodies and prompts are
 * personal data, so they're redacted alongside credentials.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.apiKey',
  '*.bodyMd',
  '*.prompt',
  '*.messages',
];

export interface LoggerConfig {
  service: string;
  level: string;
  version: string;
  pretty?: boolean;
}

export function createLogger(cfg: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: cfg.level,
    base: { service: cfg.service, version: cfg.version },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Correlate every log line with the active trace so Loki -> Tempo links work.
    mixin() {
      const span = trace.getSpan(context.active());
      if (!span) return {};
      const { traceId, spanId } = span.spanContext();
      return { trace_id: traceId, span_id: spanId };
    },
  };
  if (cfg.pretty) {
    options.transport = { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' } };
  }
  return pino(options);
}
