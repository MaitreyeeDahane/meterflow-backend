import { RegisteredApi, IRegisteredApi } from './api.model';
import { encrypt, decrypt } from '../../utils/crypto';
import { createError } from '../../middleware/errorHandler';
import { parsePagination, buildPaginationResult } from '../../utils/paginate';
import mongoose from 'mongoose';

export interface CreateApiDto {
  name: string;
  description?: string;
  baseUrl: string;
  aliasRoute: string;
  mode: 'proxy' | 'wrapper';
  pricingPerRequest: number;
  rateLimitPerMin: number;
  cacheTTL: number;
  tags?: string[];
  upstreamHeaders?: { key: string; value: string }[];
  wrapperConfig?: IRegisteredApi['wrapperConfig'];
}

export class ApiService {
  async create(workspaceId: string, userId: string, dto: CreateApiDto): Promise<IRegisteredApi> {
    // Check alias uniqueness within workspace
    const existing = await RegisteredApi.findOne({
      workspaceId,
      aliasRoute: dto.aliasRoute,
    });
    if (existing) throw createError('An API with this alias route already exists', 409);

    const upstreamHeaders = (dto.upstreamHeaders || []).map((h) => ({
      key: h.key,
      value: encrypt(h.value),  // encrypt upstream credentials
    }));

    const api = await RegisteredApi.create({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      createdBy: new mongoose.Types.ObjectId(userId),
      ...dto,
      upstreamHeaders,
    });

    return api;
  }

  async list(
    workspaceId: string,
    query: Record<string, unknown>
  ): Promise<ReturnType<typeof buildPaginationResult<IRegisteredApi>>> {
    const { page, limit } = parsePagination(query);
    const filter: Record<string, unknown> = { workspaceId, status: 'active' };
    if (query.tag) filter.tags = query.tag;
    if (query.mode) filter.mode = query.mode;

    const [data, total] = await Promise.all([
      RegisteredApi.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('-upstreamHeaders'), // never expose headers in list
      RegisteredApi.countDocuments(filter),
    ]);

    return buildPaginationResult(data, total, { page, limit });
  }

  async getById(workspaceId: string, apiId: string): Promise<IRegisteredApi> {
    const api = await RegisteredApi.findOne({
      _id: apiId,
      workspaceId,
    }).select('-upstreamHeaders');

    if (!api) throw createError('API not found', 404);
    return api;
  }

  async update(
    workspaceId: string,
    apiId: string,
    dto: Partial<CreateApiDto>
  ): Promise<IRegisteredApi> {
    const update: Record<string, unknown> = { ...dto };

    // Re-encrypt headers if provided
    if (dto.upstreamHeaders) {
      update.upstreamHeaders = dto.upstreamHeaders.map((h) => ({
        key: h.key,
        value: encrypt(h.value),
      }));
    }

    // Prevent changing aliasRoute to a conflicting one
    if (dto.aliasRoute) {
      const conflict = await RegisteredApi.findOne({
        workspaceId,
        aliasRoute: dto.aliasRoute,
        _id: { $ne: apiId },
      });
      if (conflict) throw createError('Alias route already taken', 409);
    }

    const api = await RegisteredApi.findOneAndUpdate(
      { _id: apiId, workspaceId },
      { $set: update },
      { new: true, runValidators: true }
    ).select('-upstreamHeaders');

    if (!api) throw createError('API not found', 404);
    return api;
  }

  async archive(workspaceId: string, apiId: string): Promise<void> {
    const result = await RegisteredApi.updateOne(
      { _id: apiId, workspaceId },
      { $set: { status: 'archived' } }
    );
    if (result.matchedCount === 0) throw createError('API not found', 404);
  }

  /**
   * Used by the gateway: get full API config including decrypted headers.
   */
  async getForGateway(aliasRoute: string): Promise<{
    api: IRegisteredApi;
    decryptedHeaders: { key: string; value: string }[];
  } | null> {
    const api = await RegisteredApi.findOne({ aliasRoute, status: 'active' });
    if (!api) return null;

    const decryptedHeaders = api.upstreamHeaders.map((h) => ({
      key: h.key,
      value: decrypt(h.value),
    }));

    return { api, decryptedHeaders };
  }
}

export const apiService = new ApiService();
