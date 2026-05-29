/**
 * app.module.ts
 *
 * Root module. Wires all feature modules together.
 *
 * Module import order matters for clarity (not for NestJS):
 *   1. Config (needed by all other modules for env vars)
 *   2. Logger (Pino — pure JSON with traceId; attached as app logger in main.ts)
 *   3. Database (Mongoose connection)
 *   4. Infrastructure (Kafka, JWKS) — global modules, available everywhere
 *   5. Feature modules (Events, Health, Metrics)
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { LoggerModule } from 'nestjs-pino'; // ← OBS #3
import configuration, { type AppConfig } from './config/configuration';
import { JwksModule } from './jwks/jwks.module';
import { KafkaModule } from './kafka/kafka.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module'; // ← OBS #2

@Module({
  imports: [
    // 1. Config — isGlobal makes ConfigService injectable everywhere without importing ConfigModule
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // Prevent NestJS from reading .env files in production — all config via environment.
      ignoreEnvFile: process.env['NODE_ENV'] === 'production',
    }),

    // 2. Logger — Pino, pure JSON, traceId/spanId on every line (NFR-OBS-001).
    //    main.ts calls app.useLogger(app.get(Logger)) so Nest's own logs route
    //    through this too. Must be registered here or that get(Logger) throws.
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env['LOG_LEVEL'] ?? 'info',
        // NO `transport` / pino-pretty: that injects ANSI colour codes and a
        // human-readable prefix, which breaks Loki's `| json` parsing. Raw
        // pino output is newline-delimited JSON — exactly what Loki wants.
        messageKey: 'message',
        // ISO-8601 UTC timestamp field (NFR-OBS-001 wants UTC timestamps).
        timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
        // Stable service field in the log BODY. (The Loki stream LABEL
        // `service_name` comes from Promtail relabel, not from here.)
        base: { service: process.env['OTEL_SERVICE_NAME'] ?? 'event-service' },
        // Emit level as a word ("info") not a number (30) — easier to read in Loki.
        formatters: {
          level: (label): { level: string } => ({ level: label }),
        },
        // Don't spam a log line for infra polling endpoints. Removes noise from
        // K8s probes and the Prometheus scrape of /metrics.
        autoLogging: {
          ignore: (req): boolean => {
            const url = (req as { url?: string }).url ?? '';
            return url === '/metrics' || url === '/health/live' || url === '/health/ready';
          },
        },
        // Enrich pino-http's request log with userId from the verified JWT.
        // This replaces LoggingInterceptor — userId was the only field it added
        // that pino-http didn't. Lands on the SAME log line (no duplicate).
        customProps: (req): Record<string, string> => {
          const user = (req as { user?: { sub?: string } }).user;
          return { userId: user?.sub ?? 'anonymous' };
        },
      },
    }),

    // 3. MongoDB connection — URI from typed config
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        uri: config.get('mongodb.uri', { infer: true }),
        dbName: config.get('mongodb.dbName', { infer: true }),
        // Connection pool settings — aligned with expected T2 load
        maxPoolSize: 10,
        minPoolSize: 2,
        // Fail fast on connection timeout rather than hanging indefinitely
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      }),
    }),

    // 4. Infrastructure modules (@Global — exported providers available everywhere)
    JwksModule,
    KafkaModule,

    // 5. Feature modules
    EventsModule,
    HealthModule,
    MetricsModule, // ← OBS #2: registers GET /metrics + collectDefaultMetrics()
  ],
})
export class AppModule {}
