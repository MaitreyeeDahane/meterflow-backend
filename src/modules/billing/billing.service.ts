import PDFDocument from 'pdfkit';
import { Workspace } from '../workspaces/workspace.model';
import { Invoice, IInvoice } from './invoice.model';
import { UsageLog } from '../analytics/usageLog.model';
import { RegisteredApi } from '../apis/api.model';
import { emailQueue } from '../../queues/queues';
import { createError } from '../../middleware/errorHandler';
import { getCurrentMonthRange } from '../../utils/paginate';
import { parsePagination, buildPaginationResult } from '../../utils/paginate';
import mongoose from 'mongoose';

// Credit pricing: 1000 credits = $1.00 (stored as cents)
const CREDIT_PRICE_CENTS = 0.1; // $0.001 per credit

const PLAN_ALLOWANCES: Record<string, { credits: number; pricePerMonth: number }> = {
  free:       { credits: 1_000,     pricePerMonth: 0 },
  starter:    { credits: 50_000,    pricePerMonth: 2900 },
  pro:        { credits: 500_000,   pricePerMonth: 9900 },
  enterprise: { credits: 5_000_000, pricePerMonth: 29900 },
};

export class BillingService {
  async getWallet(workspaceId: string) {
    const workspace = await Workspace.findById(workspaceId).select(
      'credits creditAllowance plan currency'
    );
    if (!workspace) throw createError('Workspace not found', 404);

    // Predictive exhaustion
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [usage7d] = await UsageLog.aggregate([
      { $match: { workspaceId: new mongoose.Types.ObjectId(workspaceId), timestamp: { $gte: sevenDaysAgo } } },
      { $group: { _id: null, totalCredits: { $sum: '$creditsDeducted' } } },
    ]);

    const creditsPerDay = (usage7d?.totalCredits || 0) / 7;
    const daysRemaining = creditsPerDay > 0 ? workspace.credits / creditsPerDay : null;

    return {
      credits: workspace.credits,
      creditAllowance: workspace.creditAllowance,
      plan: workspace.plan,
      currency: workspace.currency,
      creditsPerDay: Math.round(creditsPerDay * 100) / 100,
      predictedExhaustionDays: daysRemaining ? Math.round(daysRemaining * 10) / 10 : null,
      exhaustionDate: daysRemaining
        ? new Date(Date.now() + daysRemaining * 24 * 60 * 60 * 1000)
        : null,
    };
  }

  async topUp(workspaceId: string, credits: number): Promise<{ invoice: IInvoice; newBalance: number }> {
    if (credits < 100) throw createError('Minimum top-up is 100 credits', 400);
    if (credits > 10_000_000) throw createError('Maximum single top-up is 10M credits', 400);

    const workspace = await Workspace.findByIdAndUpdate(
      workspaceId,
      { $inc: { credits } },
      { new: true }
    );
    if (!workspace) throw createError('Workspace not found', 404);

    const amountCents = Math.round(credits * CREDIT_PRICE_CENTS);
    const { start, end } = getCurrentMonthRange();

    const invoice = await Invoice.create({
      workspaceId,
      type: 'topup',
      period: { start, end },
      lineItems: [{
        description: `Credit top-up: ${credits.toLocaleString()} credits`,
        quantity: credits,
        unitPrice: Math.round(CREDIT_PRICE_CENTS * 100) / 100,
        amount: amountCents,
      }],
      subtotal: amountCents,
      taxRate: workspace.taxRate,
      taxAmount: Math.round(amountCents * workspace.taxRate / 100),
      total: Math.round(amountCents * (1 + workspace.taxRate / 100)),
      currency: workspace.currency,
      status: 'paid',
      paidAt: new Date(),
      creditsAdded: credits,
    });

    return { invoice, newBalance: workspace.credits };
  }

  async generateMonthlyInvoices(): Promise<void> {
    const { start, end } = getPreviousMonthRange();
    const workspaces = await Workspace.find({ status: 'active' });

    for (const workspace of workspaces) {
      try {
        await this.generateInvoiceForWorkspace(workspace._id.toString(), start, end);
      } catch (err) {
        console.error(`Invoice generation failed for workspace ${workspace._id}:`, err);
      }
    }
  }

