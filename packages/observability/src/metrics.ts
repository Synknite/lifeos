import { metrics, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

const meter = metrics.getMeter('lifeos');
export const tracer = trace.getTracer('lifeos');

/** Domain metrics. Instruments are no-ops until the SDK is started. */
export const appMetrics = {
  llmTokens: meter.createCounter('gen_ai.client.token.usage', {
    description: 'LLM tokens consumed',
    unit: '{token}',
  }),
  llmDuration: meter.createHistogram('gen_ai.client.operation.duration', {
    description: 'LLM call duration',
    unit: 's',
  }),
  llmCost: meter.createCounter('lifeos_llm_cost_usd_total', {
    description: 'Estimated LLM spend in USD',
    unit: 'USD',
  }),
  reminderLag: meter.createHistogram('lifeos_reminder_lag_seconds', {
    description: 'Delay between a reminder being due and being delivered',
    unit: 's',
  }),
  jobsProcessed: meter.createCounter('lifeos_jobs_processed_total', {
    description: 'Background jobs processed, by queue and outcome',
  }),
  agentSteps: meter.createHistogram('lifeos_agent_steps', {
    description: 'Model round-trips per agent run',
  }),
};

/** Run `fn` inside a span, recording exceptions and status automatically. */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
