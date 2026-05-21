/**
 * event.dto.ts
 *
 * All DTOs for the events domain, co-located for readability.
 * In a larger service each would be its own file; at this size,
 * a single file reduces import overhead without losing clarity.
 *
 * WHY class-validator over Zod:
 *   NestJS's ValidationPipe is class-validator-native. Zod is a better
 *   TypeScript experience but requires a custom pipe adapter. For a
 *   backend-only service with no client bundle size constraint, the
 *   class-validator + class-transformer combo integrates with NestJS DI
 *   and Swagger without friction. We use Zod on the React frontend.
 *
 * Money is validated as a string matching the ADR-004 pattern.
 * The service layer parses it into a Money value object.
 */

import {
  IsString,
  IsOptional,
  IsUUID,
  IsDateString,
  IsUrl,
  IsArray,
  IsInt,
  IsBoolean,
  IsNumber,
  ValidateNested,
  MaxLength,
  IsIn,
  Min,
  Max,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EventStatus } from '../schemas/event.schema';

// ── Money DTO ─────────────────────────────────────────────────────────────────

export class MoneyInputDto {
  /** Decimal string with exactly 4 decimal places. e.g. "1250.0000" (ADR-004) */
  @Matches(/^\d+\.\d{4}$/, {
    message: 'amount must be a decimal string with exactly 4 decimal places (e.g. "1250.0000")',
  })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 3-letter code (e.g. "INR")' })
  currency!: string;
}

// ── Cancellation Policy ────────────────────────────────────────────────────────

export class CancellationBracketDto {
  @IsInt()
  @Min(0)
  hoursBeforeEvent!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  refundPercentage!: number;
}

export class CancellationPolicyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CancellationBracketDto)
  brackets!: CancellationBracketDto[];
}

// ── Surge Rules ────────────────────────────────────────────────────────────────

export class SurgeRulesDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxMultiplier?: number;
}

// ── Create Event ──────────────────────────────────────────────────────────────

export class CreateEventDto {
  @IsUUID()
  venueBookingId!: string;

  @IsString()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsDateString()
  eventDate!: string;

  @IsOptional()
  @IsDateString()
  doorOpenTime?: string;

  @IsOptional()
  @IsUrl()
  posterUrl?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  @ValidateNested()
  @Type(() => CancellationPolicyDto)
  cancellationPolicy!: CancellationPolicyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SurgeRulesDto)
  surgeRules?: SurgeRulesDto;
}

// ── Update Event ──────────────────────────────────────────────────────────────

export class UpdateEventDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsUrl()
  posterUrl?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CancellationPolicyDto)
  cancellationPolicy?: CancellationPolicyDto;
}

// ── List Events ────────────────────────────────────────────────────────────────

export class ListEventsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  pageSize?: number;

  @IsOptional()
  @IsIn(Object.values(EventStatus))
  status?: EventStatus;

  @IsOptional()
  @IsUUID()
  venueId?: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;
}

// ── Cancel Event ──────────────────────────────────────────────────────────────

export class CancelEventDto {
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

// ── Postpone Event ────────────────────────────────────────────────────────────

export class PostponeEventDto {
  @IsDateString()
  newDate!: string;

  @IsString()
  @MaxLength(1000)
  reason!: string;
}

// ── Create Section ────────────────────────────────────────────────────────────

export class CreateSectionDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsString()
  layoutSectionRef!: string;

  @IsUUID()
  pricingTierId!: string;

  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'colour must be a hex colour code (e.g. #A1B2C3)' })
  colour?: string;
}

// ── Create Pricing Tier ────────────────────────────────────────────────────────

export class CreatePricingTierDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @ValidateNested()
  @Type(() => MoneyInputDto)
  price!: MoneyInputDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;
}
