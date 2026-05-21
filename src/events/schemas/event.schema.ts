/**
 * event.schema.ts
 *
 * WHY EMBEDDED SUB-DOCUMENTS:
 *   Sections and PricingTiers are embedded as arrays within the Event document.
 *   They have no independent lifecycle — a section cannot exist without an event.
 *   Embedding means a single MongoDB read returns the full aggregate; no $lookup
 *   (JOIN equivalent) required. The event IS the aggregate root. (ADR-002 §3.4)
 *
 * WHY Decimal128 FOR PRICE (not Number):
 *   MongoDB's native Number type is a 64-bit IEEE 754 double — the same
 *   precision trap as JavaScript's number. Decimal128 stores the value as a
 *   128-bit decimal, preserving exact fractional values. (ADR-004 §3.3)
 *
 * INDEXES:
 *   - organiserId: primary query pattern for Organiser portal (list own events)
 *   - status: secondary filter on all list queries
 *   - eventDate: range queries (fromDate/toDate filter in list endpoint)
 *   Compound index on (organiserId, status, eventDate) covers the most common
 *   Organiser query: "show me my DRAFT events sorted by date".
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type EventDocument = EventEntity & Document;

export enum EventStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  CANCELLED = 'CANCELLED',
  POSTPONED = 'POSTPONED',
}

// ── Embedded: CancellationPolicyBracket ──────────────────────────────────────

@Schema({ _id: false })
export class CancellationBracket {
  @Prop({ required: true, type: Number })
  hoursBeforeEvent!: number;

  @Prop({ required: true, type: Number, min: 0, max: 100 })
  refundPercentage!: number;
}

const CancellationBracketSchema = SchemaFactory.createForClass(CancellationBracket);

// ── Embedded: CancellationPolicy ─────────────────────────────────────────────

@Schema({ _id: false })
export class CancellationPolicy {
  @Prop({ type: [CancellationBracketSchema], default: [] })
  brackets!: CancellationBracket[];
}

const CancellationPolicySchema = SchemaFactory.createForClass(CancellationPolicy);

// ── Embedded: SurgeRules ─────────────────────────────────────────────────────

@Schema({ _id: false })
export class SurgeRules {
  @Prop({ type: Boolean, default: false })
  enabled!: boolean;

  @Prop({ type: Number, nullable: true })
  maxMultiplier?: number;
}

const SurgeRulesSchema = SchemaFactory.createForClass(SurgeRules);

// ── Embedded: PricingTier ─────────────────────────────────────────────────────

@Schema({ _id: false })
export class PricingTierSubDoc {
  /** UUID assigned by the service at creation time. Stored as string for portability. */
  @Prop({ required: true, type: String })
  tierId!: string;

  @Prop({ required: true, type: String, maxlength: 100 })
  name!: string;

  /**
   * Price amount stored as Decimal128 for exact decimal arithmetic. (ADR-004)
   * Serialised to string ("1250.0000") in API responses — never exposed as a
   * JavaScript number.
   */
  @Prop({ required: true, type: MongooseSchema.Types.Decimal128 })
  priceAmount!: Types.Decimal128;

  @Prop({ required: true, type: String, minlength: 3, maxlength: 3 })
  priceCurrency!: string;

  @Prop({ type: Number, nullable: true })
  capacity?: number;

  /**
   * soldCount is owned by the Seat Inventory Service. This field is a
   * denormalised read-optimised copy, updated via Kafka events when a ticket
   * is sold. In Phase 3 it is always 0. Pricing tier price-lock (soldCount > 0)
   * is enforced here but the source of truth for sold tickets is Seat Inventory.
   */
  @Prop({ type: Number, default: 0 })
  soldCount!: number;

  @Prop({ required: true, type: Date })
  createdAt!: Date;
}

const PricingTierSubDocSchema = SchemaFactory.createForClass(PricingTierSubDoc);

// ── Embedded: Section ────────────────────────────────────────────────────────

@Schema({ _id: false })
export class SectionSubDoc {
  @Prop({ required: true, type: String })
  sectionId!: string;

  @Prop({ required: true, type: String, maxlength: 100 })
  name!: string;

  /** Reference to the section identifier in the Venue SeatingLayout. */
  @Prop({ required: true, type: String })
  layoutSectionRef!: string;

  /** Foreign key to the PricingTierSubDoc.tierId within the same event. */
  @Prop({ required: true, type: String })
  pricingTierId!: string;

  @Prop({ type: String, match: /^#[0-9A-Fa-f]{6}$/ })
  colour?: string;
}

const SectionSubDocSchema = SchemaFactory.createForClass(SectionSubDoc);

// ── Root: Event ──────────────────────────────────────────────────────────────

@Schema({
  collection: 'events',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  // Optimistic concurrency — MongoDB 4.4+ supports this natively.
  // Prevents two concurrent PATCH operations from both succeeding on stale state.
  optimisticConcurrency: true,
})
export class EventEntity {
  /** UUID — assigned by the service, stored as string. Not MongoDB's _id. */
  @Prop({ required: true, type: String, unique: true, index: true })
  eventId!: string;

  @Prop({ required: true, type: String })
  venueBookingId!: string;

  @Prop({ required: true, type: String })
  venueId!: string;

  @Prop({ required: true, type: String, index: true })
  organiserId!: string;

  @Prop({ required: true, type: String, maxlength: 200 })
  title!: string;

  @Prop({ type: String, maxlength: 5000 })
  description?: string;

  @Prop({
    required: true,
    type: String,
    enum: Object.values(EventStatus),
    index: true,
  })
  status!: EventStatus;

  @Prop({ required: true, type: Date, index: true })
  eventDate!: Date;

  @Prop({ type: Date })
  doorOpenTime?: Date;

  @Prop({ type: Date, nullable: true })
  postponedDate?: Date;

  @Prop({ type: String })
  posterUrl?: string;

  @Prop({ type: [String], default: [] })
  categoryIds!: string[];

  @Prop({ type: CancellationPolicySchema, default: () => ({ brackets: [] }) })
  cancellationPolicy!: CancellationPolicy;

  @Prop({ type: SurgeRulesSchema })
  surgeRules?: SurgeRules;

  @Prop({ type: [SectionSubDocSchema], default: [] })
  sections!: SectionSubDoc[];

  @Prop({ type: [PricingTierSubDocSchema], default: [] })
  pricingTiers!: PricingTierSubDoc[];

  @Prop({ type: Date, nullable: true })
  publishedAt?: Date;

  @Prop({ type: Date, nullable: true })
  cancelledAt?: Date;

  @Prop({ type: String, nullable: true })
  cancellationReason?: string;

  // Injected by Mongoose timestamps option:
  createdAt!: Date;
  updatedAt!: Date;
}

export const EventEntitySchema = SchemaFactory.createForClass(EventEntity);

// ── Compound index for the most common query pattern ──────────────────────────
// Organiser list: { organiserId: X, status: DRAFT, eventDate: range }
EventEntitySchema.index({ organiserId: 1, status: 1, eventDate: 1 });

// Admin list: { status: X, eventDate: range }
EventEntitySchema.index({ status: 1, eventDate: 1 });
