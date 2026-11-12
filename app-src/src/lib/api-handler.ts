import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import * as s from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { randomBytes, randomInt } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { cookies } from "next/headers";
import { getUsageReport, exportUsage, reportOptions } from "@/lib/analytics";
import { ApiError, PRICING, createSandbox, dataFor, isDemo, decryptImage, encryptImage, getUser, limit, requireUser, sandboxOnly, sha, verifier, pricingFor } from "@/lib/server";
import { ascii } from "@/lib/shared";
import { systemSettings } from "@/lib/rules";
import { logger } from "@/lib/logger";

type Context = { params: Promise<{ path: string[] }> };
const uuid = z.string().uuid();
const success = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
function originCheck(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host") && new URL(origin).host !== req.nextUrl.host) throw new ApiError("invalid_origin", "مبدأ درخواست معتبر نیست.", 403);
  if (req.headers.get("sec-fetch-site") === "cross-site") throw new ApiError("invalid_origin", "درخواست بین‌سایتی مجاز نیست.", 403);
}
async function bytes(req: NextRequest, max = 65536) {
  if (Number(req.headers.get("content-length") || 0) > max) throw new ApiError("payload_too_large", "اندازه فایل یا درخواست بیش از حد مجاز است.", 413);
  const reader = req.body?.getReader();
  if (!reader) return Buffer.from("{}");
  let length = 0; const chunks: Buffer[] = [];
  try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > max) { await reader.cancel(); throw new ApiError("payload_too_large", "اندازه درخواست بیش از حد مجاز است.", 413); } chunks.push(Buffer.from(value)); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
