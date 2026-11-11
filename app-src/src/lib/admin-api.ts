import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, audit } from "@/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError, sandboxOnly } from "@/lib/server";
import { MODEL_CATALOG } from "@/lib/shared";
export async function adminAction(req: NextRequest, user: typeof users.$inferSelect, route: string, getBody: () => Promise<unknown>) {
  sandboxOnly();
  if (!user.demo) throw new ApiError("forbidden", "مدیریت فقط برای داده‌های آزمایشی همین حساب در دسترس است.", 403);
  const done = () => NextResponse.json({ ok: true, demo: true }, { headers: { "Cache-Control": "private, no-store" } });
  if (route === "admin/provider/reconcile" && req.method === "POST") {
    const input = z.object({ balance: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), reason: z.string().trim().min(10).max(1000) }).parse(await getBody());
    await db.insert(audit).values({ userId: user.id, action: "provider.manual_reconciled", details: { ...input, verified: false, source: "manual_unverified" } });
    return done();
  }
  if (route === "admin/provider/sync" && req.method === "POST") {
    await db.insert(audit).values({ userId: user.id, action: "provider.sync_requested", details: { outcome: "not_configured", verified: false } });
    throw new ApiError("provider_status_unverified", "آدرس و اعتبارنامه تأییدشده همگام‌سازی CVC تنظیم نشده است. موجودی همچنان نامشخص است.", 503);
  }
  if (route === "admin/pricing" && req.method === "PUT") {
    const input = z.object({ rateIrr: z.number().int().min(10000).max(100000000), minToman: z.number().int().min(1000).max(5000000), maxToman: z.number().int().min(1000).max(100000000), reason: z.string().trim().min(10).max(1000) }).parse(await getBody());
    if (input.maxToman < input.minToman) throw new ApiError("invalid_range", "حداکثر مبلغ باید از حداقل بیشتر باشد.");
    await db.transaction(async tx => {
      const [current] = await tx.select().from(users).where(eq(users.id, user.id)).for("update");
      const version = `demo-${Date.now()}`;
      await tx.update(users).set({ settings: { ...current.settings, fxRateIrr: String(input.rateIrr), minToman: String(input.minToman), maxToman: String(input.maxToman), priceVersion: version } }).where(eq(users.id, user.id));
      await tx.insert(audit).values({ userId: user.id, action: "pricing.updated", details: { ...input, version, previousRate: current.settings.fxRateIrr || "900000", source: "manual_demo", prospectiveOnly: true } });
    });
    return done();
  }
  if (route.startsWith("admin/models/") && req.method === "PUT") {
    const id = route.split("/")[2];
    if (!MODEL_CATALOG.some(m => m.id === id)) throw new ApiError("model_disabled", "مدل یافت نشد.", 404);
    const input = z.object({ enabled: z.boolean(), reason: z.string().trim().min(10).max(1000) }).parse(await getBody());
    await db.transaction(async tx => {
      const [current] = await tx.select().from(users).where(eq(users.id, user.id)).for("update");
      await tx.update(users).set({ settings: { ...current.settings, [`model:${id}`]: input.enabled } }).where(eq(users.id, user.id));
      await tx.insert(audit).values({ userId: user.id, action: "model.updated", targetId: id, details: { ...input, previousEnabled: current.settings[`model:${id}`] !== false, liveActivated: false } });
    });
    return done();
  }
  if (route === "admin/alerts/acknowledge" && req.method === "POST") {
    await db.insert(audit).values({ userId: user.id, action: "alert.acknowledged", details: { alert: "production_gates_pending", actor: "sandbox_operator", resolved: false } });
    return done();
  }
  return null;
}
