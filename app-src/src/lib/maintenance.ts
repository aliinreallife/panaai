import "server-only";
import { db } from "@/db";
import * as s from "@/db/schema";
import { and, eq, lt, sql } from "drizzle-orm";
import { release } from "@/lib/wallet";
import { logger } from "@/lib/logger";

const USAGE_RETENTION_DAYS = 365;

/**
 * Platform maintenance: release stale FEFO reservations and delete usage metadata
 * older than 365 days. Financial/receipt rows are not deleted here.
 */
export async function runMaintenance(opts: { reason?: string } = {}) {
  const now = new Date();
  const stale = await db.select({ requestId: s.reservations.requestId }).from(s.reservations).where(and(eq(s.reservations.state, "held"), lt(s.reservations.expiresAt, now)));
  let released = 0;
  for (const row of stale) {
    await release(row.requestId, "expired");
    released += 1;
  }

  const cutoff = new Date(now.getTime() - USAGE_RETENTION_DAYS * 86400000);
  const deletedUsage = await db.delete(s.usage).where(lt(s.usage.createdAt, cutoff)).returning({ id: s.usage.id });
  const dayCutoff = cutoff.toISOString().slice(0, 10);
  const deletedDays = await db.delete(s.usageDaily).where(lt(s.usageDaily.day, dayCutoff)).returning({ id: s.usageDaily.id });
  // Drop expired rate-limit buckets so the table cannot grow forever.
  const deletedBuckets = await db.delete(s.rateBuckets).where(lt(s.rateBuckets.expiresAt, now)).returning({ key: s.rateBuckets.key });

  const report = {
    at: now.toISOString(),
    reason: opts.reason ?? "scheduled",
    releasedStaleReservations: released,
    deletedUsageRows: deletedUsage.length,
    deletedUsageDayRows: deletedDays.length,
    deletedRateBuckets: deletedBuckets.length,
    retentionDays: USAGE_RETENTION_DAYS,
  };
  logger.info("maintenance.completed", report);
  // Audit against a synthetic platform marker only if there is at least one user to attach to —
  // prefer inserting nothing when the DB is empty.
  const [anyUser] = await db.select({ id: s.users.id }).from(s.users).limit(1);
  if (anyUser) await db.insert(s.audit).values({ userId: anyUser.id, action: "system.maintenance", details: report });
  return report;
}

/** Cheap readiness probe used by cron auth failures / health-adjacent tooling. */
export async function maintenanceStats() {
  const [held] = await db.select({ n: sql<number>`count(*)::int` }).from(s.reservations).where(eq(s.reservations.state, "held"));
  return { heldReservations: held?.n ?? 0 };
}
