/**
 * events.controller.it.spec.ts
 *
 * Integration tests: real MongoDB via Testcontainers, Kafka and JWKS mocked.
 *
 * WHY we do not import EventsModule as a whole:
 *   @Global() modules (KafkaModule, JwksModule) only register their providers
 *   into the global scope when imported at the application root (AppModule).
 *   In a test that creates a TestingModule without AppModule, the global context
 *   does not exist — KafkaProducerService and JwksService tokens are unknown
 *   to EventsModule's DI resolver regardless of how they are provided at the
 *   test module root.
 *
 *   Solution: import EventsModule's internals explicitly (controllers, services,
 *   repository) rather than the module itself. Provide mocked global services
 *   directly. This gives the test full DI control without the module scoping problem.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import supertest from 'supertest';
import type { Connection } from 'mongoose';

import { EventsController } from '../../src/events/controllers/events.controller';
import { SectionsController } from '../../src/events/controllers/sections.controller';
import { PricingTiersController } from '../../src/events/controllers/pricing-tiers.controller';
import { EventsService } from '../../src/events/services/events.service';
import { SectionsService } from '../../src/events/services/sections.service';
import { PricingTiersService } from '../../src/events/services/pricing-tiers.service';
import { EventsRepository } from '../../src/events/repositories/events.repository';
import { HealthController } from '../../src/health/health.controller';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { KafkaProducerService } from '../../src/kafka/kafka-producer.service';
import { JwksService } from '../../src/jwks/jwks.service';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { UserRole } from '../../src/common/types/jwt-payload.type';
import type { JwtPayload } from '../../src/common/types/jwt-payload.type';
import { EventEntity, EventEntitySchema } from '../../src/events/schemas/event.schema';

const DEFAULT_ORGANISER: JwtPayload = {
  sub: 'organiser-uuid-integration',
  email: 'org@test.com',
  role: UserRole.ORGANISER,
  jti: 'jti-1',
  iat: 0,
  exp: 9999999999,
};

describe('EventsController (integration)', () => {
  let container: StartedMongoDBContainer;
  let app: INestApplication;
  let mongoConnection: Connection;

  const mockJwksService = {
    verifyToken: jest.fn().mockResolvedValue(DEFAULT_ORGANISER),
    onModuleInit: jest.fn(),
  };

  const mockKafkaProducer = {
    publish: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
  };

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:7').start();

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [() => ({})] }),
        MongooseModule.forRoot(container.getConnectionString(), {
          dbName: 'event_db_test',
          directConnection: true,
        }),
        MongooseModule.forFeature([{ name: EventEntity.name, schema: EventEntitySchema }]),
      ],
      // Declare controllers and providers explicitly instead of importing EventsModule.
      // This sidesteps the @Global() module scoping problem in test context.
      controllers: [EventsController, SectionsController, PricingTiersController, HealthController],
      providers: [
        // Domain providers
        EventsService,
        SectionsService,
        PricingTiersService,
        EventsRepository,
        // Guards (used by controllers via @UseGuards)
        JwtAuthGuard,
        RolesGuard,
        // Mocked global services
        { provide: KafkaProducerService, useValue: mockKafkaProducer },
        { provide: JwksService, useValue: mockJwksService },
      ],
    }).compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    mongoConnection = module.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    if (mongoConnection?.db) {
      await mongoConnection.dropDatabase();
    }
    if (app) {
      await app.close();
    }
    if (container) {
      await container.stop();
    }
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
        .set('Authorization', 'Bearer mock-token')
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
      expect(mockKafkaProducer.publish).toHaveBeenCalledWith(
        'event.events',
        expect.any(String) as string,
        expect.objectContaining({ status: 'DRAFT', schemaVersion: '1.0' }),
      );
    });

    it('returns 401 if Authorization header is missing', async () => {
      mockJwksService.verifyToken.mockRejectedValue(
        Object.assign(new Error('Unauthorized'), { status: 401 }),
      );
      const response = await supertest(app.getHttpServer())
        .post('/events')
        .send({ title: 'No Auth' });
      expect(response.status).toBe(401);
    });

    it('returns 400 on invalid request body', async () => {
      const response = await supertest(app.getHttpServer())
        .post('/events')
        .set('Authorization', 'Bearer mock-token')
        .send({ title: 'Missing eventDate' });
      expect(response.status).toBe(400);
    });
  });

  // ── GET /events/:eventId ─────────────────────────────────────────────────────

  describe('GET /events/:eventId', () => {
    it('returns a DRAFT event to its owner Organiser', async () => {
      const createResponse = await supertest(app.getHttpServer())
        .post('/events')
        .set('Authorization', 'Bearer mock-token')
        .send({
          venueBookingId: '550e8400-e29b-41d4-a716-446655440002',
          title: 'Blues Festival',
          eventDate: new Date(Date.now() + 86400000 * 30).toISOString(),
          cancellationPolicy: { brackets: [] },
        });

      const eventId = createResponse.body.eventId as string;
      const getResponse = await supertest(app.getHttpServer())
        .get(`/events/${eventId}`)
        .set('Authorization', 'Bearer mock-token');

      expect(getResponse.status).toBe(200);
      expect(getResponse.body.eventId).toBe(eventId);
    });

    it('returns 404 for non-existent event', async () => {
      const response = await supertest(app.getHttpServer())
        .get('/events/550e8400-e29b-41d4-a716-000000000000')
        .set('Authorization', 'Bearer mock-token');
      expect(response.status).toBe(404);
    });

    it('returns 404 for Customer trying to access DRAFT event', async () => {
      const createResponse = await supertest(app.getHttpServer())
        .post('/events')
        .set('Authorization', 'Bearer mock-token')
        .send({
          venueBookingId: '550e8400-e29b-41d4-a716-446655440003',
          title: 'Secret Gig',
          eventDate: new Date(Date.now() + 86400000 * 30).toISOString(),
          cancellationPolicy: { brackets: [] },
        });
      const eventId = createResponse.body.eventId as string;

      const customer: JwtPayload = {
        ...DEFAULT_ORGANISER,
        sub: 'customer-1',
        role: UserRole.CUSTOMER,
      };
      mockJwksService.verifyToken.mockResolvedValue(customer);

      const response = await supertest(app.getHttpServer())
        .get(`/events/${eventId}`)
        .set('Authorization', 'Bearer mock-token');
      expect(response.status).toBe(404);
    });
  });

  // ── GET /health/live ─────────────────────────────────────────────────────────

  describe('GET /health/live', () => {
    it('returns 200 UP', async () => {
      const response = await supertest(app.getHttpServer()).get('/health/live');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'UP' });
    });
  });
});
