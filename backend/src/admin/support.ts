import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { recordAdminAction } from '../events/log.js';
import { EVENT_LEVELS, EVENT_TYPES, EventLogModel } from '../models/event-log.js';
import { MissingOrderReportModel, REPORT_STATUSES } from '../models/missing-order-report.js';
import { SellerModel } from '../models/seller.js';
import { dateRangeFilter, dateRangeQuery, objectIdText, paginationQuery, toPagination } from './query.js';

const HOUR_MS = 3_600_000;
export const HEALTH_WINDOW_HOURS = 24;

// ---- Health ---------------------------------------------------------------------
const CONNECTION_STATES: Record<number, string> = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

export const HEALTH_DEFINITIONS = {
  failedSubmissions:
    'Orders customers tried to place but that were refused (sold out, ordering closed, wrong area or day, invalid form). These never become orders.',
  serverErrors: 'Requests that ended in an unexpected server error (HTTP 500).',
  notificationFailures:
    'Push or email notifications that failed to send. Nothing sends notifications yet, so this is always 0 until that feature exists; 0 means "nothing is reporting", not "nothing is failing".',
  openReports: 'Customer "my order is missing" reports no admin has resolved yet (all time, not only the last 24 hours).',
} as const;

export async function health(now: Date = new Date()) {
  const since = new Date(now.getTime() - HEALTH_WINDOW_HOURS * HOUR_MS);

  const [byType, failedByCode, openReports, reportsInWindow] = await Promise.all([
    // One pass over the last 24 hours of events, counted per type. Uses { type, createdAt }.
    EventLogModel.aggregate<{ _id: string; n: number }>([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$type', n: { $sum: 1 } } },
    ]),
    EventLogModel.aggregate<{ _id: string; n: number }>([
      { $match: { type: 'order_failed', createdAt: { $gte: since } } },
      { $group: { _id: '$code', n: { $sum: 1 } } },
      { $sort: { n: -1, _id: 1 } },
    ]),
    MissingOrderReportModel.countDocuments({ status: 'open' }),
    MissingOrderReportModel.countDocuments({ createdAt: { $gte: since } }),
  ]);

  const count = (type: string) => byType.find((row) => row._id === type)?.n ?? 0;
  return {
    generatedAt: now,
    window: { hours: HEALTH_WINDOW_HOURS, since },
    database: CONNECTION_STATES[mongoose.connection.readyState] ?? 'unknown',
    failedSubmissions: {
      total: count('order_failed'),
      byCode: Object.fromEntries(failedByCode.map((row) => [row._id, row.n])),
    },
    serverErrors: count('server_error'),
    notificationFailures: count('notification_failed'),
    openReports,
    reportsLast24h: reportsInWindow,
    definitions: HEALTH_DEFINITIONS,
  };
}

// ---- Event log ------------------------------------------------------------------
export const eventListQuery = z.object({
  type: z.enum(EVENT_TYPES, { error: `type must be one of: ${EVENT_TYPES.join(', ')}` }).optional(),
  level: z.enum(EVENT_LEVELS, { error: `level must be one of: ${EVENT_LEVELS.join(', ')}` }).optional(),
  sellerId: objectIdText('sellerId').optional(),
  ...dateRangeQuery,
  ...paginationQuery,
});

