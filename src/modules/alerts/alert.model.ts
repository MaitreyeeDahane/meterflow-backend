import mongoose, { Document, Schema, Model } from 'mongoose';

export type AlertType =
  | 'credits_low'
  | 'quota_nearing'
  | 'traffic_spike'
  | 'repeated_failures'
  | 'key_expiring'
  | 'abuse_detected'
  | 'latency_high'
  | 'error_rate_high';

export type AlertChannel = 'email' | 'webhook' | 'slack';

export interface IAlertHistory {
  triggeredAt: Date;
  value: number;
  message: string;
  resolved: boolean;
}

export interface IAlert extends Document {
  _id: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  type: AlertType;
  threshold: number;      // e.g. 20 for "20% credits remaining"
  channels: AlertChannel[];
  webhookUrl?: string;
  slackWebhookUrl?: string;
  enabled: boolean;
  cooldownMinutes: number; // min minutes between repeated triggers
  apiId?: mongoose.Types.ObjectId;  // optional: scope to specific API
  keyId?: mongoose.Types.ObjectId;  // optional: scope to specific key
  lastTriggeredAt?: Date;
  history: IAlertHistory[];
  createdAt: Date;
  updatedAt: Date;
}

const alertHistorySchema = new Schema<IAlertHistory>(
  {
    triggeredAt: { type: Date, default: Date.now },
    value: Number,
    message: String,
    resolved: { type: Boolean, default: false },
  },
  { _id: false }
);

const alertSchema = new Schema<IAlert>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: [
        'credits_low', 'quota_nearing', 'traffic_spike',
        'repeated_failures', 'key_expiring', 'abuse_detected',
        'latency_high', 'error_rate_high',
      ],
      required: true,
    },
    threshold: { type: Number, required: true },
    channels: [{ type: String, enum: ['email', 'webhook', 'slack'] }],
    webhookUrl: String,
    slackWebhookUrl: String,
    enabled: { type: Boolean, default: true },
    cooldownMinutes: { type: Number, default: 60 },
    apiId: { type: Schema.Types.ObjectId, ref: 'RegisteredApi' },
    keyId: { type: Schema.Types.ObjectId, ref: 'ApiKey' },
    lastTriggeredAt: Date,
    history: { type: [alertHistorySchema], default: [] },
  },
  { timestamps: true }
);

export const Alert: Model<IAlert> =
  mongoose.models.Alert || mongoose.model<IAlert>('Alert', alertSchema);
