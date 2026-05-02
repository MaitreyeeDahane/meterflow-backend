import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IUsageLog extends Document {
  _id: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  apiId: mongoose.Types.ObjectId;
  apiKeyId: mongoose.Types.ObjectId;
  aliasRoute: string;
  method: string;
  upstreamPath: string;
  statusCode: number;
  latencyMs: number;
  creditsDeducted: number;
  cacheHit: boolean;
  ipHash: string;
  geoCountry?: string;
  geoCity?: string;
  userAgent?: string;
  requestId: string;
  error?: string;
  timestamp: Date;
}

const usageLogSchema = new Schema<IUsageLog>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
    apiId: { type: Schema.Types.ObjectId, ref: 'RegisteredApi', required: true },
    apiKeyId: { type: Schema.Types.ObjectId, ref: 'ApiKey', required: true },
    aliasRoute: { type: String, required: true },
    method: { type: String, required: true, uppercase: true },
    upstreamPath: { type: String, required: true },
    statusCode: { type: Number, required: true },
    latencyMs: { type: Number, required: true },
    creditsDeducted: { type: Number, default: 0 },
    cacheHit: { type: Boolean, default: false },
    ipHash: { type: String, required: true },
    geoCountry: String,
    geoCity: String,
    userAgent: String,
    requestId: { type: String, required: true },
    error: String,
    timestamp: { type: Date, default: Date.now },
  },
  {
    // No timestamps: true — we use custom `timestamp` field for precision
    versionKey: false,
  }
);

// Critical compound indexes for analytics queries
usageLogSchema.index({ workspaceId: 1, timestamp: -1 });
usageLogSchema.index({ apiKeyId: 1, timestamp: -1 });
usageLogSchema.index({ apiId: 1, timestamp: -1 });
usageLogSchema.index({ workspaceId: 1, apiId: 1, timestamp: -1 });
usageLogSchema.index({ workspaceId: 1, statusCode: 1, timestamp: -1 });
usageLogSchema.index({ geoCountry: 1, workspaceId: 1 });

// TTL index — raw logs expire after 90 days; aggregations persist forever
usageLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const UsageLog: Model<IUsageLog> =
  mongoose.models.UsageLog || mongoose.model<IUsageLog>('UsageLog', usageLogSchema);
