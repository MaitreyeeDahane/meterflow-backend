import { Worker, Job } from 'bullmq';
import { getRedis } from '../config/redis';
import { UsageLog } from '../modules/analytics/usageLog.model';
import { ApiKey } from '../modules/keys/key.model';
import { RegisteredApi } from '../modules/apis/api.model';
import { Workspace } from '../modules/workspaces/workspace.model';
import { geoLookup } from '../utils/geo';

export interface UsageJobData {
  workspaceId: string;
  apiId: string;
  apiKeyId: string;
  aliasRoute: string;
  method: string;
  upstreamPath: string;
  statusCode: number;
  latencyMs: number;
  creditsDeducted: number;
  cacheHit: boolean;
  ipHash: string;
  rawIp?: string;      // used for geo lookup only, never stored
  requestId: string;
  userAgent?: string;
  geoCountry?: string;
  geoCity?: string;
  error?: string;
  timestamp: Date;
}

export function startUsageWorker(): Worker {
  const worker = new Worker<UsageJobData>(
    'usage-log',
    async (job: Job<UsageJobData>) => {
      const data = job.data;

      // Geo-IP lookup (non-blocking, cached)
      const geo = data.rawIp ? await geoLookup(data.rawIp) : {};
      const geoCountry = data.geoCountry ?? geo.country;
      const geoCity    = data.geoCity    ?? geo.city;

      // 1. Persist usage log
      await UsageLog.create({
        workspaceId: data.workspaceId,
        apiId: data.apiId,
        apiKeyId: data.apiKeyId,
        aliasRoute: data.aliasRoute,
        method: data.method,
        upstreamPath: data.upstreamPath,
        statusCode: data.statusCode,
        latencyMs: data.latencyMs,
        creditsDeducted: data.creditsDeducted,
        cacheHit: data.cacheHit,
        ipHash: data.ipHash,
        requestId: data.requestId,
        userAgent: data.userAgent,
        error: data.error,
        geoCountry,
        geoCity,
        timestamp: new Date(data.timestamp),
      });

      // 2. Increment real-time Redis counters for dashboard
      const redis = getRedis();
      const now = new Date();
      const minuteBucket = `stats:${data.workspaceId}:${data.apiId}:${Math.floor(now.getTime() / 60000)}`;
      await redis.incr(minuteBucket);
      await redis.expire(minuteBucket, 3600); // keep 1h of minute buckets

      // 3. Reconcile quota counter to MongoDB (every N requests)
      // We batch-write quotaUsed to avoid hot writes every request
      if (data.statusCode < 400) {
        await ApiKey.updateOne(
          { _id: data.apiKeyId },
          {
            $inc: { quotaUsed: 1, totalRequests: 1, totalCreditsConsumed: data.creditsDeducted },
            $set: { lastUsedAt: new Date(data.timestamp) },
          }
        );

        // Update API counters
        await RegisteredApi.updateOne(
          { _id: data.apiId },
          { $inc: { totalRequests: 1, totalCreditsConsumed: data.creditsDeducted } }
        );

        // Reconcile workspace credits (Redis decrby → sync to Mongo)
        if (data.creditsDeducted > 0) {
          await Workspace.updateOne(
            { _id: data.workspaceId },
            { $inc: { credits: -data.creditsDeducted } }
          );
        }
      }

      // 4. Emit real-time event via Redis pub/sub for Socket.io
      await redis.publish(
        `ws:usage:${data.workspaceId}`,
        JSON.stringify({
          type: 'usage',
          apiId: data.apiId,
          statusCode: data.statusCode,
          latencyMs: data.latencyMs,
          creditsDeducted: data.creditsDeducted,
          timestamp: data.timestamp,
        })
      );
    },
    {
      connection: getRedis(),
      concurrency: 20,      // process up to 20 jobs in parallel
      limiter: {
        max: 500,
        duration: 1000,     // max 500 jobs/sec
      },
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`[UsageWorker] Job ${job?.id} failed:`, err.message);
  });

  console.log('✅ Usage logger worker started');
  return worker;
}
