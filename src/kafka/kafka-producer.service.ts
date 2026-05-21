/**
 * kafka-producer.service.ts
 *
 * WHY: The Event Service publishes domain events to Kafka on every state
 * transition. Publishing is fire-and-forget from the perspective of the HTTP
 * response — the caller gets a 200/201 as soon as MongoDB is updated; the
 * Kafka publish is best-effort for this T2 service.
 *
 * OUTBOX NOTE: This is "outbox-lite" — we write to MongoDB and then publish
 * to Kafka in the same handler, without a formal Outbox table. For a T2
 * service this is acceptable: if the Kafka publish fails after a successful
 * MongoDB write, the event is lost (no retry). The Search Service will
 * eventually rebuild from a replay (30-day topic retention). For T1 services
 * (Booking, Disbursement), a full Outbox with the transactional relay is
 * required. This trade-off is documented in ADR-003 §3.4.1.
 *
 * Anti-pattern avoided: creating a new KafkaJS producer per request. Producers
 * are expensive to create (TCP connection, metadata fetch). One shared producer
 * instance is correct.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer, Partitioners, CompressionTypes } from 'kafkajs';
import type { AppConfig } from '../config/configuration';

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private producer!: Producer;
  private connected = false;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  async onModuleInit(): Promise<void> {
    const { brokers, clientId } = this.configService.get('kafka', { infer: true });

    const kafka = new Kafka({
      clientId,
      brokers,
      // Retry config aligns with NFR-REL-006: exponential backoff, max 3 attempts.
      retry: {
        initialRetryTime: 100,
        maxRetryTime: 5000,
        retries: 3,
        factor: 2,
      },
    });

    this.producer = kafka.producer({
      // LegacyPartitioner is deprecated but explicit — consistent with KafkaJS 2.x.
      createPartitioner: Partitioners.LegacyPartitioner,
      // Idempotent producer ensures no duplicate messages even on retries.
      // Requires acks: -1 (all) which is set per-send below.
      idempotent: true,
    });

    await this.producer.connect();
    this.connected = true;
    this.logger.log(`Kafka producer connected to ${brokers.join(', ')}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connected) {
      await this.producer.disconnect();
      this.connected = false;
      this.logger.log('Kafka producer disconnected.');
    }
  }

  /** Health check for /health/ready */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Publish a typed message to a Kafka topic.
   *
   * @param topic    - Topic name (use KAFKA_TOPICS constants)
   * @param key      - Partition key (eventId ensures ordering per event)
   * @param value    - Typed message payload — serialised to JSON
   * @param headers  - Optional headers (e.g. traceId for OTel propagation)
   */
  async publish<T extends object>(
    topic: string,
    key: string,
    value: T,
    headers?: Record<string, string>,
  ): Promise<void> {
    if (!this.connected) {
      throw new Error('Kafka producer is not connected. Message not published.');
    }

    await this.producer.send({
      topic,
      compression: CompressionTypes.GZIP,
      messages: [
        {
          key,
          value: JSON.stringify(value),
          headers: headers ?? {},
        },
      ],
      acks: -1, // Wait for all in-sync replicas — required for idempotent producer
    });

    this.logger.debug({ topic, key }, 'Kafka message published');
  }
}
