import mongoose, { Document, Schema, Model } from 'mongoose';

export type ApiMode = 'proxy' | 'wrapper';
export type ApiStatus = 'active' | 'archived';

export interface IWrapperField {
  source: string;    // dot-notation path in upstream response
  target: string;    // field name in transformed response
}

export interface IWrapperConfig {
  sourceRoute: string;              // upstream path template e.g. /pokemon/:name
  responseFields: IWrapperField[];  // field mappings
  metadata?: Record<string, unknown>;
  composeWith?: string[];           // other API IDs to compose
}

export interface IUpstreamHeader {
  key: string;
  value: string;  // encrypted with AES-256-GCM
}

export interface IRegisteredApi extends Document {
  _id: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  baseUrl: string;
  aliasRoute: string;          // e.g. "pokemon" → /gateway/pokemon/*
  mode: ApiMode;
  status: ApiStatus;
  pricingPerRequest: number;   // credits deducted per request
  rateLimitPerMin: number;     // per-API rate limit cap
  cacheTTL: number;            // seconds, 0 = no cache
  upstreamHeaders: IUpstreamHeader[];   // encrypted upstream auth headers
  wrapperConfig?: IWrapperConfig;
  tags: string[];
  totalRequests: number;       // denormalized counter
  totalCreditsConsumed: number;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const wrapperFieldSchema = new Schema<IWrapperField>({ source: String, target: String }, { _id: false });

const wrapperConfigSchema = new Schema<IWrapperConfig>(
  {
    sourceRoute: String,
    responseFields: [wrapperFieldSchema],
    metadata: Schema.Types.Mixed,
    composeWith: [String],
  },
  { _id: false }
);

const upstreamHeaderSchema = new Schema<IUpstreamHeader>(
  { key: String, value: String },
  { _id: false }
);

const registeredApiSchema = new Schema<IRegisteredApi>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: String,
    baseUrl: { type: String, required: true },
    aliasRoute: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: /^[a-z0-9-_]+$/,
    },
    mode: { type: String, enum: ['proxy', 'wrapper'], default: 'proxy' },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    pricingPerRequest: { type: Number, required: true, min: 0, default: 1 },
    rateLimitPerMin: { type: Number, required: true, min: 1, default: 60 },
    cacheTTL: { type: Number, default: 0, min: 0 },
    upstreamHeaders: [upstreamHeaderSchema],
    wrapperConfig: wrapperConfigSchema,
    tags: [String],
    totalRequests: { type: Number, default: 0 },
    totalCreditsConsumed: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

registeredApiSchema.index({ workspaceId: 1, aliasRoute: 1 }, { unique: true });
registeredApiSchema.index({ workspaceId: 1, status: 1 });

export const RegisteredApi: Model<IRegisteredApi> =
  mongoose.models.RegisteredApi ||
  mongoose.model<IRegisteredApi>('RegisteredApi', registeredApiSchema);
