import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { MODEL_CATALOG } from "@/lib/shared";
import { cvcBalanceConfigured, cvcLiveDispatchEnabled, fetchCvcModels, parseCvcModels, type CvcModel } from "@/lib/cvc";
import { logger } from "@/lib/logger";

export type UiModel = {
  id: string;
  name: string;
  company: string;
  color: string;
  context: string;
  description: string;
  mark: string;
  multiplier?: number | null;
  live?: boolean;
};

export type CatalogSyncMeta = {
  syncedAt: string | null;
  count: number;
  failures: number;
  lastError: string | null;
  lastAlertAt: string | null;
  source: string | null;
};

const COLORS = ["#287e6b", "#8bb9a7", "#d8ba87", "#cad4d5", "#6b8cae", "#c49a6c", "#7a9e7e", "#9b7bb8"];
const CATALOG_KEY = "model_catalog";
const STALE_MS = 60 * 60 * 1000; // refresh owned catalog about every hour
const FAILURE_ALERT_AFTER = 2;
let memory: { at: number; models: UiModel[]; meta: CatalogSyncMeta } | null = null;
const MEMORY_MS = 30_000;

function companyFromId(id: string): { company: string; mark: string } {
  const lower = id.toLowerCase();
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3") || lower.startsWith("openai")) return { company: "OpenAI", mark: "openai" };
  if (lower.includes("claude") || lower.includes("anthropic") || lower.includes("sonnet") || lower.includes("opus") || lower.includes("haiku") || lower.includes("fable")) return { company: "Anthropic", mark: "claude" };
  if (lower.includes("gemini") || lower.includes("google")) return { company: "Google", mark: "gemini" };
  if (lower.includes("deepseek")) return { company: "DeepSeek", mark: "deepseek" };
  if (lower.includes("llama") || lower.includes("meta")) return { company: "Meta", mark: "openai" };
  if (lower.includes("mistral")) return { company: "Mistral", mark: "openai" };
  return { company: "panaAI", mark: "openai" };
}

