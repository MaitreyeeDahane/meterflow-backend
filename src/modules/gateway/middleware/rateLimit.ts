import { Request, Response, NextFunction } from 'express';
import { getRedis } from '../../../config/redis';

export async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.gatewayKey!;
  const api = req.gatewayApi!;

  // Effective rate limit: key override > API default
  const limit = key.rateLimit > 0 ? key.rateLimit : api.rateLimitPerMin;
  if (limit <= 0) {
    next();
    return;
  }

  const redis = getRedis();
  const windowStart = Math.floor(Date.now() / 60000); // current minute bucket
  const rlKey = `rl:${key._id}:${windowStart}`;

  const count = await redis.incr(rlKey);
  if (count === 1) {
    await redis.expire(rlKey, 60); // expire after 1 minute
  }

  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
  res.setHeader('X-RateLimit-Reset', String((windowStart + 1) * 60));

  if (count > limit) {
    res.status(429).json({
      success: false,
      error: {
        message: 'Rate limit exceeded',
        limit,
        retryAfter: 60 - (Math.floor(Date.now() / 1000) % 60),
      },
    });
    return;
  }

  next();
}