export async function listEvents(query: z.infer<typeof eventListQuery>) {
  const { type, level, sellerId, page, limit } = query;
  const createdAt = dateRangeFilter(query);
  const filter = {
    ...(type ? { type } : {}),
    ...(level ? { level } : {}),
    ...(sellerId ? { sellerId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };

  const [events, total] = await Promise.all([
    EventLogModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    EventLogModel.countDocuments(filter),
  ]);

  return {
    events: events.map((event) => ({
      id: event._id.toString(),
      type: event.type,
      level: event.level,
      code: event.code,
      message: event.message,
      sellerId: event.sellerId?.toString() ?? null,
      menuId: event.menuId?.toString() ?? null,
      orderRef: event.orderRef ?? null,
      meta: event.meta ?? {},
      createdAt: event.createdAt,
    })),
    pagination: toPagination(total, page, limit),
  };
}

// ---- Missing-order reports ------------------------------------------------------
export const reportListQuery = z.object({
  status: z.enum(REPORT_STATUSES, { error: `status must be one of: ${REPORT_STATUSES.join(', ')}` }).optional(),
  ...paginationQuery,
});

export async function listReports(query: z.infer<typeof reportListQuery>) {
  const { status, page, limit } = query;
  const filter = status ? { status } : {};

  const [reports, total] = await Promise.all([
    MissingOrderReportModel.aggregate<Record<string, any>>([
      { $match: filter },
      // Open reports first (they need action), then newest first.
      { $addFields: { sortOpen: { $cond: [{ $eq: ['$status', 'open'] }, 0, 1] } } },
      { $sort: { sortOpen: 1, createdAt: -1, _id: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      {
        $lookup: {
          from: SellerModel.collection.name,
          localField: 'sellerId',
          foreignField: '_id',
          pipeline: [{ $project: { businessName: 1, slug: 1 } }],
          as: 'seller',
        },
      },
    ]),
    MissingOrderReportModel.countDocuments(filter),
  ]);

  return { reports: reports.map(toAdminReport), pagination: toPagination(total, page, limit) };
}

type ReportRow = {
  _id: Types.ObjectId;
  ref?: string;
  phoneLast4?: string;
  menuSlug?: string;
  message: string;
  orderFound: boolean;
  matchedOrderRef?: string;
  status: string;
  resolvedBy?: string;
  resolvedAt?: Date;
  resolutionNote?: string;
  createdAt: Date;
  seller?: { _id: Types.ObjectId; businessName: string; slug: string }[];
};

function toAdminReport(row: Record<string, any>) {
  const r = row as ReportRow;
  const seller = r.seller?.[0];
  return {
    id: r._id.toString(),
    status: r.status,
    createdAt: r.createdAt,
    // What the customer typed. Only the LAST 4 digits of a phone number are ever stored.
    ref: r.ref ?? null,
    phoneLast4: r.phoneLast4 ?? null,
    menuSlug: r.menuSlug ?? null,
    message: r.message,
    seller: seller ? { id: seller._id.toString(), businessName: seller.businessName, slug: seller.slug } : null,
    // What the system found when the report arrived (admin only; the customer is never told).
    orderFound: r.orderFound,
    matchedOrderRef: r.matchedOrderRef ?? null,
    resolvedBy: r.resolvedBy ?? null,
    resolvedAt: r.resolvedAt ?? null,
    resolutionNote: r.resolutionNote ?? null,
  };
}

export const resolveBody = z.object({ note: z.string().trim().max(300).optional() });

export function parseReportId(raw: unknown): Types.ObjectId {
  const parsed = objectIdText('id').safeParse(raw);
  if (!parsed.success) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found');
  return parsed.data;
}

async function loadReport(id: Types.ObjectId) {
  const [row] = await MissingOrderReportModel.aggregate<Record<string, any>>([
    { $match: { _id: id } },
    {
      $lookup: {
        from: SellerModel.collection.name,
        localField: 'sellerId',
        foreignField: '_id',
        pipeline: [{ $project: { businessName: 1, slug: 1 } }],
        as: 'seller',
      },
    },
  ]);
  if (!row) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found');
  return toAdminReport(row);
}

// open -> resolved. Same rules as the seller status changes: asking again for
// something already done changes nothing and adds no audit entry; otherwise the
// audit entry is written FIRST and the update is conditional on the report still
// being open, so two admins resolving it at once resolve it once.
export async function resolveReport(input: { id: Types.ObjectId; adminId: string; note?: string | undefined }) {
  const { id, adminId, note } = input;
  const current = await MissingOrderReportModel.findById(id, { status: 1 }).lean();
  if (!current) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found');
  if (current.status === 'resolved') return loadReport(id);

  await recordAdminAction({ adminId, action: 'report.resolve', targetId: id.toString(), ...(note ? { reason: note } : {}) });
  await MissingOrderReportModel.updateOne(
    { _id: id, status: 'open' },
    { $set: { status: 'resolved', resolvedBy: adminId, resolvedAt: new Date(), ...(note ? { resolutionNote: note } : {}) } },
  );
  return loadReport(id);
}
