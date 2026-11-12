import "server-only";
import { db } from "@/db";
import * as s from "@/db/schema";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { isDemo } from "@/lib/server";
import { PROVIDER_STATE_INFO, nextProviderState, systemSettings, type ProviderState } from "@/lib/rules";

type User = typeof s.users.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const SYNC_INTERVAL_MS = 30000;
const SANDBOX_START_BALANCE = 250000000;

/** Outstanding customer liability in credits (unexpired remaining credits). */
async function liabilities(tx: Tx | typeof db, userId: string) {
  const [row] = await tx.select({ total: sql<string>`coalesce(sum(${s.lots.remaining}), 0)` }).from(s.lots).where(and(eq(s.lots.userId, userId), gt(s.lots.expiresAt, new Date())));
  return Number(row.total);
}

/**
 * Balance source. In live mode the reseller runtime key calls GET /v1/balance
 * (see src/lib/cvc.ts). Legacy CVC_BALANCE_URL + CVC_API_KEY still works.
 * Until configured, the provider stays `unverified` and the gateway fails closed.
 * The sandbox uses an operator-controlled simulator.
 */
async function observeBalance(stored: number | null): Promise<{ balance: number | null; source: string }> {
  if (isDemo) return { balance: stored, source: "sandbox_simulator" };
  const { cvcBalanceConfigured, fetchCvcBalance } = await import("@/lib/cvc");
  if (!cvcBalanceConfigured()) return { balance: null, source: "not_configured" };
  const result = await fetchCvcBalance();
  if (result.ok) return { balance: result.data, source: result.source };
  return { balance: null, source: result.source };
}

export async function ensureProviderRow(userId: string) {
  await db.insert(s.providerState).values({ userId, state: isDemo ? "healthy" : "unverified", balance: isDemo ? SANDBOX_START_BALANCE : null, source: isDemo ? "sandbox_simulator" : "not_configured" }).onConflictDoNothing();
}

/**
 * Evaluate the state machine. Called lazily (at most every 30 s per account, or when forced)
 * from data loads, the gateway admission check and admin actions. Transitions are row-locked,
 * recorded in audit, and raise alerts that fan out to the configured channels.
 */
export async function evaluateProvider(user: User, opts: { force?: boolean; balance?: number | null; outage?: boolean; paused?: boolean; reason?: string } = {}) {
  await ensureProviderRow(user.id);
  const outcome = await db.transaction(async tx => {
    const [row] = await tx.select().from(s.providerState).where(eq(s.providerState.userId, user.id)).for("update");
    const stale = !row.checkedAt || Date.now() - row.checkedAt.getTime() > SYNC_INTERVAL_MS;
    const graceExpired = row.state === "grace" && row.graceUntil && row.graceUntil <= new Date();
    if (!opts.force && !stale && !graceExpired && opts.balance === undefined && opts.paused === undefined) return { row, changed: false, from: row.state };
    const observed = opts.outage ? { balance: null, source: "sandbox_simulated_outage" }
      : opts.balance !== undefined ? { balance: opts.balance, source: isDemo ? "sandbox_simulator" : "manual_unverified" }
      : row.source === "sandbox_simulated_outage" && opts.paused === undefined ? { balance: null, source: row.source }
      : await observeBalance(row.balance);
    const observationStale = observed.balance === null && observed.source !== "not_configured";
    const paused = opts.paused ?? row.paused;
    const result = nextProviderState({ current: row.state as ProviderState, balance: observed.balance, liabilities: await liabilities(tx, user.id), paused, graceUntil: row.graceUntil, now: new Date(), graceMinutes: systemSettings(user.settings).graceMinutes, stale: observationStale });
    const [updated] = await tx.update(s.providerState).set({ state: result.state, balance: observed.balance, source: observed.source, paused, graceUntil: result.graceUntil, checkedAt: new Date(), coverageTier: result.tier, ...(result.changed ? { changedAt: new Date() } : {}) }).where(eq(s.providerState.userId, user.id)).returning();
    if (result.changed) await tx.insert(s.audit).values({ userId: user.id, action: "provider.state_changed", details: { from: row.state, to: result.state, balance: observed.balance, tier: result.tier, source: observed.source, reason: opts.reason ?? null } });
    if (result.tier !== row.coverageTier && result.tier !== null && row.coverageTier !== null && result.tier < row.coverageTier) await tx.insert(s.audit).values({ userId: user.id, action: "provider.coverage_dropped", details: { from: row.coverageTier, to: result.tier } });
    return { row: updated, changed: result.changed, from: row.state, tierDropped: result.tier !== null && row.coverageTier !== null && result.tier < row.coverageTier ? { from: row.coverageTier, to: result.tier } : null };
  });
  if (outcome.changed) await raiseAlert(user, alertForTransition(outcome.from as ProviderState, outcome.row.state as ProviderState, outcome.row.balance));
  if ("tierDropped" in outcome && outcome.tierDropped) await raiseAlert(user, { kind: "coverage", severity: outcome.tierDropped.to === 0 ? "critical" : "warning", title: `پوشش ذخیره به ${outcome.tierDropped.to}٪ رسید`, message: `پوشش موجودی تأمین‌کننده نسبت به تعهد اعتبار مشتریان از ${outcome.tierDropped.from}٪ به ${outcome.tierDropped.to}٪ کاهش یافت.` });
  const row = outcome.row;
  const info = PROVIDER_STATE_INFO[row.state as ProviderState];
  return { state: row.state as ProviderState, admits: info.admits, balance: row.balance, source: row.source, paused: row.paused, graceUntil: row.graceUntil?.toISOString() ?? null, checkedAt: row.checkedAt?.toISOString() ?? null, changedAt: row.changedAt.toISOString(), coverageTier: row.coverageTier, simulated: row.source === "sandbox_simulator" };
}

