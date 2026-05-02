import { Request, Response, NextFunction } from 'express';
import { AxiosRequestConfig } from 'axios';
import { getCircuitBreaker } from '../circuitBreaker';
import { buildCacheWriter } from './cacheCheck';
import { getRedis } from '../../../config/redis';
import { usageQueue, abuseQueue } from '../../../queues/queues';
import { hashString } from '../../../utils/crypto';
import { Workspace } from '../../workspaces/workspace.model';
import mongoose from 'mongoose';

export async function proxyForward(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const api = req.gatewayApi!;
  const key = req.gatewayKey!;
  const startTime = req.gatewayRequestStart!;

  const upstreamPath = req.path || '/';
  const upstreamUrl = `${api.baseUrl}${upstreamPath}`;

  const forwardHeaders: Record<string, string> = {};
  const skipHeaders = new Set(['host', 'x-api-key', 'authorization', 'x-request-id']);
  for (const [k, v] of Object.entries(req.headers)) {
    if (!skipHeaders.has(k.toLowerCase()) && typeof v === 'string') {
      forwardHeaders[k] = v;
    }
  }

  if (req.gatewayUpstreamHeaders) {
    for (const h of req.gatewayUpstreamHeaders) {
      forwardHeaders[h.key] = h.value;
    }
  }

  const requestConfig: AxiosRequestConfig = {
    method: req.method as AxiosRequestConfig['method'],
    url: upstreamUrl,
    headers: forwardHeaders,
    params: req.query,
    data: req.body && Object.keys(req.body as object).length ? req.body : undefined,
    timeout: 15000,
    validateStatus: () => true,
  };

  const breaker = getCircuitBreaker(String(api._id));
  const latencyMs = () => Date.now() - startTime;

  try {
    if (breaker.opened) {
      res.status(503).json({ success: false, error: { message: 'Upstream service temporarily unavailable' } });
      await queueUsage(req, key, api, 503, latencyMs(), false, 0);
      return;
    }

    const upstream = await breaker.fire(requestConfig) as {
      status: number;
      data: unknown;
      headers: Record<string, string | string[] | undefined>;
    };
    const statusCode: number = upstream.status;
    const responseBody: unknown = upstream.data;
    const responseHeaders: Record<string, string> = {};

    const safeHeaders = ['content-type', 'cache-control', 'etag', 'last-modified'];
    for (const h of safeHeaders) {
      const val = upstream.headers[h];
      if (val && typeof val === 'string') {
        responseHeaders[h] = val;
        res.setHeader(h, val);
      }
    }

    res.setHeader('X-Request-Id', req.gatewayRequestId!);
    res.setHeader('X-Latency-Ms', String(latencyMs()));

    let creditsDeducted = 0;
    if (statusCode < 400) {
      creditsDeducted = api.pricingPerRequest;
      await deductCredits(String(key.workspaceId), creditsDeducted);
    }

    if (!req.gatewayCacheHit && statusCode < 400) {
      buildCacheWriter(req, statusCode, responseHeaders, responseBody);
    }

    await queueUsage(req, key, api, statusCode, latencyMs(), req.gatewayCacheHit || false, creditsDeducted);

    res.status(statusCode).json(responseBody);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[Gateway] Proxy error for ${api.aliasRoute}:`, message);
    await queueUsage(req, key, api, 502, latencyMs(), false, 0, message);
    res.status(502).json({ success: false, error: { message: 'Bad gateway — upstream request failed' } });
  }
}

async function deductCredits(workspaceId: string, credits: number): Promise<void> {
  if (credits <= 0) return;
  const redis = getRedis();
  await redis.decrby(`credits:${workspaceId}`, credits);
}

async function queueUsage(
  req: Request,
  key: { _id: unknown; workspaceId: unknown },
  api: { _id: unknown; aliasRoute: string },
  statusCode: number,
  latencyMs: number,
  cacheHit: boolean,
  creditsDeducted: number,
  error?: string
): Promise<void> {
  const ipRaw = req.ip || req.socket?.remoteAddress || '';
  const ip = Array.isArray(ipRaw) ? (ipRaw as string[])[0] : ipRaw as string;
  const ipHash = hashString(ip);

  const usageData = {
    workspaceId: String(key.workspaceId),
    apiId: String(api._id),
    apiKeyId: String(key._id),
    aliasRoute: api.aliasRoute,
    method: req.method,
    upstreamPath: req.path,
    statusCode,
    latencyMs,
    creditsDeducted,
    cacheHit,
    ipHash,
    rawIp: ip,   // passed to worker for geo lookup, never stored in DB
    requestId: req.gatewayRequestId!,
    userAgent: req.headers['user-agent'],
    error,
    timestamp: new Date(),
  };

  await Promise.allSettled([
    usageQueue.add('logRequest', usageData, { priority: 10 }),
    abuseQueue.add('scoreRequest', usageData, { priority: 5 }),
  ]);
}
