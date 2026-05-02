import mongoose from 'mongoose';
import { UsageLog } from './usageLog.model';
import { Workspace } from '../workspaces/workspace.model';
import { getCurrentMonthRange } from '../../utils/paginate';

export class AnalyticsService {
  async overview(workspaceId: string) {
    const { start, end } = getCurrentMonthRange();

    const [stats] = await UsageLog.aggregate([
      { $match: { workspaceId: new mongoose.Types.ObjectId(workspaceId), timestamp: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          successRequests: { $sum: { $cond: [{ $lt: ['$statusCode', 400] }, 1, 0] } },
          errorRequests: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
          totalCredits: { $sum: '$creditsDeducted' },
          avgLatency: { $avg: '$latencyMs' },
          cacheHits: { $sum: { $cond: ['$cacheHit', 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          totalRequests: 1,
          successRequests: 1,
          errorRequests: 1,
          errorRate: { $multiply: [{ $divide: ['$errorRequests', { $max: ['$totalRequests', 1] }] }, 100] },
          totalCredits: 1,
          avgLatency: { $round: ['$avgLatency', 2] },
          cacheHitRate: { $multiply: [{ $divide: ['$cacheHits', { $max: ['$totalRequests', 1] }] }, 100] },
        },
      },
    ]);

    const workspace = await Workspace.findById(workspaceId).select('credits creditAllowance');
    const sevenDayAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [usage7d] = await UsageLog.aggregate([
      { $match: { workspaceId: new mongoose.Types.ObjectId(workspaceId), timestamp: { $gte: sevenDayAgo } } },
      { $group: { _id: null, totalCredits: { $sum: '$creditsDeducted' } } },
    ]);

    const creditsPerDay = (usage7d?.totalCredits || 0) / 7;
    const daysRemaining = creditsPerDay > 0 ? (workspace?.credits || 0) / creditsPerDay : null;

    return {
      ...(stats || { totalRequests: 0, errorRate: 0, totalCredits: 0, avgLatency: 0, cacheHitRate: 0 }),
      credits: workspace?.credits || 0,
      creditAllowance: workspace?.creditAllowance || 0,
      creditsPerDay: Math.round(creditsPerDay * 100) / 100,
      predictedExhaustionDays: daysRemaining ? Math.round(daysRemaining * 10) / 10 : null,
    };
  }

  async timeseries(workspaceId: string, interval: 'hour' | 'day' = 'hour', days = 7, apiId?: string) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const matchFilter: Record<string, unknown> = {
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      timestamp: { $gte: since },
    };
    if (apiId) matchFilter.apiId = new mongoose.Types.ObjectId(apiId);

    const dateFormat = interval === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%d';

    return UsageLog.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$timestamp' } },
          requests: { $sum: 1 },
          errors: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
          credits: { $sum: '$creditsDeducted' },
          avgLatency: { $avg: '$latencyMs' },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          timestamp: '$_id',
          requests: 1,
          errors: 1,
          credits: 1,
          avgLatency: { $round: ['$avgLatency', 2] },
          _id: 0,
        },
      },
    ]);
  }

  async topEndpoints(workspaceId: string, days = 7, limit = 10) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return UsageLog.aggregate([
      { $match: { workspaceId: new mongoose.Types.ObjectId(workspaceId), timestamp: { $gte: since } } },
      {
        $group: {
          _id: { aliasRoute: '$aliasRoute', method: '$method' },
          requests: { $sum: 1 },
          errors: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
          avgLatency: { $avg: '$latencyMs' },
          credits: { $sum: '$creditsDeducted' },
        },
      },
      { $sort: { requests: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          route: '$_id.aliasRoute',
          method: '$_id.method',
          requests: 1,
          errorRate: { $multiply: [{ $divide: ['$errors', { $max: ['$requests', 1] }] }, 100] },
          avgLatency: { $round: ['$avgLatency', 2] },
          credits: 1,
        },
      },
    ]);
  }

  async geoBreakdown(workspaceId: string, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return UsageLog.aggregate([
      {
        $match: {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          timestamp: { $gte: since },
          geoCountry: { $exists: true, $ne: null },
        },
      },
      { $group: { _id: '$geoCountry', requests: { $sum: 1 }, credits: { $sum: '$creditsDeducted' } } },
      { $sort: { requests: -1 } },
      { $limit: 50 },
      { $project: { _id: 0, country: '$_id', requests: 1, credits: 1 } },
    ]);
  }

  async topConsumers(workspaceId: string, days = 7, limit = 10) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return UsageLog.aggregate([
      { $match: { workspaceId: new mongoose.Types.ObjectId(workspaceId), timestamp: { $gte: since } } },
      {
        $group: {
          _id: '$apiKeyId',
          requests: { $sum: 1 },
          credits: { $sum: '$creditsDeducted' },
          errors: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
        },
      },
      { $sort: { requests: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'apikeys',
          localField: '_id',
          foreignField: '_id',
          as: 'key',
          pipeline: [{ $project: { label: 1, keyPrefix: 1, environment: 1 } }],
        },
      },
      { $unwind: { path: '$key', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          keyId: '$_id',
          label: '$key.label',
          keyPrefix: '$key.keyPrefix',
          environment: '$key.environment',
          requests: 1,
          credits: 1,
          errorRate: { $multiply: [{ $divide: ['$errors', { $max: ['$requests', 1] }] }, 100] },
        },
      },
    ]);
  }

  async heatmap(workspaceId: string, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return UsageLog.aggregate([
      { $match: { workspaceId: new mongoose.Types.ObjectId(workspaceId), timestamp: { $gte: since } } },
      {
        $group: {
          _id: { hour: { $hour: '$timestamp' }, dayOfWeek: { $dayOfWeek: '$timestamp' } },
          requests: { $sum: 1 },
        },
      },
      { $project: { _id: 0, hour: '$_id.hour', dayOfWeek: '$_id.dayOfWeek', requests: 1 } },
      { $sort: { dayOfWeek: 1, hour: 1 } },
    ]);
  }

  async platformStats() {
    const { start } = getCurrentMonthRange();
    const [usage, workspaceCount] = await Promise.all([
      UsageLog.aggregate([
        { $match: { timestamp: { $gte: start } } },
        { $group: { _id: null, totalRequests: { $sum: 1 }, totalCredits: { $sum: '$creditsDeducted' }, avgLatency: { $avg: '$latencyMs' } } },
      ]),
      Workspace.countDocuments({ status: 'active' }),
    ]);
    return { ...(usage[0] || { totalRequests: 0, totalCredits: 0, avgLatency: 0 }), workspaceCount };
  }
}

export const analyticsService = new AnalyticsService();
