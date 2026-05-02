import { Request, Response, NextFunction } from 'express';
import { keyService } from '../../keys/key.service';

export async function checkExpiry(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.gatewayKey!;

  if (key.status === 'revoked') {
    res.status(401).json({ success: false, error: { message: 'API key has been revoked' } });
    return;
  }

  if (key.status === 'expired') {
    res.status(401).json({ success: false, error: { message: 'API key has expired' } });
    return;
  }

  if (key.expiresAt && new Date() > new Date(key.expiresAt)) {
    // Lazily mark as expired in the DB and bust cache
    await keyService.invalidateCache(key.keyHash);
    res.status(401).json({ success: false, error: { message: 'API key has expired' } });
    return;
  }

  next();
}
