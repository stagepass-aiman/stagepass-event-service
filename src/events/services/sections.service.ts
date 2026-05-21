/**
 * sections.service.ts
 *
 * Handles section management within an event.
 * Sections can only be added while the event is in DRAFT status.
 * Sections are embedded sub-documents in the Event document (see event.schema.ts).
 */

import { Injectable } from '@nestjs/common';
import { EventsRepository } from '../repositories/events.repository';
import { EventStatus, type EventDocument } from '../schemas/event.schema';
import {
  EventNotFoundException,
  EventStateConflictException,
  TenantIsolationException,
} from '../exceptions/event.exceptions';
import type { CreateSectionDto } from '../dto/event.dto';
import { UserRole, type JwtPayload } from '../../common/types/jwt-payload.type';

@Injectable()
export class SectionsService {
  constructor(private readonly eventsRepository: EventsRepository) {}

  async listSections(eventId: string, caller: JwtPayload): Promise<EventDocument['sections']> {
    const event = await this.requireReadableEvent(eventId, caller);
    return event.sections;
  }

  async createSection(
    eventId: string,
    dto: CreateSectionDto,
    caller: JwtPayload,
  ): Promise<EventDocument['sections'][0]> {
    const event = await this.requireEvent(eventId);
    this.assertOrganiserOwns(event, caller.sub);

    if (event.status !== EventStatus.DRAFT) {
      throw new EventStateConflictException(event.status, EventStatus.DRAFT, 'createSection');
    }

    // Validate the pricingTierId references an existing tier within this event.
    const tierExists = event.pricingTiers.some((t) => t.tierId === dto.pricingTierId);
    if (!tierExists) {
      throw new EventStateConflictException(
        `pricingTierId "${dto.pricingTierId}" does not exist in this event's pricing tiers`,
        'valid pricingTierId',
        'createSection',
      );
    }

    const updated = await this.eventsRepository.addSection(eventId, dto);
    if (!updated) throw new EventNotFoundException(eventId);

    // Return the newly added section (last element after push)
    const newSection = updated.sections[updated.sections.length - 1];
    if (!newSection) throw new EventNotFoundException(eventId);
    return newSection;
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
