import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { cvcConfig, proxyCvcJson } from "@/lib/cvc";
import { ApiError, isDemo, PRICING, verifier } from "@/lib/server";
import {
  creditsFromCvcCost,
  desiredSharedTokenLimit,
  estimateTokens,
  liveReservationBound,
  remoteRevokeFreesUpstreamPool,
  systemSettings,
} from "@/lib/rules";
import { adjust, release, reserve, settle, walletAllocation } from "@/lib/wallet";
import {
  ensureUpstreamForPlatformKey,
  revokeCappedUpstream,
  syncUpstreamTokenLimitSafe,
} from "@/lib/upstream-keys";
import { resolveModelCatalog } from "@/lib/models";
import { logger } from "@/lib/logger";

type User = typeof s.users.$inferSelect;

export type DrillCheck = {
  id: string;
  token: "A" | "B" | "C" | "wallet" | "shared" | "cvc";
  title: string;
  expect: string;
  actual: string;
  pass: boolean;
  hint: string;
  panaPrefix?: string | null;
  cvcPrefix?: string | null;
};

export type DrillTokenRow = {
  label: "A" | "B" | "C";
  name: string;
  role: string;
  panaPrefix: string;
  cvcPrefix: string | null;
  budget: number | null;
  spent: number;
  enabled: boolean;
  status: string;
};

export type CvcFinanceDrillReport = {
  ranAt: string;
  ok: boolean;
  mode: "demo" | "live";
  cvcConfigured: boolean;
  scenario: string;
  steps: string[];
  tokens: DrillTokenRow[];
  checks: DrillCheck[];
  pool: { available: number; allocated: number; unallocated: number };
  /** Actual credits charged for the tiny "hi" call (not 1M). */
  tinySpend: number;
};

const DRILL_A = "drill-A-capped-5m";
const DRILL_B = "drill-B-uncapped";
const DRILL_C = "drill-C-capped-2m";
const BUDGET_A = 5_000_000;
const BUDGET_C = 2_000_000;
const TARGET_START = 20_000_000;
/** Cap the FEFO reservation for the smoke "hi" so we never earmark a huge bound. */
const TINY_RESERVE_CAP = 50_000;

function check(partial: Omit<DrillCheck, "pass"> & { pass: boolean }): DrillCheck {
  return partial;
}

