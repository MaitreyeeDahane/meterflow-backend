import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import { env } from './config/env';
import { connectMongo } from './config/mongo';
import { getRedis } from './config/redis';

import { requestId, httpLoggerDev, httpLogger } from './middleware/requestLogger';
import { errorHandler, notFound } from './middleware/errorHandler';
import { requireWorkspaceMember } from './middleware/workspace';

import { authRouter } from './modules/auth/auth.routes';
import { apiRouter } from './modules/apis/api.routes';
import { keyRouter } from './modules/keys/key.routes';
import { analyticsRouter } from './modules/analytics/analytics.routes';
import { billingRouter } from './modules/billing/billing.routes';
import { alertRouter } from './modules/alerts/alert.routes';
import { auditRouter } from './modules/audit/audit.routes';
import { webhookRouter } from './modules/webhooks/webhook.routes';
import { teamRouter } from './modules/team/team.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { gatewayRouter } from './modules/gateway/gateway.router';

import { initSocketServer } from './realtime/gateway.events';
import { startScheduler } from './queues/scheduler';
import { startUsageWorker } from './workers/usageLogger.worker';
import { startWebhookWorker } from './workers/webhookFirer.worker';
import { startAlertWorker } from './workers/alertEngine.worker';
import { startAbuseWorker } from './workers/abuseDetector.worker';
import { startEmailWorker } from './workers/email.worker';
import { startInvoiceWorker } from './workers/invoiceGen.worker';
import { startCleanupWorker } from './workers/cleanup.worker';
import { startExportWorker } from './workers/export.worker';

async function bootstrap(): Promise<void> {
  // ── Connect to data stores ──────────────────────────────────────
  await connectMongo();
  getRedis(); // Initialize Redis connection

  // ── Express App ─────────────────────────────────────────────────
  const app = express();
  const httpServer = createServer(app);

  // ── Global middleware ────────────────────────────────────────────
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  app.use(cors({
    origin: [env.APP_URL, 'http://localhost:5173'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-Id'],
  }));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(requestId);
  app.use(env.NODE_ENV === 'production' ? httpLogger : httpLoggerDev);

  // ── Health check (no auth) ───────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: process.env.npm_package_version || '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // ── API Gateway (mounted BEFORE /api to avoid auth middleware) ───
  app.use('/gateway', gatewayRouter);

  // ── Dashboard API routes ─────────────────────────────────────────
  app.use('/auth', authRouter);
  // All routes below require a valid workspace membership
  app.use('/apis',      requireWorkspaceMember, apiRouter);
  app.use('/keys',      requireWorkspaceMember, keyRouter);
  app.use('/analytics', requireWorkspaceMember, analyticsRouter);
  app.use('/billing',   requireWorkspaceMember, billingRouter);
  app.use('/alerts',    requireWorkspaceMember, alertRouter);
  app.use('/audit',     requireWorkspaceMember, auditRouter);
  app.use('/webhooks',  requireWorkspaceMember, webhookRouter);
  app.use('/team',      requireWorkspaceMember, teamRouter);
  app.use('/admin',     adminRouter);

  // ── 404 + Global error handler ───────────────────────────────────
  app.use(notFound);
  app.use(errorHandler);

  // ── Socket.io ────────────────────────────────────────────────────
  initSocketServer(httpServer);

  // ── BullMQ workers ───────────────────────────────────────────────
  startUsageWorker();
  startWebhookWorker();
  startAlertWorker();
  startAbuseWorker();
  startEmailWorker();
  startInvoiceWorker();
  startCleanupWorker();
  startExportWorker();

  // ── Cron scheduler ───────────────────────────────────────────────
  startScheduler();

  // ── Start server ─────────────────────────────────────────────────
  httpServer.listen(env.PORT, () => {
    console.log(`\n🚀 MeterFlow API running on port ${env.PORT}`);
    console.log(`   Environment : ${env.NODE_ENV}`);
    console.log(`   Gateway     : http://localhost:${env.PORT}/gateway`);
    console.log(`   Dashboard   : http://localhost:${env.PORT}/auth\n`);
  });

  // ── Graceful shutdown ────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    httpServer.close(async () => {
      const { disconnectMongo } = await import('./config/mongo');
      const { disconnectRedis } = await import('./config/redis');
      await disconnectMongo();
      await disconnectRedis();
      console.log('Shutdown complete.');
      process.exit(0);
    });

    // Force exit after 10s
    setTimeout(() => process.exit(1), 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
    shutdown('unhandledRejection');
  });
}

bootstrap();
