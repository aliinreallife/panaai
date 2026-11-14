// Pure business rules shared by server and client. No imports, so the file can be
// unit-tested directly with Node's type stripping (see scripts/rules-check.mjs).

/* ------------------------------------------------------------------ */
/* Provider (CVC) balance state machine                                */
/* ------------------------------------------------------------------ */
export type ProviderState = "healthy" | "low" | "grace" | "zero" | "paused" | "resuming" | "unverified";
/**
 * `label`/`customer` are internal (admin) wording. Customers only ever see `service` and `notice`,
 * which describe panaAI's own API service and never mention an upstream supplier or its balance.
 */
export const PROVIDER_STATE_INFO: Record<ProviderState, { label: string; tone: string; admits: boolean; customer: string; service: string; notice: string }> = {
  healthy: { label: "سالم", tone: "success", admits: true, customer: "درخواست‌های API به‌طور عادی پذیرفته می‌شوند.", service: "فعال", notice: "درخواست‌های API به‌طور عادی پذیرفته می‌شوند." },
  low: { label: "پوشش کم", tone: "warning", admits: true, customer: "درخواست‌ها پذیرفته می‌شوند؛ تیم عملیات در حال تأمین موجودی است.", service: "فعال", notice: "درخواست‌های API به‌طور عادی پذیرفته می‌شوند." },
  grace: { label: "دوره ارفاق", tone: "warning", admits: true, customer: "موجودی تأمین‌کننده به پایان رسیده و درخواست‌ها فقط تا پایان دوره کوتاه ارفاق پذیرفته می‌شوند.", service: "فعال", notice: "درخواست‌ها پذیرفته می‌شوند؛ ممکن است سرویس به‌زودی برای مدت کوتاهی محدود شود." },
  zero: { label: "موجودی صفر", tone: "danger", admits: false, customer: "ارسال درخواست API موقتاً متوقف است و پس از تأمین موجودی خودکار ادامه می‌یابد.", service: "موقتاً در دسترس نیست", notice: "سرویس API موقتاً در دسترس نیست و به‌زودی به‌طور خودکار ادامه می‌یابد." },
  paused: { label: "توقف دستی", tone: "danger", admits: false, customer: "ارسال درخواست API توسط تیم عملیات موقتاً متوقف شده است.", service: "در حال نگهداری", notice: "سرویس API برای نگهداری موقتاً متوقف شده است." },
  resuming: { label: "در حال ازسرگیری", tone: "info", admits: true, customer: "موجودی تأمین شد و پذیرش درخواست‌ها از سر گرفته شده است.", service: "فعال", notice: "سرویس API دوباره فعال شده است." },
  unverified: { label: "تأییدنشده", tone: "warning", admits: false, customer: "اتصال تأمین‌کننده هنوز تأیید نشده و درخواستی ارسال نمی‌شود.", service: "به‌زودی", notice: "سرویس API هنوز فعال نشده است. به‌محض فعال‌شدن، از همین کلیدها می‌توانید استفاده کنید." },
};
export type ProviderInput = { current: ProviderState; balance: number | null; liabilities: number; paused: boolean; graceUntil: Date | null; now: Date; graceMinutes: number; /** balance check failed (timeout/invalid) rather than never configured */ stale?: boolean };
export type ProviderOutcome = { state: ProviderState; graceUntil: Date | null; tier: number | null; changed: boolean };

/** Coverage tier (100/75/25/0) of verified provider balance against outstanding customer credits. */
export function coverageTier(balance: number | null, liabilities: number): number | null {
  if (balance === null) return null;
  if (balance <= 0) return 0;
  if (liabilities <= 0) return 100;
  const ratio = balance / liabilities * 100;
  return ratio >= 100 ? 100 : ratio >= 75 ? 75 : ratio >= 25 ? 25 : 0;
}

/**
 * Deterministic transition function.
 *  - manual pause wins over everything;
 *  - no verified balance → unverified (fail closed); a failed/stale check while admitting gets one bounded grace window first;
 *  - balance hits zero → one bounded grace window, then zero (stop admission, keep selling);
 *  - balance returns after zero/pause/grace → resuming for one check, then healthy/low.
 */
