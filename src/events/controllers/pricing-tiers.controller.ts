/**
 * pricing-tiers.controller.ts
 *
 * GET  /events/:eventId/pricing-tiers
 * POST /events/:eventId/pricing-tiers
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { PricingTiersService } from '../services/pricing-tiers.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { UserRole, type JwtPayload } from '../../common/types/jwt-payload.type';
import { CreatePricingTierDto } from '../dto/event.dto';

@Controller('events/:eventId/pricing-tiers')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(IdempotencyInterceptor)
export class PricingTiersController {
  constructor(private readonly pricingTiersService: PricingTiersService) {}

  @Get()
  async listPricingTiers(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() caller: JwtPayload,
  ): Promise<unknown> {
    const tiers = await this.pricingTiersService.listPricingTiers(eventId, caller);
    return { items: tiers };
  }

  @Post()
  @Roles(UserRole.ORGANISER)
  @HttpCode(HttpStatus.CREATED)
  async createPricingTier(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: CreatePricingTierDto,
    @CurrentUser() caller: JwtPayload,
  ): Promise<unknown> {
    return this.pricingTiersService.createPricingTier(eventId, dto, caller);
  }
}
