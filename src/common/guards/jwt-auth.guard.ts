/**
 * jwt-auth.guard.ts
 *
 * WHY: Every protected endpoint must verify the caller's identity using the
 * JWT issued by the Auth Service. We validate locally using the cached JWKS
 * public key — zero network calls in the hot path (ADR-003 §3.3, NFR-SEC-001).
 *
 * The guard:
 *   1. Extracts the Bearer token from the Authorization header.
 *   2. Delegates to JwksService.verifyToken() for RS256 verification.
 *   3. Attaches the typed JwtPayload to request.user for downstream use.
 *
 * Endpoints that don't require auth (e.g. /health/*) bypass this guard by
 * NOT applying @UseGuards(JwtAuthGuard) — or by using NestJS's IS_PUBLIC_KEY
 * metadata pattern if we need a default-secured approach. For this service,
 * we apply the guard explicitly to controller methods rather than globally,
 * keeping the health endpoints clean without extra metadata.
 *
 * Anti-pattern avoided: calling the Auth Service on every request to validate
 * the token. That creates a hard dependency between every protected endpoint
 * and the Auth Service — if Auth is slow, every service is slow.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { JwksService } from '../../jwks/jwks.service';
import type { JwtPayload } from '../types/jwt-payload.type';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwksService: JwksService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { user?: JwtPayload }>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Authorization header missing or malformed.');
    }

    // JwksService handles the cache-hit/re-fetch/verify cycle.
    // Throws UnauthorizedException on any failure.
    request.user = await this.jwksService.verifyToken(token);
    return true;
  }

  private extractBearerToken(request: FastifyRequest): string | null {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.slice(7); // Remove "Bearer " prefix
  }
}
