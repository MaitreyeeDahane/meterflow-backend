import mongoose, { Document, Schema, Model } from 'mongoose';

export type PlanType = 'free' | 'starter' | 'pro' | 'enterprise';
export type WorkspaceMemberRole = 'owner' | 'admin' | 'developer' | 'billing' | 'viewer';

export interface IWorkspaceMember {
  userId: mongoose.Types.ObjectId;
  role: WorkspaceMemberRole;
  invitedAt: Date;
  acceptedAt?: Date;
}

export interface IWorkspace extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  ownerId: mongoose.Types.ObjectId;
  members: IWorkspaceMember[];
  plan: PlanType;
  credits: number;           // current credit balance
  creditAllowance: number;   // monthly plan allowance
  billingEmail?: string;
  taxId?: string;
  currency: string;
  taxRate: number;
  stripeCustomerId?: string;
  activeCoupon?: string;
  status: 'active' | 'suspended' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
}

const workspaceMemberSchema = new Schema<IWorkspaceMember>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: {
      type: String,
      enum: ['owner', 'admin', 'developer', 'billing', 'viewer'],
      required: true,
    },
    invitedAt: { type: Date, default: Date.now },
    acceptedAt: Date,
  },
  { _id: false }
);

const workspaceSchema = new Schema<IWorkspace>(
  {
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9-]+$/,
    },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    members: [workspaceMemberSchema],
    plan: {
      type: String,
      enum: ['free', 'starter', 'pro', 'enterprise'],
      default: 'free',
    },
    credits: { type: Number, default: 1000, min: 0 },
    creditAllowance: { type: Number, default: 1000 },
    billingEmail: String,
    taxId: String,
    currency: { type: String, default: 'USD' },
    taxRate: { type: Number, default: 0 },
    stripeCustomerId: String,
    activeCoupon: String,
    status: {
      type: String,
      enum: ['active', 'suspended', 'cancelled'],
      default: 'active',
    },
  },
  { timestamps: true }
);

// Indexes
workspaceSchema.index({ slug: 1 }, { unique: true });
workspaceSchema.index({ ownerId: 1 });
workspaceSchema.index({ 'members.userId': 1 });

export const Workspace: Model<IWorkspace> =
  mongoose.models.Workspace || mongoose.model<IWorkspace>('Workspace', workspaceSchema);
