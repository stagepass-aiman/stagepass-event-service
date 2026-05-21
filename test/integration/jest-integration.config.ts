import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '../..',
  // Only run files ending in .it.spec.ts
  testRegex: '\\.it\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  // Integration tests need more time — Testcontainers startup can take 30–60s
  testTimeout: 120000,
  // Run sequentially — container port conflicts when run in parallel
  maxWorkers: 1,
};

export default config;
