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
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  coverageDirectory: './coverage',
};

export default config;
