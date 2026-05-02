import cron from 'node-cron';
import { alertQueue, invoiceQueue, cleanupQueue } from './queues';

export function startScheduler(): void {
  // Evaluate all alert rules every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    await alertQueue.add('evaluateAlerts', {}, { jobId: `alerts-${Date.now()}` });
  });

  // Monthly invoice generation — 1st of every month at 00:05 UTC
  cron.schedule('5 0 1 * *', async () => {
    await invoiceQueue.add(
      'generateMonthly',
      { triggeredAt: new Date().toISOString() },
      { jobId: `invoice-monthly-${new Date().toISOString().slice(0, 7)}` }
    );
  });

  // Daily cleanup of old data — 3 AM UTC
  cron.schedule('0 3 * * *', async () => {
    await cleanupQueue.add('purgeOldData', {}, { jobId: `cleanup-${Date.now()}` });
  });

  console.log('✅ Cron scheduler started');
}
