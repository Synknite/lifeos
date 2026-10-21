import { trace } from '@opentelemetry/api';
import { appMetrics, tracer } from '@lifeos/observability';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import type { z } from 'zod';
import { LlmError } from './errors.js';
import { estimateCostUsd } from './pricing.js';
import {
  addUsage,
  emptyUsage,
  type CallOptions,
  type ChatProvider,
  type ChatRequest,
  type ChatStreamEvent,
  type EmbeddingProvider,
  type ModelTier,
  type ProviderId,
  type Usage,
} from './types.js';

export interface UsageRecord {
  userId: string | null;
  purpose: string;
  provider: ProviderId;
  model: string;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
  status: 'ok' | 'error';
  errorCode: string | null;
  traceId: string | null;
}

/** Where usage rows go (Postgres in the apps, an array in tests). */
export interface UsageSink {
  record(r: UsageRecord): Promise<void>;
}

/** Per-user daily token budget; throws LlmError('budget_exceeded') when spent. */
export interface TokenBudget {
  assertAvailable(userId: string): Promise<void>;
  consume(userId: string, tokens: number): Promise<void>;
}

export interface InstrumentOptions {
  sink?: UsageSink;
  budget?: TokenBudget;
  onSinkError?: (err: unknown) => void;
}

/**
 * Decorate a provider with the cross-cutting concerns every call needs:
 * an OpenTelemetry span with gen_ai.* attributes (no prompt content, which
 * is personal data), token/cost/latency metrics, a usage row, and budget
 * enforcement. Providers stay focused on wire translation.
 */
export function instrumentChat(inner: ChatProvider, opts: InstrumentOptions = {}): ChatProvider {
  const before = async (o: CallOptions) => {
    if (o.userId && opts.budget) await opts.budget.assertAvailable(o.userId);
  };
  const after = async (
    o: CallOptions,
    tier: ModelTier,
    started: number,
    outcome: { usage: Usage; model: string } | { error: unknown },
  ) => {
    const latencyMs = Math.round(performance.now() - started);
    const model = 'model' in outcome ? outcome.model : inner.model(tier);
    const usage = 'usage' in outcome ? outcome.usage : emptyUsage();
    const costUsd = estimateCostUsd(model, usage);
    const attrs = { 'gen_ai.system': inner.id, 'gen_ai.request.model': model, 'lifeos.purpose': o.purpose };
    appMetrics.llmDuration.record(latencyMs / 1000, attrs);
    appMetrics.llmTokens.add(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, {
      ...attrs,
      'gen_ai.token.type': 'input',
    });
    appMetrics.llmTokens.add(usage.outputTokens, { ...attrs, 'gen_ai.token.type': 'output' });
    if (costUsd > 0) appMetrics.llmCost.add(costUsd, attrs);

    if (o.userId && opts.budget) {
      await opts.budget.consume(o.userId, usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens);
    }
    const errorCode = 'error' in outcome ? (outcome.error instanceof LlmError ? outcome.error.code : 'unknown') : null;
    await opts.sink
      ?.record({
        userId: o.userId ?? null,
        purpose: o.purpose,
        provider: inner.id,
        model,
        usage,
        costUsd,
        latencyMs,
        status: errorCode ? 'error' : 'ok',
        errorCode,
        traceId: trace.getActiveSpan()?.spanContext().traceId ?? null,
      })
      .catch((err: unknown) => opts.onSinkError?.(err));
  };

  const spanAttrs = (o: CallOptions, tier: ModelTier, op: string) => ({
    'gen_ai.operation.name': op,
    'gen_ai.system': inner.id,
    'gen_ai.request.model': inner.model(tier),
    'lifeos.purpose': o.purpose,
  });

  return {
    id: inner.id,
    model: (tier) => inner.model(tier),

    generate: (req, o) => {
      const tier = o.tier ?? 'smart';
      return tracer.startActiveSpan(
        `llm.chat ${o.purpose}`,
        { attributes: spanAttrs(o, tier, 'chat') },
        async (span) => {
          const started = performance.now();
          try {
            await before(o);
            const res = await inner.generate(req, o);
            setUsageAttrs(span, res.usage, res.model, res.stopReason);
            await after(o, tier, started, res);
            return res;
          } catch (err) {
            recordError(span, err);
            await after(o, tier, started, { error: err });
            throw err;
          } finally {
            span.end();
          }
        },
      );
    },

    stream: (req: ChatRequest, o: CallOptions): AsyncIterable<ChatStreamEvent> => {
      const tier = o.tier ?? 'smart';
      return {
        async *[Symbol.asyncIterator]() {
          const span = tracer.startSpan(`llm.chat ${o.purpose}`, { attributes: spanAttrs(o, tier, 'chat') });
          const started = performance.now();
          let firstToken = false;
          try {
            await before(o);
            for await (const ev of inner.stream(req, o)) {
              if (!firstToken && ev.type === 'text_delta') {
                firstToken = true;
                span.setAttribute('lifeos.time_to_first_token_ms', Math.round(performance.now() - started));
              }
              if (ev.type === 'done') {
                setUsageAttrs(span, ev.result.usage, ev.result.model, ev.result.stopReason);
                await after(o, tier, started, ev.result);
              }
              yield ev;
            }
          } catch (err) {
            recordError(span, err);
            await after(o, tier, started, { error: err });
            throw err;
          } finally {
            span.end();
          }
        },
      };
    },

    generateObject: <T>(req: ChatRequest, schema: z.ZodType<T>, o: CallOptions) => {
      const tier = o.tier ?? 'fast';
      return tracer.startActiveSpan(
        `llm.object ${o.purpose}`,
        { attributes: spanAttrs(o, tier, 'chat') },
        async (span) => {
          const started = performance.now();
          try {
            await before(o);
            const res = await inner.generateObject(req, schema, o);
            setUsageAttrs(span, res.usage, res.model);
            await after(o, tier, started, res);
            return res;
          } catch (err) {
            recordError(span, err);
            await after(o, tier, started, { error: err });
            throw err;
          } finally {
            span.end();
          }
        },
      );
    },
  };
}

