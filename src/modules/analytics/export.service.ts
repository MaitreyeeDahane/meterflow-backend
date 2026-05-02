import { createWriteStream, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { format } from '@fast-csv/format';
import { UsageLog } from '../analytics/usageLog.model';
import mongoose from 'mongoose';

export interface ExportOptions {
  workspaceId: string;
  startDate: Date;
  endDate: Date;
  apiId?: string;
}

export interface ExportResult {
  jobId: string;
  rowCount: number;
  filePath: string;   // tmp file path — in prod this would be an S3 URL
  filename: string;
}

/**
 * Streams usage logs to a CSV file.
 * In production replace filePath with an S3 pre-signed URL.
 */
export async function exportUsageCsv(options: ExportOptions): Promise<ExportResult> {
  const { workspaceId, startDate, endDate, apiId } = options;
  const jobId = uuidv4();
  const filename = `usage-export-${workspaceId}-${startDate.toISOString().slice(0, 10)}.csv`;
  const filePath = join(tmpdir(), `${jobId}-${filename}`);

  const matchFilter: Record<string, unknown> = {
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    timestamp: { $gte: startDate, $lte: endDate },
  };
  if (apiId) matchFilter.apiId = new mongoose.Types.ObjectId(apiId);

  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(filePath);
    const csvStream = format({ headers: true });

    csvStream.pipe(ws);
    csvStream.on('error', reject);
    ws.on('finish', resolve);
    ws.on('error', reject);

    // Stream cursor to avoid loading all logs into memory
    const cursor = UsageLog.find(matchFilter)
      .sort({ timestamp: -1 })
      .select('aliasRoute method statusCode latencyMs creditsDeducted cacheHit geoCountry geoCity ipHash timestamp requestId')
      .lean()
      .cursor();

    cursor.on('data', (doc) => {
      csvStream.write({
        timestamp:       new Date(doc.timestamp).toISOString(),
        aliasRoute:      doc.aliasRoute,
        method:          doc.method,
        statusCode:      doc.statusCode,
        latencyMs:       doc.latencyMs,
        creditsDeducted: doc.creditsDeducted,
        cacheHit:        doc.cacheHit ? 'yes' : 'no',
        geoCountry:      doc.geoCountry ?? '',
        geoCity:         doc.geoCity ?? '',
        requestId:       doc.requestId,
      });
    });

    cursor.on('error', (err) => { csvStream.end(); reject(err); });
    cursor.on('end', () => csvStream.end());
  });

  // Count rows written
  const rowCount = await UsageLog.countDocuments(matchFilter);

  return { jobId, rowCount, filePath, filename };
}

/**
 * Clean up a tmp export file after download.
 */
export function cleanupExportFile(filePath: string): void {
  try { unlinkSync(filePath); } catch { /* ignore */ }
}
