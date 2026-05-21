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
 *   1. Create app with Fastify adapter
 *   2. Enable CORS (before any routes are registered)
 *   3. Set global prefix (before ValidationPipe)
 *   4. Set global ValidationPipe (transforms + whitelist)
 *   5. Set global exception filter (converts all exceptions to Problem Details)
 *   6. Set global interceptors (logging, idempotency)
 *   7. Listen on configured port
 */

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import type { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Log at warn level in production — Fastify's default logger is not structured JSON.
      // We handle structured logging via the LoggingInterceptor + Pino.
      logger: false,
    }),
  );

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
  app.useGlobalInterceptors(new LoggingInterceptor());

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

  console.log(`[event-service] Listening on port ${port}`);
}

void bootstrap();
