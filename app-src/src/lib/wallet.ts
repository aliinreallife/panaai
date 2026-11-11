import "server-only";
import { db } from "@/db";
import * as s from "@/db/schema";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { ApiError } from "@/lib/server";
import { allocateFefo, splitSettlement } from "@/lib/rules";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const RESERVATION_TTL_MS = 5 * 60000;

async function journalPair(tx: Tx, userId: string, eventId: string, delta: number, counter: string) {
  await tx.insert(s.journal).values([{ eventId, account: `customer:${userId}`, delta }, { eventId, account: counter, delta: -delta }]);
}

/**
 * Reserve an upper-bound cost before dispatch. Account, key and FEFO lots are row-locked in a
 * fixed order (user → key → lots, NO KEY UPDATE so FK checks from concurrent inserts don't deadlock) so concurrent requests serialize and can never overdraw
 * the wallet or the key budget.
 */
export async function reserve(input: { userId: string; keyId: string; requestId: string; model: string; amount: number }) {
  return db.transaction(async tx => {
    const [prior] = await tx.select().from(s.reservations).where(eq(s.reservations.requestId, input.requestId));
    if (prior) return prior;
    await tx.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, input.userId)).for("no key update");
    const [key] = await tx.select().from(s.keys).where(and(eq(s.keys.id, input.keyId), eq(s.keys.userId, input.userId))).for("no key update");
    if (!key?.enabled) throw new ApiError("key_revoked", "این کلید لغو شده است.", 401);
    if (key.budget !== null) {
      const [held] = await tx.select({ total: sql<string>`coalesce(sum(${s.reservations.amount}), 0)` }).from(s.reservations).where(and(eq(s.reservations.keyId, key.id), eq(s.reservations.state, "held")));
      if (key.spent + Number(held.total) + input.amount > key.budget) throw new ApiError("key_budget_exceeded", "بودجه باقی‌مانده این کلید برای سقف هزینه این درخواست کافی نیست.", 403);
    }
    const lots = await tx.select().from(s.lots).where(and(eq(s.lots.userId, input.userId), gt(s.lots.expiresAt, new Date()))).orderBy(asc(s.lots.expiresAt), asc(s.lots.id)).for("no key update");
    const allocations = allocateFefo(lots, input.amount);
    if (!allocations) throw new ApiError("insufficient_credits", "اعتبار کیف پول برای سقف هزینه این درخواست کافی نیست. اعتبار بخرید یا max_tokens را کمتر کنید.", 402);
    for (const a of allocations) await tx.update(s.lots).set({ reserved: sql`${s.lots.reserved} + ${a.amount}` }).where(eq(s.lots.id, a.lotId));
    const [row] = await tx.insert(s.reservations).values({ ...input, allocations, expiresAt: new Date(Date.now() + RESERVATION_TTL_MS) }).returning();
    return row;
  });
}

