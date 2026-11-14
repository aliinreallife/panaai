import { pgTable, uuid, text, timestamp, bigint, integer, boolean, jsonb, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const date = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const units = (name: string) => bigint(name, { mode: "number" }).notNull();

export const users = pgTable("platform_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().default("آرین محمدی"),
  phone: text("phone"),
  demo: boolean("demo").notNull().default(true),
  state: text("state").notNull().default("active"),
  role: text("role").notNull().default("owner"),
  settings: jsonb("settings").$type<Record<string, boolean | string>>().notNull().default({ lowBalance: true, expiry: true, payments: true, email: "" }),
  createdAt: date("created_at"),
});
export const sessions = pgTable("platform_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  expiresAt: date("expires_at"),
  elevatedUntil: timestamp("elevated_until", { withTimezone: true }),
  createdAt: date("created_at"),
});
export const keys = pgTable("platform_api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  verifier: text("verifier").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  budget: bigint("budget", { mode: "number" }),
  rateLimit: integer("rate_limit").notNull().default(60),
  allowedModels: jsonb("allowed_models").$type<string[]>().notNull().default([]),
  spent: units("spent").default(0),
  createdAt: date("created_at"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [index("keys_owner_idx").on(t.userId)]);
export const quotes = pgTable("platform_quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  amountIrr: units("amount_irr"),
  credits: units("credits"),
  rateIrr: units("rate_irr"),
  version: text("version").notNull().default("demo-v1"),
  expiresAt: date("expires_at"),
  createdAt: date("created_at"),
});
export const orders = pgTable("platform_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  reference: text("reference").notNull().unique(),
  quoteId: uuid("quote_id").references(() => quotes.id),
  amountIrr: units("amount_irr"),
  credits: units("credits"),
  rateIrr: units("rate_irr"),
  state: text("state").notNull().default("awaiting_transfer"),
  claimedIrr: bigint("claimed_irr", { mode: "number" }),
  transferredAt: timestamp("transferred_at", { withTimezone: true }),
  bankReference: text("bank_reference"),
  customerNote: text("customer_note"),
  reviewNote: text("review_note"),
  transferDeadline: date("transfer_deadline"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: date("created_at"),
}, (t) => [uniqueIndex("one_order_per_quote").on(t.quoteId), index("orders_owner_idx").on(t.userId)]);
export const receipts = pgTable("platform_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  encryptedData: text("encrypted_data").notNull(),
  sha256: text("sha256").notNull(),
  byteSize: integer("byte_size").notNull(),
  createdAt: date("created_at"),
});
export const bankVerifications = pgTable("platform_bank_verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().unique().references(() => orders.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  fingerprint: text("fingerprint").notNull().unique(),
  bankReference: text("bank_reference").notNull(),
  amountIrr: units("amount_irr"),
  note: text("note").notNull(),
  createdAt: date("created_at"),
});
export const lots = pgTable("platform_credit_lots", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  orderId: uuid("order_id").unique().references(() => orders.id),
  origin: text("origin").notNull().default("purchase"),
  granted: units("granted"),
  remaining: units("remaining"),
  reserved: units("reserved").default(0),
  expiresAt: date("expires_at"),
  createdAt: date("created_at"),
}, (t) => [
  index("lots_owner_expiry_idx").on(t.userId, t.expiresAt),
  check("lot_nonnegative_available", sql`${t.granted} > 0 AND ${t.remaining} >= 0 AND ${t.reserved} >= 0 AND ${t.remaining} <= ${t.granted} AND ${t.reserved} <= ${t.remaining}`),
]);
export const walletEvents = pgTable("platform_wallet_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  lotId: uuid("lot_id").notNull().references(() => lots.id),
  type: text("type").notNull(),
  delta: units("delta"),
  description: text("description").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: date("created_at"),
});
export const journal = pgTable("platform_credit_journal", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull().references(() => walletEvents.id),
  account: text("account").notNull(),
  delta: units("delta"),
  createdAt: date("created_at"),
});
export const usageDaily = pgTable("platform_usage_daily", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  day: text("day").notNull(),
  credits: units("credits"),
  requests: integer("requests").notNull(),
  errors: integer("errors").notNull().default(0),
}, (t) => [uniqueIndex("usage_day_user").on(t.userId, t.day)]);
export const usage = pgTable("platform_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  requestId: text("request_id").notNull().unique(),
  keyName: text("key_name").notNull(),
  model: text("model").notNull(),
  credits: units("credits"),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  latency: integer("latency").notNull(),
  status: text("status").notNull(),
  createdAt: date("created_at"),
}, (t) => [
  index("usage_owner_time_idx").on(t.userId, t.createdAt),
  index("usage_owner_model_time_idx").on(t.userId, t.model, t.createdAt),
  check("usage_nonnegative_charge", sql`${t.credits} >= 0 AND ${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.latency} >= 0`),
]);
export const audit = pgTable("platform_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  targetId: text("target_id"),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: date("created_at"),
});
export const tickets = pgTable("platform_tickets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  category: text("category").notNull(),
  state: text("state").notNull().default("open"),
  createdAt: date("created_at"),
});
export const otpChallenges = pgTable("platform_otp_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  phone: text("phone").notNull(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: date("expires_at"),
  usedAt: timestamp("used_at", { withTimezone: true }),
});
export const rateBuckets = pgTable("platform_rate_buckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(1),
  expiresAt: date("expires_at"),
});