async function json(req: NextRequest) { try { return JSON.parse((await bytes(req)).toString()); } catch (e) { if (e instanceof ApiError) throw e; throw new ApiError("invalid_json", "ساختار درخواست معتبر نیست."); } }
function errorResponse(error: unknown) {
  if (error instanceof ApiError) {
    const res = success({ code: error.code, message: error.message, retryAfter: error.retryAfter, request_id: randomBytes(8).toString("hex") }, error.status);
    if (error.retryAfter) res.headers.set("Retry-After", String(error.retryAfter));
    return res;
  }
  if (error instanceof z.ZodError) return success({ code: "validation_error", message: "اطلاعات واردشده کامل یا معتبر نیست. فیلدها را دوباره بررسی کنید.", fields: error.issues.map(i => i.path.join(".")) }, 400);
  const cause = error as { cause?: { code?: string }; code?: string };
  if (cause.code === "23505" || cause.cause?.code === "23505") return success({ code: "bank_reference_duplicate", message: "این مرجع قبلاً ثبت شده است. برای جلوگیری از ثبت دوباره، اطلاعات را بررسی کنید." }, 409);
  logger.error("platform.request_failed", { error });
  return success({ code: "internal_error", message: "ارتباط با سرور برقرار نشد. لطفاً دوباره تلاش کنید.", request_id: randomBytes(8).toString("hex") }, 500);
}
export async function handler(req: NextRequest, context: Context) {
  try {
    const segments = (await context.params).path;
    const route = segments.join("/");
    if (req.method !== "GET") originCheck(req);
    if (route === "bootstrap" && req.method === "POST") {
      let user = await getUser();
      if (user) return success(await dataFor(user));
      await limit(`bootstrap:${req.headers.get("x-forwarded-for")?.split(",")[0] || "local"}`, 30, 3600000);
      const sandbox = await createSandbox(); user = sandbox.user;
      const res = success(await dataFor(user));
      const secureCookie = process.env.NODE_ENV === "production" || req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
      // Partition sandbox sessions by top-level site so embedded previews work
      // without sharing credentials with another embedding site. Mutations also
      // require same-origin Origin/Sec-Fetch-Site validation above.
      res.cookies.set("platform_session", sandbox.token, { httpOnly: true, sameSite: secureCookie ? "none" : "lax", secure: secureCookie, partitioned: secureCookie, maxAge: 604800, path: "/" });
      return res;
    }
    const user = await requireUser();
    const PRICING = await pricingFor(user);
    await limit(`requests:${user.id}`, 180);
    if (req.method !== "GET") sandboxOnly();
    if (req.method !== "GET" && user.state === "suspended" && ["quotes", "orders", "keys", "refunds"].includes(segments[0])) throw new ApiError("account_suspended", "حساب شما معلق است؛ ثبت سفارش، کلید یا درخواست جدید ممکن نیست. با پشتیبانی تماس بگیرید.", 403);
    if (segments[0] === "admin") {
      const { adminOps } = await import("@/lib/ops-api");
      const handled = await adminOps(req, user, route, () => json(req));
      if (handled) return handled;
      const { adminAction } = await import("@/lib/admin-api");
      const result = await adminAction(req, user, route, () => json(req));
      if (result) return result;
    }
    if (req.method === "GET") {
      if (route === "admin/audit") {
        sandboxOnly();
        if (!user.demo) throw new ApiError("forbidden", "دسترسی به حسابرسی مدیریت مجاز نیست.", 403);
        return success(await db.select().from(s.audit).where(eq(s.audit.userId, user.id)).orderBy(desc(s.audit.createdAt)).limit(100));
      }
      if (route === "analytics" || route === "analytics/export") {
        const options = reportOptions.parse(Object.fromEntries(req.nextUrl.searchParams));
        if (route === "analytics/export") {
          await limit(`usage-export:${user.id}`, 10, 60000);
          return new NextResponse(await exportUsage(user.id, options), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="usage.csv"', "Cache-Control": "private, no-store" } });
        }
        return success(await getUsageReport(user.id, options));
      }
      if (["data", "me", "wallet", "wallet/lots", "keys", "orders", "usage", "admin/orders", "admin/audit", "admin/finance/summary"].includes(route)) {
        const data = await dataFor(user);
        const result: Record<string, unknown> = { data, me: data.user, wallet: data.wallet, "wallet/lots": data.lots, keys: data.keys, orders: data.orders, usage: data.usage, "admin/orders": data.orders, "admin/audit": data.audit, "admin/finance/summary": { approvedCashIrr: data.orders.filter(o => o.state === "approved_and_credited").reduce((a,o) => a+o.amountIrr,0), outstandingCredits: data.wallet.available + data.wallet.reserved, coverage: null, demo: true } };
        return success(result[route]);
      }
      if (segments[0] === "orders" && segments[2] === "receipt") {
        const orderId = uuid.parse(segments[1]);
        const [receipt] = await db.select().from(s.receipts).where(and(eq(s.receipts.orderId, orderId), eq(s.receipts.userId, user.id))).orderBy(desc(s.receipts.createdAt)).limit(1);
        if (!receipt) throw new ApiError("not_found", "رسیدی برای این سفارش یافت نشد.", 404);
        await db.insert(s.audit).values({ userId: user.id, action: req.nextUrl.searchParams.has("admin") ? "receipt.admin_viewed" : "receipt.viewed", targetId: orderId, details: { sandbox: true } });
        return new NextResponse(new Uint8Array(await decryptImage(receipt.encryptedData)), { headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline; filename=receipt.webp" } });
      }
    }
    if (req.method === "POST" && route === "quotes") {
      const input = z.object({ amountToman: z.number().int().min(PRICING.minToman).max(PRICING.maxToman) }).parse(await json(req));
      const amountIrr = input.amountToman * 10;
      const credits = Number(BigInt(amountIrr) * BigInt(PRICING.creditsPerUsd) / BigInt(PRICING.rateIrr));
      const [quote] = await db.insert(s.quotes).values({ userId: user.id, amountIrr, credits, rateIrr: PRICING.rateIrr, version: PRICING.version, expiresAt: new Date(Date.now() + 900000) }).returning();
      return success(quote, 201);
    }
    if (req.method === "POST" && route === "orders") {
      const { quoteId } = z.object({ quoteId: uuid }).parse(await json(req));
      const order = await db.transaction(async tx => {
        const [quote] = await tx.select().from(s.quotes).where(and(eq(s.quotes.id, quoteId), eq(s.quotes.userId, user.id))).for("update");
        if (!quote) throw new ApiError("not_found", "پیش‌فاکتور یافت نشد.", 404);
        const [prior] = await tx.select().from(s.orders).where(eq(s.orders.quoteId, quoteId));
        if (prior) return prior;
        if (quote.expiresAt < new Date()) throw new ApiError("quote_expired", "اعتبار ۱۵ دقیقه‌ای پیش‌فاکتور تمام شده است. قیمت را دوباره دریافت کنید.", 409);
        const [created] = await tx.insert(s.orders).values({ userId: user.id, quoteId: quote.id, reference: `CR-${randomBytes(4).toString("hex").toUpperCase()}`, amountIrr: quote.amountIrr, credits: quote.credits, rateIrr: quote.rateIrr, transferDeadline: new Date(Date.now() + systemSettings(user.settings).transferHours * 3600000) }).returning();
        await tx.insert(s.audit).values({ userId: user.id, action: "order.created", targetId: created.id, details: { version: quote.version, amountIrr: quote.amountIrr, credits: quote.credits, transferHours: systemSettings(user.settings).transferHours, demo: true } });
        return created;
      });
      return success(order, 201);
    }
    if (req.method === "POST" && segments[0] === "orders" && segments[2] === "receipt") {
      await limit(`receipt:${user.id}`, 6);
      const orderId = uuid.parse(segments[1]);
      const [owned] = await db.select().from(s.orders).where(and(eq(s.orders.id, orderId), eq(s.orders.userId, user.id)));
      if (!owned) throw new ApiError("not_found", "سفارش یافت نشد.", 404);
      const raw = await bytes(req, 8 * 1024 * 1024 + 65536);
      const form = await new Response(new Uint8Array(raw), { headers: { "Content-Type": req.headers.get("content-type") || "" } }).formData();
      const file = form.get("file");
      if (!(file instanceof File) || !/\.(jpg|jpeg|png|webp)$/i.test(file.name) || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new ApiError("receipt_invalid", "فقط تصویر JPEG، PNG یا WebP معتبر پذیرفته می‌شود.");
      if (file.size > 8 * 1024 * 1024) throw new ApiError("receipt_too_large", "حجم تصویر باید کمتر از ۸ مگابایت باشد.", 413);
      const amountToman = z.number().int().positive().max(100000000).parse(Number(ascii(String(form.get("amountToman") || ""))));
      const transferredAt = z.coerce.date().parse(form.get("transferredAt"));
      if (transferredAt.getTime() > Date.now() + 900000) throw new ApiError("invalid_transfer_time", "زمان واریز نمی‌تواند در آینده باشد.");
      const bankReference = z.string().max(100).parse(String(form.get("bankReference") || ""));
      const note = z.string().max(1000).parse(String(form.get("note") || ""));
      let image: Buffer;
      try {
        const source = Buffer.from(await file.arrayBuffer());
        const processor = sharp(source, { limitInputPixels: 16000000, failOn: "warning", animated: false });
        const meta = await processor.metadata();
        const expected = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" }[file.type];
        if (meta.format !== expected || !meta.width || !meta.height || meta.width > 6000 || meta.height > 6000 || (meta.pages || 1) > 1) throw new Error("Invalid image");
        image = await processor.rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
      } catch { throw new ApiError("receipt_invalid", "تصویر معتبر نیست یا ابعاد آن بیش از حد مجاز است."); }
      const encrypted = await encryptImage(image);
      const hash = sha(image);
      const result = await db.transaction(async tx => {
        const [order] = await tx.select().from(s.orders).where(and(eq(s.orders.id, orderId), eq(s.orders.userId, user.id))).for("update");
        if (!order || !["awaiting_transfer", "needs_more_information", "needs_manual_resolution"].includes(order.state)) throw new ApiError("invalid_transition", "در وضعیت فعلی نمی‌توان رسید جدید بارگذاری کرد.", 409);
        const duplicates = await tx.select({ id: s.receipts.id }).from(s.receipts).where(eq(s.receipts.sha256, hash)).limit(1);
        const mismatch = amountToman * 10 !== order.amountIrr || transferredAt > order.transferDeadline || duplicates.length > 0;
        const [updated] = await tx.update(s.orders).set({ state: mismatch ? "needs_manual_resolution" : "receipt_submitted", claimedIrr: amountToman * 10, transferredAt, bankReference, customerNote: note, reviewNote: mismatch ? "مبلغ، مهلت واریز یا تکرار تصویر نیاز به تطبیق مستقل دارد." : null }).where(eq(s.orders.id, orderId)).returning();
        await tx.insert(s.receipts).values({ orderId, userId: user.id, encryptedData: encrypted, sha256: hash, byteSize: image.length });
        await tx.insert(s.audit).values({ userId: user.id, action: "receipt.submitted", targetId: orderId, details: { from: order.state, to: updated.state, duplicateSignal: duplicates.length > 0 } });
        return updated;
      });
      return success(result);
    }
    if (req.method === "POST" && route === "keys") {
      const input = z.object({
        name: z.string().trim().min(2).max(50),
        budget: z.number().int().positive().max(1000000000000).nullable().optional(),
        rateLimit: z.number().int().min(1).max(300),
        allowedModels: z.array(z.string().trim().min(1).max(120).regex(/^[\w./:-]+$/)).max(50),
      }).parse(await json(req));
      const { resolveModelCatalog } = await import("@/lib/models");
      const catalog = await resolveModelCatalog(user.settings);
      const allowedIds = new Set(catalog.map(m => m.id));
      if (input.allowedModels.some(id => !allowedIds.has(id))) throw new ApiError("model_disabled", "یکی از مدل‌های انتخاب‌شده در فهرست فعال نیست.");
      const secret = `sk_${isDemo ? "test" : "live"}_${randomBytes(30).toString("hex")}`;
      const hash = await verifier(secret);
      const created = await db.transaction(async tx => {
        await tx.select().from(s.users).where(eq(s.users.id, user.id)).for("update");
        const existing = await tx.select({ id: s.keys.id }).from(s.keys).where(and(eq(s.keys.userId, user.id), eq(s.keys.enabled, true)));
        const maxKeys = systemSettings(user.settings).maxKeys;
        if (existing.length >= maxKeys) throw new ApiError("key_limit", `حداکثر ${maxKeys.toLocaleString("fa-IR")} کلید فعال مجاز است.`);
        const [key] = await tx.insert(s.keys).values({ ...input, userId: user.id, prefix: secret.slice(0, 16), verifier: hash }).returning({ id: s.keys.id, name: s.keys.name, prefix: s.keys.prefix });
        await tx.insert(s.audit).values({ userId: user.id, action: "key.created", targetId: key.id, details: { name: input.name } });
        return key;
      });
      return success({ ...created, secret }, 201);
    }
    if (req.method === "POST" && segments[0] === "keys" && segments[2] === "rotate") {
      const id = uuid.parse(segments[1]);
      const secret = `sk_${isDemo ? "test" : "live"}_${randomBytes(30).toString("hex")}`;
      const hash = await verifier(secret);
      const result = await db.transaction(async tx => {
        const [old] = await tx.select().from(s.keys).where(and(eq(s.keys.id, id), eq(s.keys.userId, user.id))).for("update");
        if (!old || !old.enabled) throw new ApiError("key_revoked", "کلید لغو شده یا وجود ندارد.", 409);
        const [key] = await tx.insert(s.keys).values({ userId: user.id, name: old.name, prefix: secret.slice(0, 16), verifier: hash, budget: old.budget, rateLimit: old.rateLimit, allowedModels: old.allowedModels, spent: old.spent }).returning({ id: s.keys.id, name: s.keys.name });
        await tx.update(s.keys).set({ enabled: false, revokedAt: new Date() }).where(eq(s.keys.id, old.id));
        await tx.insert(s.audit).values({ userId: user.id, action: "key.rotated", targetId: key.id, details: { previousId: old.id } });
        return key;
      });
      return success({ ...result, secret }, 201);
    }
    if (req.method === "POST" && segments[0] === "keys" && segments[2] === "revoke") {
      const id = uuid.parse(segments[1]);
      await db.transaction(async tx => {
        const [key] = await tx.update(s.keys).set({ enabled: false, revokedAt: new Date() }).where(and(eq(s.keys.id, id), eq(s.keys.userId, user.id), eq(s.keys.enabled, true))).returning({ id: s.keys.id });
        if (key) await tx.insert(s.audit).values({ userId: user.id, action: "key.revoked", targetId: id });
      });
      return success({ ok: true });
    }
    if (req.method === "POST" && segments[0] === "keys" && segments[2] === "update") {
      const id = uuid.parse(segments[1]);
      const input = z.object({
        budget: z.number().int().positive().max(1000000000000).nullable().optional(),
        rateLimit: z.number().int().min(1).max(300).optional(),
        allowedModels: z.array(z.string().trim().min(1).max(120).regex(/^[\w./:-]+$/)).max(50).optional(),
      }).parse(await json(req));
      if (input.allowedModels) {
        const { resolveModelCatalog } = await import("@/lib/models");
        const catalog = await resolveModelCatalog(user.settings);
        const allowedIds = new Set(catalog.map(m => m.id));
        if (input.allowedModels.some(modelId => !allowedIds.has(modelId))) throw new ApiError("model_disabled", "یکی از مدل‌های انتخاب‌شده در فهرست فعال نیست.");
      }
      const updated = await db.transaction(async tx => {
        const [key] = await tx.select().from(s.keys).where(and(eq(s.keys.id, id), eq(s.keys.userId, user.id))).for("update");
        if (!key || !key.enabled) throw new ApiError("key_revoked", "کلید لغو شده یا وجود ندارد.", 409);
        if (input.budget !== undefined && input.budget !== null && input.budget < key.spent) {
          throw new ApiError("budget_below_spent", "سقف بودجه نمی‌تواند از مصرف فعلی کلید کمتر باشد.");
        }
        const patch = {
          ...(input.budget !== undefined ? { budget: input.budget } : {}),
          ...(input.rateLimit !== undefined ? { rateLimit: input.rateLimit } : {}),
          ...(input.allowedModels !== undefined ? { allowedModels: input.allowedModels } : {}),
        };
        const [row] = await tx.update(s.keys).set(patch).where(eq(s.keys.id, id)).returning({
          id: s.keys.id, name: s.keys.name, budget: s.keys.budget, rateLimit: s.keys.rateLimit, allowedModels: s.keys.allowedModels, spent: s.keys.spent,
        });
        await tx.insert(s.audit).values({ userId: user.id, action: "key.updated", targetId: id, details: patch });
        return row;
      });
      return success(updated);
    }
    if (req.method === "POST" && segments[0] === "admin" && segments[1] === "orders") {
      sandboxOnly();
      if (!user.demo) throw new ApiError("forbidden", "دسترسی به مدیریت مجاز نیست.", 403);
      const orderId = uuid.parse(segments[2]); const action = segments[3];
      const input = z.object({ note: z.string().trim().min(10).max(1000), bankReference: z.string().trim().max(100).optional(), bankVerified: z.boolean().optional(), confirmedIrr: z.number().int().positive().optional(), reasonCode: z.enum(["bank_not_received", "amount_mismatch", "duplicate_reference", "unclear_receipt", "other"]).optional(), customerMessage: z.string().trim().max(500).optional() }).parse(await json(req));
      const result = await db.transaction(async tx => {
        const [order] = await tx.select().from(s.orders).where(and(eq(s.orders.id, orderId), eq(s.orders.userId, user.id))).for("update");
        if (!order) throw new ApiError("not_found", "سفارش یافت نشد.", 404);
        if (order.state === "approved_and_credited") {
          if (action === "approve") return { ...order, alreadyCredited: true };
          throw new ApiError("order_already_credited", "سفارش تأییدشده قابل ویرایش نیست؛ اصلاح به رویداد جبرانی نیاز دارد.", 409);
        }
        let nextState: string;
        if (action === "approve") {
          if (!["receipt_submitted", "under_review"].includes(order.state)) throw new ApiError("invalid_transition", "ابتدا رسید معتبر و مبلغ منطبق باید ثبت شود.", 409);
          if (!input.bankVerified || !input.bankReference || input.bankReference.length < 4 || input.confirmedIrr !== order.amountIrr || order.claimedIrr !== order.amountIrr) throw new ApiError("bank_verification_required", "تأیید مستقل بانک، مرجع یکتا و مبلغ دقیق الزامی است.");
          const [receipt] = await tx.select({ id: s.receipts.id }).from(s.receipts).where(eq(s.receipts.orderId, order.id)).limit(1);
          if (!receipt) throw new ApiError("receipt_required", "تصویر رسید ثبت نشده است.");
          const reference = input.bankReference.replace(/\s/g, "").toUpperCase();
          await tx.insert(s.bankVerifications).values({ userId: user.id, orderId, fingerprint: sha(`sandbox-destination:${reference}`), bankReference: reference, amountIrr: order.amountIrr, note: input.note });
          const [lot] = await tx.insert(s.lots).values({ userId: user.id, orderId, granted: order.credits, remaining: order.credits, expiresAt: new Date(Date.now() + PRICING.validityDays * 86400000) }).returning();
          const [event] = await tx.insert(s.walletEvents).values({ userId: user.id, lotId: lot.id, type: "grant", delta: order.credits, description: `شارژ آزمایشی سفارش ${order.reference}`, idempotencyKey: `order-grant:${orderId}` }).returning();
          await tx.insert(s.journal).values([{ eventId: event.id, account: `customer:${user.id}`, delta: order.credits }, { eventId: event.id, account: "issuer:demo", delta: -order.credits }]);
          nextState = "approved_and_credited";
        } else if (action === "reject") {
          if (!input.reasonCode || !input.customerMessage || input.customerMessage.length < 10) throw new ApiError("customer_message_required", "کد دلیل و توضیح قابل نمایش به مشتری الزامی است.");
          if (!["receipt_submitted", "under_review", "needs_manual_resolution", "needs_more_information"].includes(order.state)) throw new ApiError("invalid_transition", "وضعیت سفارش اجازه رد نمی‌دهد.", 409);
          nextState = "rejected";
        } else if (action === "request-info") {
          if (!input.reasonCode || !input.customerMessage || input.customerMessage.length < 10) throw new ApiError("customer_message_required", "کد دلیل و توضیح قابل نمایش به مشتری الزامی است.");
          if (!["receipt_submitted", "under_review", "needs_manual_resolution", "rejected"].includes(order.state)) throw new ApiError("invalid_transition", "وضعیت سفارش اجازه درخواست مدرک نمی‌دهد.", 409);
          nextState = "needs_more_information";
        } else throw new ApiError("not_found", "عملیات یافت نشد.", 404);
        const [updated] = await tx.update(s.orders).set({ state: nextState, reviewNote: action === "approve" ? "بررسی آزمایشی تکمیل شد و اعتبار سفارش به کیف پول اضافه شد." : input.customerMessage, ...(action === "approve" ? { approvedAt: new Date() } : {}) }).where(eq(s.orders.id, orderId)).returning();
        await tx.insert(s.audit).values({ userId: user.id, action: `payment.${action}`, targetId: orderId, details: { actor: "sandbox_operator", from: order.state, to: nextState, reason: input.note, reasonCode: input.reasonCode || null, customerMessage: input.customerMessage || null, amountIrr: order.amountIrr, bankReference: input.bankReference || null } });
        return updated;
      });
      return success(result);
    }
    if (route === "auth/logout" && req.method === "POST") {
      const token = (await cookies()).get("platform_session")?.value;
      if (token) await db.delete(s.sessions).where(and(eq(s.sessions.tokenHash, sha(token)), eq(s.sessions.userId, user.id)));
      const response = success({ ok: true });
      const secure = process.env.NODE_ENV === "production" || req.nextUrl.protocol === "https:";
      response.cookies.set("platform_session", "", { httpOnly: true, secure, sameSite: secure ? "none" : "lax", partitioned: secure, maxAge: 0, path: "/" });
      return response;
    }
    if (route === "notifications/read" && req.method === "POST") {
      const readAt = new Date().toISOString();
      await db.transaction(async tx => {
        const [current] = await tx.select().from(s.users).where(eq(s.users.id, user.id)).for("update");
        await tx.update(s.users).set({ settings: { ...current.settings, notificationsReadAt: readAt } }).where(eq(s.users.id, user.id));
      });
      return success({ readAt });
    }
    if (route === "settings" && req.method === "PUT") {
      const input = z.object({ name: z.string().trim().min(2).max(60), email: z.union([z.literal(""), z.string().email().max(120)]), lowBalance: z.boolean(), expiry: z.boolean(), payments: z.boolean() }).parse(await json(req));
      await db.transaction(async tx => {
        const [current] = await tx.select().from(s.users).where(eq(s.users.id, user.id)).for("update");
        await tx.update(s.users).set({ name: input.name, settings: { ...current.settings, email: input.email, lowBalance: input.lowBalance, expiry: input.expiry, payments: input.payments } }).where(eq(s.users.id, user.id));
        await tx.insert(s.audit).values({ userId: user.id, action: "settings.updated", details: { fields: Object.keys(input) } });
      });
      return success({ ok: true });
    }
    if (route === "tickets" && req.method === "POST") {
      await limit(`tickets:${user.id}`, 5, 3600000);
      const input = z.object({ subject: z.string().trim().min(4).max(100), message: z.string().trim().min(10).max(3000), category: z.enum(["support", "refund", "payment", "api"]) }).parse(await json(req));
      const [ticket] = await db.insert(s.tickets).values({ ...input, userId: user.id }).returning();
      return success(ticket, 201);
    }
    if (route === "auth/otp/request" && req.method === "POST") {
      await limit(`otp:${user.id}`, 1, 60000);
      const { phone } = z.object({ phone: z.string().regex(/^09\d{9}$/) }).parse(await json(req));
      const code = String(randomInt(100000, 1000000));
      const { kavenegarConfigured, sendLookupOtp } = await import("@/lib/kavenegar");
      const { recordSmsSend } = await import("@/lib/sms-metrics");
      const liveSms = kavenegarConfigured();
      let delivery: { messageId?: string; costRial: number } = { costRial: 0 };
      if (liveSms) {
        try {
          const sent = await sendLookupOtp(phone, code);
          delivery = { messageId: sent.messageId, costRial: sent.costRial };
          await recordSmsSend({ ok: true, costRial: sent.costRial });
        } catch (error) {
          await recordSmsSend({ ok: false, error: error instanceof ApiError ? error.message : "ارسال ناموفق" });
          throw error;
        }
      } else {
        await recordSmsSend({ ok: true, costRial: 0 });
      }
      const [challenge] = await db.insert(s.otpChallenges).values({ userId: user.id, phone, codeHash: await verifier(code), expiresAt: new Date(Date.now() + 120000) }).returning({ id: s.otpChallenges.id });
      await db.insert(s.audit).values({
        userId: user.id,
        action: liveSms ? "auth.otp_sent" : "auth.otp_demo_issued",
        targetId: challenge.id,
        details: { provider: liveSms ? "kavenegar" : "demo", messageId: delivery.messageId || null, costRial: delivery.costRial },
      });
      return success({
        challengeId: challenge.id,
        demo: !liveSms,
        demoCode: liveSms ? undefined : code,
        expiresIn: 120,
        message: liveSms ? "کد تأیید به شماره شما ارسال شد." : "پیامکی ارسال نشده است؛ این کد فقط برای ورود در محیط آزمایشی است.",
      });
    }
    if (route === "auth/otp/verify" && req.method === "POST") {
      const input = z.object({ challengeId: uuid, code: z.string().regex(/^\d{6}$/) }).parse(await json(req));
      const { kavenegarConfigured } = await import("@/lib/kavenegar");
      const liveSms = kavenegarConfigured();
      const { isAdminPhone } = await import("@/lib/staff");
      const result = await db.transaction(async tx => {
        const [challenge] = await tx.select().from(s.otpChallenges).where(and(eq(s.otpChallenges.id, input.challengeId), eq(s.otpChallenges.userId, user.id))).for("update");
        if (!challenge || challenge.usedAt || challenge.expiresAt < new Date() || challenge.attempts >= 5) return false;
        await tx.update(s.otpChallenges).set({ attempts: challenge.attempts + 1 }).where(eq(s.otpChallenges.id, challenge.id));
        if (challenge.codeHash !== await verifier(input.code)) return false;
        await tx.update(s.otpChallenges).set({ usedAt: new Date() }).where(eq(s.otpChallenges.id, challenge.id));
        const staff = isAdminPhone(challenge.phone);
        await tx.update(s.users).set({ phone: challenge.phone, ...(staff ? { role: "owner" } : {}) }).where(eq(s.users.id, user.id));
        await tx.insert(s.audit).values({
          userId: user.id,
          action: liveSms ? "auth.otp_verified" : "auth.demo_verified",
          details: { realSms: liveSms, staff },
        });
        return true;
      });
      if (!result) throw new ApiError("invalid_otp", "کد نادرست، استفاده‌شده یا منقضی است.");
      const { recordSmsVerified } = await import("@/lib/sms-metrics");
      await recordSmsVerified();
      return success({ ok: true, demo: !liveSms });
    }
    const { customerOps } = await import("@/lib/ops-api");
    const handled = await customerOps(req, user, route, () => json(req));
    if (handled) return handled;
    throw new ApiError("not_found", "مسیر درخواستی یافت نشد.", 404);
  } catch (error) { return errorResponse(error); }
}
