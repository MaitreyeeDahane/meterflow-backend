import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { analyticsService } from './analytics.service';
import { sendSuccess } from '../../utils/paginate';

export const analyticsRouter = Router();
analyticsRouter.use(authenticate);

analyticsRouter.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await analyticsService.overview(req.workspaceId!);
    sendSuccess(res, data);
  } catch (err) { next(err); }
});

analyticsRouter.get('/timeseries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await analyticsService.timeseries(
      req.workspaceId!,
      (req.query.interval as 'hour' | 'day') || 'hour',
      Number(req.query.days) || 7,
      req.query.apiId as string | undefined
    );
    sendSuccess(res, data);
  } catch (err) { next(err); }
});

analyticsRouter.get('/endpoints', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await analyticsService.topEndpoints(
      req.workspaceId!,
      Number(req.query.days) || 7,
      Number(req.query.limit) || 10
    );
    sendSuccess(res, data);
  } catch (err) { next(err); }
});

analyticsRouter.get('/consumers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await analyticsService.topConsumers(req.workspaceId!, Number(req.query.days) || 7);
    sendSuccess(res, data);
  } catch (err) { next(err); }
});

analyticsRouter.get('/geo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await analyticsService.geoBreakdown(req.workspaceId!, Number(req.query.days) || 30);
    sendSuccess(res, data);
  } catch (err) { next(err); }
});

analyticsRouter.get('/heatmap', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await analyticsService.heatmap(req.workspaceId!, Number(req.query.days) || 30);
    sendSuccess(res, data);
  } catch (err) { next(err); }
});

import { z } from 'zod';
import { createReadStream } from 'fs';
import { exportQueue } from '../../queues/queues';
import { getExportResult } from '../../workers/export.worker';
import { cleanupExportFile } from './export.service';

analyticsRouter.post('/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      startDate: z.string().datetime().transform(v => new Date(v)),
      endDate:   z.string().datetime().transform(v => new Date(v)),
      apiId:     z.string().optional(),
    });
    const { startDate, endDate, apiId } = schema.parse(req.body);

    const job = await exportQueue.add('generateExport', {
      workspaceId: req.workspaceId!,
      startDate,
      endDate,
      apiId,
      requestedBy: req.user!.sub,
    });

    sendSuccess(res, { jobId: job.id, message: 'Export queued' }, 202);
  } catch (err) { next(err); }
});

analyticsRouter.get('/export/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = getExportResult(req.params.jobId);
    if (!result) {
      res.status(404).json({ success: false, error: { message: 'Export job not found' } });
      return;
    }
    if (result.status === 'pending') {
      sendSuccess(res, { status: 'pending', jobId: req.params.jobId });
      return;
    }
    if (result.status === 'failed') {
      res.status(500).json({ success: false, error: { message: result.error ?? 'Export failed' } });
      return;
    }
    // Stream the file then delete it
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    const stream = createReadStream(result.filePath!);
    stream.pipe(res);
    stream.on('end', () => cleanupExportFile(result.filePath!));
    stream.on('error', () => next(new Error('Failed to stream export file')));
  } catch (err) { next(err); }
});