export const reservations = pgTable("platform_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  keyId: uuid("key_id").notNull().references(() => keys.id),
  requestId: text("request_id").notNull().unique(),
  model: text("model").notNull(),
  amount: units("amount"),
  settled: bigint("settled", { mode: "number" }),
  state: text("state").notNull().default("held"),
  allocations: jsonb("allocations").$type<{ lotId: string; amount: number }[]>().notNull().default([]),
  expiresAt: date("expires_at"),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: date("created_at"),
}, (t) => [
  index("reservations_owner_state_idx").on(t.userId, t.state),
  check("reservation_positive", sql`${t.amount} > 0 AND (${t.settled} IS NULL OR (${t.settled} >= 0 AND ${t.settled} <= ${t.amount}))`),
]);
export const providerState = pgTable("platform_provider_state", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  state: text("state").notNull().default("healthy"),
  balance: bigint("balance", { mode: "number" }),
  source: text("source").notNull().default("sandbox_simulator"),
  paused: boolean("paused").notNull().default(false),
  graceUntil: timestamp("grace_until", { withTimezone: true }),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  changedAt: date("changed_at"),
  coverageTier: integer("coverage_tier"),
});
export const alerts = pgTable("platform_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  state: text("state").notNull().default("open"),
  deliveries: jsonb("deliveries").$type<{ channel: string; status: string; at: string; detail?: string }[]>().notNull().default([]),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: date("created_at"),
}, (t) => [index("alerts_owner_time_idx").on(t.userId, t.createdAt)]);
export const adminMfa = pgTable("platform_admin_mfa", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  secret: text("secret").notNull(),
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
  lastStep: bigint("last_step", { mode: "number" }),
  failures: integer("failures").notNull().default(0),
  createdAt: date("created_at"),
});
export const refunds = pgTable("platform_refunds", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  credits: units("credits"),
  amountIrr: units("amount_irr"),
  reason: text("reason").notNull(),
  state: text("state").notNull().default("requested"),
  decisionNote: text("decision_note"),
  payoutReference: text("payout_reference"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: date("created_at"),
}, (t) => [index("refunds_owner_idx").on(t.userId)]);
export const packages = pgTable("platform_packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  label: text("label").notNull(),
  subtitle: text("subtitle").notNull().default(""),
  amountToman: integer("amount_toman").notNull(),
  icon: text("icon").notNull().default("sparkle"),
  featured: boolean("featured").notNull().default(false),
  active: boolean("active").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  createdAt: date("created_at"),
}, (t) => [index("packages_owner_idx").on(t.userId)]);

/** Platform-wide key/value state (catalog snapshot, sync counters, etc.). Not customer-scoped. */
export const platformState = pgTable("platform_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: date("updated_at"),
});

/**
 * Desktop connect sessions for Panacode (and future clients).
 * Browser completes login + key options; desktop exchanges a one-time code on loopback.
 */
export const connectSessions = pgTable("platform_connect_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientState: text("client_state").notNull().unique(),
  redirectUri: text("redirect_uri").notNull(),
  userId: uuid("user_id").references(() => users.id),
  product: text("product").notNull().default("panacode"),
  keyName: text("key_name").notNull().default("Panacode"),
  /** null = unlimited (share unallocated); number = capped soft budget */
  budget: bigint("budget", { mode: "number" }),
  rateLimit: integer("rate_limit").notNull().default(60),
  status: text("status").notNull().default("pending"),
  exchangeCodeHash: text("exchange_code_hash"),
  encryptedSecret: text("encrypted_secret"),
  keyId: uuid("key_id").references(() => keys.id),
  keyPrefix: text("key_prefix"),
  expiresAt: date("expires_at"),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: date("created_at"),
}, (t) => [
  index("connect_sessions_user_idx").on(t.userId),
  index("connect_sessions_expiry_idx").on(t.expiresAt),
]);

/**
 * Upstream (CVC) runtime credentials.
 * - kind=capped: one CVC key per budgeted PanaAI key (platform_key_id set)
 * - kind=shared_uncapped: one CVC key shared by all no-budget PanaAI keys of the user
 * Plaintext never leaves the server; only the encrypted blob is stored.
 */
export const upstreamCredentials = pgTable("platform_upstream_key_creds", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  platformKeyId: uuid("platform_key_id").references(() => keys.id),
  kind: text("kind").notNull(), // 'capped' | 'shared_uncapped'
  encryptedSecret: text("encrypted_secret").notNull(),
  prefix: text("prefix").notNull(),
  upstreamRef: text("upstream_ref"),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: date("created_at"),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