export function nextProviderState(input: ProviderInput): ProviderOutcome {
  const { current, balance, liabilities, paused, now, graceMinutes } = input;
  const tier = coverageTier(balance, liabilities);
  const out = (state: ProviderState, graceUntil: Date | null = null): ProviderOutcome => ({ state, graceUntil, tier, changed: state !== current });
  if (paused) return out("paused");
  if (balance === null) {
    if (input.stale && (current === "healthy" || current === "low" || current === "resuming") && graceMinutes > 0) return out("grace", new Date(now.getTime() + graceMinutes * 60000));
    if (input.stale && current === "grace" && input.graceUntil && now < input.graceUntil) return out("grace", input.graceUntil);
    return out("unverified");
  }
  if (balance <= 0) {
    if (current === "zero" || current === "unverified" || current === "paused") return out("zero");
    if (current === "grace") return input.graceUntil && now < input.graceUntil ? out("grace", input.graceUntil) : out("zero");
    return graceMinutes > 0 ? out("grace", new Date(now.getTime() + graceMinutes * 60000)) : out("zero");
  }
  if (current === "zero" || current === "paused" || current === "grace" || current === "unverified") return out("resuming");
  return out(tier !== null && tier < 25 ? "low" : "healthy");
}

/* ------------------------------------------------------------------ */
/* Request cost bounds (internal credits)                              */
/* ------------------------------------------------------------------ */
// Sandbox per-token prices in internal credits. NOT verified CVC tariffs.
export const MODEL_PRICES: Record<string, { input: number; output: number; maxOutput: number }> = {
  "gpt-4o": { input: 50, output: 200, maxOutput: 4096 },
  "claude-3-7-sonnet": { input: 60, output: 300, maxOutput: 4096 },
  "gemini-2.5-pro": { input: 25, output: 200, maxOutput: 8192 },
  "deepseek-v3": { input: 6, output: 22, maxOutput: 4096 },
};
/** Upper bound reserved before dispatch, so concurrent requests can never overdraw. */
export function reservationBound(model: string, inputTokens: number, maxTokens?: number | null) {
  const price = MODEL_PRICES[model];
  if (!price) throw new Error("unknown_model");
  const output = Math.min(Math.max(1, maxTokens ?? price.maxOutput), price.maxOutput);
  return Math.max(1, inputTokens) * price.input + output * price.output;
}
export function actualCost(model: string, inputTokens: number, outputTokens: number) {
  const price = MODEL_PRICES[model];
  if (!price) throw new Error("unknown_model");
  return inputTokens * price.input + outputTokens * price.output;
}
/**
 * Reserve for a live CVC dispatch using billed-token multipliers.
 * `creditsPerCvcToken` converts CVC `cost_tokens` into PanaAI internal credits.
 */
export function liveReservationBound(inputTokens: number, maxTokens: number | null | undefined, multiplier: number, creditsPerCvcToken: number) {
  const output = Math.min(Math.max(1, maxTokens ?? 4096), 8192);
  const estimatedCvc = Math.ceil((Math.max(1, inputTokens) + output) * Math.max(0.01, multiplier));
  return Math.max(1, estimatedCvc * Math.max(1, creditsPerCvcToken));
}
/** Convert authoritative CVC `cost_tokens` into internal credits (ceil, never undercharge). */
export function creditsFromCvcCost(costTokens: number, creditsPerCvcToken: number) {
  if (!Number.isFinite(costTokens) || costTokens < 0) return 0;
  return Math.max(0, Math.ceil(costTokens * Math.max(1, creditsPerCvcToken)));
}
/** Rough, content-free token estimate used only for the reservation bound. */
export const estimateTokens = (chars: number) => Math.max(1, Math.ceil(chars / 3));

