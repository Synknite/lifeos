import { loadConfig, apiConfigSchema } from '@lifeos/config';
import { startTelemetry } from '@lifeos/observability/telemetry';

// Loaded via `node --import` so instrumentation hooks are registered before
// fastify, pg and ioredis are imported by main.ts.
const config = loadConfig(apiConfigSchema);
if (config.OTEL_ENABLED) {
  startTelemetry({
    serviceName: 'lifeos-api',
    serviceVersion: config.SERVICE_VERSION,
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  });
}
