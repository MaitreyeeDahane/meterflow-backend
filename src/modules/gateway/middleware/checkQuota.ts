import { Request, Response, NextFunction } from 'express';
import { getRedis } from '../../../config/redis';

export async function checkQuota(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.gatewayKey!;

  // -1 = unlimited
  if (key.quota === -1) {
    next();
    return;
  }

  const now = new Date();
  const monthKey = `quota:${key._id}:month:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const redis = getRedis();

  // Atomically increment and check
  const used = await redis.incr(monthKey);

  // Set expiry on first increment (end of month)
  if (used === 1) {
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const ttlSeconds = Math.floor((monthEnd.getTime() - Date.now()) / 1000);
    await redis.expire(monthKey, ttlSeconds);
  }

  if (used > key.quota) {
    res.setHeader('X-Quota-Limit', String(key.quota));
    res.setHeader('X-Quota-Used', String(used - 1));
    res.setHeader('X-Quota-Reset', getMonthResetHeader());
    res.status(429).json({
      success: false,
      error: {
        message: 'Monthly quota exceeded',
        quota: key.quota,
        used: used - 1,
        resetAt: getMonthResetHeader(),
      },
    });
    return;
  }

  res.setHeader('X-Quota-Limit', String(key.quota));
  res.setHeader('X-Quota-Used', String(used));
  next();
}

function getMonthResetHeader(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}
