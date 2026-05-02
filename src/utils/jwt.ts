import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';
import { redis } from '../config/redis';

export interface AccessTokenPayload {
  sub: string;         // userId
  email: string;
  role: string;
  workspaceId?: string;
  jti: string;         // JWT ID for blacklisting
  type: 'access';
  exp?: number;        // JWT expiry (set by jsonwebtoken)
  iat?: number;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

/**
 * Sign a short-lived access token (15 minutes).
 */
export function signAccessToken(payload: Omit<AccessTokenPayload, 'jti' | 'type'>): string {
  const jti = uuidv4();
  return jwt.sign(
    { ...payload, jti, type: 'access' },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );
}

/**
 * Sign a long-lived refresh token (7 days), stored hash in Redis.
 */
export function signRefreshToken(userId: string): { token: string; jti: string } {
  const jti = uuidv4();
  const token = jwt.sign(
    { sub: userId, jti, type: 'refresh' },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );
  return { token, jti };
}

/**
 * Verify and decode an access token. Returns null if invalid/expired.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
    if (payload.type !== 'access') return null;

    // Check blacklist
    const blacklisted = await redis.exists(`token:blacklist:${payload.jti}`);
    if (blacklisted) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Verify and decode a refresh token.
 */
export function verifyRefreshToken(token: string): RefreshTokenPayload | null {
  try {
    const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
    if (payload.type !== 'refresh') return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Blacklist an access token by its JTI until it would have expired.
 */
export async function blacklistAccessToken(jti: string, expiresAt: number): Promise<void> {
  const ttl = Math.max(0, Math.floor(expiresAt - Date.now() / 1000));
  if (ttl > 0) {
    await redis.set(`token:blacklist:${jti}`, '1', ttl);
  }
}

/**
 * Store refresh token reference in Redis.
 */
export async function storeRefreshToken(userId: string, jti: string): Promise<void> {
  const ttl = 7 * 24 * 60 * 60; // 7 days
  await redis.set(`rt:${userId}:${jti}`, '1', ttl);
}

/**
 * Invalidate a specific refresh token.
 */
export async function invalidateRefreshToken(userId: string, jti: string): Promise<void> {
  await redis.del(`rt:${userId}:${jti}`);
}

/**
 * Validate that a refresh token JTI exists in Redis (not yet rotated or revoked).
 */
export async function validateRefreshTokenInStore(userId: string, jti: string): Promise<boolean> {
  const exists = await redis.exists(`rt:${userId}:${jti}`);
  return exists === 1;
}
