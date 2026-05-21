/**
 * logging.interceptor.ts
 *
 * WHY: NFR-OBS-001 requires structured JSON logs with correlation IDs on every
 * request. A NestJS interceptor is the right place for this because it wraps
 * the full request lifecycle — we can measure the actual handler duration
 * including serialisation, which the middleware (pre-handler) cannot.
 *
 * Every log line includes:
 *   traceId   — from x-trace-id header (set by API Gateway / OTel propagator)
 *   spanId    — from x-span-id header
 *   userId    — from verified JWT payload (if authenticated)
 *   method    — HTTP method
 *   path      — request URL
 *   statusCode — response status
 *   durationMs — handler execution time
 *   service   — always "event-service" for easy filtering in Loki
 *
 * Anti-pattern: logging inside business logic (services, repositories).
 * Business logic should not know it's being logged. The interceptor handles it.
 */

import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { Observable, tap } from 'rxjs';
import type { JwtPayload } from '../types/jwt-payload.type';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { user?: JwtPayload }>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    const startMs = Date.now();
    const traceId = (request.headers['x-trace-id'] as string | undefined) ?? 'no-trace';
    const spanId = (request.headers['x-span-id'] as string | undefined) ?? 'no-span';

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log({
            service: 'event-service',
            traceId,
            spanId,
            userId: request.user?.sub ?? 'anonymous',
            method: request.method,
            path: request.url,
            statusCode: reply.statusCode,
            durationMs: Date.now() - startMs,
          });
        },
        error: (err: unknown) => {
          this.logger.warn({
            service: 'event-service',
            traceId,
            spanId,
            userId: request.user?.sub ?? 'anonymous',
            method: request.method,
            path: request.url,
            statusCode: reply.statusCode,
            durationMs: Date.now() - startMs,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      }),
    );
  }
}
