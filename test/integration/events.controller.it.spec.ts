/**
 * events.controller.it.spec.ts
 *
 * Integration tests: real MongoDB via Testcontainers, Kafka producer mocked.
 *
 * WHY Testcontainers for the integration test:
 *   We want to verify that our Mongoose schema, queries, and business logic
 *   work together against a real MongoDB engine — not a mock. Schema errors,
 *   missing indexes, and query mistakes only surface against a real database.
 *
 * WHY Kafka is mocked:
 *   We're testing the HTTP → service → MongoDB round-trip. Kafka publishing
 *   is tested separately (it's a side effect, not the core behaviour).
 *   Adding a real Kafka container would slow startup by ~30s for no extra
 *   coverage in this test.
 *
 * Build log rule applied: never use @TestInstance(PER_CLASS) with framework tests.
 * (For NestJS, the equivalent is: do not share the testing module across describe blocks.)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import supertest from 'supertest';
import type { Connection } from 'mongoose';
import { EventsModule } from '../../src/events/events.module';
import { KafkaProducerService } from '../../src/kafka/kafka-producer.service';
import { JwksService } from '../../src/jwks/jwks.service';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { UserRole } from '../../src/common/types/jwt-payload.type';
import type { JwtPayload } from '../../src/common/types/jwt-payload.type';
import { EventEntity, EventEntitySchema } from '../../src/events/schemas/event.schema';

// ── Mock JWT payload — simulates a verified token ───────────────────────────

function makeToken(_payload: Partial<JwtPayload> = {}): string {
  // In integration tests we mock JwksService.verifyToken() rather than
  // generating real JWTs. The token value itself doesn't matter — the guard
  // calls verifyToken() which is stubbed to return our payload.
  return 'Bearer mock-token';
}

const DEFAULT_ORGANISER: JwtPayload = {
  sub: 'organiser-uuid-integration',
  email: 'org@test.com',
  role: UserRole.ORGANISER,
  jti: 'jti-1',
  iat: 0,
  exp: 9999999999,
};

// ── Test Suite ───────────────────────────────────────────────────────────────

describe('EventsController (integration)', () => {
  let container: StartedMongoDBContainer;
  let app: INestApplication;
  let mongoConnection: Connection;
  let mockJwksService: { verifyToken: jest.Mock };
  let mockKafkaProducer: { publish: jest.Mock; isConnected: jest.Mock };

  beforeAll(async () => {
    // Start MongoDB container — takes ~15–30s on first pull
    container = await new MongoDBContainer('mongo:7').start();

    mockJwksService = {
      verifyToken: jest.fn().mockResolvedValue(DEFAULT_ORGANISER),
    };

    mockKafkaProducer = {
      publish: jest.fn().mockResolvedValue(undefined),
      isConnected: jest.fn().mockReturnValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [() => ({})] }),
        MongooseModule.forRoot(container.getConnectionString(), {
          dbName: 'event_db_test',
          directConnection: true,
        }),
        MongooseModule.forFeature([{ name: EventEntity.name, schema: EventEntitySchema }]),
        EventsModule,
      ],
      providers: [
        // Provide the global dependencies that EventsModule needs
        // but that aren't imported via their modules in this test context
        {
          provide: KafkaProducerService,
          useValue: mockKafkaProducer,
        },
        {
          provide: JwksService,
          useValue: mockJwksService,
        },
      ],
    })
      .overrideProvider(KafkaProducerService)
      .useValue(mockKafkaProducer)
      .overrideProvider(JwksService)
      .useValue(mockJwksService)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    mongoConnection = module.get<Connection>(getConnectionToken());
    await app.getHttpAdapter().getInstance().ready();

    mongoConnection = module.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    if (mongoConnection?.db) {
      await mongoConnection.dropDatabase();
    }
    await app.close();
    await container.stop();
  });

  afterEach(async () => {
    if (mongoConnection?.db) {
      await mongoConnection.collection('events').deleteMany({});
    }
    mockJwksService.verifyToken.mockResolvedValue(DEFAULT_ORGANISER);
    mockKafkaProducer.publish.mockResolvedValue(undefined);
  });

  // ── POST /events ────────────────────────────────────────────────────────────

  describe('POST /events', () => {
    it('creates an event in DRAFT status', async () => {
      const response = await supertest(app.getHttpServer())
        .post('/events')
        .set('Authorization', makeToken())
        .send({
          venueBookingId: '550e8400-e29b-41d4-a716-446655440001',
          title: 'Jazz Night',
          eventDate: new Date(Date.now() + 86400000 * 30).toISOString(),
          cancellationPolicy: { brackets: [] },
        });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        title: 'Jazz Night',
        status: 'DRAFT',
        organiserId: DEFAULT_ORGANISER.sub,
      });
      expect(response.body.eventId).toBeDefined();

      // Verify Kafka was called
      expect(mockKafkaProducer.publish).toHaveBeenCalledWith(
        'event.events',
        expect.any(String) as string,
        expect.objectContaining({ status: 'DRAFT', schemaVersion: '1.0' }),
      );
    });

    it('returns 401 if Authorization header is missing', async () => {
      mockJwksService.verifyToken.mockRejectedValue({ getStatus: () => 401 });
      const response = await supertest(app.getHttpServer())
        .post('/events')
        .send({ title: 'No Auth' });
      // JwtAuthGuard throws before reaching the handler
      expect(response.status).toBe(401);
    });

    it('returns 400 on invalid request body (missing required fields)', async () => {
      const response = await supertest(app.getHttpServer())
        .post('/events')
        .set('Authorization', makeToken())
        .send({ title: 'Missing eventDate' }); // no venueBookingId, no eventDate

      expect(response.status).toBe(400);
    });
  });

  // ── GET /events/:eventId ────────────────────────────────────────────────────

  describe('GET /events/:eventId', () => {
    it('returns a DRAFT event to its owner Organiser', async () => {
      // Create an event first
      const createResponse = await supertest(app.getHttpServer())
        .post('/events')
        .set('Authorization', makeToken())
        .send({
          venueBookingId: '550e8400-e29b-41d4-a716-446655440002',
          title: 'Blues Festival',
          eventDate: new Date(Date.now() + 86400000 * 30).toISOString(),
          cancellationPolicy: { brackets: [] },
        });

      const eventId = createResponse.body.eventId as string;

      const getResponse = await supertest(app.getHttpServer())
        .get(`/events/${eventId}`)
        .set('Authorization', makeToken());

      expect(getResponse.status).toBe(200);
      expect(getResponse.body.eventId).toBe(eventId);
    });

    it('returns 404 for non-existent event', async () => {
      const response = await supertest(app.getHttpServer())
        .get('/events/550e8400-e29b-41d4-a716-000000000000')
        .set('Authorization', makeToken());

      expect(response.status).toBe(404);
    });

    it('returns 404 for Customer trying to access DRAFT event', async () => {
      // Create event as Organiser
      const createResponse = await supertest(app.getHttpServer())
        .post('/events')
        .set('Authorization', makeToken())
        .send({
          venueBookingId: '550e8400-e29b-41d4-a716-446655440003',
          title: 'Secret Gig',
          eventDate: new Date(Date.now() + 86400000 * 30).toISOString(),
          cancellationPolicy: { brackets: [] },
        });
      const eventId = createResponse.body.eventId as string;

      // Switch caller to CUSTOMER
      const customer: JwtPayload = {
        ...DEFAULT_ORGANISER,
        sub: 'customer-1',
        role: UserRole.CUSTOMER,
      };
      mockJwksService.verifyToken.mockResolvedValue(customer);

      const response = await supertest(app.getHttpServer())
        .get(`/events/${eventId}`)
        .set('Authorization', makeToken());

      expect(response.status).toBe(404);
    });
  });

  // ── Health endpoints (no auth required) ────────────────────────────────────

  describe('GET /health/live', () => {
    it('returns 200 UP', async () => {
      const response = await supertest(app.getHttpServer()).get('/health/live');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'UP', checks: {} });
    });
  });
});
