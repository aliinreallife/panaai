import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import * as s from "@/db/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { ApiError, PRICING, sandboxOnly } from "@/lib/server";
import { authorizeAdmin, confirmMfa, demoTotp, dropElevation, elevate, enrollMfa, securityStatus } from "@/lib/security";
import { channelConfig, evaluateProvider, listAlerts, raiseAlert } from "@/lib/provider";
import { adjust, reconcile, reverseForRefund } from "@/lib/wallet";
import { ROLE_INFO, SYSTEM_DEFAULTS, SYSTEM_LIMITS, refundable, systemSettings, type Role } from "@/lib/rules";

type User = typeof s.users.$inferSelect;
const ok = (data: unknown = { ok: true }, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(1000);

export const DEFAULT_PACKAGES = [
  { label: "شروع", subtitle: "برای تجربه و پروژه‌های کوچک", amountToman: 90000, icon: "sparkle", featured: false, sort: 1 },
  { label: "حرفه‌ای", subtitle: "برای توسعه‌دهندگان و ایده‌های جدی", amountToman: 450000, icon: "zap", featured: true, sort: 2 },
  { label: "توسعه", subtitle: "برای تیم‌ها و پروژه‌های بزرگ‌تر", amountToman: 900000, icon: "models", featured: false, sort: 3 },
];
export async function ensureDefaults(user: User) {
  const [existing] = await db.select({ id: s.packages.id }).from(s.packages).where(eq(s.packages.userId, user.id)).limit(1);
  if (!existing) await db.insert(s.packages).values(DEFAULT_PACKAGES.map(p => ({ ...p, userId: user.id })));
}

async function updateSettings(user: User, patch: Record<string, string | boolean>, action: string, details: Record<string, unknown>) {
  await db.transaction(async tx => {
    const [current] = await tx.select().from(s.users).where(eq(s.users.id, user.id)).for("update");
    await tx.update(s.users).set({ settings: { ...current.settings, ...patch } }).where(eq(s.users.id, user.id));
    await tx.insert(s.audit).values({ userId: user.id, action, details });
  });
}

/** Customer-side operations that are not part of the original handler. Returns null when the route is not handled here. */
export async function customerOps(req: NextRequest, user: User, route: string, body: () => Promise<unknown>) {
  if (route === "refunds" && req.method === "POST") {
    sandboxOnly();
    const input = z.object({ orderId: uuid, reason }).parse(await body());
    const refund = await db.transaction(async tx => {
      const [order] = await tx.select().from(s.orders).where(and(eq(s.orders.id, input.orderId), eq(s.orders.userId, user.id))).for("update");
      if (!order || order.state !== "approved_and_credited") throw new ApiError("refund_not_eligible", "فقط سفارش تأییدشده قابل درخواست بازپرداخت است.", 409);
      const [open] = await tx.select({ id: s.refunds.id }).from(s.refunds).where(and(eq(s.refunds.orderId, order.id), inArray(s.refunds.state, ["requested", "approved"]))).limit(1);
      if (open) throw new ApiError("refund_exists", "برای این سفارش درخواست بازپرداخت باز وجود دارد.", 409);
      const [lot] = await tx.select().from(s.lots).where(eq(s.lots.orderId, order.id)).limit(1);
      const amount = refundable(order, lot ?? null);
      if (amount.credits <= 0) throw new ApiError("refund_not_eligible", "اعتبار مصرف‌نشده‌ای از این سفارش باقی نمانده است.", 409);
      const [row] = await tx.insert(s.refunds).values({ userId: user.id, orderId: order.id, credits: amount.credits, amountIrr: amount.amountIrr, reason: input.reason }).returning();
      await tx.insert(s.audit).values({ userId: user.id, action: "refund.requested", targetId: row.id, details: { orderId: order.id, credits: amount.credits, amountIrr: amount.amountIrr } });
      return row;
    });
    return ok(refund, 201);
  }
  return null;
}

/** Admin operations. Every route passes the server-side RBAC + MFA gate before reaching here. */
export async function adminOps(req: NextRequest, user: User, route: string, body: () => Promise<unknown>) {
  sandboxOnly();
  if (!user.demo) throw new ApiError("forbidden", "مدیریت فقط برای داده‌های آزمایشی همین حساب در دسترس است.", 403);
  await authorizeAdmin(user, route, req.method);
  const seg = route.split("/");
  const m = req.method;

  /* ---- security / MFA ---- */
  if (route === "admin/security" && m === "GET") return ok(await securityStatus(user));
  if (route === "admin/sms" && m === "GET") {
    const { readSmsOtpStats } = await import("@/lib/sms-metrics");
    return ok(await readSmsOtpStats());
  }
  if (route === "admin/mfa/enroll" && m === "POST") return ok(await enrollMfa(user));
  if (route === "admin/mfa/confirm" && m === "POST") { await confirmMfa(user, z.object({ code: z.string().regex(/^\d{6}$/) }).parse(await body()).code); return ok(); }
  if (route === "admin/mfa/elevate" && m === "POST") return ok({ elevatedUntil: (await elevate(user, z.object({ code: z.string().regex(/^\d{6}$/) }).parse(await body()).code)).toISOString() });
  if (route === "admin/mfa/drop" && m === "POST") { await dropElevation(user); return ok(); }
  if (route === "admin/mfa/demo-code" && m === "GET") return ok(await demoTotp(user));
  if (route === "admin/role" && m === "POST") {
    // Sandbox role simulator, so each role's server-side restrictions can be tried. Audited.
    const { role } = z.object({ role: z.enum(Object.keys(ROLE_INFO) as [Role, ...Role[]]) }).parse(await body());
    await db.transaction(async tx => {
      await tx.update(s.users).set({ role }).where(eq(s.users.id, user.id));
      await tx.insert(s.audit).values({ userId: user.id, action: "admin.role_simulated", details: { from: user.role, to: role } });
    });
    return ok();
  }

  /* ---- provider ---- */
  if (route === "admin/provider" && m === "GET") return ok(await evaluateProvider(user));
  if (route === "admin/provider/simulate" && m === "POST") {
    const input = z.object({ balance: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), outage: z.boolean().optional(), reason }).parse(await body());
    if (input.outage) return ok(await evaluateProvider(user, { outage: true, reason: input.reason, force: true }));
    if (input.balance === null) throw new ApiError("validation_error", "موجودی را وارد کنید.");
    return ok(await evaluateProvider(user, { balance: input.balance, reason: input.reason, force: true }));
  }
  if (route === "admin/provider/pause" && m === "POST") {
    const input = z.object({ paused: z.boolean(), reason }).parse(await body());
    return ok(await evaluateProvider(user, { paused: input.paused, reason: input.reason, force: true }));
  }
  if (route === "admin/provider/sync" && m === "POST") {
    const view = await evaluateProvider(user, { force: true, reason: "manual_sync" });
    const { syncPlatformCatalog } = await import("@/lib/models");
    const { upstreamKeyStatus } = await import("@/lib/upstream-keys");
    const catalog = await syncPlatformCatalog({ reason: "admin_manual_sync", force: true });
    // Keep a per-account mirror for older tooling; platform_state is the source of truth.
    if (catalog.ok) {
      await updateSettings(user, { "platform:catalog": JSON.stringify({ data: catalog.models.map(m => ({ id: m.id, multiplier: m.multiplier ?? null })) }) }, "provider.models_synced", { count: catalog.models.length, source: catalog.meta.source, platform: true });
    }
    return ok({
      ...view,
      models: {
        count: catalog.models.length,
        source: catalog.ok ? (catalog.meta.source || "platform_catalog") : catalog.reason,
        ok: catalog.ok,
        failures: catalog.meta.failures,
        syncedAt: catalog.meta.syncedAt,
        ids: catalog.models.map(m => m.id).slice(0, 50),
      },
      upstreamCredential: await upstreamKeyStatus(user.id),
    });
  }
  if (route === "admin/maintenance" && m === "POST") {
    const { runMaintenance } = await import("@/lib/maintenance");
    return ok(await runMaintenance({ reason: "admin_manual" }));
  }

  /* ---- alerts & channels ---- */
  if (route === "admin/alerts" && m === "GET") return ok({ alerts: await listAlerts(user.id), channels: channelConfig(user) });
  if (seg[1] === "alerts" && seg[3] === "ack" && m === "POST") {
    const id = uuid.parse(seg[2]);
    const [row] = await db.update(s.alerts).set({ state: "acknowledged", acknowledgedAt: new Date() }).where(and(eq(s.alerts.id, id), eq(s.alerts.userId, user.id), eq(s.alerts.state, "open"))).returning();
    if (row) await db.insert(s.audit).values({ userId: user.id, action: "alert.acknowledged", targetId: id, details: { kind: row.kind } });
    return ok();
  }
  if (route === "admin/alerts/acknowledge" && m === "POST") {
    await db.insert(s.audit).values({ userId: user.id, action: "alert.acknowledged", details: { alert: "production_gates_pending", actor: "sandbox_operator", resolved: false } });
    return ok();
  }
  if (route === "admin/alerts/test" && m === "POST") return ok(await raiseAlert(user, { kind: "test", severity: "info", title: "پیام آزمایشی هشدار", message: "این پیام برای آزمون کانال‌های هشدار ارسال شد." }, { test: true }));
  if (route === "admin/channels" && m === "PUT") {
    const input = z.object({ telegram: z.boolean(), telegramChatId: z.string().trim().max(64).regex(/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})?$/), email: z.boolean(), emailTo: z.union([z.literal(""), z.string().trim().email().max(120)]) }).parse(await body());
    await updateSettings(user, { "alerts:telegram": input.telegram, "alerts:telegramChatId": input.telegramChatId, "alerts:email": input.email, "alerts:emailTo": input.emailTo }, "alerts.channels_updated", { telegram: input.telegram, email: input.email });
    return ok();
  }

  /* ---- wallet: reconciliation & adjustments ---- */
  if (route === "admin/wallet/reconcile" && m === "POST") return ok(await reconcile(user.id));
  if (route === "admin/wallet/adjust" && m === "POST") {
    const input = z.object({ amount: z.number().int().refine(v => v !== 0 && Math.abs(v) <= 10000000000), reason }).parse(await body());
    return ok(await adjust(user.id, input.amount, input.reason, PRICING.validityDays));
  }

  /* ---- refunds ---- */
  if (route === "admin/refunds" && m === "GET") return ok(await db.select().from(s.refunds).where(eq(s.refunds.userId, user.id)).orderBy(desc(s.refunds.createdAt)));
  if (seg[1] === "refunds" && seg[2] && seg[3] && m === "POST") {
    const id = uuid.parse(seg[2]); const action = seg[3];
    const input = z.object({ note: reason, payoutReference: z.string().trim().min(4).max(100).optional() }).parse(await body());
    const result = await db.transaction(async tx => {
      const [refund] = await tx.select().from(s.refunds).where(and(eq(s.refunds.id, id), eq(s.refunds.userId, user.id))).for("update");
      if (!refund) throw new ApiError("not_found", "درخواست بازپرداخت یافت نشد.", 404);
      if (action === "approve") {
        if (refund.state !== "requested") throw new ApiError("invalid_transition", "فقط درخواست بررسی‌نشده قابل تأیید است.", 409);
        const [lot] = await tx.select().from(s.lots).where(eq(s.lots.orderId, refund.orderId)).limit(1);
        if (!lot) throw new ApiError("refund_not_eligible", "بسته اعتبار سفارش یافت نشد.", 409);
        await reverseForRefund(tx, user.id, lot.id, refund.credits, refund.id);
        const [row] = await tx.update(s.refunds).set({ state: "approved", decisionNote: input.note, decidedAt: new Date() }).where(eq(s.refunds.id, id)).returning();
        await tx.insert(s.audit).values({ userId: user.id, action: "refund.approved", targetId: id, details: { credits: refund.credits, amountIrr: refund.amountIrr, note: input.note } });
        return row;
      }
      if (action === "reject") {
        if (refund.state !== "requested") throw new ApiError("invalid_transition", "فقط درخواست بررسی‌نشده قابل رد است.", 409);
        const [row] = await tx.update(s.refunds).set({ state: "rejected", decisionNote: input.note, decidedAt: new Date() }).where(eq(s.refunds.id, id)).returning();
        await tx.insert(s.audit).values({ userId: user.id, action: "refund.rejected", targetId: id, details: { note: input.note } });
        return row;
      }
      if (action === "paid") {
        if (refund.state !== "approved") throw new ApiError("invalid_transition", "ابتدا بازپرداخت باید تأیید و اعتبار برگشت داده شود.", 409);
        if (!input.payoutReference) throw new ApiError("payout_reference_required", "مرجع واریز خروجی بانک الزامی است.");
        const [row] = await tx.update(s.refunds).set({ state: "paid", payoutReference: input.payoutReference, paidAt: new Date() }).where(eq(s.refunds.id, id)).returning();
        await tx.insert(s.audit).values({ userId: user.id, action: "refund.paid", targetId: id, details: { payoutReference: input.payoutReference, amountIrr: refund.amountIrr, simulated: true } });
        return row;
      }
      throw new ApiError("not_found", "عملیات یافت نشد.", 404);
    });
    return ok(result);
  }

  /* ---- packages ---- */
  if (route === "admin/packages" && m === "GET") return ok(await db.select().from(s.packages).where(eq(s.packages.userId, user.id)).orderBy(asc(s.packages.sort)));
  if (seg[1] === "packages" && (m === "PUT" || m === "POST")) {
    const pricing = { min: Number(user.settings.minToman || PRICING.minToman), max: Number(user.settings.maxToman || PRICING.maxToman) };
    const input = z.object({ label: z.string().trim().min(2).max(30), subtitle: z.string().trim().max(80), amountToman: z.number().int().min(pricing.min).max(pricing.max), icon: z.enum(["sparkle", "zap", "models", "wallet"]), featured: z.boolean(), active: z.boolean(), sort: z.number().int().min(0).max(99), reason }).parse(await body());
    const { reason: why, ...values } = input;
    const row = await db.transaction(async tx => {
      if (values.featured) await tx.update(s.packages).set({ featured: false }).where(eq(s.packages.userId, user.id));
      let saved;
      if (m === "PUT" && seg[2]) {
        [saved] = await tx.update(s.packages).set(values).where(and(eq(s.packages.id, uuid.parse(seg[2])), eq(s.packages.userId, user.id))).returning();
        if (!saved) throw new ApiError("not_found", "بسته یافت نشد.", 404);
      } else {
        const count = await tx.select({ id: s.packages.id }).from(s.packages).where(eq(s.packages.userId, user.id));
        if (count.length >= 8) throw new ApiError("package_limit", "حداکثر ۸ بسته مجاز است.");
        [saved] = await tx.insert(s.packages).values({ ...values, userId: user.id }).returning();
      }
      await tx.insert(s.audit).values({ userId: user.id, action: "package.saved", targetId: saved.id, details: { ...values, reason: why } });
      return saved;
    });
    return ok(row);
  }

  /* ---- users ---- */
  if (route === "admin/users/state" && m === "POST") {
    const input = z.object({ state: z.enum(["active", "suspended"]), reason }).parse(await body());
    await db.transaction(async tx => {
      await tx.update(s.users).set({ state: input.state }).where(eq(s.users.id, user.id));
      await tx.insert(s.audit).values({ userId: user.id, action: input.state === "suspended" ? "user.suspended" : "user.reactivated", targetId: user.id, details: { reason: input.reason, from: user.state } });
    });
    return ok();
  }

  /* ---- system settings ---- */
  if (route === "admin/system" && m === "PUT") {
    const int = (k: keyof typeof SYSTEM_LIMITS) => z.number().int().min(SYSTEM_LIMITS[k][0]).max(SYSTEM_LIMITS[k][1]);
    const input = z.object({
      transferHours: int("transferHours"),
      graceMinutes: int("graceMinutes"),
      lowBalanceCredits: int("lowBalanceCredits"),
      maxKeys: int("maxKeys"),
      creditsPerCvcToken: int("creditsPerCvcToken").default(SYSTEM_DEFAULTS.creditsPerCvcToken),
      creditsPerUsd: int("creditsPerUsd").default(SYSTEM_DEFAULTS.creditsPerUsd),
      upstreamTokensPerUsd: int("upstreamTokensPerUsd").default(SYSTEM_DEFAULTS.upstreamTokensPerUsd),
      reason,
    }).parse(await body());
    const { reason: why, ...values } = input;
    await updateSettings(user, Object.fromEntries(Object.entries(values).map(([k, v]) => [`system:${k}`, String(v)])), "system.updated", { ...values, previous: systemSettings(user.settings), reason: why });
    return ok();
  }
  return null;
}
