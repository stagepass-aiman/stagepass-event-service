/**
 * configuration.ts
 *
 * WHY: 12-Factor App principle — configuration comes from the environment,
 * never baked into the container image. NestJS ConfigModule with a factory
 * function gives us typed access to env vars with validation at startup.
 * A missing required variable fails fast before the service accepts traffic —
 * better than a runtime crash on the first request that needs the variable.
 *
 * All values are strings from the environment; we parse/coerce here.
 */

export interface AppConfig {
  port: number;
  mongodb: {
    uri: string;
    dbName: string;
  };
  kafka: {
    brokers: string[];
    clientId: string;
    groupId: string;
  };
  jwks: {
    uri: string;
    // How long to cache the JWKS before forcing a re-fetch on kid miss.
    // A kid miss always triggers one re-fetch regardless of this TTL.
    cacheTtlMs: number;
  };
  service: {
    name: string;
    environment: string;
  };
}

export default (): AppConfig => {
  const port = parseInt(process.env['PORT'] ?? '8082', 10);
  const mongoUri = process.env['MONGODB_URI'];
  const kafkaBrokers = process.env['KAFKA_BROKERS'];
  const jwksUri = process.env['JWKS_URI'];

  // Validate required variables at startup — fail fast before binding to port.
  const missing: string[] = [];
  if (!mongoUri) missing.push('MONGODB_URI');
  if (!kafkaBrokers) missing.push('KAFKA_BROKERS');
  if (!jwksUri) missing.push('JWKS_URI');

  if (missing.length > 0) {
    throw new Error(
      `[event-service] Missing required environment variables: ${missing.join(', ')}. ` +
        `See README.md for the full variable list.`,
    );
  }

  return {
    port,
    mongodb: {
      // These are guaranteed non-null by the validation above.
      uri: mongoUri as string,
      dbName: process.env['MONGODB_DB_NAME'] ?? 'event_db',
    },
    kafka: {
      brokers: (kafkaBrokers as string).split(',').map((b) => b.trim()),
      clientId: process.env['KAFKA_CLIENT_ID'] ?? 'event-service',
      groupId: process.env['KAFKA_GROUP_ID'] ?? 'event-service-group',
    },
    jwks: {
      uri: jwksUri as string,
      cacheTtlMs: parseInt(process.env['JWKS_CACHE_TTL_MS'] ?? '3600000', 10),
    },
    service: {
      name: 'event-service',
      environment: process.env['NODE_ENV'] ?? 'development',
    },
  };
};