/* ------------------------------------------------------------------ */
/* FEFO allocation                                                      */
/* ------------------------------------------------------------------ */
export type AllocLot = { id: string; remaining: number; reserved: number; expiresAt: Date };
/** First-expiring-first-out allocation of `amount` across unexpired lots; null if insufficient. */
export function allocateFefo(lots: AllocLot[], amount: number, now = new Date()) {
  const ordered = lots.filter(l => l.expiresAt > now && l.remaining - l.reserved > 0).sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.id.localeCompare(b.id));
  const allocations: { lotId: string; amount: number }[] = [];
  let left = amount;
  for (const lot of ordered) {
    if (left <= 0) break;
    const take = Math.min(left, lot.remaining - lot.reserved);
    allocations.push({ lotId: lot.id, amount: take });
    left -= take;
  }
  return left > 0 ? null : allocations;
}
/** Split the settled amount over the reserved allocations in the same FEFO order. */
export function splitSettlement(allocations: { lotId: string; amount: number }[], settled: number) {
  let left = settled;
  return allocations.map(a => { const used = Math.min(a.amount, left); left -= used; return { ...a, used }; });
}

/* ------------------------------------------------------------------ */
/* Admin roles and permissions (RBAC)                                   */
/* ------------------------------------------------------------------ */
export type Role = "owner" | "finance" | "support" | "viewer";
export type Permission = "admin.read" | "payments.review" | "finance.adjust" | "refunds.decide" | "pricing.manage" | "provider.manage" | "alerts.manage" | "users.manage" | "system.manage";
export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  owner: { label: "مالک (سوپرادمین)", description: "همه دسترسی‌ها" },
  finance: { label: "مالی", description: "بررسی پرداخت، بازپرداخت، اصلاح اعتبار و قیمت‌گذاری" },
  support: { label: "پشتیبانی", description: "بررسی پرداخت و مدیریت وضعیت کاربر" },
  viewer: { label: "فقط مشاهده", description: "مشاهده گزارش‌ها بدون هیچ تغییر" },
};
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ["admin.read", "payments.review", "finance.adjust", "refunds.decide", "pricing.manage", "provider.manage", "alerts.manage", "users.manage", "system.manage"],
  finance: ["admin.read", "payments.review", "finance.adjust", "refunds.decide", "pricing.manage"],
  support: ["admin.read", "payments.review", "users.manage"],
  viewer: ["admin.read"],
};
/** Staff roles. Every other role (e.g. "customer") has no admin surface at all. */
export const isOperator = (role: string) => Object.hasOwn(ROLE_PERMISSIONS, role);
export const can = (role: string, permission: Permission) => (ROLE_PERMISSIONS[role as Role] || []).includes(permission);
/** Server-side route → permission map. Unknown admin routes are denied. */
export function permissionFor(route: string, method: string): Permission | null {
  if (method === "GET") return "admin.read";
  const rules: [RegExp, Permission][] = [
    [/^admin\/orders\/[^/]+\/(approve|reject|request-info)$/, "payments.review"],
    [/^admin\/wallet\/(adjust|reconcile|financial-audit|cvc-finance-drill)$/, "finance.adjust"],
    [/^admin\/refunds\/[^/]+\/(approve|reject|paid)$/, "refunds.decide"],
    [/^admin\/(pricing|packages)(\/[^/]+)?$/, "pricing.manage"],
    [/^admin\/models\/[^/]+$/, "pricing.manage"],
    [/^admin\/provider\/(reconcile|sync|simulate|pause)$/, "provider.manage"],
    [/^admin\/alerts\/([^/]+\/ack|acknowledge|test)$/, "alerts.manage"],
    [/^admin\/channels$/, "alerts.manage"],
    [/^admin\/users\/state$/, "users.manage"],
    [/^admin\/system$/, "system.manage"],
    [/^admin\/payments\/destination$/, "system.manage"],
    [/^admin\/maintenance$/, "system.manage"],
  ];
  return rules.find(([pattern]) => pattern.test(route))?.[1] ?? null;
}
/** Routes that manage the operator's own MFA/session; they need no elevation. */
export const MFA_ROUTES = new Set(["admin/security", "admin/mfa/enroll", "admin/mfa/confirm", "admin/mfa/elevate", "admin/mfa/demo-code", "admin/role", "admin/mfa/drop"]);
export const ELEVATION_MINUTES = 15;