/** Exactly-once settlement: consumes the actual cost (≤ reserved) in FEFO order and releases the rest. */
export async function settle(requestId: string, actual: number, usage: { keyName: string; inputTokens: number; outputTokens: number; latency: number; status: string }) {
  return db.transaction(async tx => {
    const [r] = await tx.select().from(s.reservations).where(eq(s.reservations.requestId, requestId)).for("update");
    if (!r) throw new ApiError("reservation_missing", "رزرو یافت نشد.", 409);
    if (r.state !== "held") return r; // already settled/released: idempotent no-op
    const charged = Math.min(Math.max(0, actual), r.amount);
    // Same lock order as reserve() (key → lots) to avoid deadlocks under concurrency.
    await tx.select({ id: s.keys.id }).from(s.keys).where(eq(s.keys.id, r.keyId)).for("no key update");
    const lotIds = r.allocations.map(a => a.lotId);
    if (lotIds.length) await tx.select({ id: s.lots.id }).from(s.lots).where(inArray(s.lots.id, lotIds)).orderBy(asc(s.lots.expiresAt), asc(s.lots.id)).for("no key update");
    for (const part of splitSettlement(r.allocations, charged)) {
      await tx.update(s.lots).set({ reserved: sql`${s.lots.reserved} - ${part.amount}`, remaining: sql`${s.lots.remaining} - ${part.used}` }).where(eq(s.lots.id, part.lotId));
      if (part.used > 0) {
        const [event] = await tx.insert(s.walletEvents).values({ userId: r.userId, lotId: part.lotId, type: "consume", delta: -part.used, description: `مصرف API ${r.model}`, idempotencyKey: `settle:${requestId}:${part.lotId}` }).returning();
        await journalPair(tx, r.userId, event.id, -part.used, "consumed:api");
      }
    }
    await tx.update(s.keys).set({ spent: sql`${s.keys.spent} + ${charged}`, lastUsedAt: new Date() }).where(eq(s.keys.id, r.keyId));
    await tx.insert(s.usage).values({ userId: r.userId, requestId, model: r.model, credits: charged, ...usage });
    const [updated] = await tx.update(s.reservations).set({ state: "settled", settled: charged, settledAt: new Date() }).where(eq(s.reservations.id, r.id)).returning();
    return updated;
  });
}

/** Release a held reservation without charging (upstream failure, timeout, or stale hold). */
export async function release(requestId: string, state: "released" | "expired" = "released") {
  return db.transaction(async tx => {
    const [r] = await tx.select().from(s.reservations).where(eq(s.reservations.requestId, requestId)).for("update");
    if (!r || r.state !== "held") return r ?? null;
    for (const a of r.allocations) await tx.update(s.lots).set({ reserved: sql`${s.lots.reserved} - ${a.amount}` }).where(eq(s.lots.id, a.lotId));
    const [updated] = await tx.update(s.reservations).set({ state, settled: 0, settledAt: new Date() }).where(eq(s.reservations.id, r.id)).returning();
    return updated;
  });
}

/**
 * Reconciliation: releases stale holds, then verifies that
 *  - each lot's reserved equals the sum of its held allocations,
 *  - each lot's remaining equals the sum of its wallet events,
 *  - every journal event balances to zero.
 * Nothing is auto-corrected except stale holds; mismatches are reported for an audited adjustment.
 */
export async function reconcile(userId: string) {
  const stale = await db.select({ requestId: s.reservations.requestId }).from(s.reservations).where(and(eq(s.reservations.userId, userId), eq(s.reservations.state, "held"), lt(s.reservations.expiresAt, new Date())));
  for (const r of stale) await release(r.requestId, "expired");
  const [lots, held, events, journal] = await Promise.all([
    db.select().from(s.lots).where(eq(s.lots.userId, userId)),
    db.select().from(s.reservations).where(and(eq(s.reservations.userId, userId), eq(s.reservations.state, "held"))),
    db.select({ lotId: s.walletEvents.lotId, total: sql<string>`sum(${s.walletEvents.delta})` }).from(s.walletEvents).where(eq(s.walletEvents.userId, userId)).groupBy(s.walletEvents.lotId),
    db.select({ eventId: s.journal.eventId, total: sql<string>`sum(${s.journal.delta})` }).from(s.journal).innerJoin(s.walletEvents, eq(s.walletEvents.id, s.journal.eventId)).where(eq(s.walletEvents.userId, userId)).groupBy(s.journal.eventId),
  ]);
  const reservedByLot = new Map<string, number>();
  for (const r of held) for (const a of r.allocations) reservedByLot.set(a.lotId, (reservedByLot.get(a.lotId) || 0) + a.amount);
  const eventsByLot = new Map(events.map(e => [e.lotId, Number(e.total)]));
  const lotIssues = lots.flatMap(l => {
    const issues: string[] = [];
    if ((reservedByLot.get(l.id) || 0) !== l.reserved) issues.push(`reserved ${l.reserved} ≠ held ${reservedByLot.get(l.id) || 0}`);
    if ((eventsByLot.get(l.id) ?? 0) !== l.remaining) issues.push(`remaining ${l.remaining} ≠ ledger ${eventsByLot.get(l.id) ?? 0}`);
    return issues.length ? [{ lotId: l.id, issues }] : [];
  });
  const unbalanced = journal.filter(j => Number(j.total) !== 0).map(j => j.eventId);
  const report = { checkedAt: new Date().toISOString(), lots: lots.length, heldReservations: held.length, releasedStale: stale.length, lotIssues, unbalancedJournalEvents: unbalanced, ok: !lotIssues.length && !unbalanced.length };
  await db.insert(s.audit).values({ userId, action: "wallet.reconciled", details: report });
  return report;
}

