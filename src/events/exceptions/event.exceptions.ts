/**
 * event-not-found.exception.ts
 * event-state-conflict.exception.ts
 * publish-preconditions-not-met.exception.ts
 *
 * WHY separate files: Each exception is public. Per the Auth Service build
 * log rule: never define domain exceptions as package-private inner classes.
 * One public class per file, in its own module path.
 *
 * WHY extend HttpException: NestJS's HttpExceptionFilter catches these and
 * maps them to the correct HTTP status automatically. Our global
 * HttpExceptionFilter then serialises them to RFC 9457 Problem Details.
 */

import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

export class EventNotFoundException extends NotFoundException {
  constructor(eventId: string) {
    super(`Event "${eventId}" not found.`);
  }
}

export class EventStateConflictException extends ConflictException {
  constructor(currentStatus: string, requiredStatus: string, action: string) {
    super(
      `Cannot perform "${action}" on an event in "${currentStatus}" status. ` +
        `Required status: "${requiredStatus}".`,
    );
  }
}

export class PublishPreconditionsNotMetException extends UnprocessableEntityException {
  constructor(reasons: string[]) {
    super(
      `Event cannot be published. Pre-conditions not met:\n${reasons.map((r) => `  - ${r}`).join('\n')}`,
    );
  }
}

export class TenantIsolationException extends ConflictException {
  constructor() {
    // WHY: Do not reveal ownership information to the caller. Telling an
    // Organiser "this event belongs to another Organiser" leaks data about
    // what events exist. Return 404 — the event doesn't exist *for them*.
    // Log the violation internally for security audit. (NFR-SEC-004)
    super('Event not found.');
  }
}
