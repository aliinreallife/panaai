import "server-only";
import { db } from "@/db";
import * as s from "@/db/schema";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { createHash, randomBytes, createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MODEL_CATALOG } from "@/lib/shared";
import { getUsageReport } from "@/lib/analytics";
import { tehranDay } from "@/lib/report-utils";
import { customerSystemSettings, isOperator, systemSettings } from "@/lib/rules";

/** Default FX: 275,000 تومان/USD (= 2,750,000 ریال). Override via admin → pricing (platform-wide). */
export const PRICING = { rateIrr: 2_750_000, minToman: 50_000, maxToman: 5_000_000, version: "fx-275k-v1", validityDays: 365 };
export const isDemo = process.env.PLATFORM_MODE !== "live";
/**
 * Sandbox workspaces are customer accounts by default. Set SANDBOX_OPERATOR_ACCESS=true (internal
 * previews and tests only) to make each new sandbox workspace the operator of its own data.
 */
export const sandboxOperatorAccess = isDemo && process.env.SANDBOX_OPERATOR_ACCESS === "true";
/** Opt-in fake wallet/usage for local tests only. Production and normal sandbox stay empty. */
export const sandboxSeedDemo = isDemo && process.env.SANDBOX_SEED_DEMO === "true";
export async function pricingFor(user: typeof s.users.$inferSelect) {
  const system = systemSettings(user.settings);
  const { readPlatformPricing } = await import("@/lib/platform-pricing");
  const platform = await readPlatformPricing();
  // Prefer platform-wide FX; fall back to legacy per-account override, then code default.
  const legacyRate = Number(user.settings.fxRateIrr || 0);
  const legacyMin = Number(user.settings.minToman || 0);
  const legacyMax = Number(user.settings.maxToman || 0);
  return {
    ...PRICING,
    creditsPerUsd: system.creditsPerUsd,
    rateIrr: platform.rateIrr || legacyRate || PRICING.rateIrr,
    minToman: platform.minToman || legacyMin || PRICING.minToman,
    maxToman: platform.maxToman || legacyMax || PRICING.maxToman,
    version: platform.version || String(user.settings.priceVersion || PRICING.version),
  };
}
export const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400, public retryAfter?: number) { super(message); }
}
export function sandboxOnly() {
  if (!isDemo) throw new ApiError("service_not_open", "ثبت‌نام و خرید اعتبار هنوز باز نشده است. به‌زودی از همین‌جا اطلاع‌رسانی می‌شود.", 503);
}
const future = (days: number) => new Date(Date.now() + days * 86400000);

let keyPromise: Promise<Buffer> | null = null;
export async function privateKey() {
  const configured = process.env.RECEIPT_ENCRYPTION_KEY?.trim();
  if (configured) {
    if (!/^[a-f0-9]{64}$/i.test(configured)) throw new ApiError("storage_unavailable", "تنظیمات رمزگذاری معتبر نیست.", 503);
    return Buffer.from(configured, "hex");
  }
  sandboxOnly();
  // Serverless hosts (Vercel) have no persistent disk: a generated key would change per instance.
  if (process.env.VERCEL) throw new ApiError("storage_unavailable", "RECEIPT_ENCRYPTION_KEY باید در تنظیمات میزبان تعریف شود.", 503);
  if (!keyPromise) keyPromise = (async () => {
    const directory = path.join(process.cwd(), ".private");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, "sandbox.key");
    try { return await readFile(filename); } catch { /* Create once; never expose through HTTP. */ }
    try { await writeFile(filename, randomBytes(32), { flag: "wx", mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return readFile(filename);
  })();
  return keyPromise;
}
export async function verifier(secret: string) { return createHmac("sha256", await privateKey()).update(secret).digest("hex"); }
export async function encryptImage(image: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await privateKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(image), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}
export async function decryptImage(value: string) {
  const b = Buffer.from(value, "base64");
  const cipher = createDecipheriv("aes-256-gcm", await privateKey(), b.subarray(0, 12));
  cipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]);
}

