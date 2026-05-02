import crypto from 'crypto';
import CryptoJS from 'crypto-js';
import { env } from '../config/env';

/**
 * Generate a new API key.
 * Format: mf_{env}_{32-char hex}
 * Only the SHA-256 hash is stored in MongoDB.
 */
export function generateApiKey(environment: 'sandbox' | 'production'): {
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
} {
  const prefix = environment === 'sandbox' ? 'mf_test_' : 'mf_live_';
  const random = crypto.randomBytes(32).toString('hex');
  const rawKey = `${prefix}${random}`;
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.substring(0, 16); // "mf_live_xxxxxxxx"
  return { rawKey, keyHash, keyPrefix };
}

/**
 * Hash an API key using SHA-256.
 */
export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Hash a string (IP address, etc.) using SHA-256 for privacy.
 */
export function hashString(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').substring(0, 16);
}

/**
 * Generate a cryptographically secure random token (for email verify, reset password).
 */
export function generateSecureToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Encrypt a string using AES-256 (for upstream API credentials).
 */
export function encrypt(plaintext: string): string {
  return CryptoJS.AES.encrypt(plaintext, env.ENCRYPTION_KEY).toString();
}

/**
 * Decrypt an AES-256 encrypted string.
 */
export function decrypt(ciphertext: string): string {
  const bytes = CryptoJS.AES.decrypt(ciphertext, env.ENCRYPTION_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

/**
 * Generate an HMAC-SHA256 signature for webhook payloads.
 */
export function signWebhookPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Generate a random webhook secret.
 */
export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Hash a cache key for gateway response caching.
 */
export function buildCacheKey(apiId: string, method: string, path: string, query: string): string {
  const raw = `${method}:${path}:${query}`;
  const hash = crypto.createHash('md5').update(raw).digest('hex');
  return `cache:${apiId}:${hash}`;
}
