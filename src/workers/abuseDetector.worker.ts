import { Worker, Job } from 'bullmq';
import { getRedis } from '../config/redis';
import { UsageLog } from '../modules/analytics/usageLog.model';
import { ApiKey } from '../modules/keys/key.model';

export interface AbuseJobData {
  workspaceId: string;
  apiId: string;
  apiKeyId: string;
  ipHash: string;
  statusCode: number;
  latencyMs: number;
  userAgent?: string;
  timestamp: Date;
}

const SCORE_THRESHOLDS = {
  SOFT_FLAG: 10,    // alert only
  SUSPEND_KEY: 25,  // auto-suspend key
  BLOCK_IP: 50,     // block IP at gateway
};

export function startAbuseWorker(): Worker {
  const worker = new Worker<AbuseJobData>(
    'abuse',
    async (job: Job<AbuseJobData>) => {
      const redis = getRedis();
      const { ipHash, apiKeyId, statusCode, workspaceId, timestamp } = job.data;

      let score = 0;

      // ── Rule 1: Brute force (many 401/403 from same IP in 10 min) ──
      if (statusCode === 401 || statusCode === 403) {
        const bruteKey = `abuse:brute:${ipHash}`;
        const count = await redis.incr(bruteKey);
        if (count === 1) await redis.expire(bruteKey, 600); // 10 min window

        if (count > 50) score += 5;
        else if (count > 20) score += 2;
      }

      // ── Rule 2: Velocity anomaly (compare to 7-day rolling baseline) ──
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const baselineCount = await UsageLog.countDocuments({
        apiKeyId,
        timestamp: { $gte: sevenDaysAgo },
      });
      const baselineRpm = baselineCount / (7 * 24 * 60); // requests per minute

      const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
      const recentCount = await UsageLog.countDocuments({
        apiKeyId,
        timestamp: { $gte: oneMinuteAgo },
      });

      if (baselineRpm > 0 && recentCount / baselineRpm > 5) {
        score += 3; // 5x velocity spike
      }

      // ── Rule 3: Bot-like uniform timing (detect mechanical intervals) ──
      const recentLogs = await UsageLog.find({ apiKeyId, timestamp: { $gte: oneMinuteAgo } })
        .sort({ timestamp: -1 })
        .limit(10)
        .select('timestamp');

      if (recentLogs.length >= 5) {
        const intervals = recentLogs.slice(0, -1).map((log, i) =>
          Math.abs(new Date(log.timestamp).getTime() - new Date(recentLogs[i + 1].timestamp).getTime())
        );
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const variance = intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2), 0) / intervals.length;
        const stdDev = Math.sqrt(variance);

        // Very low variance = bot-like uniform timing
        if (stdDev < 100 && avgInterval < 2000) {
          score += 2;
        }
      }

      if (score === 0) return;

      // Accumulate score in Redis
      const scoreKey = `abuse:score:${apiKeyId}`;
      const totalScore = await redis.incrby(scoreKey, score);
      if (totalScore === score) await redis.expire(scoreKey, 24 * 60 * 60); // 24h window

      // Act on thresholds
      if (totalScore >= SCORE_THRESHOLDS.BLOCK_IP) {
        await redis.setex(`blocked:ip:${ipHash}`, 24 * 60 * 60, '1');
        console.warn(`[AbuseDetector] IP ${ipHash} blocked — score ${totalScore}`);
      }

      if (totalScore >= SCORE_THRESHOLDS.SUSPEND_KEY) {
        await ApiKey.updateOne(
          { _id: apiKeyId, status: 'active' },
          { $set: { status: 'revoked', revokedAt: new Date() } }
        );
        // Bust cache
        const key = await ApiKey.findById(apiKeyId).select('keyHash');
        if (key) await redis.del(`key:${key.keyHash}`);
        console.warn(`[AbuseDetector] Key ${apiKeyId} auto-suspended — score ${totalScore}`);
      } else if (totalScore >= SCORE_THRESHOLDS.SOFT_FLAG) {
        console.info(`[AbuseDetector] Key ${apiKeyId} soft-flagged — score ${totalScore}`);
        // Could push to an abuse_flags collection for admin review
      }
    },
    { connection: getRedis(), concurrency: 10 }
  );

  worker.on('failed', (job, err) => {
    console.error(`[AbuseWorker] Job ${job?.id} failed:`, err.message);
  });

  console.log('✅ Abuse detector worker started');
  return worker;
}
