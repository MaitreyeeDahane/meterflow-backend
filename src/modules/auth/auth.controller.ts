import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authService } from './auth.service';
import { sendSuccess, sendError } from '../../utils/paginate';
import { verifyRefreshToken } from '../../utils/jwt';
import { hashString } from '../../utils/crypto';
import { auditService } from '../audit/audit.service';

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(100),
  workspaceName: z.string().min(1).max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  workspaceId: z.string().optional(),
});

const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({ token: z.string().min(1), newPassword: z.string().min(8) });

function ipStr(req: Request): string {
  const raw = req.ip || req.socket?.remoteAddress || '';
  return Array.isArray(raw) ? (raw as string[])[0] : raw as string;
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/auth/refresh',
  });
}

export class AuthController {
  async signup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const dto = signupSchema.parse(req.body);
      const { user, tokens, workspaceId } = await authService.signup(dto);
      setRefreshCookie(res, tokens.refreshToken);
      sendSuccess(res, {
        accessToken: tokens.accessToken,
        workspaceId,
        user: { id: user._id, email: user.email, name: user.name, role: user.role },
      }, 201);
    } catch (err) { next(err); }
  }

  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const dto = loginSchema.parse(req.body);
      const { user, tokens } = await authService.login(dto, dto.workspaceId);
      setRefreshCookie(res, tokens.refreshToken);

      await auditService.log({
        actorId: user._id.toString(),
        actorEmail: user.email,
        action: 'user.login',
        resource: 'User',
        resourceId: user._id.toString(),
        ipHash: hashString(ipStr(req)),
        userAgent: req.headers['user-agent'],
      });

      sendSuccess(res, {
        accessToken: tokens.accessToken,
        workspaceId: user.defaultWorkspaceId?.toString(),
        user: { id: user._id, email: user.email, name: user.name, role: user.role },
      });
    } catch (err) { next(err); }
  }

  async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const refreshToken = req.cookies?.refreshToken as string | undefined;
      if (!refreshToken) { sendError(res, 'Refresh token not found', 401); return; }
      const tokens = await authService.refresh(refreshToken);
      setRefreshCookie(res, tokens.refreshToken);
      sendSuccess(res, { accessToken: tokens.accessToken });
    } catch (err) { next(err); }
  }

  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = req.user!;
      const refreshToken = req.cookies?.refreshToken as string | undefined;
      const refreshPayload = refreshToken ? verifyRefreshToken(refreshToken) : null;
      await authService.logout(user.jti, user.exp ?? 0, user.sub, refreshPayload?.jti);
      res.clearCookie('refreshToken', { path: '/auth/refresh' });
      sendSuccess(res, { message: 'Logged out successfully' });
    } catch (err) { next(err); }
  }

  async verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await authService.verifyEmail(req.params.token);
      sendSuccess(res, { message: 'Email verified successfully' });
    } catch (err) { next(err); }
  }

  async forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email } = forgotSchema.parse(req.body);
      await authService.forgotPassword(email);
      sendSuccess(res, { message: 'If that email exists, a reset link has been sent.' });
    } catch (err) { next(err); }
  }

  async resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token, newPassword } = resetSchema.parse(req.body);
      await authService.resetPassword(token, newPassword);
      sendSuccess(res, { message: 'Password reset successfully' });
    } catch (err) { next(err); }
  }

  async me(req: Request, res: Response): Promise<void> {
    sendSuccess(res, { user: req.user });
  }

  async updateProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
      const user = await authService.updateProfile(req.user!.sub, name);
      sendSuccess(res, { user: { id: user._id, email: user.email, name: user.name, role: user.role } });
    } catch (err) { next(err); }
  }

  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { oldPassword, newPassword } = z.object({
        oldPassword: z.string().min(1),
        newPassword: z.string().min(8),
      }).parse(req.body);
      await authService.changePassword(req.user!.sub, oldPassword, newPassword);
      sendSuccess(res, { message: 'Password changed successfully' });
    } catch (err) { next(err); }
  }
}

export const authController = new AuthController();
