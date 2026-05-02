import mongoose, { Document, Schema, Model } from 'mongoose';

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
export type InvoiceType = 'monthly' | 'topup' | 'manual';

export interface ILineItem {
  description: string;
  quantity: number;
  unitPrice: number;  // in cents
  amount: number;     // quantity * unitPrice
  apiId?: mongoose.Types.ObjectId;
  apiName?: string;
}

export interface IInvoice extends Document {
  _id: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  invoiceNumber: string;
  type: InvoiceType;
  period: { start: Date; end: Date };
  lineItems: ILineItem[];
  subtotal: number;        // in cents
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  total: number;           // in cents
  currency: string;
  status: InvoiceStatus;
  couponCode?: string;
  couponDiscount?: number;
  pdfUrl?: string;
  stripeInvoiceId?: string;
  stripePaymentIntentId?: string;
  paidAt?: Date;
  dueDate?: Date;
  notes?: string;
  creditsAdded?: number;  // for topup invoices
  createdAt: Date;
  updatedAt: Date;
}

const lineItemSchema = new Schema<ILineItem>(
  {
    description: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    amount: { type: Number, required: true },
    apiId: { type: Schema.Types.ObjectId, ref: 'RegisteredApi' },
    apiName: String,
  },
  { _id: false }
);

const invoiceSchema = new Schema<IInvoice>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    invoiceNumber: { type: String, required: true, unique: true },
    type: { type: String, enum: ['monthly', 'topup', 'manual'], default: 'monthly' },
    period: {
      start: { type: Date, required: true },
      end: { type: Date, required: true },
    },
    lineItems: [lineItemSchema],
    subtotal: { type: Number, required: true, default: 0 },
    discountAmount: { type: Number, default: 0 },
    taxRate: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    total: { type: Number, required: true, default: 0 },
    currency: { type: String, default: 'USD' },
    status: {
      type: String,
      enum: ['draft', 'open', 'paid', 'void', 'uncollectible'],
      default: 'draft',
      index: true,
    },
    couponCode: String,
    couponDiscount: Number,
    pdfUrl: String,
    stripeInvoiceId: String,
    stripePaymentIntentId: String,
    paidAt: Date,
    dueDate: Date,
    notes: String,
    creditsAdded: Number,
  },
  { timestamps: true }
);

invoiceSchema.index({ workspaceId: 1, createdAt: -1 });
invoiceSchema.index({ status: 1, dueDate: 1 });

// Auto-generate invoice number: INV-{year}-{sequential}
invoiceSchema.pre('validate', async function (next) {
  if (!this.invoiceNumber) {
    const InvoiceModel = mongoose.model('Invoice');
    const count = await InvoiceModel.countDocuments();
    const year = new Date().getFullYear();
    this.invoiceNumber = `INV-${year}-${String(count + 1).padStart(6, '0')}`;
  }
  next();
});

export const Invoice: Model<IInvoice> =
  mongoose.models.Invoice || mongoose.model<IInvoice>('Invoice', invoiceSchema);
