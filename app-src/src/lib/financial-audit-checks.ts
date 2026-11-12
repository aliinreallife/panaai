/**
 * Pure financial integrity checks for separated credit buckets.
 * Used by the server audit runner and by unit tests — no DB imports.
 */

export type AuditSeverity = "error" | "warn" | "info";

export type AuditFinding = {
  code: string;
  severity: AuditSeverity;
  /** Stable bucket this finding belongs to (for UI grouping). */
  bucket: string;
  message: string;
  context?: Record<string, unknown>;
};

/** One separated book / concern — PASS/FAIL must be obvious. */
export type BucketStatus = {
  id: string;
  label: string;
  /** Short Persian description of what this bucket isolates. */
  purpose: string;
  ok: boolean;
  /** Highest severity among findings for this bucket (info if clean). */
  severity: AuditSeverity | "ok";
  summary: string;
  /** Numbers that must line up for this bucket (shown side-by-side in UI). */
  figures: { label: string; value: number; highlight?: boolean }[];
};

export type AuditSnapshot = {
  available: number;
  reserved: number;
  allocated: number;
  unallocated: number;
  keySpentTotal: number;
  usageCreditsTotal: number;
  keys: Array<{ id: string; name: string; enabled: boolean; budget: number | null; spent: number }>;
  lots: Array<{
    id: string;
    orderId: string | null;
    origin: string;
    granted: number;
    remaining: number;
    reserved: number;
    expiresAt: Date | string;
  }>;
  approvedOrders: Array<{ id: string; reference: string; credits: number }>;
  /** orderId → sum granted on lots linked to that order */
  lotGrantedByOrder: Record<string, number>;
  usageByKeyName: Record<string, number>;
  refunds: Array<{ id: string; state: string; credits: number; orderId: string }>;
  refundReversalByRefundId: Record<string, number>;
  heldReservationTotal: number;
  lotReservedTotal: number;
  walletLotIssues: Array<{ lotId: string; issues: string[] }>;
  unbalancedJournalEventIds: string[];
  upstream: Array<{ id: string; kind: string; platformKeyId: string | null; prefix: string; revoked: boolean }>;
};

export type AuditEvaluation = {
  ok: boolean;
  fishy: boolean;
  buckets: BucketStatus[];
  findings: AuditFinding[];
  identity: {
    softAllocHolds: boolean;
    spentEqualsUsage: boolean;
    ordersMatchLots: boolean;
    journalBalanced: boolean;
    lotsSane: boolean;
    upstreamShapeOk: boolean;
  };
};

function finding(
  severity: AuditSeverity,
  bucket: string,
  code: string,
  message: string,
  context?: Record<string, unknown>,
): AuditFinding {
  return context ? { severity, bucket, code, message, context } : { severity, bucket, code, message };
}

function worst(severities: AuditSeverity[]): AuditSeverity | "ok" {
  if (severities.includes("error")) return "error";
  if (severities.includes("warn")) return "warn";
  if (severities.includes("info")) return "info";
  return "ok";
}

/**
 * Evaluate separated financial books. Callers must pass a consistent snapshot.
 * Does not mutate anything — reports only.
 */
