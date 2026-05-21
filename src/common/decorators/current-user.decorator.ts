/**
 * current-user.decorator.ts
 *
 * WHY: A custom parameter decorator extracts the JwtPayload attached to the
 * request by JwtAuthGuard — so controllers write @CurrentUser() user: JwtPayload
 * rather than reaching into the raw request object. This keeps controllers
 * clean and makes the extraction point explicit and testable.
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { JwtPayload } from '../types/jwt-payload.type';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest & { user: JwtPayload }>();
    // JwtAuthGuard guarantees this is set before any controller handler runs.
    return request.user;
  },
);
