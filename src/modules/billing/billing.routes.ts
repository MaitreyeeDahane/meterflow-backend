import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { requireAdmin } from '../../middleware/authenticate';
import { billingService } from './billing.service';
import { couponService } from './coupon.service';
import { sendSuccess, sendPaginated } from '../../utils/paginate';
import { auditService } from '../audit/audit.service';
import { hashString } from '../../utils/crypto';

function ipStr(req: Request): string {
  const raw = req.ip || req.socket?.remoteAddress || '';
  return Array.isArray(raw) ? (raw as string[])[0] : raw as string;
}

export const billingRouter = Router();
billingRouter.use(authenticate);

billingRouter.get('/wallet', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await billingService.getWallet(req.workspaceId!);
    sendSuccess(res, data);
  } catch (err) { next(err); }
});

billingRouter.post('/topup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { credits } = z.object({ credits: z.number().int().min(100) }).parse(req.body);
    const result = await billingService.topUp(req.workspaceId!, credits);
    await auditService.log({
      workspaceId: req.workspaceId,
      actorId: req.user!.sub,
      actorEmail: req.user!.email,
      action: 'billing.topup',
      resource: 'Invoice',
      resourceId: result.invoice._id.toString(),
      delta: { credits, newBalance: result.newBalance },
      ipHash: hashString(ipStr(req)),
    });
    sendSuccess(res, result, 201);
  } catch (err) { next(err); }
});

billingRouter.get('/invoices', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await billingService.listInvoices(req.workspaceId!, req.query as Record<string, unknown>);
    sendPaginated(res, result);
  } catch (err) { next(err); }
});

billingRouter.get('/invoices/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invoice = await billingService.getInvoice(req.workspaceId!, req.params.id);
    sendSuccess(res, invoice);
  } catch (err) { next(err); }
});

billingRouter.get('/invoices/:id/pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invoice = await billingService.getInvoice(req.workspaceId!, req.params.id);
    const pdfBuffer = await billingService.generatePdf(invoice);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoiceNumber}.pdf"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.send(pdfBuffer);
  } catch (err) { next(err); }
});

// ── Coupon endpoints ─────────────────────────────────────────────────
billingRouter.post('/coupons/validate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = z.object({ code: z.string().min(1) }).parse(req.body);
    const coupon = await couponService.validate(code);
    sendSuccess(res, {
      code: coupon.code,
      description: coupon.description,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      validUntil: coupon.validUntil,
    });
  } catch (err) { next(err); }
});

// Admin-only: create / list / deactivate coupons
billingRouter.post('/coupons', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      code: z.string().min(3).max(32),
      description: z.string().optional(),
      discountType: z.enum(['percent', 'fixed_credits', 'fixed_amount']),
      discountValue: z.number().positive(),
      maxUses: z.number().int().optional(),
      validFrom: z.string().datetime().optional().transform(v => v ? new Date(v) : undefined),
      validUntil: z.string().datetime().optional().transform(v => v ? new Date(v) : undefined),
    });
    const dto = schema.parse(req.body);
    const coupon = await couponService.create(dto);
    sendSuccess(res, coupon, 201);
  } catch (err) { next(err); }
});

billingRouter.get('/coupons', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const coupons = await couponService.list();
    sendSuccess(res, coupons);
  } catch (err) { next(err); }
});

billingRouter.delete('/coupons/:code', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await couponService.deactivate(req.params.code);
    sendSuccess(res, { message: 'Coupon deactivated' });
  } catch (err) { next(err); }
});