export function evaluateFinancialIntegrity(snap: AuditSnapshot): AuditEvaluation {
  const findings: AuditFinding[] = [];
  const now = Date.now();
  const activeKeys = snap.keys.filter(k => k.enabled);

  // --- Soft allocation identity ---
  const expectedUnallocated = Math.max(0, snap.available - snap.allocated);
  if (snap.unallocated !== expectedUnallocated) {
    findings.push(finding("error", "soft_allocation", "unallocated_math",
      "سطل «آزاد» با موجودی − تخصیص جور نیست — احتمال باگ محاسباتی یا دستکاری داده.",
      { available: snap.available, allocated: snap.allocated, unallocated: snap.unallocated, expectedUnallocated }));
  }
  if (snap.allocated > snap.available) {
    findings.push(finding("warn", "soft_allocation", "allocation_oversubscribed",
      "تخصیص نرم کلیدها از موجودی قابل‌مصرف بیشتر است؛ سهم آزاد صفر است. اگر این عمدی نیست، سقف کلیدها یا موجودی را بررسی کنید.",
      { available: snap.available, allocated: snap.allocated, overBy: snap.allocated - snap.available }));
  } else if (snap.available !== snap.unallocated + snap.allocated) {
    findings.push(finding("error", "soft_allocation", "soft_identity_broken",
      "هویت سطل نرم شکسته: موجودی باید برابر تخصیص + آزاد باشد.",
      { available: snap.available, allocated: snap.allocated, unallocated: snap.unallocated }));
  }
  for (const key of activeKeys) {
    if (key.budget != null && key.budget < 1) {
      findings.push(finding("error", "soft_allocation", "key_budget_invalid",
        `سقف بودجه کلید «${key.name}» نامعتبر است.`,
        { keyId: key.id, budget: key.budget }));
    }
    if (key.budget != null && key.spent > key.budget) {
      findings.push(finding("error", "soft_allocation", "key_spent_over_budget",
        `کلید «${key.name}» بیش از سقف بودجه‌اش مصرف کرده — نشتی سقف یا race مشکوک.`,
        { keyId: key.id, name: key.name, spent: key.spent, budget: key.budget, overBy: key.spent - key.budget }));
    }
  }

  // --- Spent vs usage (and per-key when names are unique among active+revoked) ---
  if (snap.keySpentTotal !== snap.usageCreditsTotal) {
    findings.push(finding("error", "spend_ledger", "spent_vs_usage",
      "جمع spent کلیدها با جمع usage برابر نیست — مصرف ثبت‌نشده یا usage بدون spent.",
      { keySpentTotal: snap.keySpentTotal, usageCreditsTotal: snap.usageCreditsTotal, delta: snap.keySpentTotal - snap.usageCreditsTotal }));
  }
  const nameCounts = new Map<string, number>();
  for (const key of snap.keys) nameCounts.set(key.name, (nameCounts.get(key.name) || 0) + 1);
  for (const key of snap.keys) {
    if ((nameCounts.get(key.name) || 0) > 1) continue; // rotated same-name keys: skip per-key
    const usage = snap.usageByKeyName[key.name] || 0;
    if (usage !== key.spent) {
      findings.push(finding("error", "spend_ledger", "key_spent_vs_usage_name",
        `کلید «${key.name}»: spent با usage هم‌نام جور نیست.`,
        { keyId: key.id, name: key.name, spent: key.spent, usage, delta: key.spent - usage }));
    }
  }
  const knownNames = new Set(snap.keys.map(k => k.name));
  for (const [name, credits] of Object.entries(snap.usageByKeyName)) {
    if (!knownNames.has(name) && credits > 0) {
      findings.push(finding("warn", "spend_ledger", "usage_orphan_key_name",
        `مصرف usage برای نام کلید ناشناخته «${name}» ثبت شده است.`,
        { name, credits }));
    }
  }

  // --- Lots sanity + identity with reservations ---
  for (const lot of snap.lots) {
    if (lot.remaining < 0 || lot.reserved < 0 || lot.granted < 0) {
      findings.push(finding("error", "lots", "lot_negative",
        "مقادیر بسته اعتبار منفی است — داده خراب.",
        { lotId: lot.id, granted: lot.granted, remaining: lot.remaining, reserved: lot.reserved }));
    }
    if (lot.reserved > lot.remaining) {
      findings.push(finding("error", "lots", "lot_reserved_gt_remaining",
        "رزرو بسته از باقی‌مانده بیشتر است.",
        { lotId: lot.id, remaining: lot.remaining, reserved: lot.reserved }));
    }
    if (lot.remaining > lot.granted) {
      findings.push(finding("error", "lots", "lot_remaining_gt_granted",
        "باقی‌مانده بسته از اعطایی بیشتر است.",
        { lotId: lot.id, granted: lot.granted, remaining: lot.remaining }));
    }
    if (lot.origin === "purchase" && !lot.orderId) {
      findings.push(finding("error", "orders_lots", "purchase_lot_missing_order",
        "بسته با منشأ خرید بدون پیوند سفارش است — مشکوک.",
        { lotId: lot.id, granted: lot.granted }));
    }
  }
  if (snap.heldReservationTotal !== snap.lotReservedTotal) {
    findings.push(finding("error", "lots", "held_vs_lot_reserved",
      "جمع رزروهای held با جمع reserved بسته‌ها برابر نیست.",
      { heldReservationTotal: snap.heldReservationTotal, lotReservedTotal: snap.lotReservedTotal, delta: snap.heldReservationTotal - snap.lotReservedTotal }));
  }
  for (const issue of snap.walletLotIssues) {
    findings.push(finding("error", "lots", "wallet_lot_reconcile",
      `مغایرت تطبیق پایه بسته: ${issue.issues.join("; ")}`,
      { lotId: issue.lotId }));
  }
  if (snap.unbalancedJournalEventIds.length) {
    findings.push(finding("error", "journal", "journal_unbalanced",
      "ژورنال نامتوازن — هر رویداد باید جمع صفر داشته باشد.",
      { count: snap.unbalancedJournalEventIds.length, eventIds: snap.unbalancedJournalEventIds.slice(0, 20) }));
  }

  // --- Approved orders ↔ lots ---
  const seenOrderLots = new Set<string>();
  for (const [orderId, granted] of Object.entries(snap.lotGrantedByOrder)) {
    if (seenOrderLots.has(orderId)) continue;
    seenOrderLots.add(orderId);
    const order = snap.approvedOrders.find(o => o.id === orderId);
    if (!order) {
      findings.push(finding("error", "orders_lots", "lot_for_non_approved_order",
        "بسته اعتبار به سفارشی پیوند دارد که تأیید/صدور نشده است.",
        { orderId, lotGranted: granted }));
    }
  }
  for (const order of snap.approvedOrders) {
    const granted = snap.lotGrantedByOrder[order.id];
    if (granted == null) {
      findings.push(finding("error", "orders_lots", "approved_order_missing_lot",
        `سفارش تأییدشده ${order.reference} بسته اعتبار ندارد — اعتبار صادر نشده یا پاک شده.`,
        { orderId: order.id, reference: order.reference, credits: order.credits }));
    } else if (granted !== order.credits) {
      findings.push(finding("error", "orders_lots", "order_lot_grant_mismatch",
        `سفارش ${order.reference}: اعتبار سفارش با اعطای بسته جور نیست.`,
        { orderId: order.id, reference: order.reference, orderCredits: order.credits, lotGranted: granted, delta: granted - order.credits }));
    }
  }

  // --- Refunds must have compensating reversals when decided ---
  for (const refund of snap.refunds) {
    if (refund.state === "approved" || refund.state === "paid") {
      const reversed = snap.refundReversalByRefundId[refund.id] || 0;
      if (reversed !== -refund.credits) {
        findings.push(finding("error", "refunds", "refund_missing_reversal",
          "بازپرداخت تأیید/پرداخت‌شده رویداد برگشت اعتبار هم‌مبلغ ندارد.",
          { refundId: refund.id, state: refund.state, credits: refund.credits, reversalDelta: reversed }));
      }
    }
  }

  // --- Upstream CVC shape (separate from PanaAI wallet) ---
  const liveUpstream = snap.upstream.filter(u => !u.revoked);
  const shared = liveUpstream.filter(u => u.kind === "shared_uncapped");
  const capped = liveUpstream.filter(u => u.kind === "capped");
  if (shared.length > 1) {
    findings.push(finding("error", "upstream", "upstream_shared_duplicate",
      "بیش از یک CVC مشترک فعال است — ریسک مصرف مشترک خارج از سطل آزاد.",
      { count: shared.length, prefixes: shared.map(u => u.prefix) }));
  }
  const keyById = new Map(snap.keys.map(k => [k.id, k]));
  for (const row of capped) {
    if (!row.platformKeyId) {
      findings.push(finding("error", "upstream", "upstream_capped_missing_key",
        "CVC بودجه‌دار بدون پیوند به کلید پانا.",
        { upstreamId: row.id, prefix: row.prefix }));
      continue;
    }
    const key = keyById.get(row.platformKeyId);
    if (!key) {
      findings.push(finding("warn", "upstream", "upstream_capped_orphan",
        "CVC بودجه‌دار به کلید ناشناخته اشاره می‌کند.",
        { upstreamId: row.id, platformKeyId: row.platformKeyId, prefix: row.prefix }));
    } else if (!key.enabled) {
      findings.push(finding("warn", "upstream", "upstream_capped_for_revoked_key",
        `CVC بودجه‌دار برای کلید لغوشده «${key.name}» هنوز فعال است (D31 حذف CVC).`,
        { platformKeyId: key.id, name: key.name, prefix: row.prefix }));
    } else if (key.budget == null) {
      findings.push(finding("warn", "upstream", "upstream_capped_for_uncapped_key",
        `کلید «${key.name}» بدون سقف است ولی CVC بودجه‌دار دارد — شکل سطل‌ها به‌هم خورده.`,
        { platformKeyId: key.id, name: key.name, prefix: row.prefix }));
    }
  }
  for (const key of activeKeys.filter(k => k.budget != null)) {
    if (!capped.some(r => r.platformKeyId === key.id)) {
      findings.push(finding("info", "upstream", "upstream_capped_not_provisioned",
        `کلید بودجه‌دار «${key.name}» هنوز CVC اختصاصی ندارد (تا اولین استفاده mint می‌شود).`,
        { keyId: key.id, name: key.name, budget: key.budget }));
    }
  }
  if (activeKeys.some(k => k.budget == null) && shared.length === 0) {
    findings.push(finding("info", "upstream", "upstream_shared_not_provisioned",
      "کلید بدون سقف فعال است ولی CVC مشترک هنوز ساخته نشده.",
      { uncappedKeys: activeKeys.filter(k => k.budget == null).length }));
  }

  // Unused now marker kept for future expiry-aware checks without lint noise if removed.
  void now;

  const byBucket = (id: string) => findings.filter(f => f.bucket === id);
  const bucket = (
    id: string,
    label: string,
    purpose: string,
    figures: BucketStatus["figures"],
    cleanSummary: string,
  ): BucketStatus => {
    const mine = byBucket(id);
    const sev = worst(mine.map(f => f.severity));
    const ok = !mine.some(f => f.severity === "error");
    const summary = mine.length === 0
      ? cleanSummary
      : mine.filter(f => f.severity === "error").length
        ? mine.filter(f => f.severity === "error").map(f => f.message).join(" · ")
        : mine.map(f => f.message).join(" · ");
    return { id, label, purpose, ok, severity: sev, summary, figures };
  };

  const softOkIdentity = snap.allocated > snap.available
    ? snap.unallocated === 0
    : snap.available === snap.unallocated + snap.allocated && snap.unallocated === expectedUnallocated;

  const buckets: BucketStatus[] = [
    bucket("soft_allocation", "تخصیص نرم / آزاد",
      "موجودی قابل‌مصرف جدا از بودجه باقی‌مانده کلیدها و سهم آزاد.",
      [
        { label: "موجودی", value: snap.available },
        { label: "تخصیص", value: snap.allocated, highlight: snap.allocated > snap.available },
        { label: "آزاد", value: snap.unallocated, highlight: snap.unallocated !== expectedUnallocated },
      ],
      softOkIdentity
        ? (snap.allocated > snap.available
          ? "سربار تخصیص اعلام‌شده؛ سهم آزاد صفر است."
          : "موجودی = تخصیص + آزاد.")
        : "هویت سطل نرم ناسازگار است."),
    bucket("spend_ledger", "مصرف کلید ↔ usage",
      "spent روی کلیدها باید با دفتر usage یکی باشد.",
      [
        { label: "spent کلیدها", value: snap.keySpentTotal, highlight: snap.keySpentTotal !== snap.usageCreditsTotal },
        { label: "جمع usage", value: snap.usageCreditsTotal, highlight: snap.keySpentTotal !== snap.usageCreditsTotal },
        { label: "اختلاف", value: snap.keySpentTotal - snap.usageCreditsTotal, highlight: snap.keySpentTotal !== snap.usageCreditsTotal },
      ],
      "spent و usage برابرند."),
    bucket("lots", "بسته‌ها و رزرو FEFO",
      "بسته‌های اعتبار، رزرو held، و تطبیق پایه کیف پول.",
      [
        { label: "رزرو held", value: snap.heldReservationTotal, highlight: snap.heldReservationTotal !== snap.lotReservedTotal },
        { label: "reserved بسته‌ها", value: snap.lotReservedTotal, highlight: snap.heldReservationTotal !== snap.lotReservedTotal },
        { label: "رزرو فعال (eligible)", value: snap.reserved },
      ],
      "بسته‌ها و رزروها هم‌خوان‌اند."),
    bucket("journal", "ژورنال دوبل‌ورود",
      "هر رویداد کیف پول باید در ژورنال جمع صفر داشته باشد.",
      [
        { label: "رویداد نامتوازن", value: snap.unbalancedJournalEventIds.length, highlight: snap.unbalancedJournalEventIds.length > 0 },
      ],
      "ژورنال متوازن است."),
    bucket("orders_lots", "سفارش تأییدشده ↔ بسته",
      "هر شارژ خرید باید دقیقاً یک بسته با همان اعتبار داشته باشد.",
      [
        { label: "سفارش تأییدشده", value: snap.approvedOrders.length },
        { label: "بسته با orderId", value: Object.keys(snap.lotGrantedByOrder).length },
      ],
      "هر سفارش تأییدشده بسته هم‌مبلغ دارد."),
    bucket("refunds", "بازپرداخت ↔ برگشت اعتبار",
      "بازپرداخت تأیید/پرداخت‌شده باید رویداد جبرانی داشته باشد.",
      [
        { label: "بازپرداخت‌ها", value: snap.refunds.length },
        { label: "برگشت‌های ثبت‌شده", value: Object.keys(snap.refundReversalByRefundId).length },
      ],
      "بازپرداخت‌های قطعی برگشت اعتبار دارند."),
    bucket("upstream", "شکل CVC (جدا از کیف پانا)",
      "CVC مشترک برای بدون‌سقف؛ CVC جدا برای بودجه‌دار — بدون دوبل مشترک.",
      [
        { label: "CVC مشترک", value: shared.length, highlight: shared.length > 1 },
        { label: "CVC بودجه‌دار", value: capped.length },
        { label: "کلید بدون‌سقف", value: activeKeys.filter(k => k.budget == null).length },
      ],
      "شکل اعتبارنامه بالادست با مدل سطل‌ها سازگار است."),
  ];

  const hasError = findings.some(f => f.severity === "error");
  const fishy = hasError || findings.some(f => f.severity === "warn");

  return {
    ok: !hasError,
    fishy,
    buckets,
    findings,
    identity: {
      softAllocHolds: !byBucket("soft_allocation").some(f => f.severity === "error"),
      spentEqualsUsage: !byBucket("spend_ledger").some(f => f.severity === "error"),
      ordersMatchLots: !byBucket("orders_lots").some(f => f.severity === "error"),
      journalBalanced: !byBucket("journal").some(f => f.severity === "error"),
      lotsSane: !byBucket("lots").some(f => f.severity === "error"),
      upstreamShapeOk: !byBucket("upstream").some(f => f.severity === "error"),
    },
  };
}
