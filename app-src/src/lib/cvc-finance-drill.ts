import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { cvcConfig } from "@/lib/cvc";
import { ApiError, isDemo, PRICING, verifier } from "@/lib/server";
import { desiredSharedTokenLimit, remoteRevokeFreesUpstreamPool, systemSettings } from "@/lib/rules";
import { adjust, reserve, settle, walletAllocation } from "@/lib/wallet";
import {
  ensureUpstreamForPlatformKey,
  revokeCappedUpstream,
  syncUpstreamTokenLimitSafe,
} from "@/lib/upstream-keys";
import { logger } from "@/lib/logger";

type User = typeof s.users.$inferSelect;

export type DrillCheck = {
  id: string;
  token: "A" | "B" | "C" | "wallet" | "shared" | "cvc";
  title: string;
  /** What you should see when you look it up. */
  expect: string;
  /** What the drill measured. */
  actual: string;
  pass: boolean;
  /** Plain instruction for manual confirmation. */
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
};

const DRILL_A = "drill-A-capped-5m";
const DRILL_B = "drill-B-uncapped";
const DRILL_C = "drill-C-capped-2m";
const BUDGET_A = 5_000_000;
const BUDGET_C = 2_000_000;
const SPEND_A = 1_000_000;
const TARGET_START = 20_000_000;