/** Audited admin correction: positive creates a new lot, negative debits available credits FEFO. Never edits history. */
export async function adjust(userId: string, amount: number, reason: string, validityDays: number) {
  return db.transaction(async tx => {
    await tx.select({ id: s.users.id }).from(s.users).where(eq(s.users.id, userId)).for("no key update");
    const key = `adjust:${userId}:${Date.now()}:${amount}`;
    if (amount > 0) {
      const [lot] = await tx.insert(s.lots).values({ userId, origin: "admin_adjustment", granted: amount, remaining: amount, expiresAt: new Date(Date.now() + validityDays * 86400000) }).returning();
      const [event] = await tx.insert(s.walletEvents).values({ userId, lotId: lot.id, type: "admin_adjustment", delta: amount, description: `اصلاح مدیریتی: ${reason}`, idempotencyKey: key }).returning();
      await journalPair(tx, userId, event.id, amount, "adjustments:admin");
    } else {
      const lots = await tx.select().from(s.lots).where(and(eq(s.lots.userId, userId), gt(s.lots.expiresAt, new Date()))).orderBy(asc(s.lots.expiresAt), asc(s.lots.id)).for("no key update");
      const allocations = allocateFefo(lots, -amount);
      if (!allocations) throw new ApiError("insufficient_credits", "اعتبار آزاد کافی برای کسر وجود ندارد.", 409);
      for (const a of allocations) {
        await tx.update(s.lots).set({ remaining: sql`${s.lots.remaining} - ${a.amount}` }).where(eq(s.lots.id, a.lotId));
        const [event] = await tx.insert(s.walletEvents).values({ userId, lotId: a.lotId, type: "admin_adjustment", delta: -a.amount, description: `اصلاح مدیریتی: ${reason}`, idempotencyKey: `${key}:${a.lotId}` }).returning();
        await journalPair(tx, userId, event.id, -a.amount, "adjustments:admin");
      }
    }
    await tx.insert(s.audit).values({ userId, action: "wallet.adjusted", details: { amount, reason } });
    return { ok: true };
  });
}

/** Refund approval removes the order lot's unreserved remaining credits (compensating event). */
export async function reverseForRefund(tx: Tx, userId: string, lotId: string, credits: number, refundId: string) {
  if (credits <= 0) return;
  const [lot] = await tx.select().from(s.lots).where(eq(s.lots.id, lotId)).for("update");
  if (!lot || lot.remaining - lot.reserved < credits) throw new ApiError("refund_credits_changed", "اعتبار قابل بازپرداخت از زمان درخواست تغییر کرده است. درخواست را دوباره بررسی کنید.", 409);
  await tx.update(s.lots).set({ remaining: sql`${s.lots.remaining} - ${credits}` }).where(eq(s.lots.id, lotId));
  const [event] = await tx.insert(s.walletEvents).values({ userId, lotId, type: "refund_reversal", delta: -credits, description: "برگشت اعتبار بابت بازپرداخت", idempotencyKey: `refund:${refundId}` }).returning();
  await journalPair(tx, userId, event.id, -credits, "refunds:payable");
}
