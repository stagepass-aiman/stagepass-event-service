/**
 * roles.guard.ts
 *
 * WHY: Authentication (who you are) is separate from authorisation (what you
 * can do). JwtAuthGuard establishes identity. RolesGuard enforces permissions.
 * This separation means we can test each concern independently.
 *
 * The guard reads the @Roles() metadata set on the handler/controller and
 * compares the caller's role (from the verified JWT payload) against the
 * allowed roles. A mismatch returns 403 — not 401. The distinction matters:
 *   - 401: we don't know who you are (not authenticated)
 *   - 403: we know who you are, you're not allowed (not authorised)
 *
 * If no @Roles() metadata is present, the guard allows the request — meaning
 * any authenticated user can access the endpoint. If you want to restrict to
 * specific roles, apply @Roles() explicitly. (NFR-SEC-003)
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { UserRole, type JwtPayload } from '../types/jwt-payload.type';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Get the allowed roles for this specific handler (method-level takes priority)
    // then fall back to controller-level metadata.
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() decorator — any authenticated user is allowed.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest & { user: JwtPayload }>();
    const user = request.user;

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Role "${user.role}" is not permitted to perform this action. ` +
          `Required: ${requiredRoles.join(' or ')}.`,
      );
    }

    return true;
  }
}
