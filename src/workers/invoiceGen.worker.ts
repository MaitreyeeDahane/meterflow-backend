import { Worker, Job } from 'bullmq';
import { getRedis } from '../config/redis';
import { billingService } from '../modules/billing/billing.service';
import { Workspace } from '../modules/workspaces/workspace.model';
import { emailQueue } from '../queues/queues';

export interface InvoiceJobData {
  type: 'monthly' | 'topup';
  workspaceId?: string;   // for single workspace; undefined = all
  triggeredAt?: string;
}

export function startInvoiceWorker(): Worker {
  const worker = new Worker<InvoiceJobData>(
    'invoice-gen',
    async (job: Job<InvoiceJobData>) => {
      if (job.data.type === 'monthly') {
        await runMonthlyBilling();
      }
    },
    {
      connection: getRedis(),
      concurrency: 3,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`[InvoiceWorker] Job ${job?.id} failed:`, err.message);
  });

  console.log('✅ Invoice generation worker started');
  return worker;
}

async function runMonthlyBilling(): Promise<void> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));

  const workspaces = await Workspace.find({ status: 'active' });
  console.log(`[InvoiceWorker] Generating ${workspaces.length} invoices for ${start.toISOString().slice(0, 7)}`);

  let generated = 0;
  let failed = 0;

  for (const workspace of workspaces) {
    try {
      const invoice = await billingService.generateInvoiceForWorkspace(
        workspace._id.toString(),
        start,
        end
      );

      // Email notification for non-zero invoices
      if (invoice.total > 0 && workspace.billingEmail) {
        await emailQueue.add('sendEmail', {
          type: 'invoice_paid',
          to: workspace.billingEmail,
          workspaceName: workspace.name,
          invoiceNumber: invoice.invoiceNumber,
          invoiceTotal: invoice.total,
        });
      }

      generated++;
    } catch (err) {
      console.error(`[InvoiceWorker] Failed for workspace ${workspace._id}:`, err);
      failed++;
    }
  }

  console.log(`[InvoiceWorker] Monthly billing complete: ${generated} generated, ${failed} failed`);
}
