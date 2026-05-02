import axios from 'axios';
import { getRedis } from '../config/redis';

interface GeoResult {
  country?: string;
  city?: string;
}

/**
 * Look up country + city for an IP address.
 * Uses ip-api.com (free tier: 45 req/min, no API key).
 * Results are cached in Redis for 24h to avoid rate limits.
 * Private/local IPs return empty result immediately.
 */
export async function geoLookup(ip: string): Promise<GeoResult> {
  // Skip private/loopback IPs
  if (isPrivateIp(ip)) return {};

  const cacheKey = `geo:${ip}`;

  try {
    const redis = getRedis();
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as GeoResult;
    }

    const { data } = await axios.get<{
      status: string;
      country: string;
      city: string;
    }>(`http://ip-api.com/json/${ip}?fields=status,country,city`, {
      timeout: 2000, // never block the gateway for more than 2s
    });

    const result: GeoResult = data.status === 'success'
      ? { country: data.country, city: data.city }
      : {};

    // Cache for 24 hours
    await redis.setex(cacheKey, 86400, JSON.stringify(result));
    return result;
  } catch {
    // Geo lookup failures are non-fatal — return empty
    return {};
  }
}

function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  const cleaned = ip.replace('::ffff:', '');
  return (
    cleaned === '::1' ||
    cleaned === 'localhost' ||
    cleaned.startsWith('127.') ||
    cleaned.startsWith('10.') ||
    cleaned.startsWith('192.168.') ||
    cleaned.startsWith('172.16.') ||
    cleaned.startsWith('172.17.') ||
    cleaned.startsWith('172.18.') ||
    cleaned.startsWith('fd') ||
    cleaned === '0.0.0.0'
  );
}
