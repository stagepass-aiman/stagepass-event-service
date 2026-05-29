// test/unit/metrics.controller.spec.ts
import { MetricsController } from '../../src/metrics/metrics.controller';

describe('MetricsController', () => {
  it('returns Prometheus-format metrics text', async () => {
    const controller = new MetricsController();
    const body = await controller.getMetrics();
    expect(typeof body).toBe('string');
    expect(body).toContain('# HELP'); // Prometheus exposition format
  });
});
