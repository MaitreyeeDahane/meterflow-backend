import Redis from 'ioredis';
import { env } from './env';

let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy: (times) => {
        if (times > 10) return null; // Stop retrying
        return Math.min(times * 200, 3000);
      },
    });

    redisClient.on('connect', () => console.log('✅ Redis connected'));
    redisClient.on('error', (err) => console.error('Redis error:', err.message));
    redisClient.on('reconnecting', () => console.warn('Redis reconnecting...'));
  }
  return redisClient;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const result = await getRedis().ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    console.log('Redis disconnected cleanly');
  }
}

// Convenience helpers
export const redis = {
  get: (key: string) => getRedis().get(key),
  set: (key: string, value: string, ttlSeconds?: number) =>
    ttlSeconds ? getRedis().setex(key, ttlSeconds, value) : getRedis().set(key, value),
  del: (...keys: string[]) => getRedis().del(...keys),
  incr: (key: string) => getRedis().incr(key),
  incrby: (key: string, n: number) => getRedis().incrby(key, n),
  decrby: (key: string, n: number) => getRedis().decrby(key, n),
  expire: (key: string, ttl: number) => getRedis().expire(key, ttl),
  exists: (key: string) => getRedis().exists(key),
  publish: (channel: string, message: string) => getRedis().publish(channel, message),
};
