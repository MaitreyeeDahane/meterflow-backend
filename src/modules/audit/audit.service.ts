import { AuditLog, AuditAction } from './auditLog.model';
import { parsePagination, buildPaginationResult } from '../../utils/paginate';

export interface LogAuditDto {
  workspaceId?: string;
  actorId: string;
  actorEmail: string;
  action: AuditAction;
  resource: string;
  resourceId?: string;
  delta?: Record<string, unknown>;
  ipHash: string;
  userAgent?: string;
}

export class AuditService {
  /** Append-only: never update or delete audit logs */
  async log(dto: LogAuditDto): Promise<void> {
    try {
      await AuditLog.create(dto);
    } catch (err) {
      // Audit log failures must never break the main flow
      console.error('Audit log write failed:', err);
    }
  }

  async list(workspaceId: string, query: Record<string, unknown> = {}) {
    const { page, limit } = parsePagination(query);
    const filter: Record<string, unknown> = { workspaceId };

    if (query.action) filter.action = query.action;
    if (query.actorId) filter.actorId = query.actorId;
    if (query.resource) filter.resource = query.resource;
    if (query.from || query.to) {
      filter.timestamp = {};
      if (query.from) (filter.timestamp as Record<string, unknown>).$gte = new Date(String(query.from));
      if (query.to) (filter.timestamp as Record<string, unknown>).$lte = new Date(String(query.to));
    }

    const [data, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      AuditLog.countDocuments(filter),
    ]);

    return buildPaginationResult(data, total, { page, limit });
  }

  async listPlatform(query: Record<string, unknown> = {}) {
    const { page, limit } = parsePagination(query);
    const filter: Record<string, unknown> = {};
    if (query.action) filter.action = query.action;

    const [data, total] = await Promise.all([
      AuditLog.find(filter).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit),
      AuditLog.countDocuments(filter),
    ]);

    return buildPaginationResult(data, total, { page, limit });
  }
}

export const auditService = new AuditService();
