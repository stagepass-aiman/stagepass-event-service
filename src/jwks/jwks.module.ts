import { Global, Module } from '@nestjs/common';
import { JwksService } from './jwks.service';

/**
 * WHY @Global(): The JwksService is used by JwtAuthGuard which is applied to
 * every request in every module. Making the module global avoids importing it
 * in every feature module's imports array — the service is available everywhere.
 *
 * This is one of the few legitimate uses of @Global(). The rule: only make a
 * module global if its providers are genuinely needed by every other module.
 */
@Global()
@Module({
  providers: [JwksService],
  exports: [JwksService],
})
export class JwksModule {}
