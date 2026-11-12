import "server-only";
import { db } from "@/db";
import * as s from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";

const KEY = "pricing.fx";

/** Default FX: 275,000 toman per USD = 2,750,000 rial. Admin can change anytime. */
export const DEFAULT_FX_RATE_IRR = 2_750_000;
export const DEFAULT_MIN_TOMAN = 50_000;
export const DEFAULT_MAX_TOMAN = 5_000_000;
export const DEFAULT_PRICE_VERSION = "fx-275k-v1";

export type PlatformPricing = {
  rateIrr: number;
  minToman: number;
  maxToman: number;
  version: string;
};

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

function asInt(value: unknown, fallback: number) {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function defaultPlatformPricing(): PlatformPricing {
  return {
    rateIrr: DEFAULT_FX_RATE_IRR,
    minToman: DEFAULT_MIN_TOMAN,
    maxToman: DEFAULT_MAX_TOMAN,
    version: DEFAULT_PRICE_VERSION,
  };
}

export async function readPlatformPricing(): Promise<PlatformPricing> {
  const fallback = defaultPlatformPricing();
  try {
    await ensurePlatformStateTable();
    const [row] = await db.select().from(s.platformState).where(eq(s.platformState.key, KEY)).limit(1);
    if (!row?.value) return fallback;
    const rateIrr = asInt(row.value.rateIrr, fallback.rateIrr);
    const minToman = asInt(row.value.minToman, fallback.minToman);
    const maxToman = asInt(row.value.maxToman, fallback.maxToman);
    const version = typeof row.value.version === "string" && row.value.version ? row.value.version : fallback.version;
    if (maxToman < minToman) return fallback;
    return { rateIrr, minToman, maxToman, version };
  } catch (error) {
    logger.warn("pricing.fx_read_failed", { error });
    return fallback;
  }
}

export async function writePlatformPricing(input: { rateIrr: number; minToman: number; maxToman: number; version?: string }) {
  await ensurePlatformStateTable();
  const version = input.version || `fx-${Date.now()}`;
  const value = {
    rateIrr: input.rateIrr,
    minToman: input.minToman,
    maxToman: input.maxToman,
    version,
    updatedAt: new Date().toISOString(),
  };
  const now = new Date();
  await db.insert(s.platformState).values({ key: KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: s.platformState.key, set: { value, updatedAt: now } });
  return { rateIrr: input.rateIrr, minToman: input.minToman, maxToman: input.maxToman, version };
}
