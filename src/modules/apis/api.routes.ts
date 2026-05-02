import { Request, Response, NextFunction, Router } from 'express';
import { z } from 'zod';
import { apiService } from './api.service';
import { sendSuccess, sendPaginated } from '../../utils/paginate';
import { authenticate } from '../../middleware/authenticate';
import { auditService } from '../audit/audit.service';
import { hashString } from '../../utils/crypto';

const createApiSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  baseUrl: z.string().url(),
  aliasRoute: z.string().regex(/^[a-z0-9-_]+$/, 'Alias must be lowercase alphanumeric with hyphens'),
  mode: z.enum(['proxy', 'wrapper']).default('proxy'),
  pricingPerRequest: z.number().min(0).default(1),
  rateLimitPerMin: z.number().min(1).max(10000).default(60),
  cacheTTL: z.number().min(0).default(0),
  tags: z.array(z.string()).optional(),
  upstreamHeaders: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  wrapperConfig: z
    .object({
      sourceRoute: z.string(),
      responseFields: z.array(z.object({ source: z.string(), target: z.string() })),
      metadata: z.record(z.unknown()).optional(),
    })
    .optional(),
});

function ipStr(req: Request): string {
  const raw = req.ip || req.socket?.remoteAddress || '';
  return Array.isArray(raw) ? raw[0] : raw;
}

class ApiController {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const dto = createApiSchema.parse(req.body);
      const api = await apiService.create(req.workspaceId!, req.user!.sub, dto);
      await auditService.log({
        workspaceId: req.workspaceId,
        actorId: req.user!.sub,
        actorEmail: req.user!.email,
        action: 'api.created',
        resource: 'RegisteredApi',
        resourceId: api._id.toString(),
        ipHash: hashString(ipStr(req)),
      });
      sendSuccess(res, api, 201);
    } catch (err) { next(err); }
  }

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await apiService.list(req.workspaceId!, req.query as Record<string, unknown>);
      sendPaginated(res, result);
    } catch (err) { next(err); }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const api = await apiService.getById(req.workspaceId!, req.params.id);
      sendSuccess(res, api);
    } catch (err) { next(err); }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const dto = createApiSchema.partial().parse(req.body);
      const api = await apiService.update(req.workspaceId!, req.params.id, dto);
      await auditService.log({
        workspaceId: req.workspaceId,
        actorId: req.user!.sub,
        actorEmail: req.user!.email,
        action: 'api.updated',
        resource: 'RegisteredApi',
        resourceId: req.params.id,
        ipHash: hashString(ipStr(req)),
      });
      sendSuccess(res, api);
    } catch (err) { next(err); }
  }

  async archive(req: Request, res: Response, next: NextFunction) {
    try {
      await apiService.archive(req.workspaceId!, req.params.id);
      await auditService.log({
        workspaceId: req.workspaceId,
        actorId: req.user!.sub,
        actorEmail: req.user!.email,
        action: 'api.archived',
        resource: 'RegisteredApi',
        resourceId: req.params.id,
        ipHash: hashString(ipStr(req)),
      });
      sendSuccess(res, { message: 'API archived' });
    } catch (err) { next(err); }
  }
}

const ctrl = new ApiController();
export const apiRouter = Router();
apiRouter.use(authenticate);
apiRouter.post('/', ctrl.create.bind(ctrl));
apiRouter.get('/', ctrl.list.bind(ctrl));
apiRouter.get('/:id', ctrl.getById.bind(ctrl));
apiRouter.put('/:id', ctrl.update.bind(ctrl));
apiRouter.delete('/:id', ctrl.archive.bind(ctrl));
