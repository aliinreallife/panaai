import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { createDelegatedKey, cvcConfig, editDelegatedKey } from "@/lib/cvc";
import { ApiError, decryptImage, encryptImage } from "@/lib/server";
import { logger } from "@/lib/logger";
import { desiredCappedTokenLimit, desiredSharedTokenLimit, remoteRevokeFreesUpstreamPool, resolveCvcTokenLimit, systemSettings } from "@/lib/rules";
export { remoteRevokeFreesUpstreamPool };
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
  try {
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
  } catch (error) {
    // Unique race or DB failure after a paid CVC mint — delete the orphan upstream key.
    const deleted = await editDelegatedKey({ key: minted.data.key, delete: true });
    logger.error("upstream_key.insert_failed_orphan_cleanup", {
      userId: user.id,
      kind: opts.kind,
      platformKeyId: opts.platformKeyId,
      prefix,
      deleted: deleted.ok,
      deleteCode: deleted.ok ? null : deleted.code,
      message: error instanceof Error ? error.message : "unknown",
    });
    throw error;
  }
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

/**
 * Revoke a capped upstream row when its PanaAI key is revoked/converted.
 * Deletes (preferred) or freezes the CVC key remotely so shared rebalance cannot double-issue.
 */
export async function revokeCappedUpstream(platformKeyId: string, userId: string) {
  await ensureUpstreamTable();
  const existing = await readCapped(platformKeyId);
  if (!existing || existing.userId !== userId) return { row: null, remote: "missing" as const };

  let remote: "deleted" | "frozen" | "failed" | "skipped" = "skipped";
  const cfg = cvcConfig();
  if (cfg.primaryKey) {
    let plaintext: string | null = null;
    try {
      plaintext = await decryptSecret(existing.encryptedSecret);
    } catch {
      logger.error("upstream_key.decrypt_failed", { userId, platformKeyId, reason: "revoke_capped" });
    }
    if (plaintext) {
      const deleted = await editDelegatedKey({ key: plaintext, delete: true });
      if (deleted.ok) {
        remote = "deleted";
      } else {
        const frozen = await editDelegatedKey({ key: plaintext, active: false });
        remote = frozen.ok ? "frozen" : "failed";
        if (!frozen.ok) {
          logger.error("upstream_key.revoke_remote_failed", {
            userId,
            platformKeyId,
            deleteCode: deleted.code,
            freezeCode: frozen.code,
          });
        }
      }
    } else {
      remote = "failed";
    }
  }

  const [row] = await db.update(s.upstreamCredentials).set({
    revokedAt: new Date(),
    meta: {
      ...existing.meta,
      revokedRemote: remote,
      revokedAt: new Date().toISOString(),
    },
  }).where(and(
    eq(s.upstreamCredentials.id, existing.id),
    isNull(s.upstreamCredentials.revokedAt),
  )).returning();

  if (row) {
    await db.insert(s.audit).values({
      userId,
      action: "upstream_key.revoked",
      targetId: platformKeyId,
      details: { kind: "capped", remote, prefix: row.prefix },
    });
  }
  return { row: row ?? null, remote };
}

/** True when CVC edit reported a successful delete (HTTP 2xx; status deleted/ok/omitted). */
function cvcDeleteSucceeded(result: Awaited<ReturnType<typeof editDelegatedKey>>): boolean {
  if (!result.ok) return false;
  const status = result.data.status;
  return status == null || status === "deleted" || status === "ok";
}

/**
 * Replace a shared uncapped CVC key with a freshly minted limited one.
 * Used when local meta has no tokenLimit (legacy / unlimited remote) or when
 * CVC rejects absolute `token_limit` edits (`unlimited_token_limit`).
 *
 * Never leaves two active shared keys: if the old remote cannot be deleted,
 * the new mint is deleted and remint aborts (freeze-only is not enough).
 */
