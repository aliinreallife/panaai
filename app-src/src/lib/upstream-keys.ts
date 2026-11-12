import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { createDelegatedKey, cvcConfig } from "@/lib/cvc";
import { ApiError, decryptImage, encryptImage } from "@/lib/server";
import { logger } from "@/lib/logger";
import { resolveCvcTokenLimit, systemSettings } from "@/lib/rules";

type User = typeof s.users.$inferSelect;

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

let tableReady: Promise<void> | null = null;
async function ensureUpstreamTable() {
  if (!tableReady) {
    tableReady = db.execute(sql`
      CREATE TABLE IF NOT EXISTS platform_upstream_credentials (
        user_id uuid PRIMARY KEY REFERENCES platform_users(id),
        encrypted_secret text NOT NULL,
        prefix text NOT NULL,
        upstream_ref text,
        meta jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        rotated_at timestamptz,
        revoked_at timestamptz
      )
    `).then(() => undefined).catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  await tableReady;
}

async function readActive(userId: string) {
  await ensureUpstreamTable();
  const [row] = await db.select().from(s.upstreamCredentials)
    .where(and(eq(s.upstreamCredentials.userId, userId), isNull(s.upstreamCredentials.revokedAt)))
    .limit(1);
  return row ?? null;
}

type MintOpts = {
  platformKeyId?: string;
  reason: "create" | "first_use";
  /** Required positive lifetime billed-token allowance — never mint unlimited. */
  tokenLimit: number;
  budgetCredits?: number | null;
};

async function callCvcMint(user: User, opts: MintOpts) {
  const cfg = cvcConfig();
  if (!cfg.primaryKey) {
    throw new ApiError("service_unavailable", "سرویس در حال حاضر آماده ارسال درخواست نیست. اعتباری کسر نشد.", 503);
  }
  const tokenLimit = Math.max(1, Math.floor(opts.tokenLimit));
  const nameSeed = (opts.platformKeyId || user.id).replace(/-/g, "").slice(0, 16);
  const minted = await createDelegatedKey({
    name: `pana-${nameSeed}`,
    token_limit: tokenLimit,
  });
  if (!minted.ok) {
    logger.error("upstream_key.mint_failed", {
      userId: user.id,
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

/**
 * Return (and create if needed) the customer's dedicated upstream runtime key.
 * Never falls back to the shared platform key for customer traffic.
 * Mint always sets a finite CVC token_limit (key budget or platform safety cap).
 */
export async function ensureUserUpstreamKey(
  user: User,
  opts: { budgetCredits?: number | null; platformKeyId?: string; reason?: "create" | "first_use" } = {},
): Promise<{ key: string; prefix: string; created: boolean; tokenLimit: number | null }> {
  const existing = await readActive(user.id);
  if (existing) {
    try {
      const storedLimit = typeof existing.meta?.tokenLimit === "number" ? existing.meta.tokenLimit : null;
      return {
        key: await decryptSecret(existing.encryptedSecret),
        prefix: existing.prefix,
        created: false,
        tokenLimit: storedLimit,
      };
    } catch {
      logger.error("upstream_key.decrypt_failed", { userId: user.id, prefix: existing.prefix });
      throw new ApiError("service_unavailable", "سرویس در حال حاضر آماده ارسال درخواست نیست. اعتباری کسر نشد.", 503);
    }
  }

  const settings = systemSettings(user.settings);
  const tokenLimit = resolveCvcTokenLimit(opts.budgetCredits, settings);
  const reason = opts.reason ?? "first_use";

  // Serialize provisioning per user so concurrent first requests do not mint many upstream keys.
  const provisioned = await db.transaction(async (tx) => {
    await tx.select().from(s.users).where(eq(s.users.id, user.id)).for("update");
    await ensureUpstreamTable();
    const [again] = await tx.select().from(s.upstreamCredentials)
      .where(and(eq(s.upstreamCredentials.userId, user.id), isNull(s.upstreamCredentials.revokedAt)))
      .limit(1);
    if (again) return { row: again, created: false as const, tokenLimit };

    const { minted, tokenLimit: applied } = await callCvcMint(user, {
      reason,
      platformKeyId: opts.platformKeyId,
      tokenLimit,
      budgetCredits: opts.budgetCredits,
    });
    const encryptedSecret = await encryptSecret(minted.data.key);
    const prefix = prefixOf(minted.data.key);
    const upstreamRef = typeof minted.data.meta.id === "string"
      ? minted.data.meta.id
      : typeof minted.data.meta.key_id === "string"
        ? minted.data.meta.key_id
        : null;
    const [row] = await tx.insert(s.upstreamCredentials).values({
      userId: user.id,
      encryptedSecret,
      prefix,
      upstreamRef,
      meta: {
        source: minted.source,
        mintedAt: new Date().toISOString(),
        reason,
        tokenLimit: applied,
        budgetCredits: opts.budgetCredits ?? null,
        platformKeyId: opts.platformKeyId ?? null,
      },
    }).returning();

    await tx.insert(s.audit).values({
      userId: user.id,
      action: "upstream_key.provisioned",
      targetId: opts.platformKeyId ?? user.id,
      details: { prefix, upstreamRef, source: minted.source, reason, tokenLimit: applied },
    });
    logger.info("upstream_key.minted", {
      userId: user.id,
      reason,
      prefix,
      tokenLimit: applied,
      budgetCredits: opts.budgetCredits ?? null,
    });
    return { row, created: true as const, tokenLimit: applied };
  });

  return {
    key: await decryptSecret(provisioned.row.encryptedSecret),
    prefix: provisioned.row.prefix,
    created: provisioned.created,
    tokenLimit: provisioned.tokenLimit,
  };
}

export async function upstreamKeyStatus(userId: string) {
  const row = await readActive(userId);
  if (!row) return { provisioned: false as const };
  return {
    provisioned: true as const,
    prefix: row.prefix,
    upstreamRef: row.upstreamRef,
    tokenLimit: typeof row.meta?.tokenLimit === "number" ? row.meta.tokenLimit : null,
    createdAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
  };
}
