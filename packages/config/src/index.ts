import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_VERSION: z.string().default('0.0.0-dev'),

  DATABASE_URL: z.url().default('postgres://lifeos:lifeos@localhost:5432/lifeos'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.url().default('redis://localhost:6379'),

  OTEL_ENABLED: bool.default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().default('http://localhost:4318'),

  LLM_PROVIDER: z.enum(['auto', 'anthropic', 'openai', 'ollama', 'mock']).default('auto'),
  EMBEDDING_PROVIDER: z.enum(['auto', 'openai', 'ollama', 'mock']).default('auto'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL_SMART: z.string().default('claude-opus-5-5'),
  ANTHROPIC_MODEL_FAST: z.string().default('claude-opus-5-5'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.url().optional(),
  OPENAI_MODEL_SMART: z.string().default('gpt-5.1'),
  OPENAI_MODEL_FAST: z.string().default('gpt-5.1-mini'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  OLLAMA_BASE_URL: z.url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('qwen3:4b'),
  OLLAMA_EMBEDDING_MODEL: z.string().default('nomic-embed-text'),
  LLM_DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(500_000),
});

export const apiConfigSchema = baseSchema.extend({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  COOKIE_SECURE: bool.default(false),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().nonnegative().default(20_000),
});

export const workerConfigSchema = baseSchema.extend({
  HEALTH_PORT: z.coerce.number().int().default(9000),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  SMTP_URL: z.string().default('smtp://localhost:1025'),
  MAIL_FROM: z.string().default('LifeOS <noreply@lifeos.local>'),
  APP_URL: z.url().default('http://localhost:5173'),
});

export type BaseConfig = z.infer<typeof baseSchema>;
export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;

/**
 * Parse environment variables against a schema and fail fast with a readable
 * message, so a misconfigured pod crashes at startup instead of at first use.
 */
export function loadConfig<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv = process.env): z.infer<S> {
  // Treat empty strings as unset so `FOO=` in .env files falls back to defaults.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