async function remintSharedUncapped(
  user: User,
  row: UpstreamRow,
  tokenLimit: number,
  reason: string,
  pool: { unallocated: number; allocated: number },
): Promise<{ ok: true; tokenLimit: number; prefix: string; previousPrefix: string } | { ok: false; code: string | null; previousPrefix?: string }> {
  const limit = Math.max(1, Math.floor(tokenLimit));
  const previousPrefix = row.prefix;
  let oldKey: string | null = null;
  try {
    oldKey = await decryptSecret(row.encryptedSecret);
  } catch {
    logger.error("upstream_key.decrypt_failed", { userId: user.id, prefix: previousPrefix, reason: "remint_shared" });
    return { ok: false, code: "decrypt_failed", previousPrefix };
  }
  if (!oldKey) return { ok: false, code: "decrypt_failed", previousPrefix };

  let minted: Awaited<ReturnType<typeof callCvcMint>>["minted"];
  try {
    ({ minted } = await callCvcMint(user, {
      kind: "shared_uncapped",
      tokenLimit: limit,
      reason: `remint:${reason}`,
    }));
  } catch {
    return { ok: false, code: "mint_failed", previousPrefix };
  }

  const deleted = await editDelegatedKey({ key: oldKey, delete: true });
  const oldGone = cvcDeleteSucceeded(deleted);
  if (!oldGone) {
    // Do not keep a second active shared key — roll back the new mint.
    const rolled = await editDelegatedKey({ key: minted.data.key, delete: true });
    if (!rolled.ok) await editDelegatedKey({ key: minted.data.key, active: false });
    // Best-effort freeze old so it cannot spend while operator deletes it on CVC.
    const frozen = await editDelegatedKey({ key: oldKey, active: false });
    logger.error("upstream_key.remint_old_cleanup", {
      userId: user.id,
      oldPrefix: previousPrefix,
      deleted: false,
      frozen: frozen.ok,
      deleteCode: deleted.ok ? deleted.data.status ?? null : deleted.code,
      freezeCode: frozen.ok ? null : frozen.code,
      newRolledBack: rolled.ok,
    });
    return { ok: false, code: deleted.ok ? "old_delete_unconfirmed" : (deleted.code ?? "old_delete_failed"), previousPrefix };
  }

  const encryptedSecret = await encryptSecret(minted.data.key);
  const prefix = prefixOf(minted.data.key);
  const upstreamRef = typeof minted.data.meta.id === "string"
    ? minted.data.meta.id
    : typeof minted.data.meta.key_id === "string"
      ? minted.data.meta.key_id
      : null;
  const tokensUsed = metaNumber(minted.data.meta, "tokens_used", "tokensUsed") ?? 0;
  const nextLimit = metaNumber(minted.data.meta, "token_limit", "tokenLimit") ?? limit;

  await db.update(s.upstreamCredentials).set({
    encryptedSecret,
    prefix,
    upstreamRef,
    meta: {
      ...row.meta,
      source: minted.source,
      remintedAt: new Date().toISOString(),
      remintReason: reason,
      previousPrefix,
      tokenLimit: nextLimit,
      tokensUsed,
      syncedAt: new Date().toISOString(),
      syncReason: reason,
      unallocatedAtSync: pool.unallocated,
      kind: "shared_uncapped",
    },
    rotatedAt: new Date(),
  }).where(eq(s.upstreamCredentials.id, row.id));

  await db.insert(s.audit).values({
    userId: user.id,
    action: "upstream_key.reminted",
    targetId: user.id,
    details: {
      reason,
      kind: "shared_uncapped",
      previousPrefix,
      prefix,
      tokenLimit: nextLimit,
      unallocated: pool.unallocated,
      allocated: pool.allocated,
      oldDeleted: true,
    },
  });
  logger.info("upstream_key.reminted", {
    userId: user.id,
    reason,
    kind: "shared_uncapped",
    previousPrefix,
    prefix,
    tokenLimit: nextLimit,
    unallocated: pool.unallocated,
    oldDeleted: true,
  });
  return { ok: true, tokenLimit: nextLimit, prefix, previousPrefix };
}

/**
 * Sync the shared uncapped CVC token_limit to current unallocated credits.
 * Does not touch PanaAI secrets or capped per-key CVC credentials.
 *
 * Grow uses `additional_tokens`. Shrink / unknown / CVC `unlimited_token_limit`
 * heals by reminting a new limited shared key (edit cannot convert unlimited → capped).
 */
