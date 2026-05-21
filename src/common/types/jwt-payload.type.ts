/**
 * jwt-payload.type.ts
 *
 * WHY: Typing the JWT claims explicitly prevents us from accidentally
 * reading a claim that doesn't exist or trusting a field whose name we
 * misremembered. The shape here must match what the Auth Service issues
 * (verified against auth.yaml and the Auth Service implementation).
 *
 * Role values match the four-actor model: CUSTOMER, ORGANISER, VENUE, ADMIN.
 * (PRD §4.1, NFR-SEC-003)
 */

export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  ORGANISER = 'ORGANISER',
  VENUE = 'VENUE',
  ADMIN = 'ADMIN',
}

export interface JwtPayload {
  /** Subject — the userId (UUID) */
  sub: string;
  /** User email address */
  email: string;
  /** Role assigned at registration — single role per user */
  role: UserRole;
  /** JWT ID — used for revocation lookup in the Auth Service Redis blocklist */
  jti: string;
  /** Issued-at (Unix timestamp seconds) */
  iat: number;
  /** Expiry (Unix timestamp seconds) — access token TTL ≤ 15 min (NFR-SEC-002) */
  exp: number;
}
