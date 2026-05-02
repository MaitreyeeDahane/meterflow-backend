import { Worker, Job } from 'bullmq';
import { getRedis } from '../config/redis';
import { Alert } from '../modules/alerts/alert.model';
import { Workspace } from '../modules/workspaces/workspace.model';
import { UsageLog } from '../modules/analytics/usageLog.model';
import { ApiKey } from '../modules/keys/key.model';
import { webhookQueue, emailQueue } from '../queues/queues';
import mongoose from 'mongoose';

export interface AlertJobData {
  workspaceId?: string;
}

export function startAlertWorker(): Worker {
  const worker = new Worker<AlertJobData>(
    'alerts',
    async (job: Job<AlertJobData>) => {
      const filter = job.data.workspaceId ? { workspaceId: job.data.workspaceId } : {};
      const alerts = await Alert.find({ ...filter, enabled: true });
      await Promise.allSettled(alerts.map((alert) => evaluateAlert(alert)));
    },
    { connection: getRedis(), concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    console.error(`[AlertWorker] Job ${job?.id} failed:`, err.message);
  });

  console.log('✅ Alert engine worker started');
  return worker;
}

async function evaluateAlert(alert: InstanceType<typeof Alert>): Promise<void> {
  const redis = getRedis();
  const cooldownKey = `alert:cooldown:${alert._id}`;
  const onCooldown = await redis.exists(cooldownKey);
  if (onCooldown) return;

  const workspace = await Workspace.findById(alert.workspaceId);
  if (!workspace) return;

  const workspaceOid = new mongoose.Types.ObjectId(String(alert.workspaceId));

  let shouldFire = false;
  let value = 0;
  let message = '';

  switch (alert.type) {
    case 'credits_low': {
      const pct = (workspace.credits / Math.max(workspace.creditAllowance, 1)) * 100;
      value = pct;
      shouldFire = pct <= alert.threshold;
      message = `Credits at ${pct.toFixed(1)}% — ${workspace.credits} remaining`;
      break;
    }

    case 'quota_nearing': {
      if (alert.keyId) {
        const key = await ApiKey.findById(alert.keyId);
        if (key && key.quota > 0) {
          const pct = (key.quotaUsed / key.quota) * 100;
          value = pct;
          shouldFire = pct >= alert.threshold;
          message = `Key quota at ${pct.toFixed(1)}% (${key.quotaUsed}/${key.quota})`;
        }
      }
      break;
    }

    case 'traffic_spike': {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
      const [recentCount, baselineCount] = await Promise.all([
        UsageLog.countDocuments({ workspaceId: workspaceOid, timestamp: { $gte: fiveMinAgo } }),
        UsageLog.countDocuments({ workspaceId: workspaceOid, timestamp: { $gte: thirtyMinAgo, $lt: fiveMinAgo } }),
      ]);
      const baselineRpm = baselineCount / 25;
      const recentRpm = recentCount / 5;
      value = recentRpm;
      if (baselineRpm > 0) {
        const multiplier = recentRpm / baselineRpm;
        shouldFire = multiplier >= alert.threshold;
        message = `Traffic spike: ${recentRpm.toFixed(1)} RPM (${multiplier.toFixed(1)}x baseline)`;
      }
      break;
    }

    case 'repeated_failures': {
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
      const matchFilter: Record<string, unknown> = { workspaceId: workspaceOid, statusCode: { $gte: 500 }, timestamp: { $gte: tenMinAgo } };
      if (alert.apiId) matchFilter.apiId = alert.apiId;
      const failCount = await UsageLog.countDocuments(matchFilter);
      value = failCount;
      shouldFire = failCount >= alert.threshold;
      message = `${failCount} server errors in the last 10 minutes`;
      break;
    }

    case 'key_expiring': {
      const cutoff = new Date(Date.now() + alert.threshold * 24 * 60 * 60 * 1000);
      const expiringKeys = await ApiKey.find({ workspaceId: workspaceOid, status: 'active', expiresAt: { $lte: cutoff, $gt: new Date() } });
      value = expiringKeys.length;
      shouldFire = expiringKeys.length > 0;
      message = `${expiringKeys.length} key(s) expiring within ${alert.threshold} days`;
      break;
    }

    case 'error_rate_high': {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const [total, errors] = await Promise.all([
        UsageLog.countDocuments({ workspaceId: workspaceOid, timestamp: { $gte: oneHourAgo } }),
        UsageLog.countDocuments({ workspaceId: workspaceOid, statusCode: { $gte: 400 }, timestamp: { $gte: oneHourAgo } }),
      ]);
      if (total > 0) {
        const errorPct = (errors / total) * 100;
        value = errorPct;
        shouldFire = errorPct >= alert.threshold;
        message = `Error rate at ${errorPct.toFixed(1)}% in the last hour`;
      }
      break;
    }

    default:
      break;
  }

  if (!shouldFire) return;

  await redis.setex(cooldownKey, alert.cooldownMinutes * 60, '1');

  await Alert.updateOne(
    { _id: alert._id },
    {
      $set: { lastTriggeredAt: new Date() },
      $push: { history: { $each: [{ triggeredAt: new Date(), value, message, resolved: false }], $slice: -50 } },
    }
  );

  for (const channel of alert.channels) {
    if (channel === 'email' && workspace.billingEmail) {
      await emailQueue.add('sendEmail', {
        type: 'alert_triggered',
        to: workspace.billingEmail,
        workspaceName: workspace.name,
        alertName: alert.name,
        message,
        value,
      });
    }
    if (channel === 'webhook' && alert.webhookUrl) {
      await webhookQueue.add('deliverWebhook', {
        workspaceId: String(alert.workspaceId),
        event: 'alert.triggered',
        payload: { alertId: alert._id, type: alert.type, message, value },
      });
    }
  }
}
