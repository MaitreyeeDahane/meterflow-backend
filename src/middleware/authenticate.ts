import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, AccessTokenPayload } from '../utils/jwt';
import { sendError } from '../utils/paginate';

// Extend Express Request with authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
      workspaceId?: string;
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, 'Missing or malformed Authorization header', 401);
    return;
  }

  const token = authHeader.slice(7);
  const payload = await verifyAccessToken(token);

  if (!payload) {
    sendError(res, 'Invalid or expired access token', 401);
    return;
  }

  req.user = payload;
  req.workspaceId = payload.workspaceId;
  next();
}

/**
 * Require a specific role (or super_admin always passes).
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendError(res, 'Unauthorized', 401);
      return;
    }
    if (req.user.role === 'super_admin' || roles.includes(req.user.role)) {
      next();
      return;
    }
    sendError(res, 'Insufficient permissions', 403);
  };
}

/**
 * Require super_admin role.
 */
export const requireAdmin = requireRole('super_admin');