function prettyName(id: string) {
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

export function toUiModel(row: CvcModel, index = 0): UiModel {
  const known = MODEL_CATALOG.find(m => m.id === row.id);
  if (known) return { ...known, multiplier: row.multiplier ?? row.base_multiplier ?? null, live: true };
  const { company, mark } = companyFromId(row.id);
  return {
    id: row.id,
    name: prettyName(row.id),
    company,
    color: COLORS[index % COLORS.length],
    context: "—",
    description: "مدل فعال پانا",
    mark,
    multiplier: row.multiplier ?? row.base_multiplier ?? null,
    live: true,
  };
}

function emptyMeta(): CatalogSyncMeta {
  return { syncedAt: null, count: 0, failures: 0, lastError: null, lastAlertAt: null, source: null };
}

function parseStored(value: Record<string, unknown> | null | undefined): { models: UiModel[]; meta: CatalogSyncMeta } {
  if (!value) return { models: [], meta: emptyMeta() };
  const rawModels = value.models;
  const parsed = parseCvcModels({ data: Array.isArray(rawModels) ? rawModels : [] });
  const models = parsed.map((m, i) => toUiModel(m, i));
  const meta: CatalogSyncMeta = {
    syncedAt: typeof value.syncedAt === "string" ? value.syncedAt : null,
    count: models.length,
    failures: typeof value.failures === "number" && Number.isFinite(value.failures) ? Math.max(0, Math.floor(value.failures)) : 0,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
    lastAlertAt: typeof value.lastAlertAt === "string" ? value.lastAlertAt : null,
    source: typeof value.source === "string" ? value.source : null,
  };
  return { models, meta };
}

/** Legacy per-user cache from earlier syncs — still usable as a soft fallback. */
export function catalogFromSettings(settings: Record<string, unknown>): UiModel[] {
  const raw = settings["cvc:catalog"] ?? settings["platform:catalog"];
  if (typeof raw !== "string" || !raw) return [];
  try {
    return parseCvcModels(JSON.parse(raw)).map((m, i) => toUiModel(m, i));
  } catch {
    return [];
  }
}

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

export async function readPlatformCatalog(): Promise<{ models: UiModel[]; meta: CatalogSyncMeta }> {
  if (memory && Date.now() - memory.at < MEMORY_MS) return { models: memory.models, meta: memory.meta };
  try {
    await ensurePlatformStateTable();
    const [row] = await db.select().from(s.platformState).where(eq(s.platformState.key, CATALOG_KEY)).limit(1);
    const parsed = parseStored(row?.value);
    memory = { at: Date.now(), models: parsed.models, meta: parsed.meta };
    return parsed;
  } catch (error) {
    logger.warn("catalog.read_failed", { error });
    return { models: [], meta: emptyMeta() };
  }
}

async function writePlatformCatalog(value: Record<string, unknown>) {
  await ensurePlatformStateTable();
  const now = new Date();
  await db.insert(s.platformState).values({ key: CATALOG_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: s.platformState.key, set: { value, updatedAt: now } });
  memory = null;
}

async function notifyOperators(alert: { kind: string; severity: string; title: string; message: string }) {
  const { raiseAlert } = await import("@/lib/provider");
  const operators = await db.select().from(s.users).where(eq(s.users.role, "owner")).limit(10);
  const targets = operators.length ? operators : (await db.select().from(s.users).limit(1));
  for (const user of targets) {
    try {
      await raiseAlert(user, alert);
    } catch (error) {
      logger.error("catalog.alert_failed", { error, userId: user.id });
    }
  }
}

/**
 * Pull upstream models into the platform-owned catalog.
 * On success: replace snapshot and reset failure counter.
 * On failure: keep last good snapshot, increment failures; alert after 2 consecutive fails.
 */
export async function syncPlatformCatalog(opts: { reason?: string; force?: boolean } = {}) {
  const current = await readPlatformCatalog();
  if (!cvcBalanceConfigured()) {
    return { ok: false as const, reason: "not_configured", meta: current.meta, models: current.models };
  }

  const fetched = await fetchCvcModels();
  if (!fetched.ok || !fetched.data.length) {
    const failures = current.meta.failures + 1;
    const lastError = fetched.ok ? "empty_catalog" : (fetched.code || fetched.source || "sync_failed");
    let lastAlertAt = current.meta.lastAlertAt;
    const value = {
      models: current.models.map(m => ({ id: m.id, multiplier: m.multiplier ?? null })),
      syncedAt: current.meta.syncedAt,
      failures,
      lastError,
      lastAlertAt,
      source: current.meta.source,
      updatedAt: new Date().toISOString(),
      reason: opts.reason ?? "sync",
    };
    if (failures >= FAILURE_ALERT_AFTER) {
      await notifyOperators({
        kind: "catalog.sync_failed",
        severity: failures >= 3 ? "critical" : "warning",
        title: "همگام‌سازی فهرست مدل‌ها ناموفق بود",
        message: `همگام‌سازی فهرست مدل‌های پانا ${failures} بار پشت‌سرهم شکست خورد (${lastError}). مشتریان همچنان آخرین فهرست موفق را می‌بینند.`,
      });
      lastAlertAt = new Date().toISOString();
      value.lastAlertAt = lastAlertAt;
    }
    await writePlatformCatalog(value);
    const meta = { ...current.meta, failures, lastError, lastAlertAt };
    logger.warn("catalog.sync_failed", { failures, lastError, reason: opts.reason });
    const [anyUser] = await db.select({ id: s.users.id }).from(s.users).limit(1);
    if (anyUser) await db.insert(s.audit).values({ userId: anyUser.id, action: "provider.models_sync_failed", details: { failures, lastError, reason: opts.reason ?? "sync" } });
    return { ok: false as const, reason: lastError, meta, models: current.models };
  }

  const models = fetched.data.map((m, i) => toUiModel(m, i));
  const syncedAt = new Date().toISOString();
  await writePlatformCatalog({
    models: fetched.data.map(m => ({
      id: m.id,
      multiplier: m.multiplier ?? m.base_multiplier ?? null,
      object: m.object,
      owned_by: m.owned_by,
      base_multiplier: m.base_multiplier,
      claude_provider: m.claude_provider,
    })),
    syncedAt,
    failures: 0,
    lastError: null,
    lastAlertAt: null,
    source: fetched.source,
    updatedAt: syncedAt,
    reason: opts.reason ?? "sync",
  });
  memory = { at: Date.now(), models, meta: { syncedAt, count: models.length, failures: 0, lastError: null, lastAlertAt: null, source: fetched.source } };
  logger.info("catalog.synced", { count: models.length, source: fetched.source, reason: opts.reason });
  const [anyUser] = await db.select({ id: s.users.id }).from(s.users).limit(1);
  if (anyUser) await db.insert(s.audit).values({ userId: anyUser.id, action: "provider.models_synced", details: { count: models.length, source: fetched.source, reason: opts.reason ?? "sync" } });
  return { ok: true as const, reason: "synced", meta: memory.meta, models };
}

function isStale(meta: CatalogSyncMeta) {
  if (!meta.syncedAt) return true;
  const at = Date.parse(meta.syncedAt);
  if (!Number.isFinite(at)) return true;
  return Date.now() - at >= STALE_MS;
}

/**
 * Source of truth for customer/admin model lists: the platform-owned snapshot.
 * Refreshes from upstream when missing/stale (~hourly). Never exposes supplier names.
 */
export async function resolveModelCatalog(settings: Record<string, unknown> = {}): Promise<UiModel[]> {
  if (!cvcBalanceConfigured()) {
    return MODEL_CATALOG.map(m => ({ ...m, live: false }));
  }

  let { models, meta } = await readPlatformCatalog();
  if ((!models.length || isStale(meta)) && cvcBalanceConfigured()) {
    const synced = await syncPlatformCatalog({ reason: models.length ? "stale_refresh" : "bootstrap" });
    models = synced.models;
    meta = synced.meta;
  }

  if (models.length) return models.map(m => ({ ...m, live: true }));

  const fromSettings = catalogFromSettings(settings);
  if (fromSettings.length) return fromSettings;

  return MODEL_CATALOG.map(m => ({ ...m, live: false }));
}

export function modelIds(catalog: UiModel[]) {
  return catalog.map(m => m.id);
}

export function liveCatalogActive() {
  return cvcLiveDispatchEnabled() || cvcBalanceConfigured();
}

export async function catalogSyncStatus() {
  const { meta, models } = await readPlatformCatalog();
  return { ...meta, count: models.length, stale: isStale(meta) };
}