function alertForTransition(from: ProviderState, to: ProviderState, balance: number | null) {
  const severity = to === "zero" || to === "paused" ? "critical" : to === "grace" || to === "low" || to === "unverified" ? "warning" : "info";
  return { kind: `provider.${to}`, severity, title: `وضعیت تأمین‌کننده: ${PROVIDER_STATE_INFO[from].label} ← ${PROVIDER_STATE_INFO[to].label}`, message: `${PROVIDER_STATE_INFO[to].customer} موجودی مشاهده‌شده: ${balance === null ? "نامشخص" : balance.toLocaleString("en-US")} اعتبار.` };
}

/* ------------------------------------------------------------------ */
/* Alerts and delivery channels                                         */
/* ------------------------------------------------------------------ */
type Delivery = { channel: string; status: string; at: string; detail?: string };
export function channelConfig(user: User) {
  const st = user.settings;
  return {
    dashboard: true,
    telegram: { enabled: st["alerts:telegram"] === true, chatId: String(st["alerts:telegramChatId"] || ""), configured: !!process.env.TELEGRAM_BOT_TOKEN },
    email: { enabled: st["alerts:email"] === true, to: String(st["alerts:emailTo"] || ""), configured: !!process.env.RESEND_API_KEY && !!process.env.ALERT_EMAIL_FROM },
  };
}

/** Telegram Bot API sendMessage. Token stays server-side; only metadata is recorded. */
async function sendTelegram(chatId: string, text: string): Promise<Delivery> {
  const at = new Date().toISOString();
  if (!process.env.TELEGRAM_BOT_TOKEN) return { channel: "telegram", status: "not_configured", at, detail: "TELEGRAM_BOT_TOKEN تنظیم نشده" };
  if (!chatId) return { channel: "telegram", status: "not_configured", at, detail: "شناسه گفت‌وگو تنظیم نشده" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(5000) });
    return { channel: "telegram", status: res.ok ? "sent" : "failed", at, detail: res.ok ? undefined : `HTTP ${res.status}` };
  } catch { return { channel: "telegram", status: "failed", at, detail: "خطای شبکه" }; }
}
/** Resend email API (POST /emails). */
async function sendEmail(to: string, subject: string, text: string): Promise<Delivery> {
  const at = new Date().toISOString();
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL_FROM) return { channel: "email", status: "not_configured", at, detail: "RESEND_API_KEY یا ALERT_EMAIL_FROM تنظیم نشده" };
  if (!to) return { channel: "email", status: "not_configured", at, detail: "نشانی گیرنده تنظیم نشده" };
  try {
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: process.env.ALERT_EMAIL_FROM, to: [to], subject, text }), signal: AbortSignal.timeout(5000) });
    return { channel: "email", status: res.ok ? "sent" : "failed", at, detail: res.ok ? undefined : `HTTP ${res.status}` };
  } catch { return { channel: "email", status: "failed", at, detail: "خطای شبکه" }; }
}

export async function raiseAlert(user: User, alert: { kind: string; severity: string; title: string; message: string }, opts: { test?: boolean } = {}) {
  const [fresh] = await db.select().from(s.users).where(eq(s.users.id, user.id)).limit(1);
  const channels = channelConfig(fresh ?? user);
  const deliveries: Delivery[] = [{ channel: "dashboard", status: "sent", at: new Date().toISOString() }];
  const text = `[PanaAI${isDemo ? " sandbox" : ""}] ${alert.title}\n${alert.message}`;
  if (channels.telegram.enabled || opts.test) deliveries.push(await sendTelegram(channels.telegram.chatId, text));
  if (channels.email.enabled || opts.test) deliveries.push(await sendEmail(channels.email.to, alert.title, text));
  const [row] = await db.insert(s.alerts).values({ userId: user.id, ...alert, deliveries }).returning();
  return row;
}

export async function listAlerts(userId: string) {
  return db.select().from(s.alerts).where(eq(s.alerts.userId, userId)).orderBy(desc(s.alerts.createdAt)).limit(50);
}
