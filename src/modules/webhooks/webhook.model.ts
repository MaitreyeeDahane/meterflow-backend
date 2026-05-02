import mongoose, { Document, Schema, Model } from 'mongoose';

export type WebhookEvent =
  | 'key.created' | 'key.revoked' | 'key.expired'
  | 'quota.exceeded' | 'credits.low'
  | 'invoice.created' | 'invoice.paid'
  | 'abuse.detected'
  | 'api.created' | 'api.archived'
  | 'alert.triggered';

export interface IDeliveryAttempt {
  attemptedAt: Date;
  statusCode?: number;
  responseBody?: string;
  error?: string;
  success: boolean;
  durationMs: number;
}

export interface IWebhookDelivery {
  _id: mongoose.Types.ObjectId;
  event: WebhookEvent;
  payload: Record<string, unknown>;
  attempts: IDeliveryAttempt[];
  status: 'pending' | 'delivered' | 'failed';
  nextRetryAt?: Date;
  createdAt: Date;
}

export interface IWebhook extends Document {
  _id: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  url: string;
  secret: string;         // used for HMAC-SHA256 signing
  events: WebhookEvent[];
  status: 'active' | 'disabled' | 'failing';
  failureCount: number;
  lastDeliveredAt?: Date;
  deliveries: IWebhookDelivery[];
  createdAt: Date;
  updatedAt: Date;
}

const deliveryAttemptSchema = new Schema<IDeliveryAttempt>(
  {
    attemptedAt: { type: Date, default: Date.now },
    statusCode: Number,
    responseBody: String,
    error: String,
    success: { type: Boolean, required: true },
    durationMs: Number,
  },
  { _id: false }
);

const webhookDeliverySchema = new Schema<IWebhookDelivery>({
  event: { type: String, required: true },
  payload: Schema.Types.Mixed,
  attempts: [deliveryAttemptSchema],
  status: { type: String, enum: ['pending', 'delivered', 'failed'], default: 'pending' },
  nextRetryAt: Date,
  createdAt: { type: Date, default: Date.now },
});

const webhookSchema = new Schema<IWebhook>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    url: { type: String, required: true },
    secret: { type: String, required: true },
    events: [{ type: String }],
    status: { type: String, enum: ['active', 'disabled', 'failing'], default: 'active' },
    failureCount: { type: Number, default: 0 },
    lastDeliveredAt: Date,
    deliveries: { type: [webhookDeliverySchema], default: [] },
  },
  { timestamps: true }
);

export const Webhook: Model<IWebhook> =
  mongoose.models.Webhook || mongoose.model<IWebhook>('Webhook', webhookSchema);
