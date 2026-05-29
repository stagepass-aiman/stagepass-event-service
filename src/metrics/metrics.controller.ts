import { Controller, Get, Header } from '@nestjs/common';
import { register } from 'prom-client';

@Controller()
export class MetricsController {
  // NFR-OBS-002. @Header is adapter-agnostic — works on Fastify without
  // touching the raw `reply`. register.contentType is the Prometheus 0.0.4
  // text content-type. Explicit Promise<string> return type satisfies
  // explicit-function-return-type under --max-warnings 0 (Event issue #16).
  @Get('metrics')
  @Header('Content-Type', register.contentType)
  async getMetrics(): Promise<string> {
    return register.metrics();
  }
}