export async function limit(key: string, max = 60, period = 60000) {
  const bucket = `${sha(key)}:${Math.floor(Date.now() / period)}`;
  const [row] = await db.insert(s.rateBuckets).values({ key: bucket, expiresAt: new Date(Date.now() + period) }).onConflictDoUpdate({ target: s.rateBuckets.key, set: { count: sql`${s.rateBuckets.count} + 1` } }).returning();
  if (row.count > max) throw new ApiError("rate_limit_exceeded", "تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.", 429, Math.max(1, Math.ceil(((Math.floor(Date.now() / period) + 1) * period - Date.now()) / 1000)));
}
export async function getSession() {
  const token = (await cookies()).get("platform_session")?.value;
  if (!token) return null;
  const [session] = await db.select().from(s.sessions).where(and(eq(s.sessions.tokenHash, sha(token)), gt(s.sessions.expiresAt, new Date()))).limit(1);
  return session ?? null;
}
export async function getUser() {
  const session = await getSession();
  if (!session) return null;
  const [user] = await db.select().from(s.users).where(eq(s.users.id, session.userId)).limit(1);
  // Live mode never serves sandbox workspaces or their sample data, even if an old cookie survives.
  if (!user || (!isDemo && user.demo)) return null;
  return user;
}
export async function requireUser() {
  const user = await getUser();
  if (!user) throw new ApiError("unauthorized", "نشست شما منقضی شده است؛ صفحه را دوباره بارگذاری کنید.", 401);
  return user;
}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Fake wallet/keys/usage used only when SANDBOX_SEED_DEMO=true (CI / local test harness). */
async function seedDemoWorkspace(tx: Tx, userId: string) {
  const now = new Date();
  const seededOrders = await tx.insert(s.orders).values([
    { userId, reference: `CR-${randomBytes(3).toString("hex").toUpperCase()}`, amountIrr: 360000, rateIrr: PRICING.rateIrr, credits: 8000000, state: "approved_and_credited", transferDeadline: future(-352), approvedAt: future(-353), createdAt: future(-353) },
    { userId, reference: `CR-${randomBytes(3).toString("hex").toUpperCase()}`, amountIrr: 540000, rateIrr: PRICING.rateIrr, credits: 12000000, state: "approved_and_credited", transferDeadline: future(-57), approvedAt: future(-58), createdAt: future(-58) },
  ]).returning();
  const seededLots = await tx.insert(s.lots).values([
    { userId, orderId: seededOrders[0].id, granted: 8000000, remaining: 2480000, expiresAt: future(12), createdAt: future(-353) },
    { userId, orderId: seededOrders[1].id, granted: 12000000, remaining: 10000000, expiresAt: future(307), createdAt: future(-58) },
  ]).returning();
  for (const lot of seededLots) {
    const grantId = `seed-grant-${lot.id}`;
    const [grant] = await tx.insert(s.walletEvents).values({ userId, lotId: lot.id, type: "grant", delta: lot.granted, description: "خرید اعتبار نمونه ـ کارت‌به‌کارت", idempotencyKey: grantId, createdAt: lot.createdAt }).returning();
    const [consume] = await tx.insert(s.walletEvents).values({ userId, lotId: lot.id, type: "consume", delta: -(lot.granted - lot.remaining), description: "مصرف نمونه در دوره جاری", idempotencyKey: `seed-consume-${lot.id}`, createdAt: future(-1) }).returning();
    await tx.insert(s.journal).values([
      { eventId: grant.id, account: `customer:${userId}`, delta: lot.granted },
      { eventId: grant.id, account: "issuer:demo", delta: -lot.granted },
      { eventId: consume.id, account: `customer:${userId}`, delta: consume.delta },
      { eventId: consume.id, account: "consumed:demo", delta: -consume.delta },
    ]);
  }
  const sampleNames = ["پروژه اصلی", "محیط توسعه", "دستیار شخصی"];
  for (let i = 0; i < 3; i++) {
    await tx.insert(s.keys).values({ userId, name: sampleNames[i], prefix: `sk_test_${randomBytes(3).toString("hex")}`, verifier: sha(randomBytes(32)), spent: [5100000, 1800000, 620000][i], budget: i === 2 ? 5000000 : null, rateLimit: i === 1 ? 30 : 60, createdAt: future(-28 + i * 4), lastUsedAt: new Date(now.getTime() - i * 3600000) });
  }
  const weights = [12, 16, 14, 17, 13, 28, 32, 30, 34, 29, 19, 20, 18, 24, 21, 30, 34, 36, 33, 39, 38, 41, 44, 40, 46, 29, 32, 28, 35, 31];
  const total = weights.reduce((a, b) => a + b, 0);
  let allocated = 0, requestsAllocated = 0;
  const days = weights.map((weight, i) => {
    const credits = i === 29 ? 7520000 - allocated : Math.floor(weight / total * 7520000);
    const requests = i === 29 ? 1284 - requestsAllocated : Math.floor(weight / total * 1284);
    allocated += credits; requestsAllocated += requests;
    return { userId, day: tehranDay(future(i - 29)), credits, requests, errors: i % 3 === 0 ? 1 : 0 };
  });
  await tx.insert(s.usageDaily).values(days);
  const requestRows: (typeof s.usage.$inferInsert)[] = [];
  for (const [dayIndex, day] of days.entries()) {
    const start = new Date(`${day.day}T00:00:00+03:30`).getTime();
    const end = Math.min(start + 86400000, now.getTime() - 1000);
    const dayWeights = Array.from({ length: day.requests }, (_, i) => i < day.errors ? 0 : [1, 1.1, 1.2, 1.1][i % 20 < 9 ? 0 : i % 20 < 15 ? 1 : i % 20 < 18 ? 2 : 3]);
    const totalWeight = dayWeights.reduce((a, b) => a + b, 0);
    let charged = 0;
    for (let i = 0; i < day.requests; i++) {
      const modelIndex = i % 20 < 9 ? 0 : i % 20 < 15 ? 1 : i % 20 < 18 ? 2 : 3;
      const credits = i === day.requests - 1 ? day.credits - charged : Math.floor(day.credits * dayWeights[i] / totalWeight);
      charged += credits;
      requestRows.push({ userId, requestId: `req_${randomBytes(8).toString("hex")}`, keyName: sampleNames[(i + dayIndex) % 3], model: MODEL_CATALOG[modelIndex].id, credits, inputTokens: 420 + (i * 173) % 2000, outputTokens: i < day.errors ? 0 : 240 + (i * 137) % 1400, latency: 810 + (i * 157) % 2400, status: i < day.errors ? "error" : "success", createdAt: new Date(start + (i + 1) / (day.requests + 1) * Math.max(1, end - start)) });
    }
  }
  for (let i = 0; i < requestRows.length; i += 300) await tx.insert(s.usage).values(requestRows.slice(i, i + 300));
  for (const name of sampleNames) {
    const requests = requestRows.filter(row => row.keyName === name);
    await tx.update(s.keys).set({ spent: requests.reduce((a, row) => a + Number(row.credits), 0), lastUsedAt: new Date(Math.max(...requests.map(row => new Date(row.createdAt as Date).getTime()))) }).where(and(eq(s.keys.userId, userId), eq(s.keys.name, name)));
  }
}

