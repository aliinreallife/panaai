import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { keyAllocationRemaining, sumKeyAllocations, unallocatedCredits } from "@/lib/rules";
import { reconcile } from "@/lib/wallet";

export type AuditSeverity = "error" | "warn" | "info";
export type AuditFinding = {
  code: string;
  severity: AuditSeverity;
  message: string;
  context?: Record<string, unknown>;
};

export type FinancialAuditReport = {
  checkedAt: string;
  /** True only when no error findings and base wallet reconcile is clean. */
  ok: boolean;
  buckets: {
    available: number;
    reserved: number;
    allocated: number;
    unallocated: number;
    keySpentTotal: number;
    usageCreditsTotal: number;
  };
  walletReconcile: Awaited<ReturnType<typeof reconcile>>;
  findings: AuditFinding[];
  counts: {
    activeKeys: number;
    budgetedKeys: number;
    uncappedKeys: number;
    upstreamShared: number;
    upstreamCapped: number;
    approvedOrders: number;
  };
};

function finding(severity: AuditSeverity, code: string, message: string, context?: Record<string, unknown>): AuditFinding {
  return context ? { severity, code, message, context } : { severity, code, message };
}

/**
 * Read-only financial integrity audit (plus stale reservation release via reconcile).
 * Verifies separated books stay consistent:
 *  - FEFO lots / reservations / journal (via reconcile)
 *  - soft key allocation vs wallet available
 *  - key.spent vs usage ledger
 *  - approved orders vs credit lots
 *  - upstream CVC credential shape (shared vs capped)
 * Does not auto-correct balances; mismatches are reported for audited adjustment.
 */
