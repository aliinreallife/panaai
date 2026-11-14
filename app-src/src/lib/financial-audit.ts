import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { evaluateFinancialIntegrity, type AuditEvaluation, type AuditFinding, type BucketStatus } from "@/lib/financial-audit-checks";
import { sumKeyAllocations, unallocatedCredits } from "@/lib/rules";
import { reconcile } from "@/lib/wallet";

export type { AuditFinding, BucketStatus, AuditEvaluation };
export type FinancialAuditReport = {
  checkedAt: string;
  /** True only when no error findings (warn/info may still be present). */
  ok: boolean;
  /** True when any error or warn — something looks fishy and needs eyes. */
  fishy: boolean;
  buckets: {
    available: number;
    reserved: number;
    allocated: number;
    unallocated: number;
    keySpentTotal: number;
    usageCreditsTotal: number;
  };
  /** Per separated book: PASS/FAIL with figures side-by-side. */
  bucketStatus: BucketStatus[];
  identity: AuditEvaluation["identity"];
  walletReconcile: Awaited<ReturnType<typeof reconcile>>;
  findings: AuditFinding[];
  counts: {
    activeKeys: number;
    budgetedKeys: number;
    uncappedKeys: number;
    upstreamShared: number;
    upstreamCapped: number;
    approvedOrders: number;
    refunds: number;
  };
};

/**
 * Read-only financial integrity audit (plus stale reservation release via reconcile).
 * Makes separated books explicit so fishy mismatches are obvious:
 *  soft allocation, spend↔usage, FEFO lots/holds, journal, orders↔lots, refunds, CVC shape.
 * Does not auto-correct balances.
 */
