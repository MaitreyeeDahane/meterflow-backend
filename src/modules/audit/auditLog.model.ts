import mongoose, { Document, Schema, Model } from 'mongoose';

export type AuditAction =
  | 'user.signup' | 'user.login' | 'user.logout' | 'user.password_changed'
  | 'api.created' | 'api.updated' | 'api.archived'
  | 'key.created' | 'key.revoked' | 'key.rotated' | 'key.expired'
  | 'billing.topup' | 'billing.plan_changed' | 'invoice.created' | 'invoice.paid'
  | 'workspace.member_invited' | 'workspace.member_removed' | 'workspace.settings_changed'
  | 'alert.created' | 'alert.deleted' | 'alert.triggered'
  | 'webhook.created' | 'webhook.deleted'
  | 'admin.workspace_suspended' | 'admin.abuse_resolved';

export interface IAuditLog extends Document {
  _id: mongoose.Types.ObjectId;
  workspaceId?: mongoose.Types.ObjectId;
  actorId: mongoose.Types.ObjectId;
  actorEmail: string;
  action: AuditAction;
  resource: string;      // e.g. "ApiKey", "Invoice"
  resourceId?: string;
  delta?: Record<string, unknown>;  // before/after for updates
  ipHash: string;
  userAgent?: string;
  timestamp: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', index: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorEmail: { type: String, required: true },
    action: { type: String, required: true },
    resource: { type: String, required: true },
    resourceId: String,
    delta: Schema.Types.Mixed,
    ipHash: { type: String, required: true },
    userAgent: String,
    timestamp: { type: Date, default: Date.now, index: true },
  },
  {
    // NO timestamps: true, NO update operations — append-only
    versionKey: false,
  }
);

auditLogSchema.index({ workspaceId: 1, timestamp: -1 });
auditLogSchema.index({ actorId: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });

export const AuditLog: Model<IAuditLog> =
  mongoose.models.AuditLog || mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
