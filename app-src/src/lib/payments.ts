import "server-only";
import { db } from "@/db";
import * as s from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { ApiError } from "@/lib/server";
import { logger } from "@/lib/logger";

const KEY = "payments.destination";
/** Temporary default destination card; change anytime from admin. */
export const DEFAULT_DESTINATION_CARD = "6219861917179755";

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

export function normalizeCardNumber(raw: string) {
  return raw.replace(/\D/g, "");
}

export function formatCardNumber(raw: string) {
  const digits = normalizeCardNumber(raw);
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
}

export function assertValidCardNumber(raw: string) {
  const digits = normalizeCardNumber(raw);
  // Iranian bank cards are typically 16 digits; allow 16–19 for flexibility.
  if (!/^\d{16,19}$/.test(digits)) throw new ApiError("invalid_card", "شماره کارت مقصد باید ۱۶ تا ۱۹ رقم باشد.");
  return digits;
}

export async function readDestinationCard(): Promise<{ cardNumber: string; configured: boolean }> {
  try {
    await ensurePlatformStateTable();
    const [row] = await db.select().from(s.platformState).where(eq(s.platformState.key, KEY)).limit(1);
    const stored = typeof row?.value?.cardNumber === "string" ? normalizeCardNumber(row.value.cardNumber) : "";
    if (/^\d{16,19}$/.test(stored)) return { cardNumber: stored, configured: true };
  } catch (error) {
    logger.warn("payments.destination_read_failed", { error });
  }
  return { cardNumber: DEFAULT_DESTINATION_CARD, configured: true };
}

export async function writeDestinationCard(raw: string) {
  const cardNumber = assertValidCardNumber(raw);
  await ensurePlatformStateTable();
  const value = { cardNumber, updatedAt: new Date().toISOString() };
  const now = new Date();
  await db.insert(s.platformState).values({ key: KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: s.platformState.key, set: { value, updatedAt: now } });
  return { cardNumber, configured: true };
}
