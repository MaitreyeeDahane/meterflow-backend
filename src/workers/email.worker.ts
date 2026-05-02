import { Worker, Job } from 'bullmq';
import nodemailer from 'nodemailer';
import { getRedis } from '../config/redis';
import { env } from '../config/env';

export interface EmailJobData {
  type: 'email_verification' | 'password_reset' | 'alert_triggered' | 'invoice_paid' | 'welcome' | 'key_expiring';
  to: string;
  name?: string;
  token?: string;
  workspaceName?: string;
  alertName?: string;
  message?: string;
  value?: number;
  invoiceNumber?: string;
  invoiceTotal?: number;
  pdfUrl?: string;
}

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
});

function getEmailTemplate(data: EmailJobData): { subject: string; html: string } {
  const BASE_URL = env.APP_URL;

  switch (data.type) {
    case 'email_verification':
      return {
        subject: 'Verify your MeterFlow email',
        html: `
          <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
            <h2>Welcome to MeterFlow, ${data.name}!</h2>
            <p>Click the button below to verify your email address:</p>
            <a href="${BASE_URL}/verify-email/${data.token}"
               style="display:inline-block;padding:12px 24px;background:#6366f1;color:white;border-radius:8px;text-decoration:none;font-weight:600;">
              Verify Email
            </a>
            <p style="color:#6b7280;font-size:14px;">This link expires in 24 hours.</p>
          </div>`,
      };

    case 'password_reset':
      return {
        subject: 'Reset your MeterFlow password',
        html: `
          <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
            <h2>Password Reset Request</h2>
            <p>Click the button below to reset your password:</p>
            <a href="${BASE_URL}/reset-password/${data.token}"
               style="display:inline-block;padding:12px 24px;background:#6366f1;color:white;border-radius:8px;text-decoration:none;font-weight:600;">
              Reset Password
            </a>
            <p style="color:#6b7280;font-size:14px;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
          </div>`,
      };

    case 'alert_triggered':
      return {
        subject: `⚠️ Alert: ${data.alertName} — ${data.workspaceName}`,
        html: `
          <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
            <h2 style="color:#ef4444;">Alert Triggered</h2>
            <p><strong>Workspace:</strong> ${data.workspaceName}</p>
            <p><strong>Alert:</strong> ${data.alertName}</p>
            <p><strong>Details:</strong> ${data.message}</p>
            <a href="${BASE_URL}/alerts"
               style="display:inline-block;padding:12px 24px;background:#6366f1;color:white;border-radius:8px;text-decoration:none;">
              View Alerts
            </a>
          </div>`,
      };

    case 'invoice_paid':
      return {
        subject: `Invoice ${data.invoiceNumber} paid — MeterFlow`,
        html: `
          <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
            <h2 style="color:#10b981;">Payment Received</h2>
            <p>Invoice <strong>${data.invoiceNumber}</strong> has been paid successfully.</p>
            <p><strong>Total:</strong> $${((data.invoiceTotal || 0) / 100).toFixed(2)}</p>
            ${data.pdfUrl ? `<a href="${data.pdfUrl}" style="color:#6366f1;">Download PDF Invoice</a>` : ''}
          </div>`,
      };

    case 'key_expiring':
      return {
        subject: `API Key expiring soon — ${data.workspaceName}`,
        html: `
          <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
            <h2 style="color:#f59e0b;">Key Expiry Warning</h2>
            <p>One or more API keys in <strong>${data.workspaceName}</strong> are expiring soon.</p>
            <a href="${BASE_URL}/keys"
               style="display:inline-block;padding:12px 24px;background:#6366f1;color:white;border-radius:8px;text-decoration:none;">
              Manage Keys
            </a>
          </div>`,
      };

    default:
      return { subject: 'MeterFlow Notification', html: `<p>${data.message || ''}</p>` };
  }
}

export function startEmailWorker(): Worker {
  const worker = new Worker<EmailJobData>(
    'email',
    async (job: Job<EmailJobData>) => {
      const { subject, html } = getEmailTemplate(job.data);

      await transporter.sendMail({
        from: `MeterFlow <${env.EMAIL_FROM}>`,
        to: job.data.to,
        subject,
        html,
      });
    },
    { connection: getRedis(), concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    console.error(`[EmailWorker] Job ${job?.id} failed:`, err.message);
  });

  console.log('✅ Email worker started');
  return worker;
}
