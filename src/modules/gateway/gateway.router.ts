import { Router, Request, Response, NextFunction } from 'express';
import { resolveKey } from './middleware/resolveKey';
import { checkExpiry } from './middleware/checkExpiry';
import { checkQuota } from './middleware/checkQuota';
import { rateLimit } from './middleware/rateLimit';
import { cacheCheck } from './middleware/cacheCheck';
import { proxyForward } from './middleware/proxyForward';
import { apiService } from '../apis/api.service';

export const gatewayRouter = Router();

async function resolveApi(req: Request, res: Response, next: NextFunction): Promise<void> {
  const alias = req.params.alias as string;
  const result = await apiService.getForGateway(alias);

  if (!result) {
    res.status(404).json({ success: false, error: { message: `No active API registered under alias: ${alias}` } });
    return;
  }

  const keyWorkspace = String(req.gatewayKey!.workspaceId);
  const apiWorkspace = String(result.api.workspaceId);

  if (keyWorkspace !== apiWorkspace) {
    res.status(403).json({ success: false, error: { message: 'API key does not have access to this API' } });
    return;
  }

  req.gatewayApi = result.api;
  req.gatewayUpstreamHeaders = result.decryptedHeaders;
  next();
}

gatewayRouter.all('/:alias/*', resolveKey, checkExpiry, resolveApi, checkQuota, rateLimit, cacheCheck, proxyForward);

gatewayRouter.get('/_health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