export async function syncSharedUncappedLimit(
  user: User,
  reason: "wallet_topup" | "key_revoke" | "key_budget" | "manual" = "manual",
  opts: { allowGrow?: boolean } = {},
): Promise<{ synced: boolean; tokenLimit: number | null; previousLimit: number | null; healed?: boolean; code?: string | null; previousPrefix?: string | null }> {
  const cfg = cvcConfig();
  if (!cfg.primaryKey) return { synced: false, tokenLimit: null, previousLimit: null };

  const row = await readShared(user.id);
  if (!row) return { synced: false, tokenLimit: null, previousLimit: null };

  const settings = systemSettings(user.settings);
  const pool = await walletAllocation(user.id);
  const tokensUsed = metaNumber(row.meta, "tokensUsed", "tokens_used") ?? 0;
  // Never invent previousLimit from desired — a missing stored limit used to make
  // desired===previous and skip sync forever (shared meta stayed tokenLimit=—).
  const storedLimit = metaNumber(row.meta, "tokenLimit", "token_limit");
  const desiredLimit = desiredSharedTokenLimit(pool.unallocated, tokensUsed, settings);
  if (storedLimit != null && desiredLimit === storedLimit) {
    return { synced: false, tokenLimit: storedLimit, previousLimit: storedLimit };
  }
  const previousLimit = storedLimit;
  // Never raise shared while a capped CVC key may still hold upstream capacity (failed/frozen revoke).
  if (storedLimit != null && desiredLimit > storedLimit && opts.allowGrow === false) {
    logger.warn("upstream_key.sync_grow_blocked", {
      userId: user.id,
      reason,
      previousLimit: storedLimit,
      desiredLimit,
      unallocated: pool.unallocated,
    });
    return { synced: false, tokenLimit: storedLimit, previousLimit: storedLimit };
  }

  // No local limit (legacy unlimited shared) → remint a properly capped key.
  if (storedLimit == null) {
    const reminted = await remintSharedUncapped(user, row, desiredLimit, reason, pool);
    if (!reminted.ok) {
      logger.error("upstream_key.sync_failed", {
        userId: user.id,
        reason,
        kind: "shared_uncapped",
        code: reminted.code,
        previousLimit: null,
        desiredLimit,
        unallocated: pool.unallocated,
        heal: "remint",
      });
      return { synced: false, tokenLimit: null, previousLimit: null, healed: false, code: reminted.code, previousPrefix: reminted.previousPrefix ?? row.prefix };
    }
    return { synced: true, tokenLimit: reminted.tokenLimit, previousLimit: null, healed: true, previousPrefix: reminted.previousPrefix };
  }

  let plaintext: string;
  try {
    plaintext = await decryptSecret(row.encryptedSecret);
  } catch {
    logger.error("upstream_key.decrypt_failed", { userId: user.id, prefix: row.prefix, reason: "sync_shared" });
    return { synced: false, tokenLimit: storedLimit, previousLimit: storedLimit };
  }

  const growing = desiredLimit > storedLimit;
  const edited = growing
    ? await editDelegatedKey({ key: plaintext, additional_tokens: desiredLimit - storedLimit })
    : await editDelegatedKey({ key: plaintext, token_limit: Math.max(tokensUsed, desiredLimit) });

  if (!edited.ok) {
    // CVC refuses absolute token_limit on unlimited / some keys — heal by remint.
    if (edited.code === "unlimited_token_limit" || !growing) {
      const reminted = await remintSharedUncapped(user, row, desiredLimit, reason, pool);
      if (reminted.ok) {
        return { synced: true, tokenLimit: reminted.tokenLimit, previousLimit: storedLimit, healed: true, code: edited.code, previousPrefix: reminted.previousPrefix };
      }
      logger.error("upstream_key.sync_failed", {
        userId: user.id,
        reason,
        kind: "shared_uncapped",
        code: reminted.code ?? edited.code,
        previousLimit: storedLimit,
        desiredLimit,
        unallocated: pool.unallocated,
        heal: "remint_failed",
      });
      return { synced: false, tokenLimit: storedLimit, previousLimit: storedLimit, healed: false, code: reminted.code ?? edited.code, previousPrefix: reminted.previousPrefix ?? row.prefix };
    }
    logger.error("upstream_key.sync_failed", {
      userId: user.id,
      reason,
      kind: "shared_uncapped",
      code: edited.code,
      previousLimit: storedLimit,
      desiredLimit,
      unallocated: pool.unallocated,
    });
    return { synced: false, tokenLimit: storedLimit, previousLimit: storedLimit, code: edited.code };
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
      previousLimit: storedLimit,
      tokenLimit: nextLimit,
      unallocated: pool.unallocated,
      allocated: pool.allocated,
    },
  });
  logger.info("upstream_key.limit_synced", {
    userId: user.id,
    reason,
    kind: "shared_uncapped",
    previousLimit: storedLimit,
    tokenLimit: nextLimit,
    unallocated: pool.unallocated,
  });
  return { synced: true, tokenLimit: nextLimit, previousLimit: storedLimit };
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
  const tokensUsed = metaNumber(row.meta, "tokensUsed", "tokens_used") ?? 0;
  const storedLimit = metaNumber(row.meta, "tokenLimit", "token_limit");
  // Absolute lifetime from budget — never tokensUsed + budget (that over-issues after spend).
  const desiredLimit = desiredCappedTokenLimit(budget, tokensUsed, settings);
  if (storedLimit != null && desiredLimit === storedLimit) return { synced: false as const, tokenLimit: storedLimit };
  const previousLimit = storedLimit ?? desiredLimit;

  let plaintext: string;
  try {
    plaintext = await decryptSecret(row.encryptedSecret);
  } catch {
    return { synced: false as const, tokenLimit: storedLimit };
  }
  const edited = storedLimit == null || desiredLimit <= storedLimit
    ? await editDelegatedKey({ key: plaintext, token_limit: Math.max(tokensUsed, desiredLimit) })
    : await editDelegatedKey({ key: plaintext, additional_tokens: desiredLimit - storedLimit });
  if (!edited.ok) {
    logger.error("upstream_key.sync_failed", { userId: user.id, kind: "capped", platformKeyId, code: edited.code, reason });
    return { synced: false as const, tokenLimit: storedLimit };
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

export async function syncUpstreamTokenLimitSafe(
  user: User,
  reason: Parameters<typeof syncSharedUncappedLimit>[1],
  opts?: Parameters<typeof syncSharedUncappedLimit>[2],
): Promise<{ synced: boolean; tokenLimit: number | null; previousLimit: number | null; healed?: boolean; code?: string | null; previousPrefix?: string | null }> {
  try {
    return await syncSharedUncappedLimit(user, reason, opts);
  } catch (error) {
    logger.error("upstream_key.sync_exception", {
      userId: user.id,
      reason,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { synced: false, tokenLimit: null, previousLimit: null, healed: false, code: "exception" };
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
