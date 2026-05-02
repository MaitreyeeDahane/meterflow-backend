import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { Workspace } from '../workspaces/workspace.model';
import { User } from '../users/user.model';
import { sendSuccess } from '../../utils/paginate';
import { createError } from '../../middleware/errorHandler';
import { emailQueue } from '../../queues/queues';

export const teamRouter = Router();
teamRouter.use(authenticate);

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'developer', 'billing', 'viewer']),
});

// Get workspace members
teamRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspace = await Workspace.findById(req.workspaceId)
      .populate('members.userId', 'name email role lastLoginAt');
    if (!workspace) throw createError('Workspace not found', 404);
    sendSuccess(res, workspace.members);
  } catch (err) { next(err); }
});

// Invite member (by email)
teamRouter.post('/invite', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, role } = inviteSchema.parse(req.body);

    const user = await User.findOne({ email });
    if (!user) throw createError('No MeterFlow account found for that email', 404);

    const workspace = await Workspace.findById(req.workspaceId);
    if (!workspace) throw createError('Workspace not found', 404);

    const alreadyMember = workspace.members.some(
      (m) => m.userId.toString() === user._id.toString()
    );
    if (alreadyMember) throw createError('User is already a member', 409);

    workspace.members.push({ userId: user._id, role, invitedAt: new Date() });
    await workspace.save();

    await emailQueue.add('sendEmail', {
      type: 'welcome',
      to: email,
      name: user.name,
      workspaceName: workspace.name,
      message: `You've been invited to ${workspace.name} as ${role}.`,
    });

    sendSuccess(res, { message: `${email} invited as ${role}` }, 201);
  } catch (err) { next(err); }
});

// Remove member
teamRouter.delete('/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspace = await Workspace.findById(req.workspaceId);
    if (!workspace) throw createError('Workspace not found', 404);

    // Cannot remove owner
    const member = workspace.members.find((m) => m.userId.toString() === req.params.userId);
    if (!member) throw createError('Member not found', 404);
    if (member.role === 'owner') throw createError('Cannot remove workspace owner', 400);

    workspace.members = workspace.members.filter(
      (m) => m.userId.toString() !== req.params.userId
    );
    await workspace.save();

    sendSuccess(res, { message: 'Member removed' });
  } catch (err) { next(err); }
});

// Update member role
teamRouter.put('/:userId/role', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { role } = z.object({ role: z.enum(['admin', 'developer', 'billing', 'viewer']) }).parse(req.body);
    const workspace = await Workspace.findById(req.workspaceId);
    if (!workspace) throw createError('Workspace not found', 404);

    const member = workspace.members.find((m) => m.userId.toString() === req.params.userId);
    if (!member) throw createError('Member not found', 404);
    if (member.role === 'owner') throw createError('Cannot change owner role', 400);

    member.role = role;
    await workspace.save();
    sendSuccess(res, { message: 'Role updated' });
  } catch (err) { next(err); }
});
