import mongoose from 'mongoose';
import { ApiKey, IApiKey } from './key.model';
import { RegisteredApi } from '../apis/api.model';
import { generateApiKey, hashApiKey } from '../../utils/crypto';
import { redis } from '../../config/redis';
import { createError } from '../../middleware/errorHandler';
import { parsePagination, buildPaginationResult } from '../../utils/paginate';
import { webhookQueue } from '../../queues/queues';

export interface GenerateKeyDto {
  apiId: string;
  label?: string;
  environment?: 'sandbox' | 'production';
  quota?: number;
  rateLimit?: number;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export class KeyService {
  async generate(workspaceId: string, userId: string, dto: GenerateKeyDto): Promise<{
    key: IApiKey;
    rawKey: string;
  }> {
    // Verify API belongs to workspace
    const api = await RegisteredApi.findOne({ _id: dto.apiId, workspaceId, status: 'active' });
    if (!api) throw createError('API not found', 404);

    const { rawKey, keyHash, keyPrefix } = generateApiKey(dto.environment || 'production');

    const key = await ApiKey.create({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      apiId: new mongoose.Types.ObjectId(dto.apiId),
      keyHash,
      keyPrefix,
      label: dto.label || 'Default Key',
      environment: dto.environment || 'production',
      quota: dto.quota ?? -1,
      rateLimit: dto.rateLimit ?? 0,
      expiresAt: dto.expiresAt,
      metadata: dto.metadata || {},
      createdBy: new mongoose.Types.ObjectId(userId),
    });

    // Fire webhook
    await webhookQueue.add('deliverWebhook', {
      workspaceId,
      event: 'key.created',
      payload: { keyId: key._id, label: key.label, environment: key.environment },
    });

    return { key, rawKey }; // rawKey shown ONCE — never stored
  }

  async list(
    workspaceId: string,
    apiId?: string,
    query: Record<string, unknown> = {}
  ) {
    const { page, limit } = parsePagination(query);
    const filter: Record<string, unknown> = { workspaceId };
    if (apiId) filter.apiId = apiId;
    if (query.status) filter.status = query.status;
    if (query.environment) filter.environment = query.environment;

    const [data, total] = await Promise.all([
      ApiKey.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('-keyHash'), // never expose hash
      ApiKey.countDocuments(filter),
    ]);

    return buildPaginationResult(data, total, { page, limit });
  }

  async getById(workspaceId: string, keyId: string): Promise<IApiKey> {
    const key = await ApiKey.findOne({ _id: keyId, workspaceId }).select('-keyHash');
    if (!key) throw createError('Key not found', 404);
    return key;
  }

  async revoke(workspaceId: string, keyId: string, revokedBy: string): Promise<void> {
    const key = await ApiKey.findOneAndUpdate(
      { _id: keyId, workspaceId, status: 'active' },
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy } },
      { new: true }
    );
    if (!key) throw createError('Key not found or already revoked', 404);

    // Immediately invalidate Redis cache for this key
    await redis.del(`key:${key.keyHash}`);

    await webhookQueue.add('deliverWebhook', {
      workspaceId,
      event: 'key.revoked',
      payload: { keyId: key._id, label: key.label },
    });
  }

  async rotate(workspaceId: string, keyId: string, userId: string): Promise<{
    key: IApiKey;
    rawKey: string;
  }> {
    const oldKey = await ApiKey.findOne({ _id: keyId, workspaceId, status: 'active' });
    if (!oldKey) throw createError('Key not found or inactive', 404);

    // Issue new key with same config
    const { rawKey, keyHash, keyPrefix } = generateApiKey(oldKey.environment);
    const newKey = await ApiKey.create({
      workspaceId: oldKey.workspaceId,
      apiId: oldKey.apiId,
      keyHash,
      keyPrefix,
      label: `${oldKey.label} (rotated)`,
      environment: oldKey.environment,
      quota: oldKey.quota,
      rateLimit: oldKey.rateLimit,
      expiresAt: oldKey.expiresAt,
      metadata: oldKey.metadata,
      rotatedFromId: oldKey._id,
      createdBy: new mongoose.Types.ObjectId(userId),
    });

    // Revoke old key
    await this.revoke(workspaceId, keyId, userId);

    return { key: newKey, rawKey };
  }

  async setExpiry(workspaceId: string, keyId: string, expiresAt: Date): Promise<IApiKey> {
    const key = await ApiKey.findOneAndUpdate(
      { _id: keyId, workspaceId, status: 'active' },
      { $set: { expiresAt } },
      { new: true }
    );
    if (!key) throw createError('Key not found', 404);

    // Bust cache
    const fullKey = await ApiKey.findById(keyId).select('keyHash');
    if (fullKey) await redis.del(`key:${fullKey.keyHash}`);

    return key;
  }

  /**
   * Called by gateway middleware. Uses Redis cache for hot path.
   */
  async resolveByHash(keyHash: string): Promise<IApiKey | null> {
    const cacheKey = `key:${keyHash}`;
    const cached = await redis.get(cacheKey);

    if (cached) return JSON.parse(cached) as IApiKey;

    const key = await ApiKey.findOne({ keyHash }).lean();
    if (key) {
      await redis.set(cacheKey, JSON.stringify(key), 300); // 5 min TTL
    }

    return key as unknown as IApiKey | null;
  }

  async invalidateCache(keyHash: string): Promise<void> {
    await redis.del(`key:${keyHash}`);
  }

  /**
   * Find keys expiring in the next N days (for alerts).
   */
  async findExpiringSoon(days = 7): Promise<IApiKey[]> {
    const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return ApiKey.find({
      status: 'active',
      expiresAt: { $lte: cutoff, $gt: new Date() },
    }).select('-keyHash');
  }
}

export const keyService = new KeyService();
