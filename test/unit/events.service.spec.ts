/**
 * events.service.spec.ts
 *
 * Unit tests for EventsService — the most domain-logic-dense class in the service.
 * All external dependencies (repository, Kafka producer) are mocked.
 *
 * WHAT WE TEST:
 *   - State machine transitions (valid and invalid)
 *   - Publish pre-condition enforcement
 *   - Tenant isolation (Organiser cannot touch another Organiser's events)
 *   - Idempotency on cancelEvent (already-CANCELLED returns current state)
 *   - Kafka publish is called on state transitions (best-effort, but we verify it's called)
 *   - Kafka failure is absorbed (publishSafe does not propagate)
 *
 * WHAT WE DON'T TEST HERE:
 *   - MongoDB query correctness → integration tests (Testcontainers)
 *   - HTTP status codes → integration tests
 *   - JWT validation → JwksService has its own unit tests
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { EventsService } from '../../src/events/services/events.service';
import { EventsRepository } from '../../src/events/repositories/events.repository';
import { KafkaProducerService } from '../../src/kafka/kafka-producer.service';
import { EventStatus, type EventDocument } from '../../src/events/schemas/event.schema';
import { UserRole, type JwtPayload } from '../../src/common/types/jwt-payload.type';
import {
  EventNotFoundException,
  EventStateConflictException,
  PublishPreconditionsNotMetException,
  TenantIsolationException,
} from '../../src/events/exceptions/event.exceptions';
import type { CreateEventDto, CancelEventDto, PostponeEventDto } from '../../src/events/dto/event.dto';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOrganiserCaller(sub = 'organiser-uuid-1'): JwtPayload {
  return { sub, email: 'org@test.com', role: UserRole.ORGANISER, jti: 'jti', iat: 0, exp: 9999999999 };
}

function makeAdminCaller(): JwtPayload {
  return { sub: 'admin-uuid', email: 'admin@test.com', role: UserRole.ADMIN, jti: 'jti', iat: 0, exp: 9999999999 };
}

function makeEvent(overrides: Partial<EventDocument> = {}): EventDocument {
  const futureDate = new Date(Date.now() + 86400000 * 30); // 30 days from now
  return {
    eventId: 'event-uuid-1',
    organiserId: 'organiser-uuid-1',
    venueId: 'venue-uuid-1',
    venueBookingId: 'booking-uuid-1',
    title: 'Test Concert',
    status: EventStatus.DRAFT,
    eventDate: futureDate,
    sections: [],
    pricingTiers: [],
    categoryIds: [],
    cancellationPolicy: { brackets: [] },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as EventDocument;
}

function makePublishableEvent(): EventDocument {
  return makeEvent({
    sections: [{ sectionId: 's1', name: 'GA', layoutSectionRef: 'ga', pricingTierId: 't1' }],
    pricingTiers: [{
      tierId: 't1', name: 'General', soldCount: 0, createdAt: new Date(),
      priceAmount: { toString: () => '500.0000' } as never,
      priceCurrency: 'INR',
    }],
  } as Partial<EventDocument>);
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('EventsService', () => {
  let service: EventsService;
  let repository: jest.Mocked<EventsRepository>;
  let kafka: jest.Mocked<KafkaProducerService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        {
          provide: EventsRepository,
          useValue: {
            create: jest.fn(),
            findById: jest.fn(),
            update: jest.fn(),
            updateStatus: jest.fn(),
            findPaginated: jest.fn(),
            addSection: jest.fn(),
            addPricingTier: jest.fn(),
          } satisfies Partial<EventsRepository>,
        },
        {
          provide: KafkaProducerService,
          useValue: {
            publish: jest.fn().mockResolvedValue(undefined),
            isConnected: jest.fn().mockReturnValue(true),
          } satisfies Partial<KafkaProducerService>,
        },
      ],
    }).compile();

    service = module.get(EventsService);
    repository = module.get(EventsRepository);
    kafka = module.get(KafkaProducerService);
  });

  // ── createEvent ─────────────────────────────────────────────────────────────

  describe('createEvent', () => {
    const dto: CreateEventDto = {
      venueBookingId: 'booking-uuid-1',
      title: 'Rock Night',
      eventDate: new Date(Date.now() + 86400000).toISOString(),
      cancellationPolicy: { brackets: [] },
    };

    it('creates an event and publishes EventCreated to Kafka', async () => {
      const savedEvent = makeEvent({ title: dto.title });
      repository.create.mockResolvedValue(savedEvent);

      const result = await service.createEvent(dto, makeOrganiserCaller());

      expect(repository.create).toHaveBeenCalledWith(dto, 'organiser-uuid-1', expect.any(String));
      expect(kafka.publish).toHaveBeenCalledWith(
        'event.events',
        savedEvent.eventId,
        expect.objectContaining({ status: 'DRAFT', schemaVersion: '1.0' }),
      );
      expect(result).toBe(savedEvent);
    });

    it('throws ForbiddenException if caller is not ORGANISER', async () => {
      const adminCaller = makeAdminCaller();
      // Override role to test the service-layer guard
      adminCaller.role = UserRole.CUSTOMER;
      await expect(service.createEvent(dto, adminCaller)).rejects.toThrow(ForbiddenException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('still returns the event if Kafka publish fails (publishSafe absorbs errors)', async () => {
      const savedEvent = makeEvent();
      repository.create.mockResolvedValue(savedEvent);
      kafka.publish.mockRejectedValue(new Error('Kafka unavailable'));

      // Should NOT throw — publishSafe swallows Kafka errors for T2 service
      const result = await service.createEvent(dto, makeOrganiserCaller());
      expect(result).toBe(savedEvent);
    });
  });

  // ── getEvent ─────────────────────────────────────────────────────────────────

  describe('getEvent', () => {
    it('returns a DRAFT event to its owner Organiser', async () => {
      const event = makeEvent({ status: EventStatus.DRAFT });
      repository.findById.mockResolvedValue(event);

      const result = await service.getEvent('event-uuid-1', makeOrganiserCaller());
      expect(result).toBe(event);
    });

    it('throws 404 if Customer tries to access a DRAFT event', async () => {
      const draftEvent = makeEvent({ status: EventStatus.DRAFT });
      repository.findById.mockResolvedValue(draftEvent);
      const customer: JwtPayload = { ...makeOrganiserCaller(), role: UserRole.CUSTOMER };

      await expect(service.getEvent('event-uuid-1', customer)).rejects.toThrow(EventNotFoundException);
    });

    it('throws TenantIsolationException if Organiser accesses another Organiser event', async () => {
      const event = makeEvent({ organiserId: 'other-organiser' });
      repository.findById.mockResolvedValue(event);

      await expect(
        service.getEvent('event-uuid-1', makeOrganiserCaller('my-organiser-id')),
      ).rejects.toThrow(TenantIsolationException);
    });

    it('throws EventNotFoundException if event does not exist', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.getEvent('missing-id', makeOrganiserCaller())).rejects.toThrow(
        EventNotFoundException,
      );
    });
  });

  // ── publishEvent ──────────────────────────────────────────────────────────────

  describe('publishEvent', () => {
    it('transitions DRAFT → PUBLISHED and publishes EventPublished', async () => {
      const event = makePublishableEvent();
      const published = { ...event, status: EventStatus.PUBLISHED, publishedAt: new Date() };
      repository.findById.mockResolvedValue(event as EventDocument);
      repository.updateStatus.mockResolvedValue(published as unknown as EventDocument);

      const result = await service.publishEvent(event.eventId, makeOrganiserCaller());

      expect(repository.updateStatus).toHaveBeenCalledWith(
        event.eventId,
        EventStatus.PUBLISHED,
        expect.objectContaining({ publishedAt: expect.any(Date) as Date }),
      );
      expect(kafka.publish).toHaveBeenCalledWith(
        'event.events',
        event.eventId,
        expect.objectContaining({ status: 'PUBLISHED' }),
      );
      expect(result.status).toBe(EventStatus.PUBLISHED);
    });

    it('rejects publish if event date is in the past', async () => {
      const pastEvent = makePublishableEvent();
      pastEvent.eventDate = new Date(Date.now() - 86400000); // yesterday
      repository.findById.mockResolvedValue(pastEvent);

      await expect(service.publishEvent(pastEvent.eventId, makeOrganiserCaller())).rejects.toThrow(
        PublishPreconditionsNotMetException,
      );
    });

    it('rejects publish if no pricing tiers configured', async () => {
      const event = makeEvent({ sections: [{ sectionId: 's1' } as never], pricingTiers: [] });
      repository.findById.mockResolvedValue(event);

      await expect(service.publishEvent(event.eventId, makeOrganiserCaller())).rejects.toThrow(
        PublishPreconditionsNotMetException,
      );
    });

    it('rejects publish if no sections configured', async () => {
      const event = makeEvent({ sections: [], pricingTiers: [{ tierId: 't1' } as never] });
      repository.findById.mockResolvedValue(event);

      await expect(service.publishEvent(event.eventId, makeOrganiserCaller())).rejects.toThrow(
        PublishPreconditionsNotMetException,
      );
    });

    it('rejects publish on CANCELLED event', async () => {
      const cancelled = makePublishableEvent();
      cancelled.status = EventStatus.CANCELLED;
      repository.findById.mockResolvedValue(cancelled);

      await expect(service.publishEvent(cancelled.eventId, makeOrganiserCaller())).rejects.toThrow(
        EventStateConflictException,
      );
    });
  });

  // ── cancelEvent ───────────────────────────────────────────────────────────────

  describe('cancelEvent', () => {
    const cancelDto: CancelEventDto = { reason: 'Venue unavailable' };

    it('transitions PUBLISHED → CANCELLED and publishes EventCancelled', async () => {
      const event = makePublishableEvent();
      event.status = EventStatus.PUBLISHED;
      const cancelled = { ...event, status: EventStatus.CANCELLED };
      repository.findById.mockResolvedValue(event);
      repository.updateStatus.mockResolvedValue(cancelled as unknown as EventDocument);

      await service.cancelEvent(event.eventId, cancelDto, makeOrganiserCaller());

      expect(kafka.publish).toHaveBeenCalledWith(
        'event.events',
        event.eventId,
        expect.objectContaining({ status: 'CANCELLED' }),
      );
    });

    it('is idempotent — returns current state without duplicate Kafka publish (NFR-REL-011)', async () => {
      const alreadyCancelled = makeEvent({ status: EventStatus.CANCELLED });
      repository.findById.mockResolvedValue(alreadyCancelled);

      const result = await service.cancelEvent('event-uuid-1', cancelDto, makeOrganiserCaller());

      // Event is returned as-is
      expect(result.status).toBe(EventStatus.CANCELLED);
      // No Kafka message published — duplicate suppressed
      expect(kafka.publish).not.toHaveBeenCalled();
      // Repository was NOT asked to update status
      expect(repository.updateStatus).not.toHaveBeenCalled();
    });

    it('allows Admin to cancel any event (not just their own)', async () => {
      const event = makeEvent({ organiserId: 'different-organiser', status: EventStatus.PUBLISHED });
      const updated = { ...event, status: EventStatus.CANCELLED };
      repository.findById.mockResolvedValue(event);
      repository.updateStatus.mockResolvedValue(updated as unknown as EventDocument);

      // Admin can cancel another organiser's event — no TenantIsolationException
      await expect(
        service.cancelEvent(event.eventId, cancelDto, makeAdminCaller()),
      ).resolves.toBeDefined();
    });

    it('throws TenantIsolationException if Organiser tries to cancel another Organiser event', async () => {
      const event = makeEvent({ organiserId: 'other-org', status: EventStatus.PUBLISHED });
      repository.findById.mockResolvedValue(event);

      await expect(
        service.cancelEvent(event.eventId, cancelDto, makeOrganiserCaller('my-org')),
      ).rejects.toThrow(TenantIsolationException);
    });
  });

  // ── postponeEvent ─────────────────────────────────────────────────────────────

  describe('postponeEvent', () => {
    const postponeDto: PostponeEventDto = {
      newDate: new Date(Date.now() + 86400000 * 60).toISOString(),
      reason: 'Performer rescheduled',
    };

    it('transitions PUBLISHED → POSTPONED and publishes EventPostponed', async () => {
      const event = makeEvent({ status: EventStatus.PUBLISHED });
      const postponed = { ...event, status: EventStatus.POSTPONED };
      repository.findById.mockResolvedValue(event);
      repository.updateStatus.mockResolvedValue(postponed as unknown as EventDocument);

      await service.postponeEvent(event.eventId, postponeDto, makeOrganiserCaller());

      expect(kafka.publish).toHaveBeenCalledWith(
        'event.events',
        event.eventId,
        expect.objectContaining({ status: 'POSTPONED' }),
      );
    });

    it('rejects postpone on DRAFT event (must be PUBLISHED first)', async () => {
      const draftEvent = makeEvent({ status: EventStatus.DRAFT });
      repository.findById.mockResolvedValue(draftEvent);

      await expect(
        service.postponeEvent(draftEvent.eventId, postponeDto, makeOrganiserCaller()),
      ).rejects.toThrow(EventStateConflictException);
    });
  });
});
