/**
 * roles.decorator.ts
 *
 * WHY: Metadata-based RBAC. @Roles(UserRole.ORGANISER) on a controller method
 * attaches the allowed roles to that method's metadata. RolesGuard reads this
 * metadata and compares it against the role in the verified JWT payload.
 *
 * This is the NestJS equivalent of Spring Security's @PreAuthorize.
 * The guard runs AFTER JwtAuthGuard (auth first, then authorisation).
 */

import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../types/jwt-payload.type';

export const ROLES_KEY = 'roles';

export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
