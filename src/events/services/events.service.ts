/**
 * events.service.ts
 *
 * WHY: The service layer owns domain logic. Controllers validate input and
 * route; services enforce invariants, state machines, and tenant boundaries.
 * The repository handles persistence. This separation keeps each layer
 * focused and independently testable.
 *
 * STATE MACHINE:
 *   DRAFT → PUBLISHED   (publishEvent)
 *   DRAFT → CANCELLED   (cancelEvent — uncommon but allowed)
 *   PUBLISHED → CANCELLED (cancelEvent — triggers booking cascade)
 *   PUBLISHED → POSTPONED (postponeEvent)
 *   POSTPONED → PUBLISHED (publishEvent again after new date set)
 *
 * TENANT ISOLATION (NFR-SEC-004):
 *   Organisers can only read and write their own events. This check is in
 *   the service layer — not just the controller — because the service is the
 *   security enforcement point. The controller cannot be trusted by itself
 *   (a future admin endpoint might bypass controller-level checks).
 *   Violation: throw TenantIsolationException which maps to 404
 *   (do not reveal that the event exists for another organiser).
 */

import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EventsRepository } from '../repositories/events.repository';
import { EventStatus, type EventDocument } from '../schemas/event.schema';
import { KafkaProducerService } from '../../kafka/kafka-producer.service';
import {
  KAFKA_TOPICS,
  type EventCreatedMessage,
  type EventPublishedMessage,
  type EventCancelledMessage,
  type EventPostponedMessage,
} from '../../kafka/messages/event-messages';
import {
  EventNotFoundException,
  EventStateConflictException,
  PublishPreconditionsNotMetException,
  TenantIsolationException,
} from '../exceptions/event.exceptions';
import type {
  CreateEventDto,
  UpdateEventDto,
  ListEventsQueryDto,
  CancelEventDto,
  PostponeEventDto,
} from '../dto/event.dto';
import { UserRole, type JwtPayload } from '../../common/types/jwt-payload.type';
import type { EventPage } from '../repositories/events.repository';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly eventsRepository: EventsRepository,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  // ── Create ───────────────────────────────────────────────────────────────────

  async createEvent(dto: CreateEventDto, caller: JwtPayload): Promise<EventDocument> {
    // Caller must be ORGANISER — enforced by RolesGuard before reaching here,
    // but we assert again to make the service self-defending.
    if (caller.role !== UserRole.ORGANISER) {
      throw new ForbiddenException('Only Organisers can create events.');
    }

    // In Phase 3 we trust venueBookingId is valid (Venue Service is Phase 4).
    // TODO Phase 4: validate venueBookingId against Venue Service via gRPC.
    // The venueId is extracted from the VenueBooking record.
    // For now we use a placeholder venueId derived from the booking.
    const venueId = 'venue-to-be-resolved-phase4';

    const event = await this.eventsRepository.create(dto, caller.sub, venueId);
    this.logger.log({ eventId: event.eventId, organiserId: caller.sub }, 'Event created');

    // Publish domain event — outbox-lite (T2 acceptable, see kafka-producer.service.ts)
    const message: EventCreatedMessage = {
      messageId: randomUUID(),
      occurredAt: new Date().toISOString(),
      schemaVersion: '1.0',
      eventId: event.eventId,
      organiserId: event.organiserId,
      venueBookingId: event.venueBookingId,
      title: event.title,
      status: 'DRAFT',
      eventDate: event.eventDate.toISOString(),
    };

    await this.publishSafe(KAFKA_TOPICS.EVENT_EVENTS, event.eventId, message);
    return event;
  }

  // ── List ─────────────────────────────────────────────────────────────────────

  async listEvents(query: ListEventsQueryDto, caller: JwtPayload): Promise<EventPage> {
    // Role-based scope filter:
    const scopeFilter =
      caller.role === UserRole.CUSTOMER
        ? { status: EventStatus.PUBLISHED } // Customers see published only
        : caller.role === UserRole.ORGANISER
          ? { organiserId: caller.sub } // Organisers see their own
          : {}; // Admins see all

    return this.eventsRepository.findPaginated(query, scopeFilter, query.pageSize ?? 20);
  }

  // ── Get ──────────────────────────────────────────────────────────────────────

  async getEvent(eventId: string, caller: JwtPayload): Promise<EventDocument> {
    const event = await this.eventsRepository.findById(eventId);
    if (!event) throw new EventNotFoundException(eventId);

    // Customers: only PUBLISHED events
    if (caller.role === UserRole.CUSTOMER && event.status !== EventStatus.PUBLISHED) {
      throw new EventNotFoundException(eventId); // 404 — do not reveal non-published events
    }

    // Organisers: tenant isolation check
    if (caller.role === UserRole.ORGANISER) {
      this.assertOrganiserOwns(event, caller.sub);
    }

    return event;
  }

  // ── Update ────────────────────────────────────────────────────────────────────

  async updateEvent(
    eventId: string,
    dto: UpdateEventDto,
    caller: JwtPayload,
  ): Promise<EventDocument> {
    const event = await this.requireEvent(eventId);
    this.assertOrganiserOwns(event, caller.sub);

    if (event.status !== EventStatus.DRAFT) {
      throw new EventStateConflictException(event.status, EventStatus.DRAFT, 'updateEvent');
    }

    const updated = await this.eventsRepository.update(eventId, dto);
    if (!updated) throw new EventNotFoundException(eventId);
    return updated;
  }

  // ── Publish ───────────────────────────────────────────────────────────────────

  async publishEvent(eventId: string, caller: JwtPayload): Promise<EventDocument> {
    const event = await this.requireEvent(eventId);
    this.assertOrganiserOwns(event, caller.sub);

    // Only DRAFT and POSTPONED events can be published.
    if (event.status !== EventStatus.DRAFT && event.status !== EventStatus.POSTPONED) {
      throw new EventStateConflictException(
        event.status,
        `${EventStatus.DRAFT} or ${EventStatus.POSTPONED}`,
        'publishEvent',
      );
    }

    // Pre-condition checks (PRD §6.2, event.yaml publishEvent description)
    const failures: string[] = [];

    // 1. Event date must be in the future.
    if (event.eventDate <= new Date()) {
      failures.push('Event date must be in the future.');
    }

    // 2. At least one pricing tier must exist.
    if (event.pricingTiers.length === 0) {
      failures.push('At least one pricing tier must be configured.');
    }

    // 3. At least one section must exist.
    if (event.sections.length === 0) {
      failures.push('At least one seating section must be configured.');
    }

    // 4. TODO Phase 4: Organiser KYC status must be VERIFIED.
    //    Check against Auth Service user profile. Skipped in Phase 3.

    // 5. TODO Phase 4: VenueBooking must be CONFIRMED.
    //    Validate against Venue Service. Skipped in Phase 3.

    if (failures.length > 0) {
      throw new PublishPreconditionsNotMetException(failures);
    }

    const now = new Date();
    const updated = await this.eventsRepository.updateStatus(eventId, EventStatus.PUBLISHED, {
      publishedAt: now,
    } as Partial<EventDocument>);
    if (!updated) throw new EventNotFoundException(eventId);

    const message: EventPublishedMessage = {
      messageId: randomUUID(),
      occurredAt: now.toISOString(),
      schemaVersion: '1.0',
      eventId: updated.eventId,
      organiserId: updated.organiserId,
      venueId: updated.venueId,
      venueBookingId: updated.venueBookingId,
      title: updated.title,
      status: 'PUBLISHED',
      eventDate: updated.eventDate.toISOString(),
      publishedAt: now.toISOString(),
      totalCapacity: updated.pricingTiers.reduce((sum, t) => sum + (t.capacity ?? 0), 0),
      pricingTiers: updated.pricingTiers.map((t) => ({
        tierId: t.tierId,
        name: t.name,
        price: {
          amount: t.priceAmount.toString(),
          currency: t.priceCurrency,
        },
      })),
    };

    await this.publishSafe(KAFKA_TOPICS.EVENT_EVENTS, eventId, message);
    this.logger.log({ eventId, organiserId: caller.sub }, 'Event published');
    return updated;
  }

  // ── Cancel ────────────────────────────────────────────────────────────────────

  async cancelEvent(
    eventId: string,
    dto: CancelEventDto,
    caller: JwtPayload,
  ): Promise<EventDocument> {
    const event = await this.requireEvent(eventId);

    // Admins can cancel any event; Organisers only their own.
    if (caller.role === UserRole.ORGANISER) {
      this.assertOrganiserOwns(event, caller.sub);
    }

    // Idempotency: already cancelled → return current state, no duplicate Kafka message.
    // (NFR-REL-011)
    if (event.status === EventStatus.CANCELLED) {
      this.logger.warn(
        { eventId },
        'cancelEvent called on already-cancelled event — idempotent return',
      );
      return event;
    }

    if (
      event.status !== EventStatus.PUBLISHED &&
      event.status !== EventStatus.DRAFT &&
      event.status !== EventStatus.POSTPONED
    ) {
      throw new EventStateConflictException(
        event.status,
        'PUBLISHED/DRAFT/POSTPONED',
        'cancelEvent',
      );
    }

    const now = new Date();
    const updated = await this.eventsRepository.updateStatus(eventId, EventStatus.CANCELLED, {
      cancelledAt: now,
      cancellationReason: dto.reason,
    } as Partial<EventDocument>);
    if (!updated) throw new EventNotFoundException(eventId);

    const message: EventCancelledMessage = {
      messageId: randomUUID(),
      occurredAt: now.toISOString(),
      schemaVersion: '1.0',
      eventId: updated.eventId,
      organiserId: updated.organiserId,
      venueId: updated.venueId,
      status: 'CANCELLED',
      cancelledAt: now.toISOString(),
      cancellationReason: dto.reason,
    };

    await this.publishSafe(KAFKA_TOPICS.EVENT_EVENTS, eventId, message);
    this.logger.log({ eventId, organiserId: caller.sub }, 'Event cancelled');
    return updated;
  }

  // ── Postpone ──────────────────────────────────────────────────────────────────

  async postponeEvent(
    eventId: string,
    dto: PostponeEventDto,
    caller: JwtPayload,
  ): Promise<EventDocument> {
    const event = await this.requireEvent(eventId);
    this.assertOrganiserOwns(event, caller.sub);

    if (event.status !== EventStatus.PUBLISHED) {
      throw new EventStateConflictException(event.status, EventStatus.PUBLISHED, 'postponeEvent');
    }

    const newDate = new Date(dto.newDate);
    const now = new Date();
    const updated = await this.eventsRepository.updateStatus(eventId, EventStatus.POSTPONED, {
      postponedDate: newDate,
    } as Partial<EventDocument>);
    if (!updated) throw new EventNotFoundException(eventId);

    const message: EventPostponedMessage = {
      messageId: randomUUID(),
      occurredAt: now.toISOString(),
      schemaVersion: '1.0',
      eventId: updated.eventId,
      organiserId: updated.organiserId,
      status: 'POSTPONED',
      originalDate: event.eventDate.toISOString(),
      postponedDate: newDate.toISOString(),
      reason: dto.reason,
    };

    await this.publishSafe(KAFKA_TOPICS.EVENT_EVENTS, eventId, message);
    this.logger.log({ eventId }, 'Event postponed');
    return updated;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async requireEvent(eventId: string): Promise<EventDocument> {
    const event = await this.eventsRepository.findById(eventId);
    if (!event) throw new EventNotFoundException(eventId);
    return event;
  }

  private assertOrganiserOwns(event: EventDocument, callerId: string): void {
    if (event.organiserId !== callerId) {
      // Log the security event for audit, but return 404 to the caller
      // to avoid leaking event ownership information. (NFR-SEC-004)
      this.logger.warn(
        { eventId: event.eventId, ownerOrganiserId: event.organiserId, callerId },
        'Tenant isolation violation — organiser attempted to access another organiser event',
      );
      throw new TenantIsolationException();
    }
  }

  /**
   * Best-effort Kafka publish — log failures but do not fail the HTTP response.
   *
   * WHY: EventService is T2. If Kafka is unavailable, we must not roll back
   * the MongoDB write — the event state is committed and that is the source
   * of truth. The Search Service will rebuild from the Kafka topic replay.
   * A full Outbox pattern (T1 services) would guarantee delivery. (ADR-002 §3.4)
   */
  private async publishSafe<T extends object>(
    topic: string,
    key: string,
    message: T,
  ): Promise<void> {
    try {
      await this.kafkaProducer.publish(topic, key, message);
    } catch (err) {
      this.logger.error(
        { topic, key, error: err instanceof Error ? err.message : String(err) },
        'Kafka publish failed — event state committed to MongoDB, message lost (outbox-lite limitation)',
      );
    }
  }
}
