import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authController } from './auth.controller';
import { authenticate } from '../../middleware/authenticate';

export const authRouter = Router();

// Strict rate limiting on auth routes: 10 req/min per IP
const authRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, error: { message: 'Too many requests. Try again in a minute.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

authRouter.post('/signup', authRateLimit, authController.signup.bind(authController));
authRouter.post('/login', authRateLimit, authController.login.bind(authController));
authRouter.post('/refresh', authController.refresh.bind(authController));
authRouter.post('/logout', authenticate, authController.logout.bind(authController));
authRouter.get('/verify-email/:token', authController.verifyEmail.bind(authController));
authRouter.post('/forgot-password', authRateLimit, authController.forgotPassword.bind(authController));
authRouter.post('/reset-password', authRateLimit, authController.resetPassword.bind(authController));
authRouter.get('/me', authenticate, authController.me.bind(authController));
authRouter.put('/me', authenticate, authController.updateProfile.bind(authController));
authRouter.post('/change-password', authenticate, authController.changePassword.bind(authController));
