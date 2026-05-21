/**
 * idempotency.interceptor.ts
 *
 * WHY: NFR-REL-001 requires all write endpoints to honour the Idempotency-Key
 * header — a repeat request with the same key must return the same response
 * without re-executing the handler.
 *
 * PHASE 3 LIMITATION — IN-MEMORY STORE:
 *   This implementation stores cached responses in a Map<string, CachedResponse>
 *   in-process memory. This means:
 *     1. Restart wipes all cached responses — a duplicate sent after a restart
 *        will re-execute.
 *     2. Multiple instances (horizontal scaling) do not share the cache —
 *        a duplicate hitting a different pod will re-execute.
 *     3. A request in-flight on instance A cannot be seen by instance B —
 *        concurrent duplicates may both execute.
 *
 *   PHASE 4 UPGRADE: Replace the Map with Redis SET NX PX (set-if-not-exists
 *   with TTL). SET NX is atomic — it closes the concurrent-duplicate race.
 *   The upgrade point is clearly marked below with "UPGRADE_POINT".
 *
 * WHY interceptor, not middleware?
 *   Middleware runs before the response is serialised. An interceptor wraps
 *   the handler's Observable, which means we can cache the final serialised
 *   response body, not just a pre-serialisation object.
 *
 * Only applies to mutating methods (POST, PUT, PATCH, DELETE).
 * GET requests are idempotent by definition.
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { Observable, of, tap } from 'rxjs';

interface CachedResponse {
  statusCode: number;
  body: unknown;
  cachedAt: number;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Cache responses for 24 hours — covers any realistic retry window.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  // UPGRADE_POINT: Replace this Map with a Redis client.
  // Key: `idempotency:<Idempotency-Key>`, Value: serialised CachedResponse.
  // Use SET NX PX to atomically claim the key and set its TTL.
  private readonly cache = new Map<string, CachedResponse>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    // Only guard mutating methods.
    if (!MUTATING_METHODS.has(request.method)) {
      return next.handle();
    }

    const idempotencyKey = request.headers['idempotency-key'] as string | undefined;

    // No key provided — proceed normally. The spec marks the header as optional.
    if (!idempotencyKey) {
      return next.handle();
    }

    const cached = this.cache.get(idempotencyKey);

    if (cached) {
      // Cache hit — return the stored response without calling the handler.
      void reply.status(cached.statusCode);
      return of(cached.body);
    }

    // Cache miss — execute handler and cache the result.
    return next.handle().pipe(
      tap((body: unknown) => {
        // UPGRADE_POINT: Replace this Map.set() with Redis SET NX PX.
        this.cache.set(idempotencyKey, {
          statusCode: reply.statusCode,
          body,
          cachedAt: Date.now(),
        });

        // Evict stale entries — simple TTL enforcement without a timer.
        // UPGRADE_POINT: Redis TTL handles eviction automatically.
        this.evictStale();
      }),
    );
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.cachedAt > CACHE_TTL_MS) {
        this.cache.delete(key);
      }
    }
  }
}
