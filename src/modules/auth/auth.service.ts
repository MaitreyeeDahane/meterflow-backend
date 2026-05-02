import bcrypt from 'bcryptjs';
import { User, IUser } from '../users/user.model';
import { Workspace } from '../workspaces/workspace.model';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  storeRefreshToken,
  invalidateRefreshToken,
  validateRefreshTokenInStore,
  blacklistAccessToken,
} from '../../utils/jwt';
import { generateSecureToken, hashString } from '../../utils/crypto';
import { slugify } from '../../utils/paginate';
import { emailQueue } from '../../queues/queues';
import { createError } from '../../middleware/errorHandler';
import mongoose from 'mongoose';

const BCRYPT_ROUNDS = 12;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenJti: string;
}

export interface SignupDto {
  email: string;
  password: string;
  name: string;
  workspaceName?: string;
}

export interface LoginDto {
  email: string;
  password: string;
}

export class AuthService {
  async signup(dto: SignupDto): Promise<{ user: IUser; tokens: AuthTokens; workspaceId: string }> {
    const existingUser = await User.findOne({ email: dto.email.toLowerCase() });
    if (existingUser) throw createError('Email already registered', 409);

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const emailVerifyToken = generateSecureToken();
    const emailVerifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const [user] = await User.create(
        [
          {
            email: dto.email.toLowerCase(),
            passwordHash,
            name: dto.name,
            emailVerifyToken,
            emailVerifyExpires,
          },
        ],
        { session }
      );

      const workspaceName = dto.workspaceName || `${dto.name}'s Workspace`;
      const slug = await this.uniqueSlug(slugify(workspaceName));

      const [workspace] = await Workspace.create(
        [
          {
            name: workspaceName,
            slug,
            ownerId: user._id,
            members: [{ userId: user._id, role: 'owner', acceptedAt: new Date() }],
          },
        ],
        { session }
      );

      user.defaultWorkspaceId = workspace._id;
      await user.save({ session });

      await session.commitTransaction();

      // Queue verification email (fire and forget)
      await emailQueue.add('sendEmail', {
        type: 'email_verification',
        to: user.email,
        name: user.name,
        token: emailVerifyToken,
      });

      const tokens = await this.issueTokens(user, workspace._id.toString());
      return { user, tokens, workspaceId: workspace._id.toString() };
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  }

  async login(dto: LoginDto, workspaceId?: string): Promise<{ user: IUser; tokens: AuthTokens }> {
    const user = await User.findOne({ email: dto.email.toLowerCase() });
    if (!user) throw createError('Invalid credentials', 401);

    const valid = await user.comparePassword(dto.password);
    if (!valid) throw createError('Invalid credentials', 401);

    if (!user.emailVerified) throw createError('Email not verified. Check your inbox.', 403);

    user.lastLoginAt = new Date();
    await user.save();

    const wsId = workspaceId || user.defaultWorkspaceId?.toString();
    const tokens = await this.issueTokens(user, wsId);
    return { user, tokens };
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = verifyRefreshToken(refreshToken);
    if (!payload) throw createError('Invalid refresh token', 401);

    const valid = await validateRefreshTokenInStore(payload.sub, payload.jti);
    if (!valid) throw createError('Refresh token revoked or expired', 401);

    // Rotate: invalidate old, issue new
    await invalidateRefreshToken(payload.sub, payload.jti);

    const user = await User.findById(payload.sub);
    if (!user) throw createError('User not found', 404);

    return this.issueTokens(user, user.defaultWorkspaceId?.toString());
  }

  async logout(jti: string, exp: number, userId: string, refreshJti?: string): Promise<void> {
    await blacklistAccessToken(jti, exp);
    if (refreshJti) await invalidateRefreshToken(userId, refreshJti);
  }

  async verifyEmail(token: string): Promise<void> {
    const user = await User.findOne({
      emailVerifyToken: token,
      emailVerifyExpires: { $gt: new Date() },
    });
    if (!user) throw createError('Invalid or expired verification link', 400);

    user.emailVerified = true;
    user.emailVerifyToken = undefined;
    user.emailVerifyExpires = undefined;
    await user.save();
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return; // Don't reveal whether email exists

    const token = generateSecureToken();
    user.resetPasswordToken = token;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1h
    await user.save();

    await emailQueue.add('sendEmail', {
      type: 'password_reset',
      to: user.email,
      name: user.name,
      token,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() },
    });
    if (!user) throw createError('Invalid or expired reset link', 400);

    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();
  }

  private async issueTokens(user: IUser, workspaceId?: string): Promise<AuthTokens> {
    const accessToken = signAccessToken({
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
      workspaceId,
    });

    const { token: refreshToken, jti: refreshTokenJti } = signRefreshToken(user._id.toString());
    await storeRefreshToken(user._id.toString(), refreshTokenJti);

    return { accessToken, refreshToken, refreshTokenJti };
  }

  private async uniqueSlug(base: string): Promise<string> {
    let slug = base;
    let attempt = 0;
    while (await Workspace.exists({ slug })) {
      slug = `${base}-${++attempt}`;
    }
    return slug;
  }
  async updateProfile(userId: string, name: string): Promise<IUser> {
    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { name: name.trim() } },
      { new: true, runValidators: true }
    );
    if (!user) throw createError('User not found', 404);
    return user;
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await User.findById(userId);
    if (!user) throw createError('User not found', 404);
    const valid = await user.comparePassword(oldPassword);
    if (!valid) throw createError('Current password is incorrect', 401);
    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await user.save();
  }
}

export const authService = new AuthService();
