import mongoose, { Document, Schema, Model } from 'mongoose';

export type KeyEnvironment = 'sandbox' | 'production';
export type KeyStatus = 'active' | 'revoked' | 'expired';

export interface IApiKey extends Document {
  _id: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  apiId: mongoose.Types.ObjectId;
  keyHash: string;        // SHA-256 of the raw key — never store raw
  keyPrefix: string;      // First 12 chars for display: "mf_live_xxxx"
  label: string;
  environment: KeyEnvironment;
  status: KeyStatus;
  quota: number;          // monthly request limit, -1 = unlimited
  quotaUsed: number;      // current month usage
  quotaResetAt: Date;
  rateLimit: number;      // override per-minute rate limit (0 = use API default)
  scopes: string[];       // future: fine-grained scopes
  expiresAt?: Date;
  revokedAt?: Date;
  revokedBy?: mongoose.Types.ObjectId;
  rotatedFromId?: mongoose.Types.ObjectId; // previous key ID if rotated
  lastUsedAt?: Date;
  totalRequests: number;
  totalCreditsConsumed: number;
  metadata: Record<string, unknown>;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const apiKeySchema = new Schema<IApiKey>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    apiId: { type: Schema.Types.ObjectId, ref: 'RegisteredApi', required: true },
    keyHash: { type: String, required: true, unique: true },
    keyPrefix: { type: String, required: true },
    label: { type: String, default: 'Default Key', trim: true },
    environment: { type: String, enum: ['sandbox', 'production'], default: 'production' },
    status: { type: String, enum: ['active', 'revoked', 'expired'], default: 'active', index: true },
    quota: { type: Number, default: -1 },   // -1 = unlimited
    quotaUsed: { type: Number, default: 0 },
    quotaResetAt: { type: Date, default: () => getMonthEnd() },
    rateLimit: { type: Number, default: 0 },
    scopes: [String],
    expiresAt: Date,
    revokedAt: Date,
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    rotatedFromId: { type: Schema.Types.ObjectId, ref: 'ApiKey' },
    lastUsedAt: Date,
    totalRequests: { type: Number, default: 0 },
    totalCreditsConsumed: { type: Number, default: 0 },
    metadata: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

function getMonthEnd(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

apiKeySchema.index({ keyHash: 1 }, { unique: true });
apiKeySchema.index({ workspaceId: 1, status: 1 });
apiKeySchema.index({ apiId: 1, status: 1 });
apiKeySchema.index({ workspaceId: 1, apiId: 1 });

export const ApiKey: Model<IApiKey> =
  mongoose.models.ApiKey || mongoose.model<IApiKey>('ApiKey', apiKeySchema);
