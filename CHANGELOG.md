# Changelog

All notable changes follow [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-05

### Added

- Event CRUD endpoints (`POST /events`, `GET /events`, `GET /events/:id`, `PUT /events/:id`)
- State transitions: `publish`, `cancel`, `postpone`
- Seating sections sub-resource (`GET|POST /events/:id/sections`)
- Pricing tiers sub-resource (`GET|POST /events/:id/pricing-tiers`)
- JWT RS256 local validation via JWKS (zero per-request Auth Service calls)
- RBAC: Organiser, Customer, and Admin role enforcement
- Tenant isolation: Organisers cannot access other Organisers' events
- Kafka producer for `event.events` topic (`EventCreated`, `EventPublished`, `EventCancelled`, `EventPostponed`)
- MongoDB via Mongoose — Event aggregate root with embedded Sections and PricingTiers
- Cursor-based pagination on event list
- `/health/live` and `/health/ready` with MongoDB + Kafka checks
- RFC 9457 Problem Details on all error responses
- Structured JSON logging per request with traceId, userId, duration
- Idempotency-Key header support (in-memory, Phase 4 Redis upgrade planned)
- Multi-stage Dockerfile (node:20-alpine, non-root user)
- CI pipeline: secrets-scan → lint → unit-test → integration-test → sast → sca → build-and-scan → ci
- Unit tests (Jest) with ≥ 80% branch coverage target
- Integration tests (Testcontainers MongoDB)
