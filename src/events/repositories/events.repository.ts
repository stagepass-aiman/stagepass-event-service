/**
 * events.repository.ts
 *
 * WHY a repository layer:
 *   The repository pattern isolates Mongoose from the service layer. Services
 *   express *what* data they need; the repository expresses *how* to fetch it.
 *   This makes service logic testable without a real database (mock the
 *   repository) and makes the Mongoose schema replaceable without touching
 *   business logic.
 *
 * CURSOR PAGINATION:
 *   We use cursor-based (keysет) pagination, not offset-based. Reason:
 *   offset pagination requires counting all rows before the offset on each
 *   request — O(offset) work. As pages grow, this gets slow.
 *   Cursor pagination always starts from a known document and reads forward —
 *   O(page size) regardless of how deep the user is. (ADR-003 §3.2.2)
 *
 *   Cursor = base64(JSON({ eventDate, eventId })) — opaque to the caller.
 *   This two-field cursor handles ties on eventDate (multiple events same date).
 */

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import {
  EventEntity,
  EventDocument,
  EventStatus,
  SectionSubDoc,
  PricingTierSubDoc,
} from '../schemas/event.schema';
import type {
  CreateEventDto,
  UpdateEventDto,
  ListEventsQueryDto,
  CreateSectionDto,
  CreatePricingTierDto,
} from '../dto/event.dto';
import { Money } from '../../common/types/money.type';

export interface EventPage {
  items: EventDocument[];
  nextCursor: string | null;
  prevCursor: string | null;
}

interface DecodedCursor {
  eventDate: string;
  eventId: string;
}

@Injectable()
export class EventsRepository {
  constructor(
    @InjectModel(EventEntity.name)
    private readonly eventModel: Model<EventDocument>,
  ) {}

  async create(dto: CreateEventDto, organiserId: string, venueId: string): Promise<EventDocument> {
    const event = new this.eventModel({
      eventId: uuidv4(),
      venueBookingId: dto.venueBookingId,
      venueId,
      organiserId,
      title: dto.title,
      description: dto.description,
      status: EventStatus.DRAFT,
      eventDate: new Date(dto.eventDate),
      doorOpenTime: dto.doorOpenTime ? new Date(dto.doorOpenTime) : undefined,
      posterUrl: dto.posterUrl,
      categoryIds: dto.categoryIds ?? [],
      cancellationPolicy: dto.cancellationPolicy,
      surgeRules: dto.surgeRules,
      sections: [],
      pricingTiers: [],
    });
    return event.save();
  }

  async findById(eventId: string): Promise<EventDocument | null> {
    return this.eventModel.findOne({ eventId }).exec();
  }

  async update(eventId: string, dto: UpdateEventDto): Promise<EventDocument | null> {
    return this.eventModel
      .findOneAndUpdate(
        { eventId },
        {
          $set: {
            ...(dto.title !== undefined && { title: dto.title }),
            ...(dto.description !== undefined && { description: dto.description }),
            ...(dto.posterUrl !== undefined && { posterUrl: dto.posterUrl }),
            ...(dto.cancellationPolicy !== undefined && {
              cancellationPolicy: dto.cancellationPolicy,
            }),
          },
        },
        { new: true },
      )
      .exec();
  }

  async updateStatus(
    eventId: string,
    status: EventStatus,
    extra?: Partial<EventDocument>,
  ): Promise<EventDocument | null> {
    return this.eventModel
      .findOneAndUpdate({ eventId }, { $set: { status, ...extra } }, { new: true })
      .exec();
  }

  /**
   * Cursor-based paginated list.
   *
   * Caller role determines the filter scope:
   *   CUSTOMER  → PUBLISHED only
   *   ORGANISER → own events only (all statuses)
   *   ADMIN     → all events (all statuses)
   */
  async findPaginated(
    query: ListEventsQueryDto,
    scopeFilter: FilterQuery<EventDocument>,
    pageSize = 20,
  ): Promise<EventPage> {
    const limit = Math.min(pageSize, 100);
    const filter: FilterQuery<EventDocument> = { ...scopeFilter };

    if (query.status) filter['status'] = query.status;
    if (query.venueId) filter['venueId'] = query.venueId;
    if (query.fromDate || query.toDate) {
      filter['eventDate'] = {
        ...(query.fromDate && { $gte: new Date(query.fromDate) }),
        ...(query.toDate && { $lte: new Date(query.toDate) }),
      };
    }

    if (query.cursor) {
      const decoded = this.decodeCursor(query.cursor);
      if (decoded) {
        // Fetch events after the cursor position.
        // Using $or to handle the tie-break on eventDate:
        //   (eventDate > cursor.eventDate) OR
        //   (eventDate === cursor.eventDate AND eventId > cursor.eventId)
        filter['$or'] = [
          { eventDate: { $gt: new Date(decoded.eventDate) } },
          {
            eventDate: { $eq: new Date(decoded.eventDate) },
            eventId: { $gt: decoded.eventId },
          },
        ];
      }
    }

    // Fetch one extra to determine if there are more pages.
    const items = await this.eventModel
      .find(filter)
      .sort({ eventDate: 1, eventId: 1 })
      .limit(limit + 1)
      .exec();

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;

    const lastItem = page[page.length - 1];
    const nextCursor =
      hasMore && lastItem
        ? this.encodeCursor({
            eventDate: lastItem.eventDate.toISOString(),
            eventId: lastItem.eventId,
          })
        : null;

    return {
      items: page,
      nextCursor,
      prevCursor: null, // Prev-page cursor requires bidirectional cursor; Phase 4 enhancement
    };
  }

  async addSection(eventId: string, dto: CreateSectionDto): Promise<EventDocument | null> {
    const section: SectionSubDoc = {
      sectionId: uuidv4(),
      name: dto.name,
      layoutSectionRef: dto.layoutSectionRef,
      pricingTierId: dto.pricingTierId,
      colour: dto.colour,
    };
    return this.eventModel
      .findOneAndUpdate({ eventId }, { $push: { sections: section } }, { new: true })
      .exec();
  }

  async addPricingTier(eventId: string, dto: CreatePricingTierDto): Promise<EventDocument | null> {
    const money = Money.fromDto(dto.price);
    const tier: PricingTierSubDoc = {
      tierId: uuidv4(),
      name: dto.name,
      // Store as Decimal128 — exact decimal arithmetic (ADR-004)
      priceAmount: Types.Decimal128.fromString(money.amount.toFixed(4)),
      priceCurrency: money.currency,
      capacity: dto.capacity,
      soldCount: 0,
      createdAt: new Date(),
    };
    return this.eventModel
      .findOneAndUpdate({ eventId }, { $push: { pricingTiers: tier } }, { new: true })
      .exec();
  }

  private encodeCursor(cursor: DecodedCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  private decodeCursor(encoded: string): DecodedCursor | null {
    try {
      const decoded = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      ) as DecodedCursor;
      return decoded;
    } catch {
      return null;
    }
  }
}
