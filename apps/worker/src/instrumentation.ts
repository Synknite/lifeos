import { loadConfig, workerConfigSchema } from '@lifeos/config';
import { startTelemetry } from '@lifeos/observability/telemetry';

const config = loadConfig(workerConfigSchema);
if (config.OTEL_ENABLED) {
  startTelemetry({
    serviceName: 'lifeos-worker',
    serviceVersion: config.SERVICE_VERSION,
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  });
}
