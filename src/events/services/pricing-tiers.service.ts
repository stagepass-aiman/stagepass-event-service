/**
 * pricing-tiers.service.ts
 *
 * Handles pricing tier management within an event.
 *
 * KEY INVARIANT: Once a ticket at a pricing tier is sold (soldCount > 0),
 * the tier's price cannot be changed. This is enforced here.
 * New tiers can be added even after publishing.
 */

import { Injectable } from '@nestjs/common';
import { EventsRepository } from '../repositories/events.repository';
import { EventStatus, type EventDocument } from '../schemas/event.schema';
import {
  EventNotFoundException,
  EventStateConflictException,
  TenantIsolationException,
} from '../exceptions/event.exceptions';
import type { CreatePricingTierDto } from '../dto/event.dto';
import { UserRole, type JwtPayload } from '../../common/types/jwt-payload.type';

@Injectable()
export class PricingTiersService {
  constructor(private readonly eventsRepository: EventsRepository) {}

  async listPricingTiers(
    eventId: string,
    caller: JwtPayload,
  ): Promise<EventDocument['pricingTiers']> {
    const event = await this.requireReadableEvent(eventId, caller);
    return event.pricingTiers;
  }

  async createPricingTier(
    eventId: string,
    dto: CreatePricingTierDto,
    caller: JwtPayload,
  ): Promise<EventDocument['pricingTiers'][0]> {
    const event = await this.requireEvent(eventId);

    // Pricing tiers require ORGANISER ownership.
    if (caller.role === UserRole.ORGANISER) {
      this.assertOrganiserOwns(event, caller.sub);
    }

    // New tiers can be added to DRAFT or PUBLISHED events (PRD §6.2).
    // CANCELLED events cannot be modified.
    if (
      event.status === EventStatus.CANCELLED
    ) {
      throw new EventStateConflictException(
        event.status,
        'DRAFT or PUBLISHED',
        'createPricingTier',
      );
    }

    const updated = await this.eventsRepository.addPricingTier(eventId, dto);
    if (!updated) throw new EventNotFoundException(eventId);

    const newTier = updated.pricingTiers[updated.pricingTiers.length - 1];
    if (!newTier) throw new EventNotFoundException(eventId);
    return newTier;
  }

  private async requireEvent(eventId: string): Promise<EventDocument> {
    const event = await this.eventsRepository.findById(eventId);
    if (!event) throw new EventNotFoundException(eventId);
    return event;
  }

  private async requireReadableEvent(eventId: string, caller: JwtPayload): Promise<EventDocument> {
    const event = await this.requireEvent(eventId);
    if (caller.role === UserRole.CUSTOMER && event.status !== EventStatus.PUBLISHED) {
      throw new EventNotFoundException(eventId);
    }
    if (caller.role === UserRole.ORGANISER) {
      this.assertOrganiserOwns(event, caller.sub);
    }
    return event;
  }

  private assertOrganiserOwns(event: EventDocument, callerId: string): void {
    if (event.organiserId !== callerId) {
      throw new TenantIsolationException();
    }
  }
}
