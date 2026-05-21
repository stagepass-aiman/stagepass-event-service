import { Global, Module } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';

/**
 * WHY @Global(): KafkaProducerService is needed by EventsService for every
 * state transition. Making it global avoids boilerplate imports in EventsModule.
 * Same reasoning as JwksModule.
 */
@Global()
@Module({
  providers: [KafkaProducerService],
  exports: [KafkaProducerService],
})
export class KafkaModule {}
