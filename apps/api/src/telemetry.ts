import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { LocalProfile } from '@pulse-field/foundation';

export function startTelemetry(profile: LocalProfile): NodeSDK {
  const exporter = new OTLPTraceExporter({
    url: new URL('/v1/traces', profile.OTEL_EXPORTER_OTLP_ENDPOINT).toString(),
  });
  const telemetry = new NodeSDK({
    serviceName: 'pulse-field-api',
    traceExporter: exporter,
  });

  telemetry.start();
  return telemetry;
}
