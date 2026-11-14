export const fa = (value: number | string) => new Intl.NumberFormat("fa-IR").format(Number(value));
export const compact = (value: number) => value >= 1000000 ? `${fa(Math.round(value / 100000) / 10)} میلیون` : fa(value);
export const persianDate = (value: string | Date, options: Intl.DateTimeFormatOptions = {}) => new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", day: "numeric", month: "long", ...options }).format(new Date(value));
export const persianTime = (value: string | Date) => new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
export const ascii = (value: string) => value.replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[,٬\s]/g, "");
export const MODEL_CATALOG = [
  { id: "gpt-4o", name: "GPT-4o", company: "OpenAI", color: "#287e6b", context: "128K", description: "همراه چندمنظوره برای متن، کدنویسی و تحلیل", mark: "openai" },
  { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", company: "Anthropic", color: "#8bb9a7", context: "200K", description: "دقت بیشتر در استدلال و حل مسائل پیچیده", mark: "claude" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", company: "Google", color: "#d8ba87", context: "1M", description: "تحلیل اسناد و پردازش محتوای طولانی", mark: "gemini" },
  { id: "deepseek-v3", name: "DeepSeek V3", company: "DeepSeek", color: "#cad4d5", context: "128K", description: "انتخابی به‌صرفه برای توسعه‌دهندگان", mark: "deepseek" },
];
export const ORDER_STATES: Record<string, { label: string; tone: string }> = {
  awaiting_transfer: { label: "در انتظار واریز", tone: "neutral" },
  receipt_submitted: { label: "در انتظار بررسی", tone: "warning" },
  under_review: { label: "در حال بررسی", tone: "info" },
  approved_and_credited: { label: "تأیید و شارژ شده", tone: "success" },
  needs_more_information: { label: "نیاز به اطلاعات بیشتر", tone: "warning" },
  needs_manual_resolution: { label: "نیاز به تطبیق دستی", tone: "warning" },
  rejected: { label: "رد شده", tone: "danger" },
  cancelled: { label: "لغو شده", tone: "neutral" },
};
export type KeyItem = { id: string; name: string; prefix: string; enabled: boolean; budget: number | null; rateLimit: number; allowedModels: string[]; spent: number; createdAt: string; lastUsedAt: string | null };
export type OrderItem = { id: string; reference: string; amountIrr: number; credits: number; rateIrr: number; state: string; claimedIrr: number | null; transferredAt: string | null; bankReference: string | null; customerNote: string | null; reviewNote: string | null; transferDeadline: string; createdAt: string; approvedAt: string | null };
export type LotItem = { id: string; orderId: string | null; origin: string; granted: number; remaining: number; reserved: number; expiresAt: string; createdAt: string };
export type UsageItem = { id: string; requestId: string; keyName: string; model: string; credits: number; inputTokens: number; outputTokens: number; latency: number; status: string; createdAt: string };
export type DailyItem = { day: string; credits: number; requests: number; errors: number };
export type AuditItem = { id: string; action: string; targetId: string | null; details: Record<string, unknown>; createdAt: string };
export type TicketItem = { id: string; subject: string; message: string; category: string; state: string; createdAt: string };
export type UsageSummary = { requests: number; credits: number; errors: number; averageLatency: number; p95Latency: number; inputTokens: number; outputTokens: number; successRate: number | null };
export type UsageReport = {
  days: number; startDay: string; endDay: string; updatedAt: string;
  summary: UsageSummary; previous: UsageSummary;
  daily: DailyItem[]; previousDaily: DailyItem[];
  byModel: { model: string; credits: number; requests: number; share: number }[];
  byKey: { key: string; credits: number; requests: number; errors: number; share: number }[];
  rows: UsageItem[]; total: number; page: number; pageSize: number;
};
export type ModelItem = {
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
export type AppData = {
  user: { id: string; name: string; demo: boolean; phone: string | null; createdAt: string; settings: Record<string, boolean | string> };
  analytics: UsageReport;
  keys: KeyItem[]; orders: OrderItem[]; lots: LotItem[]; usage: UsageItem[]; daily: DailyItem[];
  events: { id: string; lotId: string; type: string; delta: number; description: string; createdAt: string }[];
  audit: AuditItem[]; tickets: TicketItem[];
  wallet: {
    available: number;
    reserved: number;
    /** Remaining budgets earmarked to active limited API keys (not deducted from lots). */
    allocated: number;
    /** available − allocated; free for new budgets or unlimited keys. */
    unallocated: number;
    expiring7: number;
    expiring: number;
    nearestExpiry: string | null;
  };
  service: { state: import("@/lib/rules").ProviderState; admits: boolean; checkedAt: string | null };
  account: { state: string; role: string; operator: boolean };
  mode: "sandbox" | "live";
  models: ModelItem[];
  packages: PackageItem[];
  refunds: RefundItem[];
  system: import("@/lib/rules").SystemSettings | import("@/lib/rules").CustomerSystemSettings;
  pricing: { rateIrr: number; creditsPerUsd: number; minToman: number; maxToman: number; version: string; validityDays: number };
  payments: { destinationCard: string; destinationCardFormatted: string; cardHolder: string };
  /** Platform payment queue for staff; absent for customers. */
  adminOrders?: Array<OrderItem & { customerName: string; customerPhone: string | null }>;
  updatedAt: string;
};
export type PackageItem = { id: string; label: string; subtitle: string; amountToman: number; icon: string; featured: boolean };
export type RefundItem = { id: string; orderId: string; credits: number; amountIrr: number; reason: string; state: string; decisionNote: string | null; payoutReference: string | null; decidedAt: string | null; paidAt: string | null; createdAt: string };
export const REFUND_STATES: Record<string, { label: string; tone: string }> = {
  requested: { label: "در انتظار بررسی", tone: "warning" },
  approved: { label: "تأیید شد، در انتظار واریز", tone: "info" },
  paid: { label: "واریز شد", tone: "success" },
  rejected: { label: "رد شد", tone: "danger" },
};
export type QuoteItem = { id: string; amountIrr: number; credits: number; rateIrr: number; expiresAt: string; version: string };
export const NAV_ITEMS = [
  { id: "overview", href: "/", label: "نمای کلی", icon: "overview" },
  { id: "wallet", href: "/wallet", label: "کیف پول", icon: "wallet" },
  { id: "purchase", href: "/purchase", label: "خرید اعتبار", icon: "purchase" },
  { id: "orders", href: "/orders", label: "سفارش‌ها و تراکنش‌ها", icon: "orders" },
  { id: "keys", href: "/keys", label: "کلیدهای API", icon: "keys" },
  { id: "usage", href: "/usage", label: "تحلیل مصرف", icon: "usage" },
  { id: "models", href: "/models", label: "مدل‌های هوش مصنوعی", icon: "models" },
];
