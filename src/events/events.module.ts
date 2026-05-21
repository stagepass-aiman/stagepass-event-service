import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EventEntity, EventEntitySchema } from './schemas/event.schema';
import { EventsController } from './controllers/events.controller';
import { SectionsController } from './controllers/sections.controller';
import { PricingTiersController } from './controllers/pricing-tiers.controller';
import { EventsService } from './services/events.service';
import { SectionsService } from './services/sections.service';
import { PricingTiersService } from './services/pricing-tiers.service';
import { EventsRepository } from './repositories/events.repository';

@Module({
  imports: [MongooseModule.forFeature([{ name: EventEntity.name, schema: EventEntitySchema }])],
  controllers: [EventsController, SectionsController, PricingTiersController],
  providers: [EventsService, SectionsService, PricingTiersService, EventsRepository],
})
export class EventsModule {}