export async function financialAudit(userId: string): Promise<FinancialAuditReport> {
  const walletReconcile = await reconcile(userId);

  const [lots, keys, usageSum, usageByName, approvedOrders, held, refunds, upstreamRows, refundEvents] = await Promise.all([
    db.select().from(s.lots).where(eq(s.lots.userId, userId)),
    db.select().from(s.keys).where(eq(s.keys.userId, userId)),
    db.select({ total: sql<string>`coalesce(sum(${s.usage.credits}), 0)` }).from(s.usage).where(eq(s.usage.userId, userId)),
    db.select({ keyName: s.usage.keyName, total: sql<string>`coalesce(sum(${s.usage.credits}), 0)` })
      .from(s.usage).where(eq(s.usage.userId, userId)).groupBy(s.usage.keyName),
    db.select().from(s.orders).where(and(eq(s.orders.userId, userId), eq(s.orders.state, "approved_and_credited"))),
    db.select().from(s.reservations).where(and(eq(s.reservations.userId, userId), eq(s.reservations.state, "held"))),
    db.select().from(s.refunds).where(eq(s.refunds.userId, userId)),
    db.select().from(s.upstreamCredentials).where(eq(s.upstreamCredentials.userId, userId)).catch(() => [] as (typeof s.upstreamCredentials.$inferSelect)[]),
    db.select({ idempotencyKey: s.walletEvents.idempotencyKey, delta: s.walletEvents.delta })
      .from(s.walletEvents)
      .where(and(eq(s.walletEvents.userId, userId), eq(s.walletEvents.type, "refund_reversal"))),
  ]);

  const now = new Date();
  const eligible = lots.filter(l => l.expiresAt > now);
  const available = eligible.reduce((a, l) => a + Math.max(0, l.remaining - l.reserved), 0);
  const reserved = eligible.reduce((a, l) => a + Math.max(0, l.reserved), 0);
  const activeKeys = keys.filter(k => k.enabled);
  const allocated = sumKeyAllocations(activeKeys);
  const unallocated = unallocatedCredits(available, allocated);
  const keySpentTotal = keys.reduce((a, k) => a + Math.max(0, k.spent), 0);
  const usageCreditsTotal = Number(usageSum[0]?.total ?? 0);

  const lotGrantedByOrder: Record<string, number> = {};
  for (const lot of lots) {
    if (!lot.orderId) continue;
    lotGrantedByOrder[lot.orderId] = (lotGrantedByOrder[lot.orderId] || 0) + lot.granted;
  }

  const usageByKeyName: Record<string, number> = {};
  for (const row of usageByName) usageByKeyName[row.keyName] = Number(row.total);

  const refundReversalByRefundId: Record<string, number> = {};
  for (const ev of refundEvents) {
    const m = /^refund:(.+)$/.exec(ev.idempotencyKey);
    if (!m) continue;
    refundReversalByRefundId[m[1]] = (refundReversalByRefundId[m[1]] || 0) + ev.delta;
  }

  const heldReservationTotal = held.reduce((a, r) => a + r.amount, 0);
  const lotReservedTotal = lots.reduce((a, l) => a + Math.max(0, l.reserved), 0);

  const evaluation = evaluateFinancialIntegrity({
    available,
    reserved,
    allocated,
    unallocated,
    keySpentTotal,
    usageCreditsTotal,
    keys: keys.map(k => ({ id: k.id, name: k.name, enabled: k.enabled, budget: k.budget, spent: k.spent })),
    lots: lots.map(l => ({
      id: l.id, orderId: l.orderId, origin: l.origin, granted: l.granted,
      remaining: l.remaining, reserved: l.reserved, expiresAt: l.expiresAt,
    })),
    approvedOrders: approvedOrders.map(o => ({ id: o.id, reference: o.reference, credits: o.credits })),
    lotGrantedByOrder,
    usageByKeyName,
    refunds: refunds.map(r => ({ id: r.id, state: r.state, credits: r.credits, orderId: r.orderId })),
    refundReversalByRefundId,
    heldReservationTotal,
    lotReservedTotal,
    walletLotIssues: walletReconcile.lotIssues,
    unbalancedJournalEventIds: walletReconcile.unbalancedJournalEvents,
    upstream: upstreamRows.map(u => ({
      id: u.id, kind: u.kind, platformKeyId: u.platformKeyId, prefix: u.prefix, revoked: !!u.revokedAt,
    })),
  });

  // If base reconcile failed but evaluate already mirrored lot/journal issues, ok stays false.
  const ok = evaluation.ok && walletReconcile.ok;
  const shared = upstreamRows.filter(u => !u.revokedAt && u.kind === "shared_uncapped");
  const capped = upstreamRows.filter(u => !u.revokedAt && u.kind === "capped");

  const report: FinancialAuditReport = {
    checkedAt: new Date().toISOString(),
    ok,
    fishy: evaluation.fishy || !ok,
    buckets: { available, reserved, allocated, unallocated, keySpentTotal, usageCreditsTotal },
    bucketStatus: evaluation.buckets,
    identity: evaluation.identity,
    walletReconcile,
    findings: evaluation.findings,
    counts: {
      activeKeys: activeKeys.length,
      budgetedKeys: activeKeys.filter(k => k.budget != null).length,
      uncappedKeys: activeKeys.filter(k => k.budget == null).length,
      upstreamShared: shared.length,
      upstreamCapped: capped.length,
      approvedOrders: approvedOrders.length,
      refunds: refunds.length,
    },
  };

  await db.insert(s.audit).values({
    userId,
    action: "finance.audited",
    details: {
      ok: report.ok,
      fishy: report.fishy,
      buckets: report.buckets,
      counts: report.counts,
      identity: report.identity,
      bucketOk: Object.fromEntries(report.bucketStatus.map(b => [b.id, b.ok])),
      findingCodes: report.findings.map(f => f.code),
      errorCount: report.findings.filter(f => f.severity === "error").length,
      warnCount: report.findings.filter(f => f.severity === "warn").length,
      releasedStale: walletReconcile.releasedStale,
    },
  });

  return report;
}
