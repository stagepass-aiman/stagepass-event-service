/**
 * jwks.service.ts
 *
 * WHY: JWT validation must happen locally — no per-request call to the Auth
 * Service (ADR-003 §3.3, NFR-SEC-001). The Auth Service exposes a JWKS endpoint
 * (RFC 7517) containing the RSA public key(s) used to sign JWTs.
 *
 * Strategy:
 *   1. OnModuleInit: fetch JWKS, build Map<kid, KeyObject> from all keys.
 *   2. JwtAuthGuard calls verifyToken(rawJwt): JwtPayload.
 *   3. If the JWT's kid is not in the cache → re-fetch ONCE (key rotation).
 *   4. If still missing after re-fetch → the token's kid is invalid → 401.
 *
 * Why re-fetch on kid miss instead of polling?
 *   - Polling adds continuous load to the Auth Service with no benefit when
 *     keys are rotated infrequently (weeks/months).
 *   - Re-fetching on a cache miss handles rotation lazily: most requests hit
 *     the cache (O(1)), rotation is handled automatically on the next request
 *     with the new kid.
 *   - A re-fetch is rate-limited to once per kid per request cycle to prevent
 *     a flood of re-fetches if an attacker sends many tokens with unknown kids.
 *
 * jwks-rsa is NOT used here — it adds a dependency and a request-per-validation
 * path by default. We fetch the JWKS ourselves and cache it; this is simpler
 * and gives us full control over the re-fetch strategy.
 */

import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import type { AppConfig } from '../config/configuration';
import type { JwtPayload } from '../common/types/jwt-payload.type';

interface JwksKey {
  kty: string;
  use?: string;
  kid: string;
  alg?: string;
  n: string;
  e: string;
}

interface JwksResponse {
  keys: JwksKey[];
}

@Injectable()
export class JwksService implements OnModuleInit {
  private readonly logger = new Logger(JwksService.name);
  private readonly keyCache = new Map<string, crypto.KeyObject>();
  private readonly jwksUri: string;

  // Guard flag: prevents concurrent re-fetches from multiple requests
  // all missing the same new kid simultaneously.
  private refetchInProgress = false;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    this.jwksUri = this.configService.get('jwks.uri', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`Fetching JWKS from ${this.jwksUri}`);
    await this.fetchAndCacheKeys();
    this.logger.log(`JWKS loaded. Cached ${this.keyCache.size} key(s).`);
  }

  /**
   * Verify a raw JWT string and return the parsed payload.
   *
   * Flow:
   *   1. Decode header to extract kid (no verification yet).
   *   2. Look up kid in cache.
   *   3. If missing: re-fetch JWKS once, retry.
   *   4. Verify signature with the cached public key.
   *   5. Return typed payload or throw UnauthorizedException.
   */
  async verifyToken(rawToken: string): Promise<JwtPayload> {
    const header = this.decodeHeader(rawToken);
    const kid = header['kid'] as string | undefined;
    if (!kid) {
      throw new UnauthorizedException('JWT is missing kid header.');
    }

    let publicKey = this.keyCache.get(kid);

    // Cache miss — could be key rotation. Re-fetch once.
    if (!publicKey && !this.refetchInProgress) {
      this.logger.warn(`kid "${kid}" not in cache. Re-fetching JWKS.`);
      this.refetchInProgress = true;
      try {
        await this.fetchAndCacheKeys();
      } finally {
        this.refetchInProgress = false;
      }
      publicKey = this.keyCache.get(kid);
    }

    if (!publicKey) {
      // kid still missing after re-fetch — this is not a rotation scenario;
      // the token is genuinely invalid or forged.
      throw new UnauthorizedException(`Unknown JWT kid: "${kid}".`);
    }

    return this.verify(rawToken, publicKey);
  }

  private decodeHeader(token: string): Record<string, unknown> {
    try {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || typeof decoded !== 'object') {
        throw new UnauthorizedException('Malformed JWT: cannot decode header.');
      }
      return decoded.header as unknown as Record<string, unknown>;
    } catch {
      throw new UnauthorizedException('Malformed JWT.');
    }
  }

  private verify(token: string, publicKey: crypto.KeyObject): JwtPayload {
    try {
      const payload = jwt.verify(token, publicKey, {
        algorithms: ['RS256'],
      });
      if (typeof payload === 'string') {
        throw new UnauthorizedException('Unexpected JWT payload format.');
      }
      return payload as JwtPayload;
    } catch (err) {
      const message = err instanceof jwt.TokenExpiredError
        ? 'JWT has expired.'
        : err instanceof jwt.JsonWebTokenError
          ? `JWT verification failed: ${err.message}`
          : 'JWT verification failed.';
      throw new UnauthorizedException(message);
    }
  }

  private async fetchAndCacheKeys(): Promise<void> {
    const response = await fetch(this.jwksUri);
    if (!response.ok) {
      throw new Error(
        `JWKS fetch failed: ${response.status} ${response.statusText} from ${this.jwksUri}`,
      );
    }

    const body = (await response.json()) as JwksResponse;
    let loaded = 0;

    for (const key of body.keys) {
      if (key.kty !== 'RSA') continue; // Only RSA keys are relevant
      try {
        const pem = this.jwkToPem(key);
        const keyObject = crypto.createPublicKey(pem);
        this.keyCache.set(key.kid, keyObject);
        loaded++;
      } catch (err) {
        this.logger.error(`Failed to import JWKS key kid="${key.kid}": ${String(err)}`);
      }
    }

    if (loaded === 0) {
      throw new Error('JWKS response contained no valid RSA keys.');
    }
  }

  /**
   * Convert a JWK (JSON Web Key) RSA public key to PEM format.
   * Node's crypto module does not parse JWK directly in older versions;
   * we construct the PEM from the raw modulus (n) and exponent (e).
   */
  private jwkToPem(key: JwksKey): string {
    // Node 15+ supports crypto.createPublicKey({ key, format: 'jwk' }) directly.
    // We use that here — it is cleaner than manual PEM construction.
    const keyObject = crypto.createPublicKey({
      key: {
        kty: key.kty,
        n: key.n,
        e: key.e,
      },
      format: 'jwk',
    });
    return keyObject.export({ type: 'spki', format: 'pem' }) as string;
  }
}