export async function createSandbox() {
  sandboxOnly();
  const token = randomBytes(32).toString("hex");
  const user = await db.transaction(async tx => {
    const [user] = await tx.insert(s.users).values({ name: "کاربر", demo: true, role: sandboxOperatorAccess ? "owner" : "customer" }).returning();
    await tx.insert(s.sessions).values({ tokenHash: sha(token), userId: user.id, expiresAt: future(7) });
    if (sandboxSeedDemo) await seedDemoWorkspace(tx, user.id);
    await tx.insert(s.audit).values({
      userId: user.id,
      action: "sandbox.created",
      details: {
        demo: true,
        seeded: sandboxSeedDemo,
        note: sandboxSeedDemo
          ? "محیط آزمایشی با دادهٔ نمونه برای آزمون ساخته شد."
          : "فضای کاری خالی ساخته شد؛ بدون موجودی، کلید یا مصرف نمونه.",
      },
    });
    return user;
  });
  return { user, token };
}
/** Audit events a customer may see (their own payments, receipts, keys). Internal/ops events stay admin-only. */
const CUSTOMER_AUDIT = /^(payment|receipt|order|key|refund|ticket|settings)\./;
export async function dataFor(user: typeof s.users.$inferSelect) {
  const { ensureDefaults } = await import("@/lib/ops-api");
  const { evaluateProvider } = await import("@/lib/provider");
  await ensureDefaults(user);
  const { resolveModelCatalog } = await import("@/lib/models");
  const [provider, packageRows, refundRows, models] = await Promise.all([
    evaluateProvider(user),
    db.select().from(s.packages).where(and(eq(s.packages.userId, user.id), eq(s.packages.active, true))).orderBy(asc(s.packages.sort)),
    db.select().from(s.refunds).where(eq(s.refunds.userId, user.id)).orderBy(desc(s.refunds.createdAt)),
    resolveModelCatalog(user.settings),
  ]);
  const own = <T>(column: T) => eq(column as unknown as typeof s.keys.userId, user.id);
  const [keyRows, orderRows, lotRows, eventRows, analytics, usageRows, auditRows, ticketRows] = await Promise.all([
    db.select({ id: s.keys.id, name: s.keys.name, prefix: s.keys.prefix, enabled: s.keys.enabled, budget: s.keys.budget, rateLimit: s.keys.rateLimit, allowedModels: s.keys.allowedModels, spent: s.keys.spent, createdAt: s.keys.createdAt, lastUsedAt: s.keys.lastUsedAt }).from(s.keys).where(own(s.keys.userId)).orderBy(desc(s.keys.createdAt)),
    db.select().from(s.orders).where(own(s.orders.userId)).orderBy(desc(s.orders.createdAt)),
    db.select().from(s.lots).where(own(s.lots.userId)).orderBy(asc(s.lots.expiresAt)),
    db.select().from(s.walletEvents).where(own(s.walletEvents.userId)).orderBy(desc(s.walletEvents.createdAt)).limit(100),
    getUsageReport(user.id),
    db.select().from(s.usage).where(own(s.usage.userId)).orderBy(desc(s.usage.createdAt)).limit(100),
    db.select().from(s.audit).where(own(s.audit.userId)).orderBy(desc(s.audit.createdAt)).limit(100),
    db.select().from(s.tickets).where(own(s.tickets.userId)).orderBy(desc(s.tickets.createdAt)),
  ]);
  const eligible = lotRows.filter(l => l.expiresAt > new Date() && l.remaining > 0);
  return { user: { id: user.id, name: user.name, demo: user.demo, createdAt: user.createdAt, settings: user.settings }, analytics, keys: keyRows, orders: orderRows, lots: lotRows, events: eventRows, daily: analytics.daily, usage: usageRows, audit: auditRows.filter(a => isOperator(user.role) || CUSTOMER_AUDIT.test(a.action)).map(a => ({ ...a, details: a.action.startsWith("payment.") ? { from: a.details.from, to: a.details.to, reasonCode: a.details.reasonCode, customerMessage: a.details.customerMessage } : {} })), tickets: ticketRows,
    wallet: { available: eligible.reduce((a,l) => a+l.remaining-l.reserved,0), reserved: eligible.reduce((a,l) => a+l.reserved,0), expiring7: eligible.filter(l => l.expiresAt < future(7)).reduce((a,l) => a+l.remaining,0), expiring: eligible.filter(l => l.expiresAt < future(30)).reduce((a,l) => a+l.remaining,0), nearestExpiry: eligible[0]?.expiresAt ?? null },
    // Customer payload: service state only. Balance, source and supplier details stay in admin routes.
    service: { state: provider.state, admits: provider.admits, checkedAt: provider.checkedAt },
    account: { state: user.state, role: isOperator(user.role) ? user.role : "customer", operator: isOperator(user.role) },
    mode: isDemo ? "sandbox" as const : "live" as const,
    models,
    packages: packageRows.map(p => ({ id: p.id, label: p.label, subtitle: p.subtitle, amountToman: p.amountToman, icon: p.icon, featured: p.featured })),
    refunds: refundRows,
    // Wholesale upstream rate stays off the customer payload.
    system: isOperator(user.role) ? systemSettings(user.settings) : customerSystemSettings(user.settings),
    pricing: await pricingFor(user),
    payments: await (async () => {
      const { formatCardNumber, readDestinationCard } = await import("@/lib/payments");
      const dest = await readDestinationCard();
      return { destinationCard: dest.cardNumber, destinationCardFormatted: formatCardNumber(dest.cardNumber) };
    })(),
    updatedAt: new Date().toISOString() };
}
