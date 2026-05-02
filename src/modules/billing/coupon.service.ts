import mongoose, { Document, Schema, Model } from 'mongoose';
import { createError } from '../../middleware/errorHandler';

// ── Coupon Model ──────────────────────────────────────────────────────

export type DiscountType = 'percent' | 'fixed_credits' | 'fixed_amount';

export interface ICoupon extends Document {
  _id: mongoose.Types.ObjectId;
  code: string;
  description: string;
  discountType: DiscountType;
  discountValue: number;    // percent (0–100) or fixed credits/cents
  maxUses: number;          // -1 = unlimited
  usedCount: number;
  validFrom: Date;
  validUntil?: Date;
  active: boolean;
  createdAt: Date;
}

const couponSchema = new Schema<ICoupon>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: String,
    discountType: { type: String, enum: ['percent', 'fixed_credits', 'fixed_amount'], required: true },
    discountValue: { type: Number, required: true, min: 0 },
    maxUses: { type: Number, default: -1 },
    usedCount: { type: Number, default: 0 },
    validFrom: { type: Date, default: Date.now },
    validUntil: Date,
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Coupon: Model<ICoupon> =
  mongoose.models.Coupon || mongoose.model<ICoupon>('Coupon', couponSchema);

// ── Coupon Service ────────────────────────────────────────────────────

export class CouponService {
  async validate(code: string): Promise<ICoupon> {
    const coupon = await Coupon.findOne({ code: code.toUpperCase().trim() });
    if (!coupon) throw createError('Invalid coupon code', 404);
    if (!coupon.active) throw createError('Coupon is no longer active', 400);
    if (coupon.validUntil && coupon.validUntil < new Date()) throw createError('Coupon has expired', 400);
    if (coupon.validFrom > new Date()) throw createError('Coupon is not yet valid', 400);
    if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses) throw createError('Coupon usage limit reached', 400);
    return coupon;
  }

  /**
   * Returns the discount amount in the same unit as the invoice total (cents).
   */
  applyToInvoice(coupon: ICoupon, subtotalCents: number): number {
    switch (coupon.discountType) {
      case 'percent':
        return Math.round(subtotalCents * (coupon.discountValue / 100));
      case 'fixed_amount':
        return Math.min(coupon.discountValue, subtotalCents); // in cents
      case 'fixed_credits':
        // credits → $0.001 each → cents
        return Math.min(Math.round(coupon.discountValue * 0.1), subtotalCents);
      default:
        return 0;
    }
  }

  async markUsed(code: string): Promise<void> {
    await Coupon.updateOne({ code: code.toUpperCase() }, { $inc: { usedCount: 1 } });
  }

  async create(data: {
    code: string;
    description?: string;
    discountType: DiscountType;
    discountValue: number;
    maxUses?: number;
    validFrom?: Date;
    validUntil?: Date;
  }): Promise<ICoupon> {
    return Coupon.create(data);
  }

  async list() {
    return Coupon.find().sort({ createdAt: -1 });
  }

  async deactivate(code: string): Promise<void> {
    await Coupon.updateOne({ code: code.toUpperCase() }, { $set: { active: false } });
  }
}

export const couponService = new CouponService();
