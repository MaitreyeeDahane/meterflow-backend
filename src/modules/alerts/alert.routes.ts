import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { Alert } from './alert.model';
import { sendSuccess, sendPaginated, parsePagination, buildPaginationResult } from '../../utils/paginate';
import { createError } from '../../middleware/errorHandler';

export const alertRouter = Router();
alertRouter.use(authenticate);

const alertSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['credits_low','quota_nearing','traffic_spike','repeated_failures','key_expiring','abuse_detected','latency_high','error_rate_high']),
  threshold: z.number(),
  channels: z.array(z.enum(['email','webhook','slack'])).min(1),
  webhookUrl: z.string().url().optional(),
  slackWebhookUrl: z.string().url().optional(),
  cooldownMinutes: z.number().int().min(1).default(60),
  apiId: z.string().optional(),
  keyId: z.string().optional(),
  enabled: z.boolean().default(true),
});

alertRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto = alertSchema.parse(req.body);
    const alert = await Alert.create({ ...dto, workspaceId: req.workspaceId });
    sendSuccess(res, alert, 201);
  } catch (err) { next(err); }
});

alertRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const [data, total] = await Promise.all([
      Alert.find({ workspaceId: req.workspaceId }).sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit),
      Alert.countDocuments({ workspaceId: req.workspaceId }),
    ]);
    sendPaginated(res, buildPaginationResult(data, total, { page, limit }));
  } catch (err) { next(err); }
});

alertRouter.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto = alertSchema.partial().parse(req.body);
    const alert = await Alert.findOneAndUpdate(
      { _id: req.params.id, workspaceId: req.workspaceId },
      { $set: dto },
      { new: true }
    );
    if (!alert) throw createError('Alert not found', 404);
    sendSuccess(res, alert);
  } catch (err) { next(err); }
});

alertRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await Alert.deleteOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (result.deletedCount === 0) throw createError('Alert not found', 404);
    sendSuccess(res, { message: 'Alert deleted' });
  } catch (err) { next(err); }
});

alertRouter.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const alerts = await Alert.find({ workspaceId: req.workspaceId, 'history.0': { $exists: true } })
      .select('name type history lastTriggeredAt')
      .sort({ lastTriggeredAt: -1 })
      .limit(50);
    sendSuccess(res, alerts);
  } catch (err) { next(err); }
});
