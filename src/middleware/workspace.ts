import { Request, Response, NextFunction } from 'express';
import { Workspace } from '../modules/workspaces/workspace.model';
import { sendError } from '../utils/paginate';

/**
 * Verifies the workspace in the JWT is active and the user is a member.
 * Mount this after `authenticate` on all workspace-scoped routes.
 */
export async function requireWorkspaceMember(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const workspaceId = req.workspaceId;
  const userId = req.user?.sub;

  if (!workspaceId || !userId) {
    sendError(res, 'Workspace context required', 400);
    return;
  }

  try {
    const workspace = await Workspace.findOne({
      _id: workspaceId,
      status: 'active',
      $or: [
        { ownerId: userId },
        { 'members.userId': userId },
      ],
    }).select('_id status').lean();

    if (!workspace) {
      sendError(res, 'Workspace not found or access denied', 403);
      return;
    }

    next();
  } catch {
    sendError(res, 'Failed to validate workspace access', 500);
  }
}

/**
 * Enforces minimum role within a workspace.
 * Role hierarchy: owner > admin > developer > billing > viewer
 */
const ROLE_RANK: Record<string, number> = {
  owner: 5, admin: 4, developer: 3, billing: 2, viewer: 1,
};

export function requireWorkspaceRole(minRole: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.user?.role === 'super_admin') { next(); return; }

    const workspaceId = req.workspaceId;
    const userId = req.user?.sub;
    if (!workspaceId || !userId) { sendError(res, 'Unauthorized', 401); return; }

    try {
      const workspace = await Workspace.findById(workspaceId).select('ownerId members').lean();
      if (!workspace) { sendError(res, 'Workspace not found', 404); return; }

      let memberRole = 'viewer';
      if (workspace.ownerId?.toString() === userId) {
        memberRole = 'owner';
      } else {
        const member = workspace.members.find((m) => m.userId?.toString() === userId);
        if (member) memberRole = member.role;
      }

      const requiredRank = ROLE_RANK[minRole] ?? 1;
      const actualRank   = ROLE_RANK[memberRole] ?? 0;

      if (actualRank < requiredRank) {
        sendError(res, `Requires ${minRole} role or higher`, 403);
        return;
      }

      next();
    } catch {
      sendError(res, 'Failed to validate workspace role', 500);
    }
  };
}
