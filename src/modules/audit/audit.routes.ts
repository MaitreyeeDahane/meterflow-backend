import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { auditService } from './audit.service';
import { sendPaginated } from '../../utils/paginate';

export const auditRouter = Router();
auditRouter.use(authenticate);

auditRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await auditService.list(req.workspaceId!, req.query as Record<string, unknown>);
    sendPaginated(res, result);
  } catch (err) { next(err); }
});
