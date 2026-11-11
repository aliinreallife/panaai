import "server-only";
import { db } from "@/db";
import { usage } from "@/db/schema";
import { and, count, desc, eq, gte, ilike, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { fillDaily, reportPeriod, csvText } from "@/lib/report-utils";
import type { UsageReport, UsageSummary } from "@/lib/shared";

export const reportOptions = z.object({
  days: z.coerce.number().int().refine(n => [7, 30, 90, 180].includes(n)).default(30),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  model: z.string().max(80).default("all"),
  key: z.string().max(80).default("all"),
  status: z.enum(["all", "success", "error"]).default("all"),
  search: z.string().max(100).default(""),
});
export type ReportOptions = z.infer<typeof reportOptions>;
const sum = (column: typeof usage.credits | typeof usage.inputTokens | typeof usage.outputTokens) => sql<number>`coalesce(sum(${column}),0)`.mapWith(Number);
const summaryFields = {
  requests: count(), credits: sum(usage.credits),
  errors: sql<number>`count(*) filter (where ${usage.status} <> 'success')`.mapWith(Number),
  averageLatency: sql<number>`coalesce(round(avg(${usage.latency})),0)`.mapWith(Number),
  p95Latency: sql<number>`coalesce(round((percentile_cont(0.95) within group (order by ${usage.latency}))::numeric),0)`.mapWith(Number),
  inputTokens: sum(usage.inputTokens), outputTokens: sum(usage.outputTokens),
};
function filters(userId: string, options: ReportOptions, start: Date, end: Date) {
  return and(eq(usage.userId, userId), gte(usage.createdAt, start), lt(usage.createdAt, end),
    options.model !== "all" ? eq(usage.model, options.model) : undefined,
    options.key !== "all" ? eq(usage.keyName, options.key) : undefined,
    options.status !== "all" ? eq(usage.status, options.status) : undefined,
    options.search ? ilike(usage.requestId, `%${options.search.replace(/[\\%_]/g, "\\$&")}%`) : undefined);
}
function withRate(row: Omit<UsageSummary, "successRate">): UsageSummary {
  return { ...row, successRate: row.requests ? Math.round((row.requests - row.errors) / row.requests * 1000) / 10 : null };
}
export async function getUsageReport(userId: string, input: Partial<ReportOptions> = {}): Promise<UsageReport> {
  const options = reportOptions.parse(input);
  const period = reportPeriod(options.days);
  const current = filters(userId, options, period.start, period.end);
  const earlier = filters(userId, options, period.previousStart, period.start);
  const day = sql<string>`to_char(${usage.createdAt} at time zone 'Asia/Tehran', 'YYYY-MM-DD')`;
  const [summaryRows, previousRows, daily, byModel, byKey, recent] = await Promise.all([
    db.select(summaryFields).from(usage).where(current),
    db.select(summaryFields).from(usage).where(earlier),
    db.select({ day, credits: sum(usage.credits), requests: count(), errors: summaryFields.errors }).from(usage).where(filters(userId, options, period.previousStart, period.end)).groupBy(day).orderBy(day),
    db.select({ model: usage.model, credits: sum(usage.credits), requests: count() }).from(usage).where(current).groupBy(usage.model).orderBy(desc(sum(usage.credits))),
    db.select({ key: usage.keyName, credits: sum(usage.credits), requests: count(), errors: summaryFields.errors }).from(usage).where(current).groupBy(usage.keyName).orderBy(desc(sum(usage.credits))),
    db.select().from(usage).where(current).orderBy(desc(usage.createdAt), desc(usage.id)).limit(options.pageSize).offset((options.page - 1) * options.pageSize),
  ]);
  const summary = withRate(summaryRows[0]);
  return { days: options.days, startDay: period.startDay, endDay: period.endDay, updatedAt: period.end.toISOString(), summary, previous: withRate(previousRows[0]),
    daily: fillDaily(period.startDay, options.days, daily), previousDaily: fillDaily(period.previousStartDay, options.days, daily),
    byModel: byModel.map(m => ({ ...m, share: summary.credits ? Math.round(m.credits / summary.credits * 1000) / 10 : 0 })),
    byKey: byKey.map(k => ({ ...k, share: summary.credits ? Math.round(k.credits / summary.credits * 1000) / 10 : 0 })),
    rows: recent.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })), total: summary.requests, page: options.page, pageSize: options.pageSize };
}
export async function exportUsage(userId: string, input: Partial<ReportOptions>) {
  const options = reportOptions.parse(input);
  const period = reportPeriod(options.days);
  const rows = await db.select().from(usage).where(filters(userId, options, period.start, period.end)).orderBy(desc(usage.createdAt), desc(usage.id)).limit(10000);
  return csvText(["request_id", "model", "key", "credits", "input_tokens", "output_tokens", "latency_ms", "status", "time_utc"], rows.map(u => [u.requestId, u.model, u.keyName, u.credits, u.inputTokens, u.outputTokens, u.latency, u.status, u.createdAt.toISOString()]));
}