  async generateInvoiceForWorkspace(
    workspaceId: string,
    start: Date,
    end: Date
  ): Promise<IInvoice> {
    // Aggregate usage by API
    const usageByApi = await UsageLog.aggregate([
      {
        $match: {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          timestamp: { $gte: start, $lte: end },
          statusCode: { $lt: 400 },
        },
      },
      {
        $group: {
          _id: '$apiId',
          totalCredits: { $sum: '$creditsDeducted' },
          totalRequests: { $sum: 1 },
        },
      },
    ]);

    if (usageByApi.length === 0) return this.createZeroInvoice(workspaceId, start, end);

    const workspace = await Workspace.findById(workspaceId);
    if (!workspace) throw createError('Workspace not found', 404);

    const plan = PLAN_ALLOWANCES[workspace.plan];
    const lineItems = [];
    let totalCredits = 0;

    for (const usage of usageByApi) {
      const api = await RegisteredApi.findById(usage._id).select('name');
      totalCredits += usage.totalCredits;

      lineItems.push({
        description: `API Usage: ${api?.name || 'Unknown API'}`,
        quantity: usage.totalRequests,
        unitPrice: usage.totalRequests > 0
          ? Math.round((usage.totalCredits * CREDIT_PRICE_CENTS * 100) / usage.totalRequests) / 100
          : 0,
        amount: Math.round(usage.totalCredits * CREDIT_PRICE_CENTS),
        apiId: usage._id,
        apiName: api?.name,
      });
    }

    // Deduct free-tier allowance
    const billableCredits = Math.max(0, totalCredits - plan.credits);
    const subtotal = Math.round(billableCredits * CREDIT_PRICE_CENTS) + plan.pricePerMonth;
    const taxAmount = Math.round(subtotal * workspace.taxRate / 100);

    const invoice = await Invoice.create({
      workspaceId,
      type: 'monthly',
      period: { start, end },
      lineItems,
      subtotal,
      taxRate: workspace.taxRate,
      taxAmount,
      total: subtotal + taxAmount,
      currency: workspace.currency,
      status: 'open',
      dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });

    // Queue PDF generation (async)
    return invoice;
  }

  async listInvoices(workspaceId: string, query: Record<string, unknown> = {}) {
    const { page, limit } = parsePagination(query);
    const filter: Record<string, unknown> = { workspaceId };
    if (query.status) filter.status = query.status;

    const [data, total] = await Promise.all([
      Invoice.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Invoice.countDocuments(filter),
    ]);

    return buildPaginationResult(data, total, { page, limit });
  }

  async getInvoice(workspaceId: string, invoiceId: string): Promise<IInvoice> {
    const invoice = await Invoice.findOne({ _id: invoiceId, workspaceId });
    if (!invoice) throw createError('Invoice not found', 404);
    return invoice;
  }

  async generatePdf(invoice: IInvoice): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.fontSize(24).fillColor('#6366f1').text('MeterFlow', 50, 50);
      doc.fontSize(10).fillColor('#6b7280').text('Usage-Based API Billing', 50, 80);

      doc.moveTo(50, 100).lineTo(545, 100).strokeColor('#e5e7eb').stroke();

      // Invoice meta
      doc.fontSize(20).fillColor('#111827').text('INVOICE', 350, 50);
      doc.fontSize(10).fillColor('#374151');
      doc.text(`Invoice #: ${invoice.invoiceNumber}`, 350, 80);
      doc.text(`Date: ${invoice.createdAt.toLocaleDateString()}`, 350, 95);
      doc.text(`Status: ${invoice.status.toUpperCase()}`, 350, 110);

      // Period
      doc.fontSize(11).fillColor('#111827').text('Billing Period', 50, 120);
      doc.fontSize(10).fillColor('#6b7280');
      doc.text(
        `${invoice.period.start.toLocaleDateString()} – ${invoice.period.end.toLocaleDateString()}`,
        50, 135
      );

      // Line items
      let y = 180;
      doc.fontSize(11).fillColor('#111827').text('Description', 50, y);
      doc.text('Qty', 300, y);
      doc.text('Unit Price', 370, y);
      doc.text('Amount', 470, y);
      doc.moveTo(50, y + 15).lineTo(545, y + 15).strokeColor('#e5e7eb').stroke();
      y += 25;

      for (const item of invoice.lineItems) {
        doc.fontSize(10).fillColor('#374151');
        doc.text(item.description, 50, y, { width: 240 });
        doc.text(item.quantity.toLocaleString(), 300, y);
        doc.text(`$${(item.unitPrice / 100).toFixed(4)}`, 370, y);
        doc.text(`$${(item.amount / 100).toFixed(2)}`, 470, y);
        y += 20;
      }

      doc.moveTo(50, y + 5).lineTo(545, y + 5).strokeColor('#e5e7eb').stroke();
      y += 20;

      // Totals
      doc.fontSize(10).fillColor('#374151');
      doc.text('Subtotal', 370, y); doc.text(`$${(invoice.subtotal / 100).toFixed(2)}`, 470, y); y += 18;
      if (invoice.taxRate > 0) {
        doc.text(`Tax (${invoice.taxRate}%)`, 370, y);
        doc.text(`$${(invoice.taxAmount / 100).toFixed(2)}`, 470, y); y += 18;
      }
      doc.fontSize(12).fillColor('#111827').font('Helvetica-Bold');
      doc.text('Total', 370, y); doc.text(`$${(invoice.total / 100).toFixed(2)}`, 470, y);

      // Footer
      doc.fontSize(9).fillColor('#9ca3af').font('Helvetica');
      doc.text('Generated by MeterFlow · meterflow.dev', 50, 750, { align: 'center' });

      doc.end();
    });
  }

  private async createZeroInvoice(workspaceId: string, start: Date, end: Date): Promise<IInvoice> {
    return Invoice.create({
      workspaceId,
      type: 'monthly',
      period: { start, end },
      lineItems: [{ description: 'No billable usage this period', quantity: 0, unitPrice: 0, amount: 0 }],
      subtotal: 0, taxAmount: 0, total: 0,
      currency: 'USD',
      status: 'paid',
      paidAt: new Date(),
    });
  }
}

function getPreviousMonthRange(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));
  return { start, end };
}

export const billingService = new BillingService();
