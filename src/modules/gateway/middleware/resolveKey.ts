import { Request, Response, NextFunction } from 'express';
import { hashApiKey } from '../../../utils/crypto';
import { keyService } from '../../keys/key.service';
import { IApiKey } from '../../keys/key.model';
import { IRegisteredApi } from '../../apis/api.model';

// Extend Request with gateway context
declare global {
  namespace Express {
    interface Request {
      gatewayKey?: IApiKey;
      gatewayApi?: IRegisteredApi;
      gatewayUpstreamHeaders?: { key: string; value: string }[];
      gatewayRequestStart?: number;
      gatewayRequestId?: string;
      gatewayCacheHit?: boolean;
    }
  }
}

export async function resolveKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Support both Authorization: Bearer and X-API-Key header
  const rawKey =
    (req.headers['x-api-key'] as string) ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);

  if (!rawKey) {
    res.status(401).json({
      success: false,
      error: { message: 'API key required. Pass via X-API-Key header or Authorization: Bearer.' },
    });
    return;
  }

  const keyHash = hashApiKey(rawKey);
  const key = await keyService.resolveByHash(keyHash);

  if (!key) {
    res.status(401).json({ success: false, error: { message: 'Invalid API key' } });
    return;
  }

  req.gatewayKey = key;
  req.gatewayRequestStart = Date.now();
  req.gatewayRequestId = req.headers['x-request-id'] as string || crypto.randomUUID();
  next();
}
