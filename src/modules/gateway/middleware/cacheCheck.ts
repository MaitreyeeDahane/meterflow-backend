import { Request, Response, NextFunction } from 'express';
import { getRedis } from '../../../config/redis';
import { buildCacheKey } from '../../../utils/crypto';

export async function cacheCheck(req: Request, res: Response, next: NextFunction): Promise<void> {
  const api = req.gatewayApi!;

  // Only cache GET requests and only if TTL > 0
  if (req.method !== 'GET' || api.cacheTTL <= 0) {
    req.gatewayCacheHit = false;
    next();
    return;
  }

  const redis = getRedis();
  const cacheKey = buildCacheKey(
    api._id.toString(),
    req.method,
    req.path,
    JSON.stringify(req.query)
  );

  const cached = await redis.get(cacheKey);
  if (cached) {
    req.gatewayCacheHit = true;
    const { statusCode, headers, body } = JSON.parse(cached) as {
      statusCode: number;
      headers: Record<string, string>;
      body: unknown;
    };

    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-TTL', String(api.cacheTTL));
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    res.status(statusCode).json(body);
    return;
  }

  req.gatewayCacheHit = false;
  res.setHeader('X-Cache', 'MISS');
  next();
}

/**
 * Called AFTER proxyForward to cache successful responses.
 * Attached to res.on('finish') so it doesn't block the response.
 */
export function buildCacheWriter(
  req: Request,
  statusCode: number,
  headers: Record<string, string>,
  body: unknown
): void {
  const api = req.gatewayApi!;
  if (req.method !== 'GET' || api.cacheTTL <= 0 || statusCode >= 400) return;

  const redis = getRedis();
  const cacheKey = buildCacheKey(
    api._id.toString(),
    req.method,
    req.path,
    JSON.stringify(req.query)
  );

  // Fire-and-forget cache write
  redis
    .setex(
      cacheKey,
      api.cacheTTL,
      JSON.stringify({ statusCode, headers, body })
    )
    .catch((err) => console.error('Cache write error:', err));
}