/* ------------------------------------------------------------------ */
/* System settings                                                      */
/* ------------------------------------------------------------------ */
/**
 * Commercial rates (customizable in admin → system):
 * - creditsPerUsd: what customers buy (default 20M credits / $1). Safe to show.
 * - upstreamTokensPerUsd: what we receive from the reseller (default 25M / $1). Admin-only; never show to customers.
 * - creditsPerCvcToken: settlement multiplier from upstream cost_tokens → customer credits (default 1).
 * With 20M/25M and creditsPerCvcToken=1, selling fewer credits than we buy creates ~20% margin.
 */
export const SYSTEM_DEFAULTS = {
  transferHours: 24,
  graceMinutes: 5,
  lowBalanceCredits: 2000000,
  maxKeys: 20,
  creditsPerCvcToken: 1,
  creditsPerUsd: 20_000_000,
  upstreamTokensPerUsd: 25_000_000,
  /**
   * Safety ceiling for every CVC delegated key. Soft-allocation sizes shared/capped keys
   * to wallet unallocated/budget 1:1 (via creditsPerCvcToken); this cap only blocks absurd
   * upstream allowances. Never mint a true unlimited CVC key.
   */
  cvcDelegatedTokenCap: 100_000_000,
};
export const SYSTEM_LIMITS = {
  transferHours: [1, 72],
  graceMinutes: [0, 60],
  lowBalanceCredits: [0, 1000000000],
  maxKeys: [1, 100],
  creditsPerCvcToken: [1, 1000],
  creditsPerUsd: [1_000_000, 100_000_000],
  upstreamTokensPerUsd: [1_000_000, 100_000_000],
  cvcDelegatedTokenCap: [1_000, 1_000_000_000],
} as const;
export type SystemSettings = typeof SYSTEM_DEFAULTS;
/** Fields customers may see in the app payload. Wholesale/upstream rates stay admin-only. */
export type CustomerSystemSettings = Omit<SystemSettings, "upstreamTokensPerUsd" | "creditsPerCvcToken" | "creditsPerUsd" | "cvcDelegatedTokenCap">;
export function systemSettings(settings: Record<string, unknown>): SystemSettings {
  const read = (key: keyof SystemSettings) => {
    const value = Number(settings[`system:${key}`]);
    const [min, max] = SYSTEM_LIMITS[key];
    return Number.isInteger(value) && value >= min && value <= max ? value : SYSTEM_DEFAULTS[key];
  };
  return {
    transferHours: read("transferHours"),
    graceMinutes: read("graceMinutes"),
    lowBalanceCredits: read("lowBalanceCredits"),
    maxKeys: read("maxKeys"),
    creditsPerCvcToken: read("creditsPerCvcToken"),
    creditsPerUsd: read("creditsPerUsd"),
    upstreamTokensPerUsd: read("upstreamTokensPerUsd"),
    cvcDelegatedTokenCap: read("cvcDelegatedTokenCap"),
  };
}

/**
 * Lifetime CVC `token_limit` for a delegated key.
 * `creditPool` is the PanaAI key budget, or the wallet's unallocated credits when the key has no budget.
 * Never returns unlimited — uncapped upstream keys are too risky.
 */
export function resolveCvcTokenLimit(creditPool: number | null | undefined, settings: SystemSettings): number {
  const rate = Math.max(1, settings.creditsPerCvcToken);
  const platformCap = Math.max(1, settings.cvcDelegatedTokenCap);
  if (creditPool != null && Number.isFinite(creditPool)) {
    if (creditPool <= 0) return 1;
    return Math.max(1, Math.min(platformCap, Math.floor(creditPool / rate)));
  }
  return platformCap;
}

/**
 * Absolute lifetime limit for a budgeted (capped) CVC key.
 * Budget is the total lifetime allowance — do NOT add tokensUsed on top (that over-issues).
 */
