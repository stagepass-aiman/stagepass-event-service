/**
 * events.controller.ts
 *
 * Implements all endpoints from event.yaml exactly:
 *   POST   /events
 *   GET    /events
 *   GET    /events/:eventId
 *   PUT    /events/:eventId
 *   POST   /events/:eventId/publish
 *   POST   /events/:eventId/cancel
 *   POST   /events/:eventId/postpone
 *
 * WHY controllers are thin:
 *   Controllers validate HTTP concerns (parsing, headers, status codes) and
 *   delegate to services for domain logic. If a controller method is >20 lines,
 *   it is probably doing something that belongs in a service.
 *
 * The @Roles() decorator is applied at the method level where role restrictions
 * differ per endpoint. @UseGuards(JwtAuthGuard, RolesGuard) is applied at the
 * controller class level to protect all endpoints. (NFR-SEC-001, NFR-SEC-003)
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
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { EventsService } from '../services/events.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { UserRole, type JwtPayload } from '../../common/types/jwt-payload.type';
import {
  CreateEventDto,
  UpdateEventDto,
  ListEventsQueryDto,
  CancelEventDto,
  PostponeEventDto,
} from '../dto/event.dto';

@Controller('events')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(IdempotencyInterceptor)
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  /**
   * POST /events
   * Create a new event in DRAFT status. Organiser only. (PRD FR-O-002)
   */
  @Post()
  @Roles(UserRole.ORGANISER)
  @HttpCode(HttpStatus.CREATED)
  async createEvent(
    @Body() dto: CreateEventDto,
    @CurrentUser() caller: JwtPayload,
  ) {
    return this.eventsService.createEvent(dto, caller);
  }

  /**
   * GET /events
   * Role-scoped list: Customers see PUBLISHED, Organisers see own, Admins see all.
   */
  @Get()
  async listEvents(
    @Query() query: ListEventsQueryDto,
    @CurrentUser() caller: JwtPayload,
  ) {
    return this.eventsService.listEvents(query, caller);
  }

  /**
   * GET /events/:eventId
   * Customers: PUBLISHED only. Organisers: own events. Admins: any.
   */
  @Get(':eventId')
  async getEvent(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() caller: JwtPayload,
  ) {
    return this.eventsService.getEvent(eventId, caller);
  }

  /**
   * PUT /events/:eventId
   * Update event metadata. DRAFT status only. Organiser only.
   */
  @Put(':eventId')
  @Roles(UserRole.ORGANISER)
  async updateEvent(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: UpdateEventDto,
    @CurrentUser() caller: JwtPayload,
  ) {
    return this.eventsService.updateEvent(eventId, dto, caller);
  }

  /**
   * POST /events/:eventId/publish
   * Transition DRAFT → PUBLISHED. Validates pre-conditions. Organiser only.
   * On success: publishes event.published to Kafka (NFR-PERF-010).
   */
  @Post(':eventId/publish')
  @Roles(UserRole.ORGANISER)
  async publishEvent(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @CurrentUser() caller: JwtPayload,
  ) {
    return this.eventsService.publishEvent(eventId, caller);
  }

  /**
   * POST /events/:eventId/cancel
   * Transition to CANCELLED. Organiser or Admin.
   * Publishes event.cancelled to Kafka → triggers Booking Service refund cascade.
   * Idempotent: already-cancelled event returns 200. (NFR-REL-011)
   */
  @Post(':eventId/cancel')
  @Roles(UserRole.ORGANISER, UserRole.ADMIN)
  async cancelEvent(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: CancelEventDto,
    @CurrentUser() caller: JwtPayload,
  ) {
    return this.eventsService.cancelEvent(eventId, dto, caller);
  }

  /**
   * POST /events/:eventId/postpone
   * Transition PUBLISHED → POSTPONED. Sets new proposed date. Organiser only.
   */
  @Post(':eventId/postpone')
  @Roles(UserRole.ORGANISER)
  async postponeEvent(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: PostponeEventDto,
    @CurrentUser() caller: JwtPayload,
  ) {
    return this.eventsService.postponeEvent(eventId, dto, caller);
  }
}
