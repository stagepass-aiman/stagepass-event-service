/**
 * sections.controller.ts
 *
 * GET  /events/:eventId/sections
 * POST /events/:eventId/sections
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
import { SectionsService } from '../services/sections.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { UserRole, type JwtPayload } from '../../common/types/jwt-payload.type';
import { CreateSectionDto } from '../dto/event.dto';

@Controller('events/:eventId/sections')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(IdempotencyInterceptor)
export class SectionsController {
  constructor(private readonly sectionsService: SectionsService) {}

  @Get()
  async listSections(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() caller: JwtPayload,
  ) {
    const sections = await this.sectionsService.listSections(eventId, caller);
    return { items: sections };
  }

  @Post()
  @Roles(UserRole.ORGANISER)
  @HttpCode(HttpStatus.CREATED)
  async createSection(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: CreateSectionDto,
    @CurrentUser() caller: JwtPayload,
  ) {
    return this.sectionsService.createSection(eventId, dto, caller);
  }
}
