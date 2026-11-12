import "server-only";
import { db } from "@/db";
import * as s from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { kavenegarConfigured } from "@/lib/kavenegar";
import { logger } from "@/lib/logger";

const STATS_KEY = "sms.otp.stats";

export type SmsOtpStats = {
  sent: number;
  succeeded: number;
  failed: number;
  verified: number;
  costRial: number;
  lastSentAt: string | null;
  lastError: string | null;
  provider: "kavenegar" | "demo";
  configured: boolean;
  templateConfigured: boolean;
};

const empty = (): SmsOtpStats => ({
  sent: 0,
  succeeded: 0,
  failed: 0,
  verified: 0,
  costRial: 0,
  lastSentAt: null,
  lastError: null,
  provider: kavenegarConfigured() ? "kavenegar" : "demo",
  configured: kavenegarConfigured(),
  templateConfigured: Boolean(process.env.KAVENEGAR_OTP_TEMPLATE?.trim()),
});

let tableReady: Promise<void> | null = null;
async function ensurePlatformStateTable() {
  if (!tableReady) {
    tableReady = db.execute(sql`
      CREATE TABLE IF NOT EXISTS platform_state (
        key text PRIMARY KEY,
        value jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `).then(() => undefined).catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  await tableReady;
}

function parse(value: Record<string, unknown> | undefined): SmsOtpStats {
  const base = empty();
  if (!value) return base;
  return {
    sent: Math.max(0, Number(value.sent) || 0),
    succeeded: Math.max(0, Number(value.succeeded) || 0),
    failed: Math.max(0, Number(value.failed) || 0),
    verified: Math.max(0, Number(value.verified) || 0),
    costRial: Math.max(0, Number(value.costRial) || 0),
    lastSentAt: typeof value.lastSentAt === "string" ? value.lastSentAt : null,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
    provider: kavenegarConfigured() ? "kavenegar" : "demo",
    configured: kavenegarConfigured(),
    templateConfigured: Boolean(process.env.KAVENEGAR_OTP_TEMPLATE?.trim()),
  };
}

export async function readSmsOtpStats(): Promise<SmsOtpStats> {
  try {
    await ensurePlatformStateTable();
    const [row] = await db.select().from(s.platformState).where(eq(s.platformState.key, STATS_KEY)).limit(1);
    return parse(row?.value);
  } catch (error) {
    logger.warn("sms.stats_read_failed", { error });
    return empty();
  }
}

async function writeStats(next: SmsOtpStats) {
  await ensurePlatformStateTable();
  const value = {
    sent: next.sent,
    succeeded: next.succeeded,
    failed: next.failed,
    verified: next.verified,
    costRial: next.costRial,
    lastSentAt: next.lastSentAt,
    lastError: next.lastError,
  };
  const now = new Date();
  await db.insert(s.platformState).values({ key: STATS_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: s.platformState.key, set: { value, updatedAt: now } });
}

export async function recordSmsSend(result: { ok: boolean; costRial?: number; error?: string }) {
  const current = await readSmsOtpStats();
  const next: SmsOtpStats = {
    ...current,
    sent: current.sent + 1,
    succeeded: current.succeeded + (result.ok ? 1 : 0),
    failed: current.failed + (result.ok ? 0 : 1),
    costRial: current.costRial + Math.max(0, result.costRial || 0),
    lastSentAt: new Date().toISOString(),
    lastError: result.ok ? null : (result.error || "ارسال ناموفق"),
    provider: kavenegarConfigured() ? "kavenegar" : "demo",
    configured: kavenegarConfigured(),
    templateConfigured: Boolean(process.env.KAVENEGAR_OTP_TEMPLATE?.trim()),
  };
  await writeStats(next);
  return next;
}

export async function recordSmsVerified() {
  const current = await readSmsOtpStats();
  const next = { ...current, verified: current.verified + 1 };
  await writeStats(next);
  return next;
}
