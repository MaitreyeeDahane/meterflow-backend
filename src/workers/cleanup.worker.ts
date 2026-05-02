import { Worker, Job } from 'bullmq';
import { getRedis } from '../config/redis';
import { ApiKey } from '../modules/keys/key.model';
import { webhookQueue } from '../queues/queues';

export function startCleanupWorker(): Worker {
  const worker = new Worker(
    'cleanup',
    async (_job: Job) => {
      await Promise.allSettled([
        expireOverdueKeys(),
        resetMonthlyQuotas(),
      ]);
    },
    { connection: getRedis(), concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    console.error(`[CleanupWorker] Job ${job?.id} failed:`, err.message);
  });

  console.log('✅ Cleanup worker started');
  return worker;
}

/**
 * Mark keys whose expiresAt has passed as 'expired' and bust their cache.
 */
async function expireOverdueKeys(): Promise<void> {
  const redis = getRedis();
  const now = new Date();

  const overdueKeys = await ApiKey.find({
    status: 'active',
    expiresAt: { $lte: now },
  }).select('_id keyHash workspaceId');

  if (!overdueKeys.length) return;

  const ids = overdueKeys.map((k) => k._id);
  await ApiKey.updateMany(
    { _id: { $in: ids } },
    { $set: { status: 'expired' } }
  );

  // Bust Redis key cache for each expired key
  for (const key of overdueKeys) {
    await redis.del(`key:${key.keyHash}`);

    // Fire webhook notification
    await webhookQueue.add('deliverWebhook', {
      workspaceId: String(key.workspaceId),
      event: 'key.expired',
      payload: { keyId: key._id },
    }).catch(() => {}); // non-fatal
  }

  console.log(`[CleanupWorker] Expired ${overdueKeys.length} overdue keys`);
}

/**
 * Reset quotaUsed for keys whose quotaResetAt has passed.
 */
async function resetMonthlyQuotas(): Promise<void> {
  const now = new Date();
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const result = await ApiKey.updateMany(
    { quotaResetAt: { $lte: now }, status: 'active' },
    {
      $set: {
        quotaUsed: 0,
        quotaResetAt: nextMonthStart,
      },
    }
  );

  if (result.modifiedCount > 0) {
    console.log(`[CleanupWorker] Reset quotas for ${result.modifiedCount} keys`);
  }
}
