/**
 * app.module.ts
 *
 * Root module. Wires all feature modules together.
 *
 * Module import order matters for clarity (not for NestJS):
 *   1. Config (needed by all other modules for env vars)
 *   2. Database (Mongoose connection)
 *   3. Infrastructure (Kafka, JWKS) — global modules, available everywhere
 *   4. Feature modules (Events, Health)
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import configuration, { type AppConfig } from './config/configuration';
import { JwksModule } from './jwks/jwks.module';
import { KafkaModule } from './kafka/kafka.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    // 1. Config — isGlobal makes ConfigService injectable everywhere without importing ConfigModule
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // Prevent NestJS from reading .env files in production — all config via environment.
      ignoreEnvFile: process.env['NODE_ENV'] === 'production',
    }),

    // 2. MongoDB connection — URI from typed config
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

    // 3. Infrastructure modules (@Global — exported providers available everywhere)
    JwksModule,
    KafkaModule,

    // 4. Feature modules
    EventsModule,
    HealthModule,
  ],
})
export class AppModule {}
