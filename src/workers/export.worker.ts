import { Worker, Job } from 'bullmq';
import { getRedis } from '../config/redis';
import { exportUsageCsv, ExportOptions } from '../modules/analytics/export.service';

export interface ExportJobData extends ExportOptions {
  startDate: Date;
  endDate: Date;
  requestedBy: string;
}

// In-memory job result store (in prod: Redis or DB)
const exportResults = new Map<string, {
  status: 'pending' | 'done' | 'failed';
  filePath?: string;
  filename?: string;
  rowCount?: number;
  error?: string;
  createdAt: Date;
}>();

export function getExportResult(jobId: string) {
  return exportResults.get(jobId) ?? null;
}

export function startExportWorker(): Worker {
  const worker = new Worker<ExportJobData>(
    'export',
    async (job: Job<ExportJobData>) => {
      const { workspaceId, startDate, endDate, apiId } = job.data;

      exportResults.set(job.id!, { status: 'pending', createdAt: new Date() });

      try {
        const result = await exportUsageCsv({
          workspaceId,
          startDate: new Date(startDate),
          endDate:   new Date(endDate),
          apiId,
        });

        exportResults.set(job.id!, {
          status:    'done',
          filePath:  result.filePath,
          filename:  result.filename,
          rowCount:  result.rowCount,
          createdAt: new Date(),
        });

        // Auto-cleanup after 15 minutes
        setTimeout(() => exportResults.delete(job.id!), 15 * 60 * 1000);
      } catch (err) {
        exportResults.set(job.id!, {
          status:    'failed',
          error:     err instanceof Error ? err.message : 'Export failed',
          createdAt: new Date(),
        });
        throw err;
      }
    },
    { connection: getRedis(), concurrency: 2 }
  );

  worker.on('failed', (job, err) => {
    console.error(`[ExportWorker] Job ${job?.id} failed:`, err.message);
  });

  console.log('✅ Export worker started');
  return worker;
}
