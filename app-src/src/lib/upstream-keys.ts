import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { createDelegatedKey, cvcConfig, editDelegatedKey } from "@/lib/cvc";
import { ApiError, decryptImage, encryptImage } from "@/lib/server";
import { logger } from "@/lib/logger";
import { resolveCvcTokenLimit, systemSettings } from "@/lib/rules";
import { walletAllocation } from "@/lib/wallet";

type User = typeof s.users.$inferSelect;
type UpstreamRow = typeof s.upstreamCredentials.$inferSelect;
export type UpstreamKind = "capped" | "shared_uncapped";

async function encryptSecret(secret: string) {
  return encryptImage(Buffer.from(secret, "utf8"));
}

async function decryptSecret(value: string) {
  return (await decryptImage(value)).toString("utf8");
}

function prefixOf(secret: string) {
  if (secret.length <= 12) return `${secret.slice(0, 4)}…`;
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
}

function metaNumber(meta: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

let tableReady: Promise<void> | null = null;
async function ensureUpstreamTable() {
  if (!tableReady) {
    tableReady = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS platform_upstream_key_creds (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid NOT NULL REFERENCES platform_users(id),
          platform_key_id uuid REFERENCES platform_api_keys(id),
          kind text NOT NULL,
          encrypted_secret text NOT NULL,
          prefix text NOT NULL,
          upstream_ref text,
          meta jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          rotated_at timestamptz,
          revoked_at timestamptz
        )
      `);
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS upstream_shared_uncapped_active
        ON platform_upstream_key_creds (user_id)
        WHERE kind = 'shared_uncapped' AND revoked_at IS NULL
      `);
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS upstream_capped_key_active
        ON platform_upstream_key_creds (platform_key_id)
        WHERE kind = 'capped' AND platform_key_id IS NOT NULL AND revoked_at IS NULL
      `);
      // One-time bridge from the legacy per-wallet table (if present).
      await db.execute(sql`
        INSERT INTO platform_upstream_key_creds (
          user_id, platform_key_id, kind, encrypted_secret, prefix, upstream_ref, meta, created_at, rotated_at, revoked_at
        )
        SELECT
          user_id, NULL, 'shared_uncapped', encrypted_secret, prefix, upstream_ref,
          coalesce(meta, '{}'::jsonb) || '{"migratedFrom":"platform_upstream_credentials"}'::jsonb,
          created_at, rotated_at, revoked_at
        FROM platform_upstream_credentials legacy
        WHERE legacy.revoked_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM platform_upstream_key_creds cur
            WHERE cur.user_id = legacy.user_id AND cur.kind = 'shared_uncapped' AND cur.revoked_at IS NULL
          )
      `).catch(() => undefined);
    })().catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  await tableReady;
}

async function readShared(userId: string) {
  await ensureUpstreamTable();
  const [row] = await db.select().from(s.upstreamCredentials)
    .where(and(
      eq(s.upstreamCredentials.userId, userId),
      eq(s.upstreamCredentials.kind, "shared_uncapped"),
      isNull(s.upstreamCredentials.revokedAt),
    ))
    .limit(1);
  return row ?? null;
}

async function readCapped(platformKeyId: string) {
  await ensureUpstreamTable();
  const [row] = await db.select().from(s.upstreamCredentials)
    .where(and(
      eq(s.upstreamCredentials.platformKeyId, platformKeyId),
      eq(s.upstreamCredentials.kind, "capped"),
      isNull(s.upstreamCredentials.revokedAt),
    ))
    .limit(1);
  return row ?? null;
}

async function callCvcMint(user: User, opts: {
  kind: UpstreamKind;
  platformKeyId?: string;
  tokenLimit: number;
  reason: string;
}) {
  const cfg = cvcConfig();
  if (!cfg.primaryKey) {
    throw new ApiError("service_unavailable", "سرویس در حال حاضر آماده ارسال درخواست نیست. اعتباری کسر نشد.", 503);
  }
  const tokenLimit = Math.max(1, Math.floor(opts.tokenLimit));
  const nameSeed = (opts.platformKeyId || `shared-${user.id}`).replace(/-/g, "").slice(0, 16);
  const minted = await createDelegatedKey({
    name: opts.kind === "shared_uncapped" ? `pana-shared-${nameSeed}` : `pana-${nameSeed}`,
    token_limit: tokenLimit,
  });
  if (!minted.ok) {
    logger.error("upstream_key.mint_failed", {
      userId: user.id,
      kind: opts.kind,
      platformKeyId: opts.platformKeyId ?? null,
      reason: opts.reason,
      tokenLimit,
      code: minted.code,
      source: minted.source,
    });
    throw new ApiError("service_unavailable", "سرویس در حال حاضر آماده ارسال درخواست نیست. اعتباری کسر نشد.", 503);
  }
  return { minted, tokenLimit };
}

async function insertCred(user: User, opts: {
  kind: UpstreamKind;
  platformKeyId: string | null;
  tokenLimit: number;
  reason: string;
  budgetCredits?: number | null;
}): Promise<UpstreamRow> {
  const { minted, tokenLimit } = await callCvcMint(user, {
    kind: opts.kind,
    platformKeyId: opts.platformKeyId ?? undefined,
    tokenLimit: opts.tokenLimit,
    reason: opts.reason,
  });
  const encryptedSecret = await encryptSecret(minted.data.key);
  const prefix = prefixOf(minted.data.key);
  const upstreamRef = typeof minted.data.meta.id === "string"
    ? minted.data.meta.id
    : typeof minted.data.meta.key_id === "string"
      ? minted.data.meta.key_id
      : null;
  const tokensUsed = metaNumber(minted.data.meta, "tokens_used", "tokensUsed") ?? 0;
  const [row] = await db.insert(s.upstreamCredentials).values({
    userId: user.id,
    platformKeyId: opts.platformKeyId,
    kind: opts.kind,
    encryptedSecret,
    prefix,
    upstreamRef,
    meta: {
      source: minted.source,
      mintedAt: new Date().toISOString(),
      reason: opts.reason,
      tokenLimit,
      tokensUsed,
      budgetCredits: opts.budgetCredits ?? null,
      platformKeyId: opts.platformKeyId,
      kind: opts.kind,
    },
  }).returning();
  await db.insert(s.audit).values({
    userId: user.id,
    action: "upstream_key.provisioned",
    targetId: opts.platformKeyId ?? user.id,
    details: { prefix, upstreamRef, source: minted.source, reason: opts.reason, tokenLimit, kind: opts.kind },
  });
  logger.info("upstream_key.minted", {
    userId: user.id,
    kind: opts.kind,
    platformKeyId: opts.platformKeyId,
    reason: opts.reason,
    prefix,
    tokenLimit,
  });
  return row;
}

async function decryptRow(row: UpstreamRow) {
  try {
    return {
      key: await decryptSecret(row.encryptedSecret),
      prefix: row.prefix,
      created: false as const,
      tokenLimit: metaNumber(row.meta, "tokenLimit", "token_limit"),
      kind: row.kind as UpstreamKind,
    };
  } catch {
    logger.error("upstream_key.decrypt_failed", { userId: row.userId, prefix: row.prefix, kind: row.kind });
    throw new ApiError("service_unavailable", "سرویس در حال حاضر آماده ارسال درخواست نیست. اعتباری کسر نشد.", 503);
  }
}

/**
 * Resolve the CVC credential for a PanaAI platform key.
 * - Budgeted key → dedicated capped CVC key
 * - No-budget key → one shared CVC key for all uncapped keys of this user
 */
export async function ensureUpstreamForPlatformKey(
  user: User,
  opts: {
    platformKeyId: string;
    budget: number | null;
    reason?: "create" | "first_use" | "budget_change";
  },
): Promise<{ key: string; prefix: string; created: boolean; tokenLimit: number | null; kind: UpstreamKind }> {
  await ensureUpstreamTable();
  const settings = systemSettings(user.settings);
  const reason = opts.reason ?? "first_use";

  if (opts.budget != null) {
    const existing = await readCapped(opts.platformKeyId);
    if (existing) return { ...(await decryptRow(existing)), created: false };

    await db.transaction(async (tx) => {
      await tx.select().from(s.users).where(eq(s.users.id, user.id)).for("update");
    });
    const again = await readCapped(opts.platformKeyId);
    if (again) return { ...(await decryptRow(again)), created: false };

    const tokenLimit = resolveCvcTokenLimit(opts.budget, settings);
    const row = await insertCred(user, {
      kind: "capped",
      platformKeyId: opts.platformKeyId,
      tokenLimit,
      reason,
      budgetCredits: opts.budget,
    });
    return { ...(await decryptRow(row)), created: true };
  }

  // Uncapped: share one CVC key per user.
  const existing = await readShared(user.id);
  if (existing) return { ...(await decryptRow(existing)), created: false };

  await db.transaction(async (tx) => {
    await tx.select().from(s.users).where(eq(s.users.id, user.id)).for("update");
  });
  const again = await readShared(user.id);
  if (again) return { ...(await decryptRow(again)), created: false };

  const pool = await walletAllocation(user.id);
  const tokenLimit = resolveCvcTokenLimit(pool.unallocated, settings);
  const row = await insertCred(user, {
    kind: "shared_uncapped",
    platformKeyId: null,
    tokenLimit,
    reason,
    budgetCredits: pool.unallocated,
  });
  return { ...(await decryptRow(row)), created: true };
}

/** @deprecated Prefer ensureUpstreamForPlatformKey — kept for any residual callers. */
export async function ensureUserUpstreamKey(
  user: User,
  opts: { budgetCredits?: number | null; platformKeyId?: string; reason?: "create" | "first_use" } = {},
) {
  if (!opts.platformKeyId) {
    // Fall back to shared uncapped pool when no platform key is known.
    const pool = await walletAllocation(user.id);
    const settings = systemSettings(user.settings);
    const existing = await readShared(user.id);
    if (existing) return decryptRow(existing);
    const tokenLimit = resolveCvcTokenLimit(opts.budgetCredits ?? pool.unallocated, settings);
    const row = await insertCred(user, {
      kind: "shared_uncapped",
      platformKeyId: null,
      tokenLimit,
      reason: opts.reason ?? "first_use",
      budgetCredits: opts.budgetCredits ?? pool.unallocated,
    });
    return { ...(await decryptRow(row)), created: true };
  }
  return ensureUpstreamForPlatformKey(user, {
    platformKeyId: opts.platformKeyId,
    budget: opts.budgetCredits ?? null,
    reason: opts.reason,
  });
}

/** After rotate: point the capped CVC row at the new PanaAI key id (same CVC secret). */
export async function relinkCappedUpstream(oldPlatformKeyId: string, newPlatformKeyId: string, userId: string) {
  await ensureUpstreamTable();
  const existing = await readCapped(oldPlatformKeyId);
  if (!existing || existing.userId !== userId) return null;
  const [row] = await db.update(s.upstreamCredentials).set({
    platformKeyId: newPlatformKeyId,
    meta: {
      ...existing.meta,
      platformKeyId: newPlatformKeyId,
      relinkedFrom: oldPlatformKeyId,
      relinkedAt: new Date().toISOString(),
    },
    rotatedAt: new Date(),
  }).where(eq(s.upstreamCredentials.id, existing.id)).returning();
  return row ?? null;
}

/** Soft-revoke a capped upstream row when its PanaAI key is revoked (CVC delete is PRD D31). */
export async function revokeCappedUpstream(platformKeyId: string, userId: string) {
  await ensureUpstreamTable();
  const [row] = await db.update(s.upstreamCredentials).set({
    revokedAt: new Date(),
  }).where(and(
    eq(s.upstreamCredentials.userId, userId),
    eq(s.upstreamCredentials.platformKeyId, platformKeyId),
    eq(s.upstreamCredentials.kind, "capped"),
    isNull(s.upstreamCredentials.revokedAt),
  )).returning();
  return row ?? null;
}

/**
 * Sync the shared uncapped CVC token_limit to current unallocated credits.
 * Does not touch PanaAI secrets or capped per-key CVC credentials.
 */
export async function syncSharedUncappedLimit(
  user: User,
  reason: "wallet_topup" | "key_revoke" | "key_budget" | "manual" = "manual",
): Promise<{ synced: boolean; tokenLimit: number | null; previousLimit: number | null }> {
  const cfg = cvcConfig();
  if (!cfg.primaryKey) return { synced: false, tokenLimit: null, previousLimit: null };

  const row = await readShared(user.id);
  if (!row) return { synced: false, tokenLimit: null, previousLimit: null };

  const settings = systemSettings(user.settings);
  const pool = await walletAllocation(user.id);
  const desiredRemaining = resolveCvcTokenLimit(pool.unallocated, settings);
  const previousLimit = metaNumber(row.meta, "tokenLimit", "token_limit") ?? desiredRemaining;
  const tokensUsed = metaNumber(row.meta, "tokensUsed", "tokens_used") ?? 0;
  const desiredLimit = Math.max(tokensUsed + 1, tokensUsed + desiredRemaining);
  if (desiredLimit === previousLimit) {
    return { synced: false, tokenLimit: previousLimit, previousLimit };
  }

  let plaintext: string;
  try {
    plaintext = await decryptSecret(row.encryptedSecret);
  } catch {
    logger.error("upstream_key.decrypt_failed", { userId: user.id, prefix: row.prefix, reason: "sync_shared" });
    return { synced: false, tokenLimit: previousLimit, previousLimit };
  }

  const edited = desiredLimit > previousLimit
    ? await editDelegatedKey({ key: plaintext, additional_tokens: desiredLimit - previousLimit })
    : await editDelegatedKey({ key: plaintext, token_limit: Math.max(tokensUsed, desiredLimit) });

  if (!edited.ok) {
    logger.error("upstream_key.sync_failed", {
      userId: user.id,
      reason,
      kind: "shared_uncapped",
      code: edited.code,
      previousLimit,
      desiredLimit,
      unallocated: pool.unallocated,
    });
    return { synced: false, tokenLimit: previousLimit, previousLimit };
  }

  const nextLimit = metaNumber(edited.data.meta, "token_limit", "tokenLimit") ?? desiredLimit;
  const nextUsed = metaNumber(edited.data.meta, "tokens_used", "tokensUsed") ?? tokensUsed;
  await db.update(s.upstreamCredentials).set({
    meta: {
      ...row.meta,
      tokenLimit: nextLimit,
      tokensUsed: nextUsed,
      syncedAt: new Date().toISOString(),
      syncReason: reason,
      unallocatedAtSync: pool.unallocated,
    },
    rotatedAt: new Date(),
  }).where(eq(s.upstreamCredentials.id, row.id));

  await db.insert(s.audit).values({
    userId: user.id,
    action: "upstream_key.limit_synced",
    targetId: user.id,
    details: {
      reason,
      kind: "shared_uncapped",
      previousLimit,
      tokenLimit: nextLimit,
      unallocated: pool.unallocated,
      allocated: pool.allocated,
    },
  });
  logger.info("upstream_key.limit_synced", {
    userId: user.id,
    reason,
    kind: "shared_uncapped",
    previousLimit,
    tokenLimit: nextLimit,
    unallocated: pool.unallocated,
  });
  return { synced: true, tokenLimit: nextLimit, previousLimit };
}

/** Align a capped CVC key's lifetime limit with its PanaAI budget (edit, not remint). */
export async function syncCappedKeyLimit(
  user: User,
  platformKeyId: string,
  budget: number,
  reason: "key_budget" | "manual" = "key_budget",
) {
  const cfg = cvcConfig();
  if (!cfg.primaryKey) return { synced: false as const, tokenLimit: null };
  const row = await readCapped(platformKeyId);
  if (!row) return { synced: false as const, tokenLimit: null };
  const settings = systemSettings(user.settings);
  const desiredRemaining = resolveCvcTokenLimit(budget, settings);
  const previousLimit = metaNumber(row.meta, "tokenLimit", "token_limit") ?? desiredRemaining;
  const tokensUsed = metaNumber(row.meta, "tokensUsed", "tokens_used") ?? 0;
  const desiredLimit = Math.max(tokensUsed + 1, tokensUsed + desiredRemaining);
  if (desiredLimit === previousLimit) return { synced: false as const, tokenLimit: previousLimit };

  let plaintext: string;
  try {
    plaintext = await decryptSecret(row.encryptedSecret);
  } catch {
    return { synced: false as const, tokenLimit: previousLimit };
  }
  const edited = desiredLimit > previousLimit
    ? await editDelegatedKey({ key: plaintext, additional_tokens: desiredLimit - previousLimit })
    : await editDelegatedKey({ key: plaintext, token_limit: Math.max(tokensUsed, desiredLimit) });
  if (!edited.ok) {
    logger.error("upstream_key.sync_failed", { userId: user.id, kind: "capped", platformKeyId, code: edited.code, reason });
    return { synced: false as const, tokenLimit: previousLimit };
  }
  const nextLimit = metaNumber(edited.data.meta, "token_limit", "tokenLimit") ?? desiredLimit;
  const nextUsed = metaNumber(edited.data.meta, "tokens_used", "tokensUsed") ?? tokensUsed;
  await db.update(s.upstreamCredentials).set({
    meta: { ...row.meta, tokenLimit: nextLimit, tokensUsed: nextUsed, syncedAt: new Date().toISOString(), syncReason: reason },
    rotatedAt: new Date(),
  }).where(eq(s.upstreamCredentials.id, row.id));
  return { synced: true as const, tokenLimit: nextLimit };
}

/** @deprecated alias — syncs shared uncapped only */
export const syncUpstreamTokenLimit = syncSharedUncappedLimit;

export async function syncUpstreamTokenLimitSafe(user: User, reason: Parameters<typeof syncSharedUncappedLimit>[1]) {
  try {
    return await syncSharedUncappedLimit(user, reason);
  } catch (error) {
    logger.error("upstream_key.sync_exception", {
      userId: user.id,
      reason,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { synced: false, tokenLimit: null, previousLimit: null };
  }
}

export async function upstreamKeyStatus(userId: string) {
  const shared = await readShared(userId);
  if (!shared) return { provisioned: false as const };
  return {
    provisioned: true as const,
    kind: "shared_uncapped" as const,
    prefix: shared.prefix,
    upstreamRef: shared.upstreamRef,
    tokenLimit: metaNumber(shared.meta, "tokenLimit", "token_limit"),
    createdAt: shared.createdAt.toISOString(),
    rotatedAt: shared.rotatedAt?.toISOString() ?? null,
  };
}
