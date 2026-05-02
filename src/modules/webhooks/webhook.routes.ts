import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { Webhook } from './webhook.model';
import { generateWebhookSecret } from '../../utils/crypto';
import { sendSuccess, parsePagination, buildPaginationResult, sendPaginated } from '../../utils/paginate';
import { createError } from '../../middleware/errorHandler';

export const webhookRouter = Router();
webhookRouter.use(authenticate);

const webhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
});

webhookRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto = webhookSchema.parse(req.body);
    const webhook = await Webhook.create({
      ...dto,
      workspaceId: req.workspaceId,
      secret: generateWebhookSecret(),
    });
    sendSuccess(res, webhook, 201);
  } catch (err) { next(err); }
});

webhookRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const [data, total] = await Promise.all([
      Webhook.find({ workspaceId: req.workspaceId }).select('-deliveries').sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit),
      Webhook.countDocuments({ workspaceId: req.workspaceId }),
    ]);
    sendPaginated(res, buildPaginationResult(data, total, { page, limit }));
  } catch (err) { next(err); }
});

webhookRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await Webhook.deleteOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (result.deletedCount === 0) throw createError('Webhook not found', 404);
    sendSuccess(res, { message: 'Webhook deleted' });
  } catch (err) { next(err); }
});

webhookRouter.post('/:id/rotate-secret', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const webhook = await Webhook.findOneAndUpdate(
      { _id: req.params.id, workspaceId: req.workspaceId },
      { $set: { secret: generateWebhookSecret() } },
      { new: true }
    );
    if (!webhook) throw createError('Webhook not found', 404);
    sendSuccess(res, { secret: webhook.secret });
  } catch (err) { next(err); }
});
