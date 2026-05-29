// src/tracing.ts
// MUST be imported as the FIRST line of main.ts. Auto-instrumentation patches
// fastify/http/mongoose at require() time; anything loaded before sdk.start()
// is cached unpatched → no spans, and (because the request span never exists)
// a blank traceId in every Pino line. `import` is hoisted, so a first-line
// import is the only way to guarantee this runs before Nest loads.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  // NodeSDK autoconfigures the OTLP/HTTP exporter from env:
  //   OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
  //   OTEL_SERVICE_NAME=event-service
  instrumentations: [
    getNodeAutoInstrumentations({
      // RULE-33: incompatible with Mongoose 8 / driver v6 — disable ONLY this.
      // fastify + http stay ENABLED: they create the server spans that put the
      // service in Jaeger and that the Pino mixin reads for traceId.
      '@opentelemetry/instrumentation-mongodb': { enabled: false },
      // fs spans are pure noise and bury the real request trace.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk
    .shutdown()
    .catch((err) => console.error('otel shutdown error', err))
    .finally(() => process.exit(0));
});
