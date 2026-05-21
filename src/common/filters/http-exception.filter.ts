/**
 * http-exception.filter.ts
 *
 * WHY: RFC 9457 (Problem Details for HTTP APIs) standardises error responses.
 * All error responses from the Event Service use application/problem+json and
 * include type, title, status, detail, instance, and traceId — matching the
 * ProblemDetail schema in event.yaml exactly.
 *
 * This filter catches ALL exceptions — both NestJS HttpExceptions and unhandled
 * domain exceptions — and maps them to Problem Details. Unhandled exceptions
 * become 500 responses; the real error is logged with the traceId so it can
 * be correlated in Grafana/Jaeger (NFR-OBS-004).
 *
 * Anti-pattern avoided: returning raw stack traces to clients. The detail field
 * describes the problem in terms meaningful to the consumer; the stack trace
 * stays in the structured log.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';

interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  traceId: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();

    // Extract traceId from the request if OpenTelemetry has set it.
    // Falls back to a random UUID so every error response is uniquely traceable.
    const traceId = (request.headers['x-trace-id'] as string | undefined) ?? randomUUID();

    let status: number;
    let title: string;
    let detail: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const responseBody = exception.getResponse();
      title =
        typeof responseBody === 'object'
          ? (((responseBody as Record<string, unknown>)['error'] as string | undefined) ??
            exception.message)
          : exception.message;
      detail =
        typeof responseBody === 'object'
          ? (((responseBody as Record<string, unknown>)['message'] as string | undefined) ??
            exception.message)
          : exception.message;
    } else {
      // Unhandled exception — log it fully, return generic 500 to client.
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      title = 'Internal Server Error';
      detail = 'An unexpected error occurred. Reference the traceId in support requests.';
      this.logger.error(
        {
          traceId,
          error: exception instanceof Error ? exception.message : String(exception),
          stack: exception instanceof Error ? exception.stack : undefined,
          path: request.url,
        },
        'Unhandled exception',
      );
    }

    const body: ProblemDetail = {
      type: `https://stagepass.dev/problems/${status}`,
      title,
      status,
      detail,
      instance: request.url,
      traceId,
    };

    void reply.status(status).header('Content-Type', 'application/problem+json').send(body);
  }
}
