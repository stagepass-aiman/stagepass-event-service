/**
 * main.ts
 *
 * WHY Fastify (not Express):
 *   NestJS supports both Express and Fastify adapters. Fastify is ~2x faster
 *   for raw HTTP throughput due to better serialisation and schema-based
 *   response validation. For an event-driven microservice with no SSR needs,
 *   Fastify is the correct default. The tradeoff: some Express-specific
 *   middleware (like express-session) won't work — but we don't need them.
 *
 * Bootstrap order matters:
 *   0. Initialise OTel BEFORE anything else is imported (see ./tracing import)
 *   1. Create app with Fastify adapter, buffering logs until Pino attaches
 *   2. Attach Pino as the app logger (pure JSON — NFR-OBS-001)
 *   3. Enable shutdown hooks (graceful drain + OTel span flush on SIGTERM)
 *   4. Global ValidationPipe, exception filter, interceptors, CORS
 *   5. Listen on configured port
 */

// ← OBS #1: MUST be the FIRST import. Its side effect (sdk.start()) installs
// the require-time hooks that patch fastify/http/mongoose. `import` is hoisted
// to the top of the compiled file, so the ONLY way to guarantee OTel starts
// before Nest loads those modules is to make tracing the first import line.
// If your ESLint has `import/order`, add the disable line shown below.
// eslint-disable-next-line import/order
import './tracing';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino'; // ← OBS #3: Nest LoggerService backed by Pino
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import type { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Fastify's own logger stays OFF. Request logging is done by pino-http
      // (configured in AppModule's LoggerModule.forRoot) so every line is pure
      // JSON with traceId/spanId. Two loggers would mean duplicate request logs.
      logger: false,
    }),
    // ← OBS #3: buffer the early framework logs emitted during creation until
    // useLogger() attaches Pino — otherwise those lines print via Nest's default
    // ANSI logger and break Loki's `| json` parsing for the first few lines.
    { bufferLogs: true },
  );

  // ← OBS #3: replace Nest's default logger with Pino for the whole app.
  // Requires LoggerModule.forRoot({...}) in AppModule (added in the app.module
  // edit) so this token resolves.
  app.useLogger(app.get(Logger));

  // ← OBS #1/#3: graceful shutdown. enableShutdownHooks() makes Nest fire
  // onModuleDestroy/SIGTERM handling; tracing.ts hooks SIGTERM to flush spans
  // so in-flight traces aren't lost on container stop.
  app.enableShutdownHooks();

  // Global validation pipe:
  //   transform: true     — convert query params to their DTO types (string → number for pageSize)
  //   whitelist: true     — strip properties not in the DTO (reject unknown fields silently)
  //   forbidNonWhitelisted: true — throw 400 on unknown fields instead of stripping silently
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Global exception filter — all exceptions become RFC 9457 Problem Details.
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global interceptors — applied in order: logging wraps idempotency check.
  // NOTE: see the double-logging flag below — decide between this interceptor
  // and pino-http autoLogging; do not run both as request loggers.

  // CORS — permissive in development; tightened via env in staging/prod.
  app.enableCors({
    origin: process.env['CORS_ORIGINS']?.split(',') ?? '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
  });

  const configService = app.get(ConfigService<AppConfig, true>);
  const port = configService.get('port', { infer: true });

  // Bind to 0.0.0.0 (all interfaces) so the container is reachable from outside.
  // Binding to localhost only would make the service unreachable from Docker networking.
  await app.listen(port, '0.0.0.0');

  // ← OBS #3: log through Pino, not console.log. A raw console.log emits a
  // non-JSON line that breaks `| json` parsing in Loki for that line.
  app.get(Logger).log(`event-service listening on port ${port}`);
}

void bootstrap();
