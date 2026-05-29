import { Module, OnModuleInit } from '@nestjs/common';
import { collectDefaultMetrics, register } from 'prom-client';
import { MetricsController } from './metrics.controller';

@Module({ controllers: [MetricsController] })
export class MetricsModule implements OnModuleInit {
  onModuleInit(): void {
    // Guard double-registration — prom-client throws if default metrics are
    // collected twice (repeated module init in tests).
    if (!register.getSingleMetric('process_cpu_user_seconds_total')) {
      collectDefaultMetrics();
    }
  }
}
