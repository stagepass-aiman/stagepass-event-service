import { MetricsController } from '../../src/metrics/metrics.controller';
import { register, collectDefaultMetrics } from 'prom-client';

describe('MetricsController', () => {
  beforeAll(() => {
    register.clear(); // start clean — other suites may have touched it
    collectDefaultMetrics(); // populate the registry (what MetricsModule does at init)
  });
  afterAll(() => register.clear()); // don't leak metrics into other suites

  it('serialises registered metrics in Prometheus text format', async () => {
    const controller = new MetricsController();
    const body = await controller.getMetrics();
    expect(typeof body).toBe('string');
    expect(body).toContain('# HELP'); // exposition format present
    expect(body).toContain('process_cpu'); // a default metric is there
  });
});
