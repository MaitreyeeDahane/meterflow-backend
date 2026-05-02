import CircuitBreaker from 'opossum';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { getRedis } from '../../config/redis';

const BREAKER_OPTIONS: CircuitBreaker.Options = {
  timeout: 10000,           // 10s timeout per request
  errorThresholdPercentage: 50,  // open after 50% failures
  resetTimeout: 30000,      // try half-open after 30s
  volumeThreshold: 5,       // minimum calls before tripping
  rollingCountTimeout: 10000,
};

// One circuit breaker per upstream API ID
const breakers = new Map<string, CircuitBreaker>();

async function httpCall(config: AxiosRequestConfig): Promise<AxiosResponse> {
  return axios(config);
}

export function getCircuitBreaker(apiId: string): CircuitBreaker {
  if (!breakers.has(apiId)) {
    const breaker = new CircuitBreaker(httpCall, BREAKER_OPTIONS);
    const redis = getRedis();

    breaker.on('open', () => {
      console.warn(`[CircuitBreaker] API ${apiId} circuit OPEN`);
      redis.setex(`cb:${apiId}`, 35, 'open').catch(() => {});
    });

    breaker.on('halfOpen', () => {
      console.info(`[CircuitBreaker] API ${apiId} circuit HALF-OPEN`);
      redis.setex(`cb:${apiId}`, 35, 'half').catch(() => {});
    });

    breaker.on('close', () => {
      console.info(`[CircuitBreaker] API ${apiId} circuit CLOSED`);
      redis.del(`cb:${apiId}`).catch(() => {});
    });

    breakers.set(apiId, breaker);
  }

  return breakers.get(apiId)!;
}

export async function getCircuitBreakerStatus(
  apiId: string
): Promise<'open' | 'half' | 'closed'> {
  const redis = getRedis();
  const status = await redis.get(`cb:${apiId}`);
  return (status as 'open' | 'half') || 'closed';
}