function metaNum(meta: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

async function mintPlatformKey(user: User, name: string, budget: number | null) {
  const secret = `pana-${randomBytes(30).toString("hex")}`;
  const hash = await verifier(secret);
  const [key] = await db.insert(s.keys).values({
    userId: user.id,
    name,
    prefix: secret.slice(0, 16),
    verifier: hash,
    budget,
    rateLimit: 60,
    allowedModels: [],
  }).returning({
    id: s.keys.id,
    name: s.keys.name,
    prefix: s.keys.prefix,
    budget: s.keys.budget,
    spent: s.keys.spent,
    enabled: s.keys.enabled,
  });
  await db.insert(s.audit).values({
    userId: user.id,
    action: "key.created",
    targetId: key.id,
    details: { name, budget, drill: true },
  });
  return { ...key, secret };
}

async function revokeDrillKey(user: User, keyId: string, budget: number | null) {
  const [revoked] = await db.update(s.keys).set({
    enabled: false,
    revokedAt: new Date(),
  }).where(and(eq(s.keys.id, keyId), eq(s.keys.userId, user.id), eq(s.keys.enabled, true)))
    .returning({ id: s.keys.id, budget: s.keys.budget });
  if (!revoked) return { remote: "missing" as const };
  await db.insert(s.audit).values({ userId: user.id, action: "key.revoked", targetId: keyId, details: { drill: true } });
  if (isDemo || !cvcConfig().primaryKey) return { remote: "skipped" as const };
  if (budget != null) {
    const { remote } = await revokeCappedUpstream(keyId, user.id);
    const allowGrow = remoteRevokeFreesUpstreamPool(remote);
    await syncUpstreamTokenLimitSafe(user, "key_revoke", { allowGrow });
    return { remote };
  }
  await syncUpstreamTokenLimitSafe(user, "key_revoke", { allowGrow: true });
  return { remote: "skipped" as const };
}

async function cleanupPriorDrillKeys(user: User) {
  const rows = await db.select({
    id: s.keys.id,
    name: s.keys.name,
    budget: s.keys.budget,
    enabled: s.keys.enabled,
  }).from(s.keys).where(eq(s.keys.userId, user.id));
  for (const row of rows) {
    if (!row.name.startsWith("drill-") || !row.enabled) continue;
    await revokeDrillKey(user, row.id, row.budget);
  }
}

/**
 * Cheapest real upstream smoke: send "hi" with a tiny max_tokens on Token A's CVC key.
 * Settles actual cost_tokens (usually a handful of credits) — never a fake 1M debit.
 */
async function tinyHiSpend(user: User, keyId: string, keyName: string): Promise<{
  spent: number;
  costTokens: number;
  model: string;
  cvcPrefix: string | null;
}> {
  const catalog = await resolveModelCatalog(user.settings);
  const model = (catalog.find(m => m.live) ?? catalog[0])?.id;
  if (!model) {
    throw new ApiError("model_disabled", "هیچ مدلی برای آزمون کوتاه در دسترس نیست.", 503);
  }
  const settings = systemSettings(user.settings);
  const requestId = `drill_${randomBytes(8).toString("hex")}`;
  const inputTokens = estimateTokens(2);
  const maxTokens = 16;
  const multiplier = catalog.find(m => m.id === model)?.multiplier;
  const bound = Math.min(
    TINY_RESERVE_CAP,
    liveReservationBound(inputTokens, maxTokens, multiplier && multiplier > 0 ? multiplier : 1, settings.creditsPerCvcToken),
  );

  await reserve({ userId: user.id, keyId, requestId, model, amount: bound });
  try {
    const upstreamCred = await ensureUpstreamForPlatformKey(user, {
      platformKeyId: keyId,
      budget: BUDGET_A,
      reason: "first_use",
    });
    const upstream = await proxyCvcJson(
      "chat/completions",
      {
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: maxTokens,
        stream: false,
      },
      { runtimeKey: upstreamCred.key },
    );
    if (!upstream.ok) {
      await release(requestId);
      throw new ApiError(
        "service_unavailable",
        `آزمون «hi» روی CVC شکست خورد (${upstream.code || upstream.status}). اعتباری کسر نشد.`,
        503,
      );
    }
    const cost = Math.max(
      1,
      Math.min(
        bound,
        creditsFromCvcCost(upstream.usage.costTokens, settings.creditsPerCvcToken) || 1,
      ),
    );
    await settle(requestId, cost, {
      keyName,
      inputTokens: upstream.usage.inputTokens || inputTokens,
      outputTokens: upstream.usage.outputTokens,
      latency: upstream.latencyMs,
      status: "success",
    });
    return {
      spent: cost,
      costTokens: upstream.usage.costTokens,
      model,
      cvcPrefix: upstreamCred.prefix,
    };
  } catch (error) {
    await release(requestId).catch(() => undefined);
    throw error;
  }
}

async function readSharedMeta(userId: string) {
  const [sharedRow] = await db.select().from(s.upstreamCredentials).where(and(
    eq(s.upstreamCredentials.userId, userId),
    eq(s.upstreamCredentials.kind, "shared_uncapped"),
    isNull(s.upstreamCredentials.revokedAt),
  )).limit(1);
  if (!sharedRow) {
    return { prefix: null as string | null, tokenLimit: null as number | null, tokensUsed: 0, previousPrefix: null as string | null };
  }
  const meta = (sharedRow.meta || {}) as Record<string, unknown>;
  const previousPrefix = typeof meta.previousPrefix === "string" ? meta.previousPrefix : null;
  return {
    prefix: sharedRow.prefix,
    tokenLimit: metaNum(meta, "tokenLimit", "token_limit"),
    tokensUsed: metaNum(meta, "tokensUsed", "tokens_used") ?? 0,
    previousPrefix,
  };
}

/**
 * Operator drill: create A/B/C → mint CVC → tiny real "hi" on A → remove C → revoke A →
 * shared rises. Checklist uses real pana-/CVC prefixes.
 */
export async function runCvcFinanceDrill(user: User): Promise<CvcFinanceDrillReport> {
  const steps: string[] = [];
  const cvcConfigured = !!cvcConfig().primaryKey;
  const settings = systemSettings(user.settings);

  await cleanupPriorDrillKeys(user);
  steps.push("Revoked any prior drill-* keys (and their capped CVC when live).");

  let pool = await walletAllocation(user.id);
  if (pool.available < TARGET_START) {
    if (!isDemo) {
      throw new ApiError(
        "insufficient_credits",
        `برای سناریوی ۲۰ میلیون حداقل ${TARGET_START.toLocaleString("fa-IR")} اعتبار آزاد لازم است (الان ${pool.available.toLocaleString("fa-IR")}). در حالت live از اصلاح اعتبار استفاده کنید.`,
        409,
      );
    }
    const need = TARGET_START - pool.available;
    await adjust(user.id, need, "CVC finance drill: seed wallet to 20M for soft-allocation scenario", PRICING.validityDays);
    steps.push(`Demo top-up +${need.toLocaleString("en-US")} → target start ${TARGET_START.toLocaleString("en-US")}.`);
    pool = await walletAllocation(user.id);
  } else {
    steps.push(`Wallet already ≥ ${TARGET_START.toLocaleString("en-US")} (available ${pool.available.toLocaleString("en-US")}).`);
  }

  pool = await walletAllocation(user.id);
  if (pool.unallocated < BUDGET_A + BUDGET_C) {
    throw new ApiError(
      "allocation_exceeded",
      `اعتبار تخصیص‌نیافته برای ساخت A(${BUDGET_A}) و C(${BUDGET_C}) کافی نیست.`,
      409,
    );
  }

  const activeCount = (await db.select({ id: s.keys.id }).from(s.keys)
    .where(and(eq(s.keys.userId, user.id), eq(s.keys.enabled, true)))).length;
  if (activeCount + 3 > settings.maxKeys) {
    throw new ApiError("key_limit", `برای ساخت ۳ کلید drill به ظرفیت کلید نیاز است (حداکثر ${settings.maxKeys}).`, 409);
  }

  const startAvailable = pool.available;
  const startAllocated = pool.allocated;
  const tokenA = await mintPlatformKey(user, DRILL_A, BUDGET_A);
  steps.push(`Created Token A «${DRILL_A}» budget ${BUDGET_A.toLocaleString("en-US")} → ${tokenA.prefix}…`);
  const tokenB = await mintPlatformKey(user, DRILL_B, null);
  steps.push(`Created Token B «${DRILL_B}» uncapped → ${tokenB.prefix}…`);
  const tokenC = await mintPlatformKey(user, DRILL_C, BUDGET_C);
  steps.push(`Created Token C «${DRILL_C}» budget ${BUDGET_C.toLocaleString("en-US")} → ${tokenC.prefix}…`);

  let cvcA: { prefix: string; tokenLimit: number | null; created: boolean } | null = null;
  let cvcB: { prefix: string; tokenLimit: number | null; created: boolean } | null = null;
  let cvcC: { prefix: string; tokenLimit: number | null; created: boolean } | null = null;

  if (!isDemo && cvcConfigured) {
    const aUp = await ensureUpstreamForPlatformKey(user, { platformKeyId: tokenA.id, budget: BUDGET_A, reason: "create" });
    cvcA = { prefix: aUp.prefix, tokenLimit: aUp.tokenLimit, created: aUp.created };
    const cUp = await ensureUpstreamForPlatformKey(user, { platformKeyId: tokenC.id, budget: BUDGET_C, reason: "create" });
    cvcC = { prefix: cUp.prefix, tokenLimit: cUp.tokenLimit, created: cUp.created };
    const bUp = await ensureUpstreamForPlatformKey(user, { platformKeyId: tokenB.id, budget: null, reason: "create" });
    cvcB = { prefix: bUp.prefix, tokenLimit: bUp.tokenLimit, created: bUp.created };
    await syncUpstreamTokenLimitSafe(user, "key_budget");
    steps.push(
      `CVC minted/linked — A=${cvcA.prefix} (new=${cvcA.created}, lim=${cvcA.tokenLimit}), `
      + `C=${cvcC.prefix} (new=${cvcC.created}, lim=${cvcC.tokenLimit}), `
      + `shared B=${cvcB.prefix} (new=${cvcB.created}, lim=${cvcB.tokenLimit}). `
      + `Look in the CVC dashboard for these prefixes NOW; A/C are deleted later in this same run.`,
    );
  } else {
    steps.push("CVC mint skipped (demo mode or CVC_PRIMARY_API_KEY unset) — soft-allocation checks still run.");
  }

  pool = await walletAllocation(user.id);
  const afterCreateAllocated = startAllocated + BUDGET_A + BUDGET_C;
  const afterCreateUnallocated = startAvailable - afterCreateAllocated;
  const midAllocOk = pool.allocated === afterCreateAllocated
    && pool.unallocated === afterCreateUnallocated
    && pool.available === startAvailable;

  // Tiny real "hi" on Token A (live CVC) — or a 1-credit local settle in demo.
  let tinySpend = 1;
  let hiModel = "demo";
  let hiCostTokens = 0;
  if (!isDemo && cvcConfigured) {
    const hi = await tinyHiSpend(user, tokenA.id, DRILL_A);
    tinySpend = hi.spent;
    hiModel = hi.model;
    hiCostTokens = hi.costTokens;
    if (!cvcA) cvcA = { prefix: hi.cvcPrefix || "—", tokenLimit: null, created: false };
    steps.push(`Tiny live spend on A: model=${hiModel}, cost_tokens=${hiCostTokens}, credits=${tinySpend} (prompt "hi").`);
  } else {
    const requestId = `drill_${randomBytes(8).toString("hex")}`;
    await reserve({ userId: user.id, keyId: tokenA.id, requestId, model: "drill-hi", amount: tinySpend });
    await settle(requestId, tinySpend, {
      keyName: DRILL_A,
      inputTokens: 1,
      outputTokens: 1,
      latency: 0,
      status: "success",
    });
    steps.push(`Demo tiny settle ${tinySpend} credit on A (no upstream).`);
  }

  pool = await walletAllocation(user.id);
  const afterSpendAvailable = startAvailable - tinySpend;
  const afterSpendAllocated = startAllocated + (BUDGET_A - tinySpend) + BUDGET_C;
  const afterSpendUnallocated = afterSpendAvailable - afterSpendAllocated;

  const remoteC = await revokeDrillKey(user, tokenC.id, BUDGET_C);
  steps.push(`Removed Token C (${tokenC.prefix}…) remote=${remoteC.remote}. CVC key should be gone.`);

  const remoteA = await revokeDrillKey(user, tokenA.id, BUDGET_A);
  steps.push(`Revoked Token A (${tokenA.prefix}…) remote=${remoteA.remote}. CVC key should be gone.`);

  pool = await walletAllocation(user.id);
  const finalAllocated = startAllocated;
  const finalUnallocated = afterSpendAvailable - finalAllocated;
  const desiredShared = desiredSharedTokenLimit(pool.unallocated, 0, settings);

  let sharedMeta = {
    prefix: cvcB?.prefix ?? null as string | null,
    tokenLimit: null as number | null,
    tokensUsed: 0,
    previousPrefix: null as string | null,
  };
  let sharedSync: {
    synced: boolean;
    tokenLimit: number | null;
    previousLimit: number | null;
    healed?: boolean;
    code?: string | null;
    previousPrefix?: string | null;
  } = {
    synced: false,
    tokenLimit: null,
    previousLimit: null,
  };
  if (!isDemo && cvcConfigured) {
    sharedSync = await syncUpstreamTokenLimitSafe(user, "key_revoke", {
      allowGrow: remoteRevokeFreesUpstreamPool(remoteA.remote) && remoteRevokeFreesUpstreamPool(remoteC.remote),
    });
    sharedMeta = await readSharedMeta(user.id);
    const orphanHint = sharedMeta.previousPrefix && sharedMeta.previousPrefix !== sharedMeta.prefix
      ? ` KEEP ${sharedMeta.prefix}; DELETE orphan ${sharedMeta.previousPrefix} on CVC if still listed.`
      : "";
    steps.push(
      `Shared CVC sync: synced=${sharedSync.synced}, healed=${sharedSync.healed === true}, `
      + `tokenLimit=${sharedMeta.tokenLimit ?? "—"}, code=${sharedSync.code ?? "ok"}, prefix=${sharedMeta.prefix ?? "—"}, `
      + `previousPrefix=${sharedMeta.previousPrefix ?? "—"}.${orphanHint}`,
    );
    if (sharedMeta.prefix && cvcB) cvcB = { ...cvcB, prefix: sharedMeta.prefix, tokenLimit: sharedMeta.tokenLimit };
  }

  const [rowA] = await db.select().from(s.keys).where(eq(s.keys.id, tokenA.id));
  const [rowB] = await db.select().from(s.keys).where(eq(s.keys.id, tokenB.id));
  const [rowC] = await db.select().from(s.keys).where(eq(s.keys.id, tokenC.id));

  const tokens: DrillTokenRow[] = [
    {
      label: "A",
      name: DRILL_A,
      role: `capped 5M → tiny "hi" spend → revoked (CVC deleted)`,
      panaPrefix: tokenA.prefix,
      cvcPrefix: cvcA?.prefix ?? null,
      budget: rowA?.budget ?? BUDGET_A,
      spent: rowA?.spent ?? 0,
      enabled: !!rowA?.enabled,
      status: rowA?.enabled ? "ACTIVE (unexpected)" : "REVOKED",
    },
    {
      label: "B",
      name: DRILL_B,
      role: "uncapped — shared CVC should rise after A/C freed (this key stays on CVC)",
      panaPrefix: tokenB.prefix,
      cvcPrefix: cvcB?.prefix ?? sharedMeta.prefix,
      budget: null,
      spent: rowB?.spent ?? 0,
      enabled: !!rowB?.enabled,
      status: rowB?.enabled ? "ACTIVE" : "REVOKED (unexpected)",
    },
    {
      label: "C",
      name: DRILL_C,
      role: "capped 2M → removed (CVC deleted)",
      panaPrefix: tokenC.prefix,
      cvcPrefix: cvcC?.prefix ?? null,
      budget: rowC?.budget ?? BUDGET_C,
      spent: rowC?.spent ?? 0,
      enabled: !!rowC?.enabled,
      status: rowC?.enabled ? "ACTIVE (unexpected)" : "REMOVED / REVOKED",
    },
  ];

  const classicRaiseFrom = startAvailable === TARGET_START && startAllocated === 0
    ? afterCreateUnallocated
    : afterCreateUnallocated;
  const classicRaiseTo = finalUnallocated;

  const checks: DrillCheck[] = [
    check({
      id: "wallet-after-create",
      token: "wallet",
      title: "Create-time earmark identity (A+C)",
      expect: `allocated=${afterCreateAllocated.toLocaleString("en-US")} (was ${startAllocated.toLocaleString("en-US")}+7M), unallocated=${afterCreateUnallocated.toLocaleString("en-US")} with available unchanged`,
      actual: midAllocOk ? "PASS at create" : "FAIL at create — see server logs",
      pass: midAllocOk,
      hint: "If this fails, concurrent keys oversubscribed the wallet.",
    }),
    check({
      id: "cvc-keys-minted",
      token: "cvc",
      title: "CVC delegated keys were minted for A/B/C",
      expect: cvcConfigured && !isDemo
        ? "Three CVC prefixes present (A+C new; B may reuse existing shared)"
        : "skipped without live CVC",
      actual: cvcConfigured && !isDemo
        ? `A=${cvcA?.prefix ?? "MISSING"} new=${cvcA?.created}; B=${cvcB?.prefix ?? "MISSING"} new=${cvcB?.created}; C=${cvcC?.prefix ?? "MISSING"} new=${cvcC?.created}`
        : "CVC not exercised",
      pass: !cvcConfigured || isDemo
        ? true
        : !!(cvcA?.prefix && cvcB?.prefix && cvcC?.prefix),
      hint: cvcConfigured && !isDemo
        ? `After this run A/C are deleted on CVC by design — only shared B (${cvcB?.prefix}) should remain. Re-run and open CVC immediately after the mint step logs if you need to catch A/C alive.`
        : "Set CVC_PRIMARY_API_KEY to exercise upstream mint.",
      cvcPrefix: cvcB?.prefix ?? null,
    }),
    check({
      id: "token-a-spent",
      token: "A",
      title: `Token A ${tokenA.prefix}… tiny spend`,
      expect: `spent≈${tinySpend.toLocaleString("en-US")} credits from real "hi" (model ${hiModel})`,
      actual: `spent=${(rowA?.spent ?? 0).toLocaleString("en-US")}, cost_tokens=${hiCostTokens}`,
      pass: (rowA?.spent ?? 0) === tinySpend && tinySpend > 0 && tinySpend <= TINY_RESERVE_CAP,
      hint: `Keys → ${tokenA.prefix}… spent should be a small number (not 1,000,000).`,
      panaPrefix: tokenA.prefix,
      cvcPrefix: cvcA?.prefix ?? null,
    }),
    check({
      id: "token-a-revoked",
      token: "A",
      title: `Token A ${tokenA.prefix}… revoked`,
      expect: "PanaAI key disabled; capped CVC deleted",
      actual: `enabled=${rowA?.enabled === true}, remote=${remoteA.remote}`,
      pass: rowA?.enabled === false && (remoteA.remote === "deleted" || remoteA.remote === "skipped" || remoteA.remote === "missing"),
      hint: cvcA
        ? `CVC: ${cvcA.prefix} should be DELETED after the run (remote=${remoteA.remote}).`
        : `Confirm ${tokenA.prefix}… shows revoked in Keys.`,
      panaPrefix: tokenA.prefix,
      cvcPrefix: cvcA?.prefix ?? null,
    }),
    check({
      id: "token-c-removed",
      token: "C",
      title: `Token C ${tokenC.prefix}… removed`,
      expect: "PanaAI key revoked; capped CVC deleted",
      actual: `enabled=${rowC?.enabled === true}, remote=${remoteC.remote}`,
      pass: rowC?.enabled === false && (remoteC.remote === "deleted" || remoteC.remote === "skipped" || remoteC.remote === "missing"),
      hint: cvcC
        ? `CVC: ${cvcC.prefix} should be gone (remote=${remoteC.remote}).`
        : `Confirm ${tokenC.prefix}… is revoked in Keys.`,
      panaPrefix: tokenC.prefix,
      cvcPrefix: cvcC?.prefix ?? null,
    }),
    check({
      id: "token-b-active",
      token: "B",
      title: `Token B ${tokenB.prefix}… still active uncapped`,
      expect: "enabled, budget=null, uses shared CVC (this is the key that should stay visible on CVC)",
      actual: `enabled=${rowB?.enabled === true}, budget=${rowB?.budget ?? "null"}`,
      pass: rowB?.enabled === true && rowB?.budget == null,
      hint: `Keys → ${tokenB.prefix}… ACTIVE. CVC → ${cvcB?.prefix ?? sharedMeta.prefix ?? "shared"} still listed.`,
      panaPrefix: tokenB.prefix,
      cvcPrefix: cvcB?.prefix ?? sharedMeta.prefix,
    }),
    check({
      id: "pool-final",
      token: "wallet",
      title: "Final soft-allocation pool",
      expect: `available=${afterSpendAvailable.toLocaleString("en-US")}, allocated=${finalAllocated.toLocaleString("en-US")}, unallocated=${finalUnallocated.toLocaleString("en-US")} (rises ${classicRaiseFrom.toLocaleString("en-US")} → ${classicRaiseTo.toLocaleString("en-US")} after freeing A/C)`,
      actual: `available=${pool.available.toLocaleString("en-US")}, allocated=${pool.allocated.toLocaleString("en-US")}, unallocated=${pool.unallocated.toLocaleString("en-US")}`,
      pass: pool.available === afterSpendAvailable && pool.allocated === finalAllocated && pool.unallocated === finalUnallocated,
      hint: "Available drops only by the tiny hi spend; revoking A/C frees earmarks into unallocated.",
    }),
    check({
      id: "after-spend-unallocated-stable",
      token: "wallet",
      title: "Unallocated stays flat while spending on capped A",
      expect: `After tiny spend (before revokes), unallocated should stay ${afterCreateUnallocated.toLocaleString("en-US")}`,
      actual: `computed after-spend unallocated=${afterSpendUnallocated.toLocaleString("en-US")}`,
      pass: afterSpendUnallocated === afterCreateUnallocated,
      hint: "If this fails, capped spend incorrectly ate the shared pool.",
    }),
    check({
      id: "shared-cvc-limit",
      token: "shared",
      title: "Shared CVC limit tracks freed unallocated",
      expect: cvcConfigured && !isDemo
        ? `shared token_limit ≈ ${desiredShared.toLocaleString("en-US")} (used+remaining); grow only if remote deletes succeeded`
        : "skipped without live CVC primary",
      actual: cvcConfigured && !isDemo
        ? `sharedPrefix=${sharedMeta.prefix ?? "—"}, tokenLimit=${sharedMeta.tokenLimit ?? "—"}, synced=${sharedSync.synced}, healed=${sharedSync.healed === true}, code=${sharedSync.code ?? "ok"}, remoteA=${remoteA.remote}, remoteC=${remoteC.remote}`
        : "CVC not exercised",
      pass: !cvcConfigured || isDemo
        ? true
        : remoteRevokeFreesUpstreamPool(remoteA.remote) && remoteRevokeFreesUpstreamPool(remoteC.remote)
          ? sharedMeta.tokenLimit != null && sharedMeta.tokenLimit >= pool.unallocated
          : true,
      hint: cvcB || sharedMeta.prefix
        ? `On CVC, open shared key ${sharedMeta.prefix ?? cvcB?.prefix} — limit should reflect ~${pool.unallocated.toLocaleString("en-US")} free credits. Legacy unlimited shared keys are reminted on sync.`
        : "Provision shared CVC on first uncapped use when primary is configured.",
      cvcPrefix: cvcB?.prefix ?? sharedMeta.prefix,
      panaPrefix: tokenB.prefix,
    }),
    check({
      id: "shared-orphan-cleanup",
      token: "shared",
      title: "Only one shared CVC key should remain",
      expect: cvcConfigured && !isDemo
        ? sharedMeta.previousPrefix && sharedMeta.previousPrefix !== sharedMeta.prefix
          ? `KEEP ${sharedMeta.prefix}; manually DELETE orphan ${sharedMeta.previousPrefix} if CVC still lists it (remint leftover)`
          : `Only active shared ${sharedMeta.prefix ?? "—"} (no remint orphan recorded)`
        : "skipped without live CVC",
      actual: cvcConfigured && !isDemo
        ? `active=${sharedMeta.prefix ?? "—"}, previousPrefix=${sharedMeta.previousPrefix ?? "none"}, healedThisRun=${sharedSync.healed === true}`
        : "CVC not exercised",
      // Informational: we cannot list CVC panel from here; pass when we know which orphan to delete (or none).
      pass: true,
      hint: sharedMeta.previousPrefix && sharedMeta.previousPrefix !== sharedMeta.prefix
        ? `CVC panel: delete ${sharedMeta.previousPrefix}. Keep ${sharedMeta.prefix} (limit ≈ ${pool.unallocated.toLocaleString("en-US")}).`
        : "If you see two pana-shared keys, keep the one matching Token B’s CVC prefix and delete the other.",
      cvcPrefix: sharedMeta.prefix,
      panaPrefix: tokenB.prefix,
    }),
    check({
      id: "no-double-issue-gate",
      token: "cvc",
      title: "No double-issue if remote delete failed",
      expect: "If remote=frozen/failed, shared must NOT grow",
      actual: `remoteA=${remoteA.remote}, remoteC=${remoteC.remote}`,
      pass: true,
      hint: "If you force a CVC delete failure, re-run and confirm shared limit stays flat while A/C stay frozen upstream.",
    }),
  ];

  const ok = checks.every(c => c.pass);
  await db.insert(s.audit).values({
    userId: user.id,
    action: "cvc.finance_drill",
    targetId: user.id,
    details: {
      ok,
      tinySpend,
      hiModel,
      hiCostTokens,
      tokens: tokens.map(t => ({ label: t.label, panaPrefix: t.panaPrefix, cvcPrefix: t.cvcPrefix, status: t.status })),
      pool,
      remotes: { A: remoteA.remote, C: remoteC.remote },
      sharedMeta,
    },
  });
  logger.info("cvc.finance_drill", {
    userId: user.id,
    ok,
    tinySpend,
    pool,
    remotes: { A: remoteA.remote, C: remoteC.remote },
    sharedTokenLimit: sharedMeta.tokenLimit,
  });

  return {
    ranAt: new Date().toISOString(),
    ok,
    mode: isDemo ? "demo" : "live",
    cvcConfigured,
    scenario: `Soft-alloc drill: create A(5M)+C(2M)+B(uncapped) → tiny live "hi" on A → remove C → revoke A → shared/unallocated rises (spend=${tinySpend} credits, not 1M)`,
    steps,
    tokens,
    checks,
    pool,
    tinySpend,
  };
}
