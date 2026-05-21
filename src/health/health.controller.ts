/**
 * health.controller.ts
 *
 * WHY two separate endpoints (not one):
 *   /health/live  → Kubernetes liveness probe. Answers: "Is this process running?"
 *                   If this fails, Kubernetes restarts the pod.
 *                   Must be fast and never depend on external services.
 *                   A slow dependency should NOT make the pod restart.
 *
 *   /health/ready → Kubernetes readiness probe. Answers: "Is this pod ready to
 *                   receive traffic?" If this fails, the pod is removed from
 *                   the load balancer but NOT restarted.
 *                   Checks MongoDB connectivity and Kafka producer connection.
 *
 * The distinction matters in practice:
 *   - If MongoDB is slow at startup, /ready returns DOWN → pod waits to receive
 *     traffic until MongoDB is available. No request is dropped.
 *   - If /live returned DOWN in that case, Kubernetes would restart the pod in
 *     a loop, making the startup race condition worse (crashloop backoff).
 *
 * No authentication required — health endpoints are public.
 */

import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { KafkaProducerService } from '../kafka/kafka-producer.service';

interface HealthStatus {
  status: 'UP' | 'DOWN' | 'DEGRADED';
  checks: Record<string, string>;
}

@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly mongoConnection: Connection,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  /** Liveness: process is alive. Always 200 if the process is running. */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): HealthStatus {
    return { status: 'UP', checks: {} };
  }

  /** Readiness: all dependencies are reachable. */
  @Get('ready')
  async ready(): Promise<HealthStatus> {
    const checks: Record<string, string> = {};
    let allUp = true;

    // MongoDB connectivity — ping the database
    try {
      const db = this.mongoConnection.db;
      if (!db) throw new Error('No DB connection');
      await db.command({ ping: 1 });
      checks['mongodb'] = 'UP';
    } catch {
      checks['mongodb'] = 'DOWN';
      allUp = false;
    }

    // Kafka producer connection status
    checks['kafka'] = this.kafkaProducer.isConnected() ? 'UP' : 'DOWN';
    if (checks['kafka'] === 'DOWN') allUp = false;

    const status = allUp ? 'UP' : 'DOWN';

    // Return 503 when not ready — Kubernetes uses the status code, not the body.
    if (!allUp) {
      // NestJS HttpCode decorator can't be dynamic; we throw to get 503.
      // Using a guard-free approach: return the body with the correct status
      // by leveraging the Fastify reply object... or simpler: throw.
      throw Object.assign(new Error('Service not ready'), {
        status: 503,
        response: { status, checks },
        getStatus: () => 503,
        getResponse: () => ({ status, checks }),
      });
    }

    return { status, checks };
  }
}
