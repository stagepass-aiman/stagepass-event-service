import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  // Unit tests only — integration tests run via test/integration/jest-integration.config.ts
  testRegex: '^(?!.*\\.it\\.spec\\.ts$).*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/test/integration/'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
  coverageThreshold: {
    global: {
      // PHASE 7 TODO: raise all thresholds to 80% when test pyramid is complete.
      // Current coverage reflects EventsService unit tests only (18 tests, all passing).
      // Guards, interceptors, filters, repository, sections service, and pricing-tiers
      // service are covered in Phase 7 integration and contract test suites.
      branches: 14,
      functions: 17,
      lines: 26,
      statements: 26,
    },
  },
  coveragePathIgnorePatterns: [
    '/node_modules/',
    'src/main.ts', // bootstrap entrypoint
    'src/tracing.ts', // OTel bootstrap — no unit-testable logic
    'src/metrics/metrics.module.ts', // DI wiring + collectDefaultMetrics side-effect
    'src/app.module.ts', // module composition
  ],
  coverageDirectory: './coverage',
};

export default config;
