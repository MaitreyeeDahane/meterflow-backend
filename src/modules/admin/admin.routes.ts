import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requireAdmin } from '../../middleware/authenticate';
import { Workspace } from '../workspaces/workspace.model';
import { User } from '../users/user.model';
import { RegisteredApi } from '../apis/api.model';
import { analyticsService } from '../analytics/analytics.service';
import { auditService } from '../audit/audit.service';
import { pingRedis, getRedis } from '../../config/redis';
import { mongoose } from '../../config/mongo';
import { sendSuccess, sendPaginated, parsePagination, buildPaginationResult } from '../../utils/paginate';
import { createError } from '../../middleware/errorHandler';
import { Queue } from 'bullmq';

export const adminRouter = Router();
adminRouter.use(authenticate, requireAdmin);

adminRouter.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [platformStats, userCount, apiCount] = await Promise.all([
      analyticsService.platformStats(),
      User.countDocuments(),
      RegisteredApi.countDocuments({ status: 'active' }),
    ]);
    sendSuccess(res, { ...platformStats, userCount, apiCount });
  } catch (err) { next(err); }
});

adminRouter.get('/tenants', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const filter: Record<string, unknown> = {};
    if (req.query.status) filter.status = req.query.status as string;

    const [data, total] = await Promise.all([
      Workspace.find(filter).populate('ownerId', 'name email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Workspace.countDocuments(filter),
    ]);
    sendPaginated(res, buildPaginationResult(data, total, { page, limit }));
  } catch (err) { next(err); }
});

adminRouter.get('/tenants/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspace = await Workspace.findById(req.params.id).populate('ownerId', 'name email');
    if (!workspace) throw createError('Workspace not found', 404);
    const [apiCount, usage] = await Promise.all([
      RegisteredApi.countDocuments({ workspaceId: req.params.id }),
      analyticsService.overview(req.params.id),
    ]);
    sendSuccess(res, { workspace, apiCount, usage });
  } catch (err) { next(err); }
});

adminRouter.post('/tenants/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await Workspace.updateOne({ _id: req.params.id }, { $set: { status: 'suspended' } });
    sendSuccess(res, { message: 'Workspace suspended' });
  } catch (err) { next(err); }
});

adminRouter.post('/tenants/:id/reactivate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await Workspace.updateOne({ _id: req.params.id }, { $set: { status: 'active' } });
    sendSuccess(res, { message: 'Workspace reactivated' });
  } catch (err) { next(err); }
});

adminRouter.get('/audit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await auditService.listPlatform(req.query as Record<string, unknown>);
    sendPaginated(res, result);
  } catch (err) { next(err); }
});

adminRouter.get('/health', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [redisOk, mongoState] = await Promise.all([
      pingRedis(),
      Promise.resolve(mongoose.connection.readyState),
    ]);

    // Queue lag — count waiting jobs in each queue
    const QUEUE_NAMES = ['usage-log', 'invoice-gen', 'alerts', 'webhooks', 'abuse', 'email', 'export', 'cleanup'];
    const queueStats = await Promise.all(
      QUEUE_NAMES.map(async (name) => {
        try {
          const q = new Queue(name, { connection: getRedis() });
          const [waiting, active, failed] = await Promise.all([
            q.getWaitingCount(),
            q.getActiveCount(),
            q.getFailedCount(),
          ]);
          await q.close();
          return { name, waiting, active, failed };
        } catch {
          return { name, waiting: -1, active: -1, failed: -1, error: 'unavailable' };
        }
      })
    );

    const health = {
      status: redisOk && mongoState === 1 ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        mongodb: { status: mongoState === 1 ? 'connected' : 'disconnected', readyState: mongoState },
        redis:   { status: redisOk ? 'connected' : 'disconnected' },
      },
      queues: queueStats,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    };

    res.status(health.status === 'healthy' ? 200 : 503).json({ success: true, data: health });
  } catch (err) { next(err); }
});
