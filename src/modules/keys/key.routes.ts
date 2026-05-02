import { Request, Response, NextFunction, Router } from 'express';
import { z } from 'zod';
import { keyService } from './key.service';
import { sendSuccess, sendPaginated } from '../../utils/paginate';
import { authenticate } from '../../middleware/authenticate';
import { auditService } from '../audit/audit.service';
import { hashString } from '../../utils/crypto';

const generateKeySchema = z.object({
  apiId: z.string().min(1),
  label: z.string().max(100).optional(),
  environment: z.enum(['sandbox', 'production']).optional(),
  quota: z.number().int().min(-1).optional(),
  rateLimit: z.number().int().min(0).optional(),
  expiresAt: z.string().datetime().optional().transform((v) => (v ? new Date(v) : undefined)),
  metadata: z.record(z.unknown()).optional(),
});

const setExpirySchema = z.object({
  expiresAt: z.string().datetime().transform((v) => new Date(v)),
});

function ipStr(req: Request): string {
  const raw = req.ip || req.socket?.remoteAddress || '';
  return Array.isArray(raw) ? (raw as string[])[0] : raw as string;
}

class KeyController {
  async generate(req: Request, res: Response, next: NextFunction) {
    try {
      const dto = generateKeySchema.parse(req.body);
      const { key, rawKey } = await keyService.generate(req.workspaceId!, req.user!.sub, dto);
      await auditService.log({
        workspaceId: req.workspaceId,
        actorId: req.user!.sub,
        actorEmail: req.user!.email,
        action: 'key.created',
        resource: 'ApiKey',
        resourceId: key._id.toString(),
        ipHash: hashString(ipStr(req)),
      });
      sendSuccess(res, { key, rawKey, warning: 'Store this key securely. It will not be shown again.' }, 201);
    } catch (err) { next(err); }
  }

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await keyService.list(
        req.workspaceId!,
        req.query.apiId as string | undefined,
        req.query as Record<string, unknown>
      );
      sendPaginated(res, result);
    } catch (err) { next(err); }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const key = await keyService.getById(req.workspaceId!, req.params.id);
      sendSuccess(res, key);
    } catch (err) { next(err); }
  }

  async revoke(req: Request, res: Response, next: NextFunction) {
    try {
      await keyService.revoke(req.workspaceId!, req.params.id, req.user!.sub);
      await auditService.log({
        workspaceId: req.workspaceId,
        actorId: req.user!.sub,
        actorEmail: req.user!.email,
        action: 'key.revoked',
        resource: 'ApiKey',
        resourceId: req.params.id,
        ipHash: hashString(ipStr(req)),
      });
      sendSuccess(res, { message: 'Key revoked' });
    } catch (err) { next(err); }
  }

  async rotate(req: Request, res: Response, next: NextFunction) {
    try {
      const { key, rawKey } = await keyService.rotate(req.workspaceId!, req.params.id, req.user!.sub);
      await auditService.log({
        workspaceId: req.workspaceId,
        actorId: req.user!.sub,
        actorEmail: req.user!.email,
        action: 'key.rotated',
        resource: 'ApiKey',
        resourceId: key._id.toString(),
        ipHash: hashString(ipStr(req)),
      });
      sendSuccess(res, { key, rawKey, warning: 'New key shown once. Store it securely.' });
    } catch (err) { next(err); }
  }

  async setExpiry(req: Request, res: Response, next: NextFunction) {
    try {
      const { expiresAt } = setExpirySchema.parse(req.body);
      const key = await keyService.setExpiry(req.workspaceId!, req.params.id, expiresAt);
      sendSuccess(res, key);
    } catch (err) { next(err); }
  }

  async usage(req: Request, res: Response, next: NextFunction) {
    try {
      const key = await keyService.getById(req.workspaceId!, req.params.id);
      sendSuccess(res, {
        keyId: key._id,
        label: key.label,
        quota: key.quota,
        quotaUsed: key.quotaUsed,
        quotaResetAt: key.quotaResetAt,
        totalRequests: key.totalRequests,
        totalCreditsConsumed: key.totalCreditsConsumed,
        lastUsedAt: key.lastUsedAt,
      });
    } catch (err) { next(err); }
  }
}

const ctrl = new KeyController();
export const keyRouter = Router();
keyRouter.use(authenticate);
keyRouter.post('/', ctrl.generate.bind(ctrl));
keyRouter.get('/', ctrl.list.bind(ctrl));
keyRouter.get('/:id', ctrl.getById.bind(ctrl));
keyRouter.get('/:id/usage', ctrl.usage.bind(ctrl));
keyRouter.post('/:id/revoke', ctrl.revoke.bind(ctrl));
keyRouter.post('/:id/rotate', ctrl.rotate.bind(ctrl));
keyRouter.put('/:id/expire', ctrl.setExpiry.bind(ctrl));