export function desiredCappedTokenLimit(budget: number, tokensUsed: number, settings: SystemSettings): number {
  const lifetime = resolveCvcTokenLimit(budget, settings);
  const used = Math.max(0, Math.floor(tokensUsed));
  return Math.max(used + 1, lifetime);
}

/**
 * Lifetime limit for the shared uncapped CVC key.
 * `unallocated` is remaining free credits, so lifetime = used + remaining allowance.
 */
export function desiredSharedTokenLimit(unallocated: number, tokensUsed: number, settings: SystemSettings): number {
  const remaining = resolveCvcTokenLimit(unallocated, settings);
  const used = Math.max(0, Math.floor(tokensUsed));
  return Math.max(used + 1, used + remaining);
}

/** Remaining earmark for a limited key (0 if unlimited or revoked). */
export function keyAllocationRemaining(key: { budget: number | null; spent: number; enabled?: boolean }): number {
  if (key.enabled === false) return 0;
  if (key.budget == null) return 0;
  return Math.max(0, key.budget - key.spent);
}

/** Sum of remaining budgets across active limited keys. Unlimited keys allocate nothing. */
export function sumKeyAllocations(keys: Array<{ budget: number | null; spent: number; enabled: boolean }>): number {
  return keys.reduce((sum, key) => sum + keyAllocationRemaining(key), 0);
}

/** Credits still free for new key budgets or unlimited-key spend. */
export function unallocatedCredits(available: number, allocated: number): number {
  return Math.max(0, available - Math.max(0, allocated));
}

/**
 * Whether a remote capped-CVC revoke freed upstream capacity enough to safely raise the shared pool.
 * - deleted / missing / skipped → pool may grow
 * - frozen / failed → capped allowance may still exist upstream; never raise shared (avoid double-issue)
 */
export function remoteRevokeFreesUpstreamPool(
  remote: "deleted" | "frozen" | "failed" | "skipped" | "missing",
): boolean {
  return remote === "deleted" || remote === "missing" || remote === "skipped";
}
export function customerSystemSettings(settings: Record<string, unknown>): CustomerSystemSettings {
  const all = systemSettings(settings);
  return {
    transferHours: all.transferHours,
    graceMinutes: all.graceMinutes,
    lowBalanceCredits: all.lowBalanceCredits,
    maxKeys: all.maxKeys,
  };
}

/* ------------------------------------------------------------------ */
/* Refund eligibility                                                   */
/* ------------------------------------------------------------------ */
/** Only unconsumed, unreserved, unexpired credits of the order's lot are refundable, prorated in rial. */
export function refundable(order: { amountIrr: number; credits: number }, lot: { remaining: number; reserved: number; expiresAt: Date } | null, now = new Date()) {
  if (!lot || lot.expiresAt <= now) return { credits: 0, amountIrr: 0 };
  const credits = Math.max(0, lot.remaining - lot.reserved);
  return { credits, amountIrr: Number(BigInt(order.amountIrr) * BigInt(credits) / BigInt(Math.max(1, order.credits))) };
}

/* ------------------------------------------------------------------ */
/* Numbers                                                              */
/* ------------------------------------------------------------------ */
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
export const toAsciiDigits = (value: string) => value.replace(/[۰-۹]/g, d => String(FA_DIGITS.indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
/** Keep only digits (any script) and return ASCII digits without separators or leading zeros. */
export const digitsOnly = (value: string) => toAsciiDigits(value).replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");
/** «۱۲۳۴۵۶۷» → «۱٬۲۳۴٬۵۶۷» */
export const groupFa = (digits: string) => digits ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, "٬").replace(/\d/g, d => FA_DIGITS[Number(d)]) : "";
export function rangeError(raw: string, { min, max, required = false, label = "مقدار" }: { min?: number; max?: number; required?: boolean; label?: string }) {
  if (!raw) return required ? `${label} را وارد کنید.` : "";
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return `${label} معتبر نیست.`;
  if (min !== undefined && value < min) return `${label} باید حداقل ${groupFa(String(min))} باشد.`;
  if (max !== undefined && value > max) return `${label} نباید بیشتر از ${groupFa(String(max))} باشد.`;
  return "";
}
