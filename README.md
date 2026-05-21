# stagepass-event-service

**Service tier:** T2 (99.5% SLO — 3.6 hr/month downtime budget)
**Framework:** NestJS 10 + TypeScript (strict)
**Database:** MongoDB (`event_db`)
**Messaging:** Kafka producer (`event.events` topic)
**Port:** 8082

---

## What This Service Does

Manages the full event lifecycle for StagePass:

- Creates events in `DRAFT` status (Organiser-only)
- Manages seating sections and pricing tiers as embedded sub-documents
- Enforces state transitions: `DRAFT → PUBLISHED → CANCELLED / POSTPONED`
- Publishes domain events to Kafka on every state change (`event.created`, `event.published`, `event.cancelled`, `event.postponed`)
- Enforces tenant isolation: Organisers cannot read or write other Organisers' events
- Validates publish pre-conditions (future date, at least one section, at least one pricing tier)

The Search Service consumes `event.published` to index events in Elasticsearch within 30s (NFR-PERF-010).

---

## How to Run Locally (< 30 minutes from clone)

**Prerequisites:** Docker, Node.js 20, npm

```bash
# 1. Clone and install
git clone https://github.com/stagepass-aiman/stagepass-event-service
cd stagepass-event-service
npm install

# 2. Start dependencies (MongoDB + Kafka) via Docker Compose
docker compose up event-mongodb event-kafka -d

# 3. Set environment variables
export MONGODB_URI=mongodb://eventuser:eventpass@localhost:27017
export MONGODB_DB_NAME=event_db
export KAFKA_BROKERS=localhost:9092
export JWKS_URI=http://localhost:8081/auth/jwks   # Auth Service must be running

# 4. Start the service in dev mode (hot reload)
npm run start:dev

# 5. Verify
curl http://localhost:8082/health/live
curl http://localhost:8082/health/ready
```

**Run full stack (service + dependencies):**
```bash
docker compose up --build
```

---

## Dependencies

| Depends on | How | Direction |
|-----------|-----|-----------|
| Auth Service | JWKS fetch at startup (JWT validation) | Outbound |
| Kafka | Producer — publishes `event.events` | Outbound |
| MongoDB | Primary data store | Outbound |
| Venue Service (Phase 4) | VenueBooking validation at event creation | Outbound (TODO) |

**Called by:**
- API Gateway (routes authenticated requests to this service)
- Booking Service (reads event details via REST)
- Search Service (consumes `event.events` Kafka topic)

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8082` | HTTP port |
| `MONGODB_URI` | **Yes** | — | MongoDB connection string |
| `MONGODB_DB_NAME` | No | `event_db` | Database name |
| `KAFKA_BROKERS` | **Yes** | — | Comma-separated broker addresses |
| `KAFKA_CLIENT_ID` | No | `event-service` | KafkaJS client ID |
| `JWKS_URI` | **Yes** | — | Auth Service JWKS endpoint |
| `NODE_ENV` | No | `development` | `development` or `production` |

Values come from Vault in staging/production. Never commit values. (NFR-SEC-008)

---

## Health Check Endpoints

```
GET /health/live   → 200 { "status": "UP" }          (Kubernetes liveness)
GET /health/ready  → 200 { "status": "UP", "checks": { "mongodb": "UP", "kafka": "UP" } }
                   → 503 if any check is DOWN           (Kubernetes readiness)
```

---

## Running Tests

```bash
# Unit tests (Jest, mocked dependencies)
npm test

# Unit tests with coverage (must be ≥ 80% branches)
npm run test:cov

# Integration tests (Testcontainers — requires Docker)
npm run test:integration
```

---

## Links

- [OpenAPI spec](https://github.com/stagepass-aiman/stagepass-docs/blob/main/docs/api/event.yaml)
- [AsyncAPI schema](https://github.com/stagepass-aiman/stagepass-docs/blob/main/docs/async-api/event.yaml)
- [ADR-002: Tech stack per service](https://github.com/stagepass-aiman/stagepass-docs/blob/main/docs/adr/ADR-002-tech-stack-per-service.md)
- [ADR-003: Service communication patterns](https://github.com/stagepass-aiman/stagepass-docs/blob/main/docs/adr/ADR-003-service-communication-patterns.md)