export function instrumentEmbeddings(inner: EmbeddingProvider, opts: InstrumentOptions = {}): EmbeddingProvider {
  return {
    id: inner.id,
    model: inner.model,
    dimensions: inner.dimensions,
    embed: (texts, o) =>
      tracer.startActiveSpan(
        `llm.embed ${o.purpose}`,
        {
          attributes: {
            'gen_ai.operation.name': 'embeddings',
            'gen_ai.system': inner.id,
            'lifeos.batch_size': texts.length,
          },
        },
        async (span) => {
          const started = performance.now();
          try {
            const vectors = await inner.embed(texts, o);
            const bad = vectors.find((v) => v.length !== inner.dimensions);
            if (bad)
              throw new LlmError(`Embedding has ${bad.length} dims, expected ${inner.dimensions}`, 'invalid_output');
            // Embedding APIs don't all report tokens; ~4 chars/token is close enough for accounting.
            const usage = { ...emptyUsage(), inputTokens: Math.ceil(texts.join(' ').length / 4) };
            await opts.sink
              ?.record({
                userId: o.userId ?? null,
                purpose: o.purpose,
                provider: inner.id,
                model: inner.model,
                usage,
                costUsd: estimateCostUsd(inner.model, usage),
                latencyMs: Math.round(performance.now() - started),
                status: 'ok',
                errorCode: null,
                traceId: span.spanContext().traceId,
              })
              .catch((err: unknown) => opts.onSinkError?.(err));
            return vectors;
          } catch (err) {
            recordError(span, err);
            throw err;
          } finally {
            span.end();
          }
        },
      ),
  };
}

function setUsageAttrs(span: Span, u: Usage, model: string, stop?: string) {
  span.setAttributes({
    'gen_ai.response.model': model,
    'gen_ai.usage.input_tokens': u.inputTokens,
    'gen_ai.usage.output_tokens': u.outputTokens,
    'gen_ai.usage.cache_read_input_tokens': u.cacheReadTokens,
    ...(stop ? { 'gen_ai.response.finish_reasons': [stop] } : {}),
  });
}

function recordError(span: Span, err: unknown) {
  span.recordException(err as Error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof LlmError ? err.code : (err as Error)?.message });
}

export { addUsage };