export async function financialAudit(userId: string): Promise<FinancialAuditReport> {
  const walletReconcile = await reconcile(userId);
  const findings: AuditFinding[] = [];

  const [lots, keys, usageSum, approvedOrders, orderLots, upstreamRows] = await Promise.all([
    db.select().from(s.lots).where(eq(s.lots.userId, userId)),
    db.select().from(s.keys).where(eq(s.keys.userId, userId)),
    db.select({ total: sql<string>`coalesce(sum(${s.usage.credits}), 0)` }).from(s.usage).where(eq(s.usage.userId, userId)),
    db.select().from(s.orders).where(and(eq(s.orders.userId, userId), eq(s.orders.state, "approved_and_credited"))),
    db.select({ orderId: s.lots.orderId, granted: s.lots.granted, remaining: s.lots.remaining, reserved: s.lots.reserved })
      .from(s.lots).where(and(eq(s.lots.userId, userId), sql`${s.lots.orderId} is not null`)),
    db.select().from(s.upstreamCredentials).where(and(eq(s.upstreamCredentials.userId, userId), isNull(s.upstreamCredentials.revokedAt))).catch(() => [] as (typeof s.upstreamCredentials.$inferSelect)[]),
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

  // --- Soft allocation buckets ---
  if (allocated > available) {
    findings.push(finding("warn", "allocation_oversubscribed",
      "جمع بودجه باقی‌مانده کلیدها از موجودی قابل‌مصرف بیشتر است؛ سهم آزاد صفر می‌شود تا موجودی رشد کند یا کلیدها لغو شوند.",
      { available, allocated, unallocated }));
  }
  if (unallocated !== Math.max(0, available - allocated)) {
    findings.push(finding("error", "unallocated_math",
      "محاسبه اعتبار آزاد با موجودی و تخصیص هم‌خوان نیست.",
      { available, allocated, unallocated }));
  }
  for (const key of activeKeys) {
    if (key.budget != null && key.spent > key.budget) {
      findings.push(finding("error", "key_spent_over_budget",
        `مصرف کلید از سقف بودجه‌اش بیشتر است.`,
        { keyId: key.id, name: key.name, spent: key.spent, budget: key.budget }));
    }
    if (key.budget != null && key.budget < 1) {
      findings.push(finding("error", "key_budget_invalid",
        "سقف بودجه کلید نامعتبر است.",
        { keyId: key.id, budget: key.budget }));
    }
    const rem = keyAllocationRemaining(key);
    if (key.budget != null && rem !== Math.max(0, key.budget - key.spent)) {
      findings.push(finding("error", "key_allocation_math",
        "باقی‌مانده تخصیص کلید نادرست محاسبه شده است.",
        { keyId: key.id, rem, budget: key.budget, spent: key.spent }));
    }
  }

  // --- Key spend vs usage ledger ---
  if (keySpentTotal !== usageCreditsTotal) {
    findings.push(finding("error", "spent_vs_usage",
      "جمع spent کلیدها با جمع اعتبار مصرف‌شده در usage برابر نیست.",
      { keySpentTotal, usageCreditsTotal, delta: keySpentTotal - usageCreditsTotal }));
  }

  // --- Lot sanity ---
  for (const lot of lots) {
    if (lot.remaining < 0 || lot.reserved < 0 || lot.granted < 0) {
      findings.push(finding("error", "lot_negative", "مقادیر بسته اعتبار منفی است.", { lotId: lot.id, granted: lot.granted, remaining: lot.remaining, reserved: lot.reserved }));
    }
    if (lot.reserved > lot.remaining) {
      findings.push(finding("error", "lot_reserved_gt_remaining", "رزرو بسته از باقی‌مانده بیشتر است.", { lotId: lot.id, remaining: lot.remaining, reserved: lot.reserved }));
    }
    if (lot.remaining > lot.granted) {
      findings.push(finding("error", "lot_remaining_gt_granted", "باقی‌مانده بسته از مقدار اعطایی بیشتر است.", { lotId: lot.id, granted: lot.granted, remaining: lot.remaining }));
    }
  }

  // --- Approved orders ↔ lots ---
  const lotsByOrder = new Map<string, { granted: number; remaining: number; reserved: number }>();
  for (const row of orderLots) {
    if (!row.orderId) continue;
    const prev = lotsByOrder.get(row.orderId) || { granted: 0, remaining: 0, reserved: 0 };
    lotsByOrder.set(row.orderId, {
      granted: prev.granted + row.granted,
      remaining: prev.remaining + row.remaining,
      reserved: prev.reserved + row.reserved,
    });
  }
  for (const order of approvedOrders) {
    const lot = lotsByOrder.get(order.id);
    if (!lot) {
      findings.push(finding("error", "approved_order_missing_lot",
        "سفارش تأییدشده بسته اعتبار متناظر ندارد.",
        { orderId: order.id, reference: order.reference, credits: order.credits }));
      continue;
    }
    if (lot.granted !== order.credits) {
      findings.push(finding("error", "order_lot_grant_mismatch",
        "اعتبار اعطایی بسته با اعتبار سفارش تأییدشده برابر نیست.",
        { orderId: order.id, reference: order.reference, orderCredits: order.credits, lotGranted: lot.granted }));
    }
  }

  // --- Upstream credential shape (separate from PanaAI wallet) ---
  const shared = upstreamRows.filter(r => r.kind === "shared_uncapped");
  const capped = upstreamRows.filter(r => r.kind === "capped");
  if (shared.length > 1) {
    findings.push(finding("error", "upstream_shared_duplicate",
      "بیش از یک کلید CVC مشترک (بدون سقف) برای این کیف پول فعال است.",
      { count: shared.length, prefixes: shared.map(r => r.prefix) }));
  }
  const keyById = new Map(keys.map(k => [k.id, k]));
  for (const row of capped) {
    if (!row.platformKeyId) {
      findings.push(finding("error", "upstream_capped_missing_key",
        "رکورد CVC بودجه‌دار بدون پیوند به کلید پانا است.",
        { upstreamId: row.id, prefix: row.prefix }));
      continue;
    }
    const key = keyById.get(row.platformKeyId);
    if (!key) {
      findings.push(finding("warn", "upstream_capped_orphan",
        "رکورد CVC بودجه‌دار به کلید پانا ناشناخته اشاره می‌کند.",
        { upstreamId: row.id, platformKeyId: row.platformKeyId, prefix: row.prefix }));
    } else if (!key.enabled) {
      findings.push(finding("warn", "upstream_capped_for_revoked_key",
        "رکورد CVC بودجه‌دار هنوز برای کلید لغوشده فعال است (حذف CVC در D31).",
        { platformKeyId: key.id, name: key.name, prefix: row.prefix }));
    } else if (key.budget == null) {
      findings.push(finding("warn", "upstream_capped_for_uncapped_key",
        "کلید پانا بدون سقف است ولی رکورد CVC بودجه‌دار دارد.",
        { platformKeyId: key.id, name: key.name, prefix: row.prefix }));
    }
  }
  for (const key of activeKeys.filter(k => k.budget != null)) {
    if (!capped.some(r => r.platformKeyId === key.id)) {
      findings.push(finding("info", "upstream_capped_not_provisioned",
        "کلید بودجه‌دار هنوز اعتبارنامه CVC اختصاصی ندارد (تا اولین استفاده/ساخت mint می‌شود).",
        { keyId: key.id, name: key.name, budget: key.budget }));
    }
  }
  if (activeKeys.some(k => k.budget == null) && shared.length === 0) {
    findings.push(finding("info", "upstream_shared_not_provisioned",
      "کلید بدون سقف فعال است ولی کلید CVC مشترک هنوز ساخته نشده است.",
      { uncappedKeys: activeKeys.filter(k => k.budget == null).length }));
  }

  // Surface wallet reconcile issues as findings too.
  for (const issue of walletReconcile.lotIssues) {
    findings.push(finding("error", "wallet_lot_reconcile",
      `مغایرت بسته در تطبیق پایه: ${issue.issues.join("; ")}`,
      { lotId: issue.lotId }));
  }
  if (walletReconcile.unbalancedJournalEvents.length) {
    findings.push(finding("error", "journal_unbalanced",
      "رویدادهای ژورنال نامتوازن وجود دارد.",
      { count: walletReconcile.unbalancedJournalEvents.length, eventIds: walletReconcile.unbalancedJournalEvents.slice(0, 20) }));
  }

  const hasError = findings.some(f => f.severity === "error") || !walletReconcile.ok;
  const report: FinancialAuditReport = {
    checkedAt: new Date().toISOString(),
    ok: !hasError,
    buckets: { available, reserved, allocated, unallocated, keySpentTotal, usageCreditsTotal },
    walletReconcile,
    findings,
    counts: {
      activeKeys: activeKeys.length,
      budgetedKeys: activeKeys.filter(k => k.budget != null).length,
      uncappedKeys: activeKeys.filter(k => k.budget == null).length,
      upstreamShared: shared.length,
      upstreamCapped: capped.length,
      approvedOrders: approvedOrders.length,
    },
  };

  await db.insert(s.audit).values({
    userId,
    action: "finance.audited",
    details: {
      ok: report.ok,
      buckets: report.buckets,
      counts: report.counts,
      findingCodes: findings.map(f => f.code),
      errorCount: findings.filter(f => f.severity === "error").length,
      warnCount: findings.filter(f => f.severity === "warn").length,
      releasedStale: walletReconcile.releasedStale,
    },
  });

  return report;
}
