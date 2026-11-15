import "server-only";
import { db } from "@/db";
import * as s from "@/db/schema";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { ApiError, encryptImage, decryptImage, isDemo, sha, verifier } from "@/lib/server";
import { systemSettings } from "@/lib/rules";
import { walletAllocation } from "@/lib/wallet";
import { logger } from "@/lib/logger";

const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})(\/[\w./\-?]*)?$/i;
const SESSION_TTL_MS = 30 * 60_000;
const EXCHANGE_TTL_MS = 5 * 60_000;

let tableReady: Promise<void> | null = null;

export async function ensureConnectSessionsTable() {
  if (!tableReady) {
    tableReady = db.execute(sql`
      CREATE TABLE IF NOT EXISTS platform_connect_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        client_state text NOT NULL UNIQUE,
        redirect_uri text NOT NULL,
        user_id uuid REFERENCES platform_users(id),
        product text NOT NULL DEFAULT 'panacode',
        key_name text NOT NULL DEFAULT 'Panacode',
        budget bigint,
        rate_limit integer NOT NULL DEFAULT 60,
        status text NOT NULL DEFAULT 'pending',
        exchange_code_hash text,
        encrypted_secret text,
        key_id uuid REFERENCES platform_api_keys(id),
        key_prefix text,
        expires_at timestamptz NOT NULL DEFAULT now(),
        consumed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS connect_sessions_user_idx ON platform_connect_sessions(user_id);
      CREATE INDEX IF NOT EXISTS connect_sessions_expiry_idx ON platform_connect_sessions(expires_at);
    `).then(() => undefined).catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  await tableReady;
}

export function parseLoopbackRedirect(redirectUri: string) {
  const match = LOOPBACK_RE.exec(redirectUri.trim());
  if (!match) throw new ApiError("invalid_redirect", "آدرس بازگشت باید روی http://127.0.0.1 یا localhost باشد.", 400);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError("invalid_redirect", "پورت بازگشت معتبر نیست.", 400);
  return { redirectUri: redirectUri.trim(), port };
}

export async function upsertConnectSession(input: {
  clientState: string;
  redirectUri: string;
  product?: string;
  keyName?: string;
  budget?: number | null;
  rateLimit?: number;
  userId?: string | null;
}) {
  await ensureConnectSessionsTable();
  parseLoopbackRedirect(input.redirectUri);
  if (!/^[A-Za-z0-9._~-]{8,128}$/.test(input.clientState)) {
    throw new ApiError("invalid_state", "پارامتر state نامعتبر است.", 400);
  }
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const keyName = (input.keyName || "Panacode").trim().slice(0, 50) || "Panacode";
  const rateLimit = Math.min(300, Math.max(1, input.rateLimit ?? 60));
  const budget = input.budget === undefined ? null : input.budget;
  if (budget != null && (!Number.isInteger(budget) || budget <= 0 || budget > 1_000_000_000_000)) {
    throw new ApiError("invalid_budget", "سقف بودجه معتبر نیست.", 400);
  }

  const [existing] = await db.select().from(s.connectSessions)
    .where(eq(s.connectSessions.clientState, input.clientState)).limit(1);

  if (existing?.consumedAt || existing?.status === "exchanged") {
    throw new ApiError("state_used", "این درخواست اتصال قبلاً مصرف شده است. از Panacode دوباره شروع کنید.", 409);
  }
  if (existing && existing.expiresAt < new Date()) {
    throw new ApiError("state_expired", "نشست اتصال منقضی شده است. از Panacode دوباره شروع کنید.", 410);
  }

  if (existing) {
    const [row] = await db.update(s.connectSessions).set({
      redirectUri: input.redirectUri.trim(),
      product: input.product || existing.product || "panacode",
      keyName,
      budget,
      rateLimit,
      userId: input.userId ?? existing.userId,
      status: existing.status === "ready" ? existing.status : (input.userId ? "awaiting_options" : existing.status),
      expiresAt,
    }).where(eq(s.connectSessions.id, existing.id)).returning();
    return row;
  }

  const [row] = await db.insert(s.connectSessions).values({
    clientState: input.clientState,
    redirectUri: input.redirectUri.trim(),
    product: input.product || "panacode",
    keyName,
    budget,
    rateLimit,
    userId: input.userId ?? null,
    status: input.userId ? "awaiting_options" : "pending",
    expiresAt,
  }).returning();
  return row;
}

export async function getConnectSessionByState(clientState: string) {
  await ensureConnectSessionsTable();
  const [row] = await db.select().from(s.connectSessions)
    .where(eq(s.connectSessions.clientState, clientState)).limit(1);
  return row ?? null;
}

export async function attachConnectUser(clientState: string, userId: string) {
  await ensureConnectSessionsTable();
  const session = await getConnectSessionByState(clientState);
  if (!session) throw new ApiError("connect_not_found", "نشست اتصال یافت نشد.", 404);
  if (session.expiresAt < new Date()) throw new ApiError("state_expired", "نشست اتصال منقضی شده است.", 410);
  if (session.consumedAt) throw new ApiError("state_used", "این نشست قبلاً مصرف شده است.", 409);
  const [row] = await db.update(s.connectSessions).set({
    userId,
    status: session.status === "ready" ? "ready" : "awaiting_options",
  }).where(eq(s.connectSessions.id, session.id)).returning();
  return row;
}

export type ConnectCreditGate = {
  ok: boolean;
  reason?: "no_credit" | "allocation_exceeded";
  available: number;
  unallocated: number;
  allocated: number;
  requiredBudget: number | null;
};

export async function evaluateConnectCredits(userId: string, budget: number | null): Promise<ConnectCreditGate> {
  const pool = await walletAllocation(userId);
  if (pool.available <= 0) {
    return { ok: false, reason: "no_credit", ...pool, requiredBudget: budget };
  }
  if (budget != null && budget > pool.unallocated) {
    return { ok: false, reason: "allocation_exceeded", ...pool, requiredBudget: budget };
  }
  return { ok: true, ...pool, requiredBudget: budget };
}

/** Mint key + seal one-time exchange code. Does not redirect. */
export async function completeConnectSession(input: {
  clientState: string;
  user: typeof s.users.$inferSelect;
  keyName?: string;
  budget?: number | null;
  rateLimit?: number;
}) {
  await ensureConnectSessionsTable();
  const session = await getConnectSessionByState(input.clientState);
  if (!session) throw new ApiError("connect_not_found", "نشست اتصال یافت نشد.", 404);
  if (session.expiresAt < new Date()) throw new ApiError("state_expired", "نشست اتصال منقضی شده است.", 410);
  if (session.consumedAt || session.status === "exchanged") {
    throw new ApiError("state_used", "این نشست قبلاً مصرف شده است.", 409);
  }
  if (session.userId && session.userId !== input.user.id) {
    throw new ApiError("connect_forbidden", "این نشست به حساب دیگری تعلق دارد.", 403);
  }

  const keyName = (input.keyName ?? session.keyName).trim().slice(0, 50) || "Panacode";
  const rateLimit = Math.min(300, Math.max(1, input.rateLimit ?? session.rateLimit ?? 60));
  const budget = input.budget !== undefined ? input.budget : session.budget;

  const gate = await evaluateConnectCredits(input.user.id, budget ?? null);
  if (!gate.ok) {
    await db.update(s.connectSessions).set({
      userId: input.user.id,
      keyName,
      budget: budget ?? null,
      rateLimit,
      status: "awaiting_credit",
    }).where(eq(s.connectSessions.id, session.id));
    throw new ApiError(
      gate.reason === "no_credit" ? "insufficient_credits" : "allocation_exceeded",
      gate.reason === "no_credit"
        ? "اعتباری در کیف پول ندارید. ابتدا اعتبار بخرید، سپس برای تکمیل اتصال بازگردید."
        : `سقف بودجه از اعتبار تخصیص‌نیافته (${gate.unallocated.toLocaleString("fa-IR")}) بیشتر است.`,
      402,
    );
  }

  const secret = `pana-${randomBytes(30).toString("hex")}`;
  const hash = await verifier(secret);
  const exchangeCode = randomBytes(24).toString("base64url");
  const exchangeCodeHash = sha(exchangeCode);
  const encryptedSecret = await encryptImage(Buffer.from(secret, "utf8"));

  const created = await db.transaction(async (tx) => {
    await tx.select().from(s.users).where(eq(s.users.id, input.user.id)).for("update");
    const existing = await tx.select({ id: s.keys.id }).from(s.keys)
      .where(and(eq(s.keys.userId, input.user.id), eq(s.keys.enabled, true)));
    const maxKeys = systemSettings(input.user.settings).maxKeys;
    if (existing.length >= maxKeys) {
      throw new ApiError("key_limit", `حداکثر ${maxKeys.toLocaleString("fa-IR")} کلید فعال مجاز است.`);
    }
    const [key] = await tx.insert(s.keys).values({
      userId: input.user.id,
      name: keyName,
      budget: budget ?? null,
      rateLimit,
      allowedModels: [],
      prefix: secret.slice(0, 16),
      verifier: hash,
    }).returning({ id: s.keys.id, name: s.keys.name, prefix: s.keys.prefix });

    await tx.update(s.connectSessions).set({
      userId: input.user.id,
      keyName,
      budget: budget ?? null,
      rateLimit,
      status: "ready",
      exchangeCodeHash,
      encryptedSecret,
      keyId: key.id,
      keyPrefix: key.prefix,
      expiresAt: new Date(Date.now() + EXCHANGE_TTL_MS),
    }).where(and(eq(s.connectSessions.id, session.id), isNull(s.connectSessions.consumedAt)));

    await tx.insert(s.audit).values({
      userId: input.user.id,
      action: "connect.panacode.completed",
      targetId: key.id,
      details: { product: session.product, budget: budget ?? null, rateLimit, connectSessionId: session.id },
    });
    return key;
  });

  if (!isDemo) {
    try {
      const { cvcConfig } = await import("@/lib/cvc");
      if (cvcConfig().primaryKey) {
        const { ensureUpstreamForPlatformKey, syncUpstreamTokenLimitSafe } = await import("@/lib/upstream-keys");
        await ensureUpstreamForPlatformKey(input.user, {
          platformKeyId: created.id,
          budget: budget ?? null,
          reason: "create",
        });
        if (budget == null) await syncUpstreamTokenLimitSafe(input.user, "key_budget");
      }
    } catch (error) {
      logger.error("connect.panacode.upstream_failed", { userId: input.user.id, keyId: created.id, error });
    }
  }

  const callback = new URL(session.redirectUri);
  callback.searchParams.set("code", exchangeCode);
  callback.searchParams.set("state", session.clientState);

  return {
    redirectUrl: callback.toString(),
    keyId: created.id,
    prefix: created.prefix,
    budget: budget ?? null,
    rateLimit,
    name: keyName,
    expiresIn: Math.floor(EXCHANGE_TTL_MS / 1000),
  };
}

export async function exchangeConnectCode(input: { code: string; state: string }) {
  await ensureConnectSessionsTable();
  if (!input.code || input.code.length > 200) throw new ApiError("invalid_code", "کد تبادل معتبر نیست.", 400);
  const session = await getConnectSessionByState(input.state);
  if (!session) throw new ApiError("connect_not_found", "نشست اتصال یافت نشد.", 404);
  if (session.expiresAt < new Date()) throw new ApiError("state_expired", "کد تبادل منقضی شده است.", 410);
  if (session.consumedAt || session.status === "exchanged") {
    throw new ApiError("state_used", "این کد قبلاً مصرف شده است.", 409);
  }
  if (session.status !== "ready" || !session.exchangeCodeHash || !session.encryptedSecret) {
    throw new ApiError("connect_not_ready", "اتصال هنوز آماده نیست.", 409);
  }
  if (session.exchangeCodeHash !== sha(input.code)) {
    throw new ApiError("invalid_code", "کد تبادل نادرست است.", 401);
  }

  const [updated] = await db.update(s.connectSessions).set({
    status: "exchanged",
    consumedAt: new Date(),
    encryptedSecret: null,
    exchangeCodeHash: null,
  }).where(and(
    eq(s.connectSessions.id, session.id),
    eq(s.connectSessions.status, "ready"),
    isNull(s.connectSessions.consumedAt),
  )).returning();

  if (!updated) throw new ApiError("state_used", "این کد قبلاً مصرف شده است.", 409);

  const secret = (await decryptImage(session.encryptedSecret)).toString("utf8");
  if (session.userId) {
    await db.insert(s.audit).values({
      userId: session.userId,
      action: "connect.panacode.exchanged",
      targetId: session.keyId || session.id,
      details: { product: session.product },
    });
  }

  return {
    secret,
    keyId: session.keyId,
    prefix: session.keyPrefix,
    name: session.keyName,
    budget: session.budget,
    rateLimit: session.rateLimit,
    baseURL: "/v1",
  };
}

export async function connectStatusForUser(clientState: string, userId: string) {
  const session = await getConnectSessionByState(clientState);
  if (!session) throw new ApiError("connect_not_found", "نشست اتصال یافت نشد.", 404);
  if (session.userId && session.userId !== userId) {
    throw new ApiError("connect_forbidden", "این نشست به حساب دیگری تعلق دارد.", 403);
  }
  const gate = await evaluateConnectCredits(userId, session.budget);
  return {
    id: session.id,
    status: session.status,
    product: session.product,
    keyName: session.keyName,
    budget: session.budget,
    rateLimit: session.rateLimit,
    expiresAt: session.expiresAt.toISOString(),
    credit: gate,
    ready: session.status === "ready",
  };
}
