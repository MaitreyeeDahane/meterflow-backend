import { Worker, Job } from 'bullmq';
import axios from 'axios';
import { getRedis } from '../config/redis';
import { Webhook } from '../modules/webhooks/webhook.model';
import { signWebhookPayload } from '../utils/crypto';

export interface WebhookJobData {
  workspaceId: string;
  event: string;
  payload: Record<string, unknown>;
}

export function startWebhookWorker(): Worker {
  const worker = new Worker<WebhookJobData>(
    'webhooks',
    async (job: Job<WebhookJobData>) => {
      const { workspaceId, event, payload } = job.data;

      const webhooks = await Webhook.find({
        workspaceId,
        status: 'active',
        events: event,
      });

      if (!webhooks.length) return;

      const body = JSON.stringify({
        event,
        workspaceId,
        timestamp: new Date().toISOString(),
        data: payload,
      });

      await Promise.allSettled(
        webhooks.map(async (webhook) => {
          const signature = signWebhookPayload(body, webhook.secret);
          const startTime = Date.now();
          let success = false;
          let responseStatus: number | undefined;
          let responseBody: string | undefined;
          let errorMsg: string | undefined;

          try {
            const response = await axios.post(webhook.url, body, {
              headers: {
                'Content-Type': 'application/json',
                'X-MeterFlow-Signature': `sha256=${signature}`,
                'X-MeterFlow-Event': event,
                'X-MeterFlow-Delivery': job.id ?? '',
              },
              timeout: 5000,
              validateStatus: () => true,
            });

            responseStatus = response.status;
            responseBody = JSON.stringify(response.data).substring(0, 500);
            success = response.status >= 200 && response.status < 300;
          } catch (err) {
            errorMsg = err instanceof Error ? err.message : 'Unknown error';
          }

          const durationMs = Date.now() - startTime;

          if (success) {
            // Successful delivery — append to deliveries array, reset failure count
            await Webhook.updateOne(
              { _id: webhook._id },
              {
                $set: {
                  lastDeliveredAt: new Date(),
                  failureCount: 0,
                  status: 'active',
                },
                $push: {
                  deliveries: {
                    $each: [{
                      event,
                      payload,
                      attempts: [{
                        attemptedAt: new Date(),
                        statusCode: responseStatus,
                        responseBody,
                        success: true,
                        durationMs,
                      }],
                      status: 'delivered',
                      createdAt: new Date(),
                    }],
                    $slice: -100, // keep last 100 deliveries
                  },
                },
              }
            );
          } else {
            // Failed delivery — increment failure count, maybe mark as failing
            const updated = await Webhook.findByIdAndUpdate(
              webhook._id,
              {
                $inc: { failureCount: 1 },
                $push: {
                  deliveries: {
                    $each: [{
                      event,
                      payload,
                      attempts: [{
                        attemptedAt: new Date(),
                        statusCode: responseStatus,
                        responseBody,
                        error: errorMsg,
                        success: false,
                        durationMs,
                      }],
                      status: 'failed',
                      createdAt: new Date(),
                    }],
                    $slice: -100,
                  },
                },
              },
              { new: true }
            );

            if (updated && updated.failureCount >= 10) {
              await Webhook.updateOne({ _id: webhook._id }, { $set: { status: 'failing' } });
            }

            throw new Error(`Webhook delivery failed: ${errorMsg ?? `HTTP ${responseStatus}`}`);
          }
        })
      );
    },
    {
      connection: getRedis(),
      concurrency: 10,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`[WebhookWorker] Job ${job?.id} failed:`, err.message);
  });

  console.log('✅ Webhook firer worker started');
  return worker;
}