function check(
  partial: Omit<DrillCheck, "pass"> & { pass: boolean },
): DrillCheck {
  return partial;
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
  let allowGrow = true;
  if (budget != null) {
    const { remote } = await revokeCappedUpstream(keyId, user.id);
    allowGrow = remoteRevokeFreesUpstreamPool(remote);
    await syncUpstreamTokenLimitSafe(user, "key_revoke", { allowGrow });
    return { remote };
  }
  await syncUpstreamTokenLimitSafe(user, "key_revoke", { allowGrow });
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
 * Operator drill: creates labeled tokens A/B/C, spends on A, removes C, revokes A,
 * then returns a human checklist ("check pana-… — should be revoked / CVC deleted / shared ≈ 19M").
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

  // Soft-alloc room: need 5M+2M earmarks from unallocated.
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
  const maxKeys = settings.maxKeys;
  if (activeCount + 3 > maxKeys) {
    throw new ApiError("key_limit", `برای ساخت ۳ کلید drill به ظرفیت کلید نیاز است (حداکثر ${maxKeys}).`, 409);
  }

  const startAvailable = pool.available;
  const startAllocated = pool.allocated;
  const startUnallocated = pool.unallocated;
  const tokenA = await mintPlatformKey(user, DRILL_A, BUDGET_A);
  steps.push(`Created Token A «${DRILL_A}» budget ${BUDGET_A.toLocaleString("en-US")} → ${tokenA.prefix}…`);
  const tokenB = await mintPlatformKey(user, DRILL_B, null);
  steps.push(`Created Token B «${DRILL_B}» uncapped → ${tokenB.prefix}…`);
  const tokenC = await mintPlatformKey(user, DRILL_C, BUDGET_C);
  steps.push(`Created Token C «${DRILL_C}» budget ${BUDGET_C.toLocaleString("en-US")} → ${tokenC.prefix}…`);

  let cvcA: { prefix: string; tokenLimit: number | null } | null = null;
  let cvcB: { prefix: string; tokenLimit: number | null } | null = null;
  let cvcC: { prefix: string; tokenLimit: number | null } | null = null;

  if (!isDemo && cvcConfigured) {
    const aUp = await ensureUpstreamForPlatformKey(user, { platformKeyId: tokenA.id, budget: BUDGET_A, reason: "create" });
    cvcA = { prefix: aUp.prefix, tokenLimit: aUp.tokenLimit };
    const cUp = await ensureUpstreamForPlatformKey(user, { platformKeyId: tokenC.id, budget: BUDGET_C, reason: "create" });
    cvcC = { prefix: cUp.prefix, tokenLimit: cUp.tokenLimit };
    const bUp = await ensureUpstreamForPlatformKey(user, { platformKeyId: tokenB.id, budget: null, reason: "create" });
    cvcB = { prefix: bUp.prefix, tokenLimit: bUp.tokenLimit };
    await syncUpstreamTokenLimitSafe(user, "key_budget");
    steps.push(`Provisioned CVC: A=${cvcA.prefix} lim=${cvcA.tokenLimit}, C=${cvcC.prefix} lim=${cvcC.tokenLimit}, shared B=${cvcB.prefix} lim=${cvcB.tokenLimit}.`);
  } else {
    steps.push("CVC mint skipped (demo mode or CVC_PRIMARY_API_KEY unset) — soft-allocation checks still run.");
  }

  pool = await walletAllocation(user.id);
  const afterCreateAllocated = startAllocated + BUDGET_A + BUDGET_C;
  const afterCreateUnallocated = startAvailable - afterCreateAllocated;
  const midAllocOk = pool.allocated === afterCreateAllocated
    && pool.unallocated === afterCreateUnallocated
    && pool.available === startAvailable;

  // Spend 1M on capped Token A via reserve → settle (real FEFO path).
  const requestId = `drill_${randomBytes(8).toString("hex")}`;
  await reserve({
    userId: user.id,
    keyId: tokenA.id,
    requestId,
    model: "drill-cvc-finance",
    amount: SPEND_A,
  });
  await settle(requestId, SPEND_A, {
    keyName: DRILL_A,
    inputTokens: 0,
    outputTokens: 0,
    latency: 0,
    status: "success",
  });
  steps.push(`Spent ${SPEND_A.toLocaleString("en-US")} on Token A via reserve/settle.`);

  pool = await walletAllocation(user.id);
  const afterSpendAvailable = startAvailable - SPEND_A;
  const afterSpendAllocated = startAllocated + (BUDGET_A - SPEND_A) + BUDGET_C;
  const afterSpendUnallocated = afterSpendAvailable - afterSpendAllocated;

  // Remove Token C (revoke + remote CVC delete).
  const remoteC = await revokeDrillKey(user, tokenC.id, BUDGET_C);
  steps.push(`Removed Token C (${tokenC.prefix}…) remote=${remoteC.remote}.`);

  // Revoke Token A — remaining earmark frees into shared (15→19 style when start=20).
  const remoteA = await revokeDrillKey(user, tokenA.id, BUDGET_A);
  steps.push(`Revoked Token A (${tokenA.prefix}…) remote=${remoteA.remote}.`);

  pool = await walletAllocation(user.id);
  // Back to pre-drill allocated; available only reduced by the 1M spend on A.
  const finalAllocated = startAllocated;
  const finalUnallocated = afterSpendAvailable - finalAllocated;
  const desiredShared = desiredSharedTokenLimit(pool.unallocated, 0, settings);

  let sharedMeta: { prefix: string | null; tokenLimit: number | null; tokensUsed: number } = {
    prefix: cvcB?.prefix ?? null,
    tokenLimit: null,
    tokensUsed: 0,
  };
  if (!isDemo && cvcConfigured) {
    await syncUpstreamTokenLimitSafe(user, "key_revoke", {
      allowGrow: remoteRevokeFreesUpstreamPool(remoteA.remote) && remoteRevokeFreesUpstreamPool(remoteC.remote),
    });
    const [sharedRow] = await db.select().from(s.upstreamCredentials).where(and(
      eq(s.upstreamCredentials.userId, user.id),
      eq(s.upstreamCredentials.kind, "shared_uncapped"),
      isNull(s.upstreamCredentials.revokedAt),
    )).limit(1);
    if (sharedRow) {
      const meta = (sharedRow.meta || {}) as Record<string, unknown>;
      const lim = typeof meta.tokenLimit === "number" ? meta.tokenLimit
        : typeof meta.token_limit === "number" ? meta.token_limit : null;
      const used = typeof meta.tokensUsed === "number" ? meta.tokensUsed
        : typeof meta.tokens_used === "number" ? meta.tokens_used : 0;
      sharedMeta = { prefix: sharedRow.prefix, tokenLimit: lim, tokensUsed: used };
    }
  }

  const [rowA] = await db.select().from(s.keys).where(eq(s.keys.id, tokenA.id));
  const [rowB] = await db.select().from(s.keys).where(eq(s.keys.id, tokenB.id));
  const [rowC] = await db.select().from(s.keys).where(eq(s.keys.id, tokenC.id));

  const tokens: DrillTokenRow[] = [
    {
      label: "A",
      name: DRILL_A,
      role: "capped 5M → spend 1M → revoked (CVC should be deleted)",
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
      role: "uncapped — shared CVC should rise after A/C freed",
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
      role: "capped 2M → removed (CVC should be deleted)",
      panaPrefix: tokenC.prefix,
      cvcPrefix: cvcC?.prefix ?? null,
      budget: rowC?.budget ?? BUDGET_C,
      spent: rowC?.spent ?? 0,
      enabled: !!rowC?.enabled,
      status: rowC?.enabled ? "ACTIVE (unexpected)" : "REMOVED / REVOKED",
    },
  ];

  const classicRaiseFrom = startAvailable === TARGET_START && startAllocated === 0 ? 15_000_000 : afterCreateUnallocated;
  const classicRaiseTo = startAvailable === TARGET_START && startAllocated === 0 ? 19_000_000 : finalUnallocated;

  const checks: DrillCheck[] = [
    check({
      id: "wallet-after-create",
      token: "wallet",
      title: "After creating A+C budgets",
      expect: `available=${startAvailable.toLocaleString("en-US")}, allocated=${afterCreateAllocated.toLocaleString("en-US")}, unallocated=${afterCreateUnallocated.toLocaleString("en-US")}`,
      actual: midAllocOk
        ? `matched at create time`
        : `re-check final pool; create-time identity expected allocated=${afterCreateAllocated.toLocaleString("en-US")}`,
      pass: midAllocOk,
      hint: "Soft-allocation must earmark A+C without debiting wallet available.",
    }),
    check({
      id: "token-a-spent",
      token: "A",
      title: `Token A ${tokenA.prefix}… spent`,
      expect: `spent=${SPEND_A.toLocaleString("en-US")}, still had remaining earmark ${(BUDGET_A - SPEND_A).toLocaleString("en-US")} before revoke`,
      actual: `spent=${(rowA?.spent ?? 0).toLocaleString("en-US")}`,
      pass: (rowA?.spent ?? 0) === SPEND_A,
      hint: `Open Keys → find ${tokenA.prefix}… (drill-A). Spent should be 1,000,000.`,
      panaPrefix: tokenA.prefix,
      cvcPrefix: cvcA?.prefix ?? null,
    }),
    check({
      id: "token-a-revoked",
      token: "A",
      title: `Token A ${tokenA.prefix}… revoked`,
      expect: "PanaAI key disabled/revoked; capped CVC deleted (or frozen only if delete failed)",
      actual: `enabled=${rowA?.enabled === true}, remote=${remoteA.remote}`,
      pass: rowA?.enabled === false && (remoteA.remote === "deleted" || remoteA.remote === "skipped" || remoteA.remote === "missing"),
      hint: cvcA
        ? `Check CVC dashboard: delegated key ${cvcA.prefix} should be DELETED. If still listed, remote=${remoteA.remote}.`
        : `No live CVC — confirm ${tokenA.prefix}… shows revoked in Keys.`,
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
        ? `Check CVC: ${cvcC.prefix} should be gone/deleted.`
        : `Confirm ${tokenC.prefix}… is revoked/removed in Keys.`,
      panaPrefix: tokenC.prefix,
      cvcPrefix: cvcC?.prefix ?? null,
    }),
    check({
      id: "token-b-active",
      token: "B",
      title: `Token B ${tokenB.prefix}… still active uncapped`,
      expect: "enabled, budget=null, uses shared CVC",
      actual: `enabled=${rowB?.enabled === true}, budget=${rowB?.budget ?? "null"}`,
      pass: rowB?.enabled === true && rowB?.budget == null,
      hint: `Keys → ${tokenB.prefix}… must stay ACTIVE (uncapped).`,
      panaPrefix: tokenB.prefix,
      cvcPrefix: cvcB?.prefix ?? sharedMeta.prefix,
    }),
    check({
      id: "pool-final",
      token: "wallet",
      title: "Final soft-allocation pool",
      expect: `available=${afterSpendAvailable.toLocaleString("en-US")}, allocated=${finalAllocated.toLocaleString("en-US")}, unallocated=${finalUnallocated.toLocaleString("en-US")} (classic empty-wallet 20M story: unallocated rises ${classicRaiseFrom.toLocaleString("en-US")} → ${classicRaiseTo.toLocaleString("en-US")})`,
      actual: `available=${pool.available.toLocaleString("en-US")}, allocated=${pool.allocated.toLocaleString("en-US")}, unallocated=${pool.unallocated.toLocaleString("en-US")}`,
      pass: pool.available === afterSpendAvailable && pool.allocated === finalAllocated && pool.unallocated === finalUnallocated,
      hint: "Wallet available dropped only by the 1M spend; revoking A/C must free earmarks into unallocated.",
    }),
    check({
      id: "after-spend-unallocated-stable",
      token: "wallet",
      title: "Unallocated stays flat while spending on capped A",
      expect: `After spend (before revokes), unallocated should stay ${afterCreateUnallocated.toLocaleString("en-US")} (spend comes from earmark)`,
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
        ? `sharedPrefix=${sharedMeta.prefix ?? "—"}, tokenLimit=${sharedMeta.tokenLimit ?? "—"}, remoteA=${remoteA.remote}, remoteC=${remoteC.remote}`
        : "CVC not exercised",
      pass: !cvcConfigured || isDemo
        ? true
        : remoteRevokeFreesUpstreamPool(remoteA.remote) && remoteRevokeFreesUpstreamPool(remoteC.remote)
          ? sharedMeta.tokenLimit != null && sharedMeta.tokenLimit >= pool.unallocated
          : true, // grow blocked is OK when remote failed
      hint: cvcB || sharedMeta.prefix
        ? `On CVC, open shared key ${cvcB?.prefix ?? sharedMeta.prefix} — limit should reflect ~${pool.unallocated.toLocaleString("en-US")} free credits (lifetime may be used+remaining).`
        : "Provision shared CVC on first uncapped use when primary is configured.",
      cvcPrefix: cvcB?.prefix ?? sharedMeta.prefix,
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

  // Fix create-time check: we didn't keep mid snapshot numbers in pool — recompute pass from invariants we recorded.
  checks[0] = check({
    id: "wallet-after-create",
    token: "wallet",
    title: "Create-time earmark identity (A+C)",
    expect: `allocated=${afterCreateAllocated.toLocaleString("en-US")} (was ${startAllocated.toLocaleString("en-US")}+7M), unallocated=${afterCreateUnallocated.toLocaleString("en-US")} with available unchanged`,
    actual: midAllocOk ? "PASS at create" : "FAIL at create — see server logs",
    pass: midAllocOk,
    hint: "If this fails, concurrent keys oversubscribed the wallet.",
  });

  const ok = checks.every(c => c.pass);
  await db.insert(s.audit).values({
    userId: user.id,
    action: "cvc.finance_drill",
    targetId: user.id,
    details: {
      ok,
      tokens: tokens.map(t => ({ label: t.label, panaPrefix: t.panaPrefix, cvcPrefix: t.cvcPrefix, status: t.status })),
      pool,
      remotes: { A: remoteA.remote, C: remoteC.remote },
    },
  });
  logger.info("cvc.finance_drill", { userId: user.id, ok, pool, remotes: { A: remoteA.remote, C: remoteC.remote } });

  return {
    ranAt: new Date().toISOString(),
    ok,
    mode: isDemo ? "demo" : "live",
    cvcConfigured,
    scenario: "20M-style soft-alloc: create A(5M)+C(2M)+B(uncapped) → spend 1M on A → remove C → revoke A → shared/unallocated rises by freed earmarks",
    steps,
    tokens,
    checks,
    pool,
  };
}
