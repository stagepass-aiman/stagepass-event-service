/**
 * event-messages.ts
 *
 * WHY: Kafka message payloads are typed here to match the AsyncAPI schemas in
 * event_async.yaml exactly. Any change to the schema contract must start here
 * (update the type), then update event_async.yaml in stagepass-docs, then
 * update any consumers in other services.
 *
 * Schema evolution rule: add optional fields only. Never remove fields.
 * Never change field types. Never rename fields. (ADR-003 §3.4 — backward-compatible only)
 *
 * messageId is required on every message for idempotency (NFR-REL-002).
 * Consumers must deduplicate on messageId before processing.
 */

import type { MoneyDto } from '../../common/types/money.type';

/** Base fields present on every message in the event domain. */
interface EventMessageBase {
  /** Unique message ID — consumers deduplicate on this. (NFR-REL-002) */
  messageId: string;
  /** ISO-8601 UTC timestamp when the message was produced. */
  occurredAt: string;
  /** Schema version for forward-compatibility detection. */
  schemaVersion: '1.0';
}

export interface EventCreatedMessage extends EventMessageBase {
  eventId: string;
  organiserId: string;
  venueBookingId: string;
  title: string;
  status: 'DRAFT';
  eventDate: string; // ISO-8601 UTC
}

export interface EventPublishedMessage extends EventMessageBase {
  eventId: string;
  organiserId: string;
  venueId: string;
  venueBookingId: string;
  title: string;
  status: 'PUBLISHED';
  eventDate: string;
  publishedAt: string;
  totalCapacity: number;
  /** Pricing tiers — needed by Search Service for indexing price ranges. */
  pricingTiers: Array<{
    tierId: string;
    name: string;
    price: MoneyDto;
  }>;
}

export interface EventCancelledMessage extends EventMessageBase {
  eventId: string;
  organiserId: string;
  venueId: string;
  status: 'CANCELLED';
  cancelledAt: string;
  /** Reason stored for customer notification and audit. */
  cancellationReason: string;
}

export interface EventPostponedMessage extends EventMessageBase {
  eventId: string;
  organiserId: string;
  status: 'POSTPONED';
  originalDate: string;
  postponedDate: string;
  reason: string;
}

/** Topic names — single source of truth. Never hardcode these in producers. */
export const KAFKA_TOPICS = {
  EVENT_EVENTS: 'event.events',
  EVENT_COMMANDS: 'event.commands',
} as const;
